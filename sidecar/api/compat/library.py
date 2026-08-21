"""One-release library compatibility adapter backed by ``LibraryService``."""

from __future__ import annotations

import json
import uuid
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from backend_core.errors import AppError
from sidecar.library_assets import (
    format_ms,
    model_to_encoding_key,
    now_ms,
    safe_name,
    slug,
    string_or_none,
    to_float,
)
from sidecar.security.payloads import (
    MAX_SINGLE_ASSET_BYTES,
    PayloadBudgetError,
    decode_base64_payload,
)
from sidecar.services.library import LibraryItem, LibraryKind, LibraryService

_OWNER = "local"


def register_library_compat_routes(
    router: APIRouter,
    library: LibraryService,
    auth: Any = None,
) -> None:
    write_deps = [auth] if auth is not None else []

    @router.get("/api/oc/list")
    async def legacy_oc_list() -> dict[str, Any]:
        items = await library.list_items(_OWNER, kind="oc")
        ocs = [_oc(item) for item in items]
        return {"ocs": ocs, "total": len(ocs), "configured": True}

    @router.post("/api/oc/create", dependencies=write_deps)
    async def legacy_oc_create(data: dict[str, Any]) -> dict[str, Any]:
        en_name = string_or_none(data.get("en_name"))
        zh_name = string_or_none(data.get("zh_name"))
        item_id = uuid.uuid4().hex
        en_name = en_name or slug(zh_name or f"oc-{item_id[:8]}")
        tag_group = str(data.get("tag_group") or "").strip()
        if not tag_group:
            raise HTTPException(status_code=400, detail="tag_group is required")
        primary, media_type = _decode_asset(data.get("preview_base64"))
        item = await _call(
            library.create_item(
                _OWNER,
                "oc",
                en_name,
                {
                    "en_name": en_name,
                    "zh_name": zh_name,
                    "zh_aliases": _string_list(data.get("zh_aliases")),
                    "tag_group": tag_group,
                    "negative_prompt": str(data.get("negative_prompt") or ""),
                    "created_by": str(data.get("created_by") or "local"),
                    "created_at": now_ms(),
                },
                primary_payload=primary,
                primary_media_type=media_type,
                item_id=item_id,
            )
        )
        return {"success": True, "message": "创建成功", "oc": _oc(item), "configured": True}

    @router.get("/api/oc/preview/{oc_id}")
    async def legacy_oc_preview(oc_id: str) -> FileResponse:
        return await _asset_response(library, "oc", oc_id)

    @router.put("/api/oc/{oc_name}", dependencies=write_deps)
    async def legacy_oc_update(oc_name: str, data: dict[str, Any]) -> dict[str, Any]:
        item = await _require_by_key(library, "oc", oc_name)
        merged = dict(item.data)
        for source, target in (
            ("zh_name", "zh_name"),
            ("tag_group", "tag_group"),
            ("negative_prompt", "negative_prompt"),
            ("created_by", "created_by"),
        ):
            if source in data:
                merged[target] = data[source]
        if "zh_aliases" in data:
            merged["zh_aliases"] = _string_list(data["zh_aliases"])
        primary, media_type = _decode_asset(data.get("preview_base64"))
        updated = await _call(
            library.update_item(
                _OWNER,
                item.id,
                lookup_key=item.lookup_key,
                data=merged,
                primary_payload=primary,
                primary_media_type=media_type,
            )
        )
        return {"success": True, "message": "更新成功", "oc": _oc(updated), "configured": True}

    @router.delete("/api/oc/{oc_name}", dependencies=write_deps)
    async def legacy_oc_delete(oc_name: str) -> dict[str, Any]:
        item = await _require_by_key(library, "oc", oc_name)
        await library.delete_item(_OWNER, item.id)
        return {"success": True, "message": "删除成功", "configured": True}

    @router.get("/api/artists/list")
    async def legacy_artists_list() -> dict[str, Any]:
        items = await library.list_items(_OWNER, kind="artist")
        artists = [_artist(item) for item in items]
        return {"artists": artists, "total": len(artists), "configured": True}

    @router.post("/api/artists/create", dependencies=write_deps)
    async def legacy_artist_create(data: dict[str, Any]) -> dict[str, Any]:
        artist_string = str(data.get("artist_string") or "").strip()
        if not artist_string:
            raise HTTPException(status_code=400, detail="artist_string is required")
        name = string_or_none(data.get("name")) or artist_string[:48]
        primary, media_type = _decode_asset(data.get("preview_base64"))
        item = await _call(
            library.create_item(
                _OWNER,
                "artist",
                name,
                {
                    "name": name,
                    "artist_string": artist_string,
                    "negative": str(data.get("negative") or ""),
                    "usage_count": 0,
                    "added_by": str(data.get("added_by") or "local"),
                    "created_time": now_ms(),
                },
                primary_payload=primary,
                primary_media_type=media_type,
            )
        )
        return {
            "success": True,
            "message": "创建成功",
            "artist": _artist(item),
            "configured": True,
        }

    @router.get("/api/artists/preview/{artist_id}")
    async def legacy_artist_preview(artist_id: str) -> FileResponse:
        return await _asset_response(library, "artist", artist_id)

    @router.put("/api/artists/{artist_name}", dependencies=write_deps)
    async def legacy_artist_update(artist_name: str, data: dict[str, Any]) -> dict[str, Any]:
        item = await _require_by_key(library, "artist", artist_name)
        merged = dict(item.data)
        for key in ("artist_string", "negative", "added_by"):
            if key in data:
                merged[key] = data[key]
        primary, media_type = _decode_asset(data.get("preview_base64"))
        updated = await _call(
            library.update_item(
                _OWNER,
                item.id,
                lookup_key=item.lookup_key,
                data=merged,
                primary_payload=primary,
                primary_media_type=media_type,
            )
        )
        return {
            "success": True,
            "message": "更新成功",
            "artist": _artist(updated),
            "configured": True,
        }

    @router.delete("/api/artists/{artist_name}", dependencies=write_deps)
    async def legacy_artist_delete(artist_name: str) -> dict[str, Any]:
        item = await _require_by_key(library, "artist", artist_name)
        await library.delete_item(_OWNER, item.id)
        return {"success": True, "message": "删除成功", "configured": True}

    @router.post("/api/artists/{artist_name}/use", dependencies=write_deps)
    async def legacy_artist_use(artist_name: str) -> dict[str, Any]:
        item = await _require_by_key(library, "artist", artist_name)
        await library.increment_artist_usage(_OWNER, item.id)
        return {"success": True, "configured": True}

    @router.get("/api/cr/list")
    async def legacy_cr_list() -> dict[str, Any]:
        items = await library.list_items(_OWNER, kind="cr")
        crs = [_cr(item) for item in items]
        return {"crs": crs, "total": len(crs), "configured": True}

    @router.post("/api/cr/create", dependencies=write_deps)
    async def legacy_cr_create(data: dict[str, Any]) -> dict[str, Any]:
        name = str(data.get("name") or "").strip()
        if not name:
            raise HTTPException(status_code=400, detail="name is required")
        primary, media_type = _decode_asset(data.get("image_base64"))
        item = await _call(
            library.create_item(
                _OWNER,
                "cr",
                name,
                {
                    "name": name,
                    "zh_names": _string_list(data.get("zh_names")),
                    "created_time": now_ms(),
                },
                primary_payload=primary,
                primary_media_type=media_type,
            )
        )
        return {"success": True, "message": "创建成功", "cr": _cr(item), "configured": True}

    @router.get("/api/cr/preview/{cr_id}")
    async def legacy_cr_preview(cr_id: str) -> FileResponse:
        return await _asset_response(library, "cr", cr_id)

    @router.put("/api/cr/{cr_id}", dependencies=write_deps)
    async def legacy_cr_update(cr_id: str, data: dict[str, Any]) -> dict[str, Any]:
        item = await _require_by_key(library, "cr", cr_id)
        merged = dict(item.data)
        name = str(data.get("name", merged.get("name", item.lookup_key))).strip()
        merged["name"] = name
        if "zh_names" in data:
            merged["zh_names"] = _string_list(data["zh_names"])
        primary, media_type = _decode_asset(data.get("image_base64"))
        updated = await _call(
            library.update_item(
                _OWNER,
                item.id,
                lookup_key=name,
                data=merged,
                primary_payload=primary,
                primary_media_type=media_type,
            )
        )
        return {"success": True, "message": "更新成功", "cr": _cr(updated), "configured": True}

    @router.delete("/api/cr/{cr_id}", dependencies=write_deps)
    async def legacy_cr_delete(cr_id: str) -> dict[str, Any]:
        item = await _require_by_key(library, "cr", cr_id)
        await library.delete_item(_OWNER, item.id)
        return {"success": True, "message": "删除成功", "configured": True}

    @router.get("/api/vibes/list")
    async def legacy_vibes_list() -> dict[str, Any]:
        items = await library.list_items(_OWNER, kind="vibe")
        vibes = [_vibe(item) for item in items]
        return {"vibes": vibes, "total": len(vibes), "configured": True}

    @router.post("/api/vibes/upload", dependencies=write_deps)
    async def legacy_vibes_upload(data: dict[str, Any]) -> dict[str, Any]:
        vibe_data = data.get("vibe_data")
        if not isinstance(vibe_data, dict):
            raise HTTPException(status_code=400, detail="vibe_data is required")
        item_id = uuid.uuid4().hex
        name = str(data.get("name") or vibe_data.get("name") or f"vibe-{item_id[:8]}").strip()
        filename = f"{safe_name(slug(name) or 'vibe')}-{item_id[:8]}.json"
        document = {**vibe_data, "name": name}
        primary = json.dumps(document, ensure_ascii=False, allow_nan=False).encode("utf-8")
        if len(primary) > MAX_SINGLE_ASSET_BYTES:
            raise HTTPException(status_code=400, detail="vibe document is too large")
        thumbnail, thumbnail_type = _decode_asset(vibe_data.get("thumbnail"))
        encodings = vibe_data.get("encodings")
        supported = list(encodings) if isinstance(encodings, dict) else []
        import_info = vibe_data.get("importInfo")
        import_data = import_info if isinstance(import_info, dict) else {}
        payload = {
            key: value for key, value in vibe_data.items() if key not in {"thumbnail", "image"}
        }
        item = await _call(
            library.create_item(
                _OWNER,
                "vibe",
                filename,
                {
                    "name": name,
                    "filename": filename,
                    "supported_models": supported,
                    "default_strength": to_float(
                        import_data.get("strength") or vibe_data.get("defaultStrength")
                    ),
                    "default_info_extracted": to_float(
                        import_data.get("information_extracted")
                        or vibe_data.get("defaultInfoExtracted")
                    ),
                    "created_at": int(vibe_data.get("createdAt") or now_ms()),
                    "has_image": bool(vibe_data.get("image")),
                    "uploader_id": str(
                        data.get("uploader_id") or data.get("session_id") or "local"
                    ),
                    "uploaded_at": now_ms(),
                    "payload": payload,
                },
                primary_payload=primary,
                primary_media_type="application/json",
                thumbnail_payload=thumbnail,
                thumbnail_media_type=thumbnail_type,
                item_id=item_id,
            )
        )
        return {
            "success": True,
            "message": "上传成功",
            "filename": filename,
            "vibe": _vibe(item),
            "configured": True,
        }

    @router.get("/api/vibes/thumbnail/{filename}")
    async def legacy_vibe_thumbnail(filename: str) -> FileResponse:
        return await _asset_response(library, "vibe", filename, role="thumbnail")

    @router.get("/api/vibes/file/{filename}")
    async def legacy_vibe_file(filename: str) -> dict[str, Any]:
        item = await _require_by_key(library, "vibe", filename)
        return await _vibe_document(library, item)

    @router.put("/api/vibes/file/{filename}", dependencies=write_deps)
    async def legacy_vibe_update(filename: str, data: dict[str, Any]) -> dict[str, Any]:
        item = await _require_by_key(library, "vibe", filename)
        document = await _vibe_document(library, item)
        if data.get("name"):
            document["name"] = data["name"]
        import_info = document.get("importInfo")
        import_data = dict(import_info) if isinstance(import_info, dict) else {}
        if data.get("default_strength") is not None:
            import_data["strength"] = data["default_strength"]
        if data.get("default_info_extracted") is not None:
            import_data["information_extracted"] = data["default_info_extracted"]
        if import_data:
            document["importInfo"] = import_data
        merged = dict(item.data)
        merged["name"] = str(document.get("name") or merged.get("name") or filename)
        merged["default_strength"] = to_float(import_data.get("strength"))
        merged["default_info_extracted"] = to_float(import_data.get("information_extracted"))
        payload = {
            key: value for key, value in document.items() if key not in {"thumbnail", "image"}
        }
        merged["payload"] = payload
        updated = await _call(
            library.update_item(
                _OWNER,
                item.id,
                lookup_key=item.lookup_key,
                data=merged,
                primary_payload=json.dumps(
                    document,
                    ensure_ascii=False,
                    allow_nan=False,
                ).encode("utf-8"),
                primary_media_type="application/json",
            )
        )
        return {
            "success": True,
            "message": "更新成功",
            "vibe": _vibe(updated),
            "configured": True,
        }

    @router.delete("/api/vibes/file/{filename}", dependencies=write_deps)
    async def legacy_vibe_delete(filename: str) -> dict[str, Any]:
        item = await _require_by_key(library, "vibe", filename)
        await library.delete_item(_OWNER, item.id)
        return {"success": True, "message": "删除成功", "configured": True}

    @router.get("/api/vibes/encoding/{filename}")
    async def legacy_vibe_encoding(
        filename: str,
        model: str = "",
        ie: float = 0.5,
    ) -> dict[str, Any]:
        item = await _require_by_key(library, "vibe", filename)
        document = await _vibe_document(library, item)
        encoding = _encoding(document, model, ie)
        return {"found": bool(encoding), "encoding": encoding}

    @router.get("/api/vibes/download/{filename}")
    async def legacy_vibe_download(filename: str) -> FileResponse:
        item = await _require_by_key(library, "vibe", filename)
        asset, path = await _call(library.asset_for_item(_OWNER, item.id))
        return FileResponse(
            path,
            media_type=asset.media_type or "application/json",
            filename=path.name,
        )


async def _call(awaitable):  # type: ignore[no-untyped-def]
    try:
        return await awaitable
    except AppError as exc:
        status = 404 if exc.code_value.endswith("not_found") else 400
        raise HTTPException(status_code=status, detail=exc.message) from exc


async def _require_by_key(
    library: LibraryService,
    kind: LibraryKind,
    key: str,
) -> LibraryItem:
    if kind == "vibe" and ("/" in key or "\\" in key):
        raise HTTPException(status_code=400, detail="invalid vibe filename")
    try:
        direct = await library.get_item(_OWNER, key)
    except AppError:
        direct = None
    if direct is not None and direct.kind == kind:
        return direct
    item = await _call(library.find_by_key(_OWNER, kind, key))
    if item is None:
        raise HTTPException(status_code=404, detail=f"{kind} not found")
    return item


async def _asset_response(
    library: LibraryService,
    kind: LibraryKind,
    key: str,
    *,
    role: Literal["primary", "thumbnail"] = "primary",
) -> FileResponse:
    item = await _require_by_key(library, kind, key)
    asset, path = await _call(library.asset_for_item(_OWNER, item.id, role=role))
    return FileResponse(path, media_type=asset.media_type or "application/octet-stream")


def _decode_asset(value: object) -> tuple[bytes | None, str | None]:
    if not isinstance(value, str) or not value.strip():
        return None, None
    try:
        return decode_base64_payload(value)
    except PayloadBudgetError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _string_list(value: object) -> list[str]:
    return [str(item) for item in value] if isinstance(value, list) else []


def _oc(item: LibraryItem) -> dict[str, Any]:
    data = item.data
    return {
        "id": item.id,
        "en_name": data.get("en_name", item.lookup_key),
        "zh_name": data.get("zh_name"),
        "zh_aliases": data.get("zh_aliases", []),
        "tag_group": data.get("tag_group", ""),
        "negative_prompt": data.get("negative_prompt", ""),
        "preview_url": f"/api/oc/preview/{item.id}" if item.primary_asset_id else None,
        "created_by": data.get("created_by", "local"),
        "created_at": data.get("created_at", 0),
        "configured": True,
    }


def _artist(item: LibraryItem) -> dict[str, Any]:
    data = item.data
    created = _integer(data.get("created_time"))
    return {
        "id": item.id,
        "name": data.get("name", item.lookup_key),
        "artist_string": data.get("artist_string", ""),
        "negative": data.get("negative", ""),
        "preview_url": (f"/api/artists/preview/{item.id}" if item.primary_asset_id else None),
        "usage_count": _integer(data.get("usage_count")),
        "created_time": created,
        "created_time_str": format_ms(created) if created else "",
        "added_by": data.get("added_by", "local"),
        "configured": True,
    }


def _cr(item: LibraryItem) -> dict[str, Any]:
    data = item.data
    return {
        "id": item.id,
        "name": data.get("name", item.lookup_key),
        "preview_url": f"/api/cr/preview/{item.id}" if item.primary_asset_id else None,
        "created_time": data.get("created_time", 0),
        "zh_names": data.get("zh_names", []),
        "configured": True,
    }


def _vibe(item: LibraryItem) -> dict[str, Any]:
    data = item.data
    return {
        "id": item.id,
        "name": data.get("name", item.lookup_key),
        "filename": data.get("filename", item.lookup_key),
        "thumbnail": (f"/api/vibes/thumbnail/{item.lookup_key}" if item.thumbnail_asset_id else ""),
        "supportedModels": data.get("supported_models", []),
        "defaultStrength": data.get("default_strength"),
        "defaultInfoExtracted": data.get("default_info_extracted"),
        "createdAt": data.get("created_at", 0),
        "hasImage": bool(data.get("has_image", False)),
        "uploaderId": data.get("uploader_id", "local"),
        "uploadedAt": data.get("uploaded_at", 0),
        "configured": True,
    }


async def _vibe_document(library: LibraryService, item: LibraryItem) -> dict[str, Any]:
    _, path = await _call(library.asset_for_item(_OWNER, item.id))
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=500, detail="invalid vibe asset") from exc
    if not isinstance(value, dict):
        raise HTTPException(status_code=500, detail="invalid vibe asset")
    return value


def _encoding(document: dict[str, Any], model: str, ie: float) -> str | None:
    encodings = document.get("encodings")
    if not isinstance(encodings, dict):
        return None
    for key in (model, model_to_encoding_key(model)):
        value = encodings.get(key)
        if isinstance(value, str):
            return value
        if isinstance(value, dict):
            for ie_key in (str(ie), f"{ie:.2f}", f"{ie:.1f}"):
                encoded = value.get(ie_key)
                if isinstance(encoded, str):
                    return encoded
    return None


def _integer(value: object) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float, str)):
        try:
            return int(value)
        except ValueError:
            return 0
    return 0


__all__ = ["register_library_compat_routes"]
