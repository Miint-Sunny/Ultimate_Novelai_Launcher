"""Authenticated storage inspection, downloads, and explicit manual pruning."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Path, Query, Request
from fastapi.responses import FileResponse

from backend_core.errors import DependencyUnavailableError
from sidecar.runtime import AppRuntime
from sidecar.services.assets import AssetNotFoundError, AssetService

from ..dependencies import authorize_request, resolve_runtime
from ..problems import ProblemDetailsRoute
from .models import (
    AssetListResponse,
    AssetResponse,
    AssetStatusValue,
    StoragePruneRequest,
    StoragePruneResponse,
    StorageStatusResponse,
)


def create_storage_router(runtime: AppRuntime | None = None) -> APIRouter:
    router = APIRouter(tags=["v1-storage"], route_class=ProblemDetailsRoute)

    @router.get("/storage", response_model=StorageStatusResponse)
    async def storage_status(request: Request) -> StorageStatusResponse:
        assets = await _require_assets(request, runtime)
        status = await assets.storage_status()
        return StorageStatusResponse.model_validate(status.to_dict())

    @router.get("/assets", response_model=AssetListResponse)
    async def list_assets(
        request: Request,
        limit: int = Query(default=100, ge=1, le=100),
        offset: int = Query(default=0, ge=0),
        status: Annotated[list[AssetStatusValue] | None, Query()] = None,
    ) -> AssetListResponse:
        assets = await _require_assets(request, runtime)
        records = await assets.list_assets(limit=limit, offset=offset, statuses=status)
        items = [AssetResponse.model_validate(record.to_dict()) for record in records]
        return AssetListResponse(
            items=items,
            limit=limit,
            offset=offset,
            count=len(items),
        )

    @router.get("/assets/{asset_id}", response_model=AssetResponse)
    async def get_asset(
        request: Request,
        asset_id: str = Path(min_length=1, max_length=256),
    ) -> AssetResponse:
        assets = await _require_assets(request, runtime)
        record = await assets.require_asset(asset_id)
        return AssetResponse.model_validate(record.to_dict())

    @router.get("/assets/{asset_id}/content", response_model=None)
    async def get_asset_content(
        request: Request,
        asset_id: str = Path(min_length=1, max_length=256),
    ) -> FileResponse:
        assets = await _require_assets(request, runtime)
        record = await assets.require_asset(asset_id)
        path = assets.asset_path(record)
        if record.status == "missing" or not path.is_file():
            raise AssetNotFoundError(asset_id)
        return FileResponse(
            path,
            media_type=record.media_type or "application/octet-stream",
            filename=path.name,
        )

    @router.post("/storage/prune", response_model=StoragePruneResponse)
    async def prune_assets(
        body: StoragePruneRequest,
        request: Request,
    ) -> StoragePruneResponse:
        assets = await _require_assets(request, runtime)
        removed: list[str] = []
        missing: list[str] = []
        for asset_id in dict.fromkeys(body.asset_ids):
            if await assets.delete_asset(asset_id):
                removed.append(asset_id)
            else:
                missing.append(asset_id)
        return StoragePruneResponse(
            removed_asset_ids=removed,
            missing_asset_ids=missing,
        )

    return router


async def _require_assets(
    request: Request,
    bound: AppRuntime | None,
) -> AssetService:
    runtime = resolve_runtime(request, bound)
    runtime.assert_ready()
    await authorize_request(runtime, request)
    assets = runtime.assets
    if not isinstance(assets, AssetService):
        raise DependencyUnavailableError(
            "asset service is not configured",
            code="asset_service_unavailable",
        )
    return assets


__all__ = ["create_storage_router"]
