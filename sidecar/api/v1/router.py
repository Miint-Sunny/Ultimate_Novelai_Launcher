"""Canonical v1 HTTP routes backed by ``AppRuntime`` protocols."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Annotated, Any, cast

from fastapi import APIRouter, Header, Path, Query, Request
from fastapi.responses import JSONResponse

from backend_core.errors import ResourceNotFoundError, RuntimeNotReadyError
from sidecar.runtime import AppRuntime

from ..dependencies import authorize_request, require_jobs, resolve_runtime
from ..models import ProblemDetails
from ..problems import PROBLEM_MEDIA_TYPE, ProblemDetailsRoute
from .auth import create_auth_router
from .backups import create_backup_router
from .cursors import decode_cursor, encode_cursor, resolve_event_cursor
from .events import SSEStreamingResponse, generation_event_stream
from .library import create_library_router
from .models import (
    DrainResponse,
    GenerationJobCancel,
    GenerationJobCreate,
    GenerationJobListResponse,
    GenerationJobResponse,
    JobStatusValue,
    ReadyResponse,
)
from .serialization import event_response as event_response
from .serialization import job_response
from .settings import create_settings_router
from .storage import create_storage_router
from .upscale import create_upscale_router

_PROBLEM_RESPONSES: dict[int | str, dict[str, Any]] = {
    status: {
        "model": ProblemDetails,
        "content": {PROBLEM_MEDIA_TYPE: {}},
        "description": description,
    }
    for status, description in {
        400: "Invalid request",
        401: "Authentication required",
        403: "Permission denied",
        404: "Resource not found",
        409: "Conflicting state",
        422: "Request validation failed",
        429: "Queue capacity exceeded",
        500: "Internal server error",
        503: "Runtime or dependency unavailable",
    }.items()
}


def create_v1_router(runtime: AppRuntime | None = None) -> APIRouter:
    """Build the v1 router, optionally binding it to a concrete runtime.

    When no runtime is supplied the router resolves ``request.app.state.runtime``;
    this makes it straightforward for the current FastAPI composition root to mount
    the router later without introducing an API-to-server import.
    """

    router = APIRouter(
        prefix="/api/v1",
        tags=["v1"],
        route_class=ProblemDetailsRoute,
    )

    @router.get(
        "/system/ready",
        response_model=ReadyResponse,
        responses={status: _PROBLEM_RESPONSES[status] for status in (401, 403, 503)},
        tags=["v1-system"],
    )
    async def ready(request: Request) -> ReadyResponse:
        current = resolve_runtime(request, runtime)
        await authorize_request(current, request)
        readiness = await current.probe_readiness()
        if not readiness["ready"]:
            raise RuntimeNotReadyError(
                "application runtime is not ready",
                details={
                    "state": current.state.value,
                    "components": readiness["components"],
                },
            )
        return ReadyResponse.model_validate(readiness)

    @router.post(
        "/system/drain",
        response_model=DrainResponse,
        responses={status: _PROBLEM_RESPONSES[status] for status in (401, 403, 500)},
        tags=["v1-system"],
    )
    async def drain(
        request: Request,
    ) -> DrainResponse:
        current = resolve_runtime(request, runtime)
        await authorize_request(current, request)
        await current.begin_drain(timeout=6.0)
        controller = current.process_control
        request_shutdown = getattr(controller, "request_shutdown", None)
        if callable(request_shutdown):
            request_shutdown()
        active_tasks = int(getattr(current.tasks, "active_count", 0))
        return DrainResponse(
            draining=True,
            active_tasks=max(0, active_tasks),
            shutdown_requested=bool(getattr(controller, "shutdown_requested", False)),
        )

    @router.post(
        "/generation/jobs",
        response_model=GenerationJobResponse,
        status_code=202,
        responses={
            **_PROBLEM_RESPONSES,
            200: {
                "model": GenerationJobResponse,
                "description": "Idempotent replay of an existing generation job",
            },
        },
        tags=["v1-generation"],
    )
    async def create_generation_job(
        body: GenerationJobCreate,
        request: Request,
        idempotency_key: str | None = Header(
            default=None,
            alias="Idempotency-Key",
            min_length=1,
            max_length=200,
        ),
    ) -> JSONResponse:
        jobs = await require_jobs(request, runtime)
        result = await jobs.create_job(
            body.payload.model_dump(mode="json"),
            idempotency_key=idempotency_key,
        )
        response = job_response(result.job)
        status_code = 202 if result.created else 200
        headers = {
            "Location": f"/api/v1/generation/jobs/{response.id}",
            "Idempotency-Replayed": "false" if result.created else "true",
        }
        return JSONResponse(
            status_code=status_code,
            content=response.model_dump(mode="json"),
            headers=headers,
        )

    @router.get(
        "/generation/jobs",
        response_model=GenerationJobListResponse,
        responses=_PROBLEM_RESPONSES,
        tags=["v1-generation"],
    )
    async def list_generation_jobs(
        request: Request,
        limit: int = Query(default=100, ge=1, le=100),
        cursor: str | None = Query(default=None, min_length=1, max_length=200),
        status: Annotated[list[JobStatusValue] | None, Query()] = None,
    ) -> GenerationJobListResponse:
        jobs = await require_jobs(request, runtime)
        offset = decode_cursor(cursor)
        records = list(
            await jobs.list_jobs(
                limit=limit + 1,
                offset=offset,
                statuses=status,
            )
        )
        has_more = len(records) > limit
        items = [job_response(record) for record in records[:limit]]
        return GenerationJobListResponse(
            items=items,
            limit=limit,
            cursor=cursor,
            next_cursor=encode_cursor(offset + limit) if has_more else None,
            count=len(items),
        )

    @router.get(
        "/generation/jobs/{job_id}",
        response_model=GenerationJobResponse,
        responses=_PROBLEM_RESPONSES,
        tags=["v1-generation"],
    )
    async def get_generation_job(
        request: Request,
        job_id: str = Path(min_length=1, max_length=128),
    ) -> GenerationJobResponse:
        jobs = await require_jobs(request, runtime)
        record = await jobs.get_job(job_id)
        if record is None:
            raise ResourceNotFoundError(
                "generation job was not found",
                code="job_not_found",
                details={"job_id": job_id},
            )
        return job_response(record)

    @router.post(
        "/generation/jobs/{job_id}/cancel",
        response_model=GenerationJobResponse,
        responses=_PROBLEM_RESPONSES,
        tags=["v1-generation"],
    )
    async def cancel_generation_job(
        request: Request,
        body: GenerationJobCancel | None = None,
        job_id: str = Path(min_length=1, max_length=128),
    ) -> GenerationJobResponse:
        jobs = await require_jobs(request, runtime)
        record = await jobs.cancel_job(job_id, reason=body.reason if body else None)
        if record is None:
            raise ResourceNotFoundError(
                "generation job was not found",
                code="job_not_found",
                details={"job_id": job_id},
            )
        return job_response(record)

    @router.get(
        "/generation/jobs/{job_id}/events",
        response_model=None,
        responses={
            **_PROBLEM_RESPONSES,
            200: {
                "description": "Server-sent job snapshots, persisted events, and keepalives",
                "content": {"text/event-stream": {"schema": {"type": "string"}}},
            },
        },
        tags=["v1-generation"],
    )
    async def list_generation_job_events(
        request: Request,
        job_id: str = Path(min_length=1, max_length=128),
        after_sequence: int = Query(default=0, ge=0),
        last_event_id: str | None = Header(default=None, alias="Last-Event-ID"),
    ) -> SSEStreamingResponse:
        jobs = await require_jobs(request, runtime)
        resolved_sequence = resolve_event_cursor(after_sequence, last_event_id)
        snapshot_reader = getattr(jobs, "snapshot_with_watermark", None)
        if callable(snapshot_reader):
            reader = cast(
                Callable[[str], Awaitable[tuple[Any, int]]],
                snapshot_reader,
            )
            record, snapshot_watermark = await reader(job_id)
        else:
            record = await jobs.get_job(job_id)
            if record is None:
                raise ResourceNotFoundError(
                    "generation job was not found",
                    code="job_not_found",
                    details={"job_id": job_id},
                )
            persisted = await jobs.list_events(job_id, after_sequence=0, limit=1000)
            snapshot_watermark = max(
                (int(item.to_dict().get("sequence", 0)) for item in persisted),
                default=0,
            )
        return SSEStreamingResponse(
            generation_event_stream(
                request,
                jobs,
                record,
                after_sequence=resolved_sequence,
                snapshot_watermark=snapshot_watermark,
            ),
            headers={
                "Cache-Control": "no-cache, no-transform",
                "X-Accel-Buffering": "no",
            },
        )

    # Empty today, but these named boundaries prevent settings/auth/library from
    # growing into the generation router as their v1 contracts are introduced.
    router.include_router(create_settings_router(runtime))
    router.include_router(create_auth_router(runtime))
    router.include_router(create_library_router(runtime))
    router.include_router(create_storage_router(runtime))
    router.include_router(create_backup_router(runtime))
    router.include_router(create_upscale_router(runtime))
    return router
