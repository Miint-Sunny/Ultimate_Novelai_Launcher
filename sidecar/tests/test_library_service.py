from __future__ import annotations

import os
import sqlite3
from contextlib import closing
from pathlib import Path

import pytest

from backend_core.errors import InvalidArgumentError, ResourceNotFoundError
from sidecar.persistence import Database
from sidecar.services.assets import AssetService
from sidecar.services.library import (
    LibraryConflictError,
    LibraryItemNotFoundError,
    LibraryService,
)


def _services(root: Path) -> tuple[Database, AssetService, LibraryService]:
    database = Database(root / "app.sqlite3")
    assets = AssetService(
        database,
        root / "assets",
        quota_bytes=64 * 1024 * 1024,
        reserve_bytes=0,
    )
    return database, assets, LibraryService(database, assets)


async def _insert_oc(
    database: Database,
    *,
    item_id: str,
    name: str,
    preview_path: Path,
    aliases_json: str = "[]",
) -> None:
    async with database.transaction() as connection:
        await connection.execute(
            """
            INSERT INTO ocs(
                id, en_name, zh_name, zh_aliases_json, tag_group, negative_prompt,
                preview_path, created_by, created_at, updated_at
            ) VALUES (?, ?, NULL, ?, '1girl', '', ?, 'local', 1, ?)
            """,
            (
                item_id,
                name,
                aliases_json,
                str(preview_path),
                "2026-07-13T00:00:00+00:00",
            ),
        )


@pytest.mark.asyncio
async def test_legacy_data_asset_is_copied_and_import_is_idempotent(tmp_path: Path) -> None:
    database, assets, library = _services(tmp_path)
    await database.initialize()
    source = tmp_path / "data" / "oc" / "preview.png"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"legacy-preview")
    await _insert_oc(
        database,
        item_id="old-oc",
        name="alice",
        preview_path=source,
    )

    await library.initialize()
    first = await library.find_by_key("local", "oc", "alice")
    assert first is not None
    assert first.id == "legacy-oc-old-oc"
    assert first.primary_asset_id is not None
    asset = await assets.require_asset(first.primary_asset_id)
    copied = assets.asset_path(asset)
    assert copied.read_bytes() == b"legacy-preview"
    assert copied != source
    assert source.read_bytes() == b"legacy-preview"

    await library.initialize()
    with closing(sqlite3.connect(database.path)) as connection:
        entry_count = connection.execute(
            "SELECT count(*) FROM library_entries WHERE id = 'legacy-oc-old-oc'"
        ).fetchone()[0]
        asset_count = connection.execute(
            "SELECT count(*) FROM assets WHERE id = ?",
            (first.primary_asset_id,),
        ).fetchone()[0]
    assert entry_count == 1
    assert asset_count == 1


@pytest.mark.asyncio
async def test_legacy_asset_import_rejects_escape_and_symlink(tmp_path: Path) -> None:
    database, _, library = _services(tmp_path)
    await database.initialize()
    outside = tmp_path / "outside.png"
    outside.write_bytes(b"outside")
    legacy_dir = tmp_path / "data" / "oc"
    legacy_dir.mkdir(parents=True)
    symlink = legacy_dir / "link.png"
    os.symlink(outside, symlink)
    await _insert_oc(
        database,
        item_id="outside",
        name="outside",
        preview_path=outside,
        aliases_json="{",
    )
    await _insert_oc(
        database,
        item_id="symlink",
        name="symlink",
        preview_path=symlink,
    )

    await library.initialize()

    escaped = await library.find_by_key("local", "oc", "outside")
    linked = await library.find_by_key("local", "oc", "symlink")
    assert escaped is not None and escaped.primary_asset_id is None
    assert escaped.data["zh_aliases"] == []
    assert linked is not None and linked.primary_asset_id is None
    assert outside.read_bytes() == b"outside"
    assert symlink.is_symlink()


@pytest.mark.asyncio
async def test_library_service_enforces_owner_and_uses_asset_ids(tmp_path: Path) -> None:
    _, assets, library = _services(tmp_path)
    await library.initialize()
    item = await library.create_item(
        "owner-a",
        "artist",
        "../../soft shading",
        {
            "name": "Soft shading",
            "artist_string": "soft shading",
            "negative": "",
            "usage_count": 0,
            "added_by": "local",
            "created_time": 1,
        },
        primary_payload=b"preview",
        primary_media_type="image/png",
    )

    assert item.primary_asset_id is not None
    assert await library.get_item("owner-b", item.id) is None
    assert await library.list_items("owner-b") == []
    assert not await library.delete_item("owner-b", item.id)
    asset = await assets.require_asset(item.primary_asset_id)
    path = assets.asset_path(asset)
    assert path.is_relative_to(assets.root)
    assert ".." not in asset.relative_path.split("/")


@pytest.mark.asyncio
async def test_library_crud_conflicts_assets_and_artist_usage(tmp_path: Path) -> None:
    _, assets, library = _services(tmp_path)
    await library.initialize()
    first = await library.create_item(
        "owner-a",
        "artist",
        "first",
        {"name": "First", "usage_count": 0},
        item_id="artist-first",
        primary_payload=b"primary-v1",
        primary_media_type="image/png",
        thumbnail_payload=b"thumbnail-v1",
        thumbnail_media_type="image/webp",
    )
    second = await library.create_item(
        "owner-a",
        "artist",
        "second",
        {"name": "Second", "usage_count": 0},
        item_id="artist-second",
    )

    with pytest.raises(LibraryConflictError):
        await library.create_item("owner-a", "artist", "first", {"name": "duplicate"})
    with pytest.raises(LibraryItemNotFoundError):
        await library.update_item(
            "owner-a",
            "missing",
            lookup_key="missing",
            data={"name": "Missing"},
        )
    with pytest.raises(LibraryConflictError):
        await library.update_item(
            "owner-a",
            first.id,
            lookup_key=second.lookup_key,
            data={"name": "Conflict"},
        )

    updated = await library.update_item(
        "owner-a",
        first.id,
        lookup_key="first-updated",
        data={"name": "First updated", "usage_count": "not-a-number"},
        primary_payload=b"primary-v2",
        primary_media_type="image/jpeg",
        thumbnail_payload=b"thumbnail-v2",
        thumbnail_media_type="image/png",
    )
    assert updated.primary_asset_id is not None
    assert updated.thumbnail_asset_id is not None
    primary, primary_path = await library.asset_for_item("owner-a", updated.id)
    thumbnail, thumbnail_path = await library.asset_for_item(
        "owner-a", updated.id, role="thumbnail"
    )
    assert primary.id == updated.primary_asset_id
    assert thumbnail.id == updated.thumbnail_asset_id
    assert primary_path.read_bytes() == b"primary-v2"
    assert thumbnail_path.read_bytes() == b"thumbnail-v2"

    incremented = await library.increment_artist_usage("owner-a", updated.id)
    assert incremented.data["usage_count"] == 1
    assert [item.id for item in await library.list_items("owner-a", kind="artist")] == [
        second.id,
        updated.id,
    ]
    with pytest.raises(InvalidArgumentError, match="page"):
        await library.list_items("owner-a", limit=0)

    no_asset = await library.create_item(
        "owner-a",
        "oc",
        "no-asset",
        {"name": "No asset"},
        item_id="oc-no-asset",
    )
    with pytest.raises(ResourceNotFoundError, match="asset"):
        await library.asset_for_item("owner-a", no_asset.id)
    with pytest.raises(LibraryItemNotFoundError):
        await library.increment_artist_usage("owner-a", no_asset.id)

    primary_path.unlink()
    with pytest.raises(ResourceNotFoundError, match="asset"):
        await library.asset_for_item("owner-a", updated.id)

    assert await library.delete_item("owner-a", second.id)
    assert await library.get_item("owner-a", second.id) is None
    await library.close()
    assert not await library.check()


@pytest.mark.asyncio
async def test_library_rejects_invalid_identifiers_payloads_and_json(tmp_path: Path) -> None:
    _, _, library = _services(tmp_path)
    await library.initialize()

    with pytest.raises(InvalidArgumentError, match="owner"):
        await library.create_item("", "oc", "valid", {})
    with pytest.raises(InvalidArgumentError, match="kind"):
        await library.create_item("owner", "unknown", "valid", {})  # type: ignore[arg-type]
    with pytest.raises(InvalidArgumentError, match="key"):
        await library.create_item("owner", "oc", 123, {})  # type: ignore[arg-type]
    with pytest.raises(InvalidArgumentError, match="key"):
        await library.create_item("owner", "oc", "bad\nkey", {})
    with pytest.raises(InvalidArgumentError, match="valid JSON"):
        await library.create_item("owner", "oc", "bad-json", {"value": float("nan")})
    with pytest.raises(InvalidArgumentError, match="payload must be bytes"):
        await library.create_item(
            "owner",
            "oc",
            "bad-payload",
            {},
            primary_payload="not-bytes",  # type: ignore[arg-type]
        )


@pytest.mark.asyncio
async def test_numbered_migration_imports_stable_legacy_key(tmp_path: Path) -> None:
    path = tmp_path / "app.sqlite3"
    with closing(sqlite3.connect(path)) as connection:
        connection.execute(
            """
            CREATE TABLE artists (
                id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
                artist_string TEXT NOT NULL, negative TEXT, preview_path TEXT,
                usage_count INTEGER NOT NULL DEFAULT 0, added_by TEXT,
                created_time INTEGER NOT NULL, updated_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            INSERT INTO artists VALUES(
                'artist-1', 'line art', 'line art', '', NULL, 0, 'local', 1,
                '2026-07-13T00:00:00+00:00'
            )
            """
        )
        connection.commit()

    await Database(path).initialize()

    with closing(sqlite3.connect(path)) as connection:
        row = connection.execute(
            "SELECT id, owner, kind, lookup_key FROM library_entries"
        ).fetchone()
    assert row == ("legacy-artist-artist-1", "local", "artist", "line art")
