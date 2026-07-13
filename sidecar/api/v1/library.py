"""Canonical owner-scoped local library HTTP adapter."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, cast

from fastapi import APIRouter, Path, Query, Request

from backend_core.errors import DependencyUnavailableError, InvalidArgumentError
from backend_core.types import JsonValue
from sidecar.runtime import AppRuntime
from sidecar.security.payloads import PayloadBudgetError, decode_base64_payload
from sidecar.services.library import LibraryKind, LibraryService

from ..dependencies import authorize_request, resolve_runtime
from ..problems import ProblemDetailsRoute
from .models import (
    ArtistLibraryData,
    CrLibraryData,
    LibraryItemCreate,
    LibraryItemDeleteResponse,
    LibraryItemListResponse,
    LibraryItemReplace,
    LibraryItemResponse,
    LibraryKindValue,
    OcLibraryData,
    VibeLibraryData,
)


def create_library_router(runtime: AppRuntime | None = None) -> APIRouter:
    router = APIRouter(
        prefix="/library",
        tags=["v1-library"],
        route_class=ProblemDetailsRoute,
    )

    @router.post("/items", response_model=LibraryItemResponse, status_code=201)
    async def create_item(body: LibraryItemCreate, request: Request) -> LibraryItemResponse:
        library, owner = await _require_library(request, runtime)
        primary, primary_type = _decode_optional(body.primary_asset_base64)
        thumbnail, thumbnail_type = _decode_optional(body.thumbnail_asset_base64)
        item = await library.create_item(
            owner,
            cast(LibraryKind, body.kind),
            body.key,
            cast(dict[str, JsonValue], body.data.model_dump(mode="json")),
            primary_payload=primary,
            primary_media_type=primary_type,
            thumbnail_payload=thumbnail,
            thumbnail_media_type=thumbnail_type,
        )
        return _response(item.to_dict())

    @router.get("/items", response_model=LibraryItemListResponse)
    async def list_items(
        request: Request,
        kind: Annotated[LibraryKindValue | None, Query()] = None,
        limit: int = Query(default=100, ge=1, le=100),
        offset: int = Query(default=0, ge=0),
    ) -> LibraryItemListResponse:
        library, owner = await _require_library(request, runtime)
        records = await library.list_items(
            owner,
            kind=cast(LibraryKind | None, kind),
            limit=limit,
            offset=offset,
        )
        items = [_response(record.to_dict()) for record in records]
        return LibraryItemListResponse(
            items=items,
            limit=limit,
            offset=offset,
            count=len(items),
        )

    @router.get("/items/{item_id}", response_model=LibraryItemResponse)
    async def get_item(
        request: Request,
        item_id: str = Path(min_length=1, max_length=256),
    ) -> LibraryItemResponse:
        library, owner = await _require_library(request, runtime)
        return _response((await library.require_item(owner, item_id)).to_dict())

    @router.put("/items/{item_id}", response_model=LibraryItemResponse)
    async def replace_item(
        body: LibraryItemReplace,
        request: Request,
        item_id: str = Path(min_length=1, max_length=256),
    ) -> LibraryItemResponse:
        library, owner = await _require_library(request, runtime)
        current = await library.require_item(owner, item_id)
        _ensure_data_kind(current.kind, body.data)
        primary, primary_type = _decode_optional(body.primary_asset_base64)
        thumbnail, thumbnail_type = _decode_optional(body.thumbnail_asset_base64)
        item = await library.update_item(
            owner,
            item_id,
            lookup_key=body.key,
            data=cast(dict[str, JsonValue], body.data.model_dump(mode="json")),
            primary_payload=primary,
            primary_media_type=primary_type,
            thumbnail_payload=thumbnail,
            thumbnail_media_type=thumbnail_type,
        )
        return _response(item.to_dict())

    @router.delete("/items/{item_id}", response_model=LibraryItemDeleteResponse)
    async def delete_item(
        request: Request,
        item_id: str = Path(min_length=1, max_length=256),
    ) -> LibraryItemDeleteResponse:
        library, owner = await _require_library(request, runtime)
        await library.require_item(owner, item_id)
        await library.delete_item(owner, item_id)
        return LibraryItemDeleteResponse(id=item_id)

    return router


async def _require_library(
    request: Request,
    bound: AppRuntime | None,
) -> tuple[LibraryService, str]:
    runtime = resolve_runtime(request, bound)
    runtime.assert_ready()
    principal = await authorize_request(runtime, request)
    library = runtime.library
    if not isinstance(library, LibraryService):
        raise DependencyUnavailableError(
            "library service is not configured",
            code="library_service_unavailable",
        )
    # Authentication identifies the single local desktop principal.  The raw
    # process credential intentionally never becomes persistent owner data: it is
    # rotated by the launcher and is itself a secret.
    owner = "local" if principal is not None else "local"
    return library, owner


def _decode_optional(value: str | None) -> tuple[bytes | None, str | None]:
    if value is None:
        return None, None
    try:
        return decode_base64_payload(value)
    except PayloadBudgetError as exc:
        raise InvalidArgumentError(str(exc), code="invalid_library_asset") from exc


def _ensure_data_kind(kind: LibraryKind, data: object) -> None:
    expected = {
        "oc": OcLibraryData,
        "artist": ArtistLibraryData,
        "cr": CrLibraryData,
        "vibe": VibeLibraryData,
    }[kind]
    if type(data) is not expected:
        raise InvalidArgumentError(
            f"{kind} library items require {expected.__name__}",
            code="library_kind_mismatch",
        )


def _response(value: dict[str, object]) -> LibraryItemResponse:
    converted = dict(value)
    for field in ("created_at", "updated_at"):
        raw = converted.get(field)
        if isinstance(raw, str):
            converted[field] = datetime.fromisoformat(raw)
    return LibraryItemResponse.model_validate(converted)


router = create_library_router()


__all__ = ["create_library_router", "router"]
