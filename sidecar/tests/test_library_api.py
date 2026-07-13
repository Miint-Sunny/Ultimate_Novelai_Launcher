from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from sidecar.config import Settings
from sidecar.server import create_app

TOKEN = "library-test-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
ONE_PIXEL = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUB"
    "AScY42YAAAAASUVORK5CYII="
)


def _settings(root: Path) -> Settings:
    return Settings(
        host="127.0.0.1",
        port=0,
        data_dir=root,
        nai_token="",
        nai_base_url="https://image.novelai.net",
        llm_base_url="",
        llm_api_key="",
        llm_model="",
        mock_generation=True,
        sidecar_auth_token=TOKEN,
        storage_reserve_bytes=0,
    )


def test_v1_library_crud_is_authenticated_strict_and_typed(tmp_path: Path) -> None:
    with TestClient(create_app(_settings(tmp_path))) as client:
        unauthorized = client.get("/api/v1/library/items")
        created = client.post(
            "/api/v1/library/items",
            headers=AUTH,
            json={
                "kind": "artist",
                "key": "soft shading",
                "data": {
                    "name": "Soft shading",
                    "artist_string": "soft shading, delicate lineart",
                },
                "primary_asset_base64": ONE_PIXEL,
            },
        )
        item_id = created.json()["id"]
        listed = client.get(
            "/api/v1/library/items",
            headers=AUTH,
            params={"kind": "artist"},
        )
        replaced = client.put(
            f"/api/v1/library/items/{item_id}",
            headers=AUTH,
            json={
                "key": "soft shading 2",
                "data": {
                    "name": "Soft shading 2",
                    "artist_string": "soft shading, lineart",
                    "usage_count": 2,
                },
            },
        )
        extra = client.post(
            "/api/v1/library/items",
            headers=AUTH,
            json={
                "kind": "artist",
                "key": "bad",
                "data": {"name": "bad", "artist_string": "bad"},
                "unexpected": True,
            },
        )
        mismatch = client.post(
            "/api/v1/library/items",
            headers=AUTH,
            json={
                "kind": "artist",
                "key": "wrong type",
                "data": {"en_name": "alice", "tag_group": "1girl"},
            },
        )
        deleted = client.delete(f"/api/v1/library/items/{item_id}", headers=AUTH)
        missing = client.get(f"/api/v1/library/items/{item_id}", headers=AUTH)

    assert unauthorized.status_code == 401
    assert created.status_code == 201
    assert created.json()["owner"] == "local"
    assert created.json()["primary_asset_id"].startswith("library-")
    assert listed.status_code == 200
    assert listed.json()["count"] == 1
    assert replaced.status_code == 200
    assert replaced.json()["key"] == "soft shading 2"
    assert extra.status_code == 422
    assert extra.json()["code"] == "validation_error"
    assert mismatch.status_code == 422
    assert deleted.status_code == 200
    assert missing.status_code == 404


def test_compat_and_v1_library_share_one_service(tmp_path: Path) -> None:
    with TestClient(create_app(_settings(tmp_path))) as client:
        compat = client.post(
            "/api/artists/create",
            headers=AUTH,
            json={
                "name": "compat artist",
                "artist_string": "compat artist string",
                "preview_base64": ONE_PIXEL,
            },
        )
        canonical = client.get(
            "/api/v1/library/items",
            headers=AUTH,
            params={"kind": "artist"},
        )
        v1 = client.post(
            "/api/v1/library/items",
            headers=AUTH,
            json={
                "kind": "oc",
                "key": "alice",
                "data": {
                    "en_name": "alice",
                    "tag_group": "1girl, blue eyes",
                },
            },
        )
        compat_list = client.get("/api/oc/list", headers=AUTH)

    assert compat.status_code == 200
    assert canonical.status_code == 200
    assert canonical.json()["items"][0]["key"] == "compat artist"
    assert v1.status_code == 201
    assert compat_list.status_code == 200
    assert compat_list.json()["ocs"][0]["en_name"] == "alice"
    assert compat.headers["Deprecation"] == "true"
