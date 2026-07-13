"""Authenticated, directory-confined backup and restore endpoints."""

from __future__ import annotations

import asyncio
import time
from datetime import datetime
from pathlib import Path
from typing import Literal, cast

from fastapi import APIRouter, BackgroundTasks, Request
from fastapi import Path as ApiPath

from backend_core.errors import ConflictError, DependencyUnavailableError
from sidecar.runtime import AppRuntime
from sidecar.services.backup import (
    SETTINGS_NAME,
    BackupManifest,
    BackupResult,
    BackupService,
)

from ..dependencies import authorize_request, resolve_runtime
from ..problems import ProblemDetailsRoute
from .models import (
    BackupCreateRequest,
    BackupDeleteResponse,
    BackupFileResponse,
    BackupListResponse,
    BackupResponse,
    BackupRestoreResponse,
    BackupValidationResponse,
)


def create_backup_router(runtime: AppRuntime | None = None) -> APIRouter:
    router = APIRouter(prefix="/backups", tags=["v1-backups"], route_class=ProblemDetailsRoute)

    @router.post("", response_model=BackupResponse, status_code=201)
    async def create_backup(
        body: BackupCreateRequest,
        request: Request,
    ) -> BackupResponse:
        backups = await _require_backups(request, runtime)
        result = await backups.create_backup(include_assets=body.include_assets)
        return _backup_response(result)

    @router.get("", response_model=BackupListResponse)
    async def list_backups(request: Request) -> BackupListResponse:
        backups = await _require_backups(request, runtime)
        results = await backups.list_backups()
        items = [_backup_response(result) for result in results]
        return BackupListResponse(items=items, count=len(items))

    @router.delete("/{backup_ref}", response_model=BackupDeleteResponse)
    async def delete_backup(
        request: Request,
        backup_ref: str = ApiPath(min_length=1, max_length=200),
    ) -> BackupDeleteResponse:
        backups = await _require_backups(request, runtime)
        deleted = await backups.delete_backup(backup_ref)
        return BackupDeleteResponse(
            filename=deleted.filename,
            reclaimed_bytes=deleted.reclaimed_bytes,
        )

    @router.post("/{backup_ref}/validate", response_model=BackupValidationResponse)
    async def validate_backup(
        request: Request,
        backup_ref: str = ApiPath(min_length=1, max_length=200),
    ) -> BackupValidationResponse:
        backups = await _require_backups(request, runtime)
        archive_path = await backups.resolve_backup(backup_ref)
        manifest = await backups.validate_backup(archive_path)
        return BackupValidationResponse(
            backup=_backup_response(BackupResult(archive_path=archive_path, manifest=manifest))
        )

    @router.post("/{backup_ref}/restore", response_model=BackupRestoreResponse)
    async def restore_backup(
        request: Request,
        background_tasks: BackgroundTasks,
        backup_ref: str = ApiPath(min_length=1, max_length=200),
    ) -> BackupRestoreResponse:
        current = resolve_runtime(request, runtime)
        backups = await _require_backups(request, runtime)
        archive_path = await backups.resolve_backup(backup_ref)
        controller = current.process_control
        request_shutdown = getattr(controller, "request_shutdown", None)
        if not callable(request_shutdown):
            raise DependencyUnavailableError(
                "process restart control is not configured",
                code="process_control_unavailable",
            )
        # ZIP bombs, corrupt archives, future schemas, and checksum failures must
        # fail while the process is still fully available.  Only a validated
        # staging tree is allowed to enter maintenance/drain.
        staging = await backups.stage_restore(archive_path)
        deadline = time.monotonic() + 8.0
        maintenance_started = False
        try:
            if not await current.mutations.try_quiesce(timeout=8.0):
                raise ConflictError(
                    "restore could not obtain exclusive access before the timeout",
                    code="restore_busy",
                    retryable=True,
                )
            remaining = max(0.0, deadline - time.monotonic())
            maintenance_started = True
            try:
                drained = await current.begin_drain(timeout=remaining)
                if not drained:
                    raise DependencyUnavailableError(
                        "sidecar could not drain background work; restart before retrying restore",
                        code="restore_restart_required",
                        retryable=True,
                    )
                restored = await backups.restore_staged(staging)
            except asyncio.CancelledError:
                request_shutdown()
                raise
            except Exception as exc:
                # begin_drain stops workers and seals writes permanently. Even when
                # the file transaction rolled back, this process must restart
                # instead of pretending it can safely reopen half-stopped services.
                request_shutdown()
                if (
                    isinstance(exc, DependencyUnavailableError)
                    and exc.code == "restore_restart_required"
                ):
                    raise
                raise DependencyUnavailableError(
                    "restore failed after maintenance began; restart is required",
                    code="restore_restart_required",
                    retryable=True,
                ) from exc
        finally:
            # restore_staged consumes staging; cleanup is intentionally idempotent.
            await asyncio.to_thread(staging.cleanup)
            if not maintenance_started and current.mutations.draining:
                await current.mutations.reopen()
        background_tasks.add_task(request_shutdown)
        return BackupRestoreResponse(
            backup=_manifest_response(
                archive_path,
                restored.manifest,
            ),
            safety_backup_filename=restored.safety_backup_path.name,
        )

    return router


async def _require_backups(
    request: Request,
    bound: AppRuntime | None,
) -> BackupService:
    runtime = resolve_runtime(request, bound)
    runtime.assert_ready()
    await authorize_request(runtime, request)
    backups = runtime.backups
    if not isinstance(backups, BackupService):
        raise DependencyUnavailableError(
            "backup service is not configured",
            code="backup_service_unavailable",
        )
    return backups


def _backup_response(result: BackupResult) -> BackupResponse:
    return _manifest_response(result.archive_path, result.manifest)


def _manifest_response(archive_path: Path, manifest: BackupManifest) -> BackupResponse:
    files = [
        BackupFileResponse(
            path=entry.path,
            byte_size=entry.byte_size,
            sha256=entry.sha256,
            kind=cast(Literal["database", "settings", "asset"], entry.kind),
        )
        for entry in manifest.files
    ]
    return BackupResponse(
        backup_id=manifest.backup_id,
        filename=archive_path.name,
        created_at=datetime.fromisoformat(manifest.created_at.replace("Z", "+00:00")),
        schema_version=manifest.schema_version,
        includes_assets=manifest.includes_assets,
        includes_settings=any(entry.path == SETTINGS_NAME for entry in manifest.files),
        archive_bytes=archive_path.stat().st_size,
        files=files,
    )


__all__ = ["create_backup_router"]
