from __future__ import annotations

from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse

from .config import Settings
from .library import (
    asset_file,
    create_artist,
    create_cr,
    create_oc,
    create_vibe,
    delete_artist,
    delete_cr,
    delete_oc,
    delete_vibe,
    get_vibe_encoding,
    get_vibe_file,
    list_artists,
    list_crs,
    list_ocs,
    list_vibes,
    update_artist,
    update_cr,
    update_oc,
    update_vibe,
    use_artist,
    vibe_download_file,
)


def register_library_routes(app: FastAPI, settings: Settings, auth: Any = None) -> None:
    # Mutating library routes are gated on the sidecar auth token (when the shell
    # injects one); read routes stay open so browser <img> previews/thumbnails and
    # direct fetches keep working without a header.
    write_deps = [auth] if auth is not None else []

    @app.get("/api/oc/list")
    def legacy_oc_list() -> dict[str, Any]:
        ocs = list_ocs(settings)
        return {"ocs": ocs, "total": len(ocs), "configured": True}

    @app.post("/api/oc/create", dependencies=write_deps)
    def legacy_oc_create(data: dict[str, Any]) -> dict[str, Any]:
        try:
            oc = create_oc(settings, data)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"success": True, "message": "创建成功", "oc": oc, "configured": True}

    @app.get("/api/oc/preview/{oc_id}")
    def legacy_oc_preview(oc_id: str) -> FileResponse:
        return _asset_file_response(settings, "oc", oc_id)

    @app.put("/api/oc/{oc_name}", dependencies=write_deps)
    def legacy_oc_update(oc_name: str, data: dict[str, Any]) -> dict[str, Any]:
        try:
            oc = update_oc(settings, oc_name, data)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if not oc:
            raise HTTPException(status_code=404, detail="oc not found")
        return {"success": True, "message": "更新成功", "oc": oc, "configured": True}

    @app.delete("/api/oc/{oc_name}", dependencies=write_deps)
    def legacy_oc_delete(oc_name: str) -> dict[str, Any]:
        if not delete_oc(settings, oc_name):
            raise HTTPException(status_code=404, detail="oc not found")
        return {"success": True, "message": "删除成功", "configured": True}

    @app.get("/api/vibes/list")
    def legacy_vibes_list() -> dict[str, Any]:
        vibes = list_vibes(settings)
        return {"vibes": vibes, "total": len(vibes), "configured": True}

    @app.post("/api/vibes/upload", dependencies=write_deps)
    def legacy_vibes_upload(data: dict[str, Any]) -> dict[str, Any]:
        vibe_data = data.get("vibe_data")
        if not isinstance(vibe_data, dict):
            raise HTTPException(status_code=400, detail="vibe_data is required")
        try:
            vibe = create_vibe(
                settings,
                vibe_data,
                name=data.get("name"),
                uploader_id=data.get("uploader_id") or data.get("session_id"),
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {
            "success": True,
            "message": "上传成功",
            "filename": vibe["filename"],
            "vibe": vibe,
            "configured": True,
        }

    @app.get("/api/vibes/thumbnail/{filename}")
    def legacy_vibe_thumbnail(filename: str) -> FileResponse:
        return _asset_file_response(settings, "vibes", filename)

    @app.get("/api/vibes/file/{filename}")
    def legacy_vibe_file(filename: str) -> dict[str, Any]:
        try:
            data = get_vibe_file(settings, filename)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if data is None:
            raise HTTPException(status_code=404, detail="vibe not found")
        return data

    @app.put("/api/vibes/file/{filename}", dependencies=write_deps)
    def legacy_vibe_update(filename: str, data: dict[str, Any]) -> dict[str, Any]:
        try:
            vibe = update_vibe(settings, filename, data)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if not vibe:
            raise HTTPException(status_code=404, detail="vibe not found")
        return {"success": True, "message": "更新成功", "vibe": vibe, "configured": True}

    @app.delete("/api/vibes/file/{filename}", dependencies=write_deps)
    def legacy_vibe_delete(filename: str) -> dict[str, Any]:
        try:
            deleted = delete_vibe(settings, filename)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if not deleted:
            raise HTTPException(status_code=404, detail="vibe not found")
        return {"success": True, "message": "删除成功", "configured": True}

    @app.get("/api/vibes/encoding/{filename}")
    def legacy_vibe_encoding(filename: str, model: str = "", ie: float = 0.5) -> dict[str, Any]:
        encoding = get_vibe_encoding(settings, filename, model, ie)
        return {"found": bool(encoding), "encoding": encoding}

    @app.get("/api/vibes/download/{filename}")
    def legacy_vibe_download(filename: str) -> FileResponse:
        try:
            path = vibe_download_file(settings, filename)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if not path:
            raise HTTPException(status_code=404, detail="vibe not found")
        return FileResponse(path, media_type="application/json", filename=path.name)

    @app.get("/api/artists/list")
    def legacy_artists_list() -> dict[str, Any]:
        artists = list_artists(settings)
        return {"artists": artists, "total": len(artists), "configured": True}

    @app.post("/api/artists/create", dependencies=write_deps)
    def legacy_artist_create(data: dict[str, Any]) -> dict[str, Any]:
        try:
            artist = create_artist(settings, data)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"success": True, "message": "创建成功", "artist": artist, "configured": True}

    @app.get("/api/artists/preview/{artist_id}")
    def legacy_artist_preview(artist_id: str) -> FileResponse:
        return _asset_file_response(settings, "artists", artist_id)

    @app.put("/api/artists/{artist_name}", dependencies=write_deps)
    def legacy_artist_update(artist_name: str, data: dict[str, Any]) -> dict[str, Any]:
        try:
            artist = update_artist(settings, artist_name, data)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        if not artist:
            raise HTTPException(status_code=404, detail="artist not found")
        return {"success": True, "message": "更新成功", "artist": artist, "configured": True}

    @app.delete("/api/artists/{artist_name}", dependencies=write_deps)
    def legacy_artist_delete(artist_name: str) -> dict[str, Any]:
        if not delete_artist(settings, artist_name):
            raise HTTPException(status_code=404, detail="artist not found")
        return {"success": True, "message": "删除成功", "configured": True}

    @app.post("/api/artists/{artist_name}/use", dependencies=write_deps)
    def legacy_artist_use(artist_name: str) -> dict[str, Any]:
        return {"success": use_artist(settings, artist_name), "configured": True}

    @app.get("/api/cr/list")
    def legacy_cr_list() -> dict[str, Any]:
        crs = list_crs(settings)
        return {"crs": crs, "total": len(crs), "configured": True}

    @app.post("/api/cr/create", dependencies=write_deps)
    def legacy_cr_create(data: dict[str, Any]) -> dict[str, Any]:
        try:
            cr = create_cr(settings, data)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"success": True, "message": "创建成功", "cr": cr, "configured": True}

    @app.get("/api/cr/preview/{cr_id}")
    def legacy_cr_preview(cr_id: str) -> FileResponse:
        return _asset_file_response(settings, "cr", cr_id)

    @app.put("/api/cr/{cr_id}", dependencies=write_deps)
    def legacy_cr_update(cr_id: str, data: dict[str, Any]) -> dict[str, Any]:
        cr = update_cr(settings, cr_id, data)
        if not cr:
            raise HTTPException(status_code=404, detail="cr not found")
        return {"success": True, "message": "更新成功", "cr": cr, "configured": True}

    @app.delete("/api/cr/{cr_id}", dependencies=write_deps)
    def legacy_cr_delete(cr_id: str) -> dict[str, Any]:
        if not delete_cr(settings, cr_id):
            raise HTTPException(status_code=404, detail="cr not found")
        return {"success": True, "message": "删除成功", "configured": True}


def _asset_file_response(settings: Settings, kind: str, key: str) -> FileResponse:
    try:
        path = asset_file(settings, kind, key)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="asset not found") from exc
    if not path:
        raise HTTPException(status_code=404, detail="asset not found")
    media_type = "image/jpeg" if path.suffix.lower() in {".jpg", ".jpeg"} else "image/png"
    return FileResponse(path, media_type=media_type)
