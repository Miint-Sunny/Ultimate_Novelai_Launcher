from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from unittest import mock

import pytest

from sidecar import (
    library_artists,
    library_assets,
    library_cr,
    library_ocs,
    library_tables,
    library_vibes,
)
from sidecar.config import Settings
from sidecar.db import init_db

ONE_PIXEL = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUB"
    "AScY42YAAAAASUVORK5CYII="
)


def _settings(root: Path) -> Settings:
    settings = Settings(
        host="127.0.0.1",
        port=0,
        data_dir=root,
        nai_token="",
        nai_base_url="https://image.novelai.net",
        llm_base_url="",
        llm_api_key="",
        llm_model="",
        mock_generation=True,
        storage_reserve_bytes=0,
    )
    init_db(settings)
    library_tables.init_library(settings)
    return settings


def _files(settings: Settings, kind: str) -> set[Path]:
    root = library_assets.asset_dir(settings, kind)
    return {path for path in root.rglob("*") if path.is_file()}


@pytest.mark.parametrize(
    ("module", "create", "kind", "payload"),
    [
        (
            library_artists,
            library_artists.create_artist,
            "artists",
            {
                "name": "artist",
                "artist_string": "artist tag",
                "preview_base64": ONE_PIXEL,
            },
        ),
        (
            library_ocs,
            library_ocs.create_oc,
            "oc",
            {
                "en_name": "alice",
                "tag_group": "1girl",
                "preview_base64": ONE_PIXEL,
            },
        ),
        (
            library_cr,
            library_cr.create_cr,
            "cr",
            {"name": "character", "image_base64": ONE_PIXEL},
        ),
    ],
)
def test_create_database_failure_removes_new_preview(
    tmp_path: Path,
    module: object,
    create: object,
    kind: str,
    payload: dict[str, object],
) -> None:
    settings = _settings(tmp_path)
    with mock.patch.object(
        module,
        "connect",
        side_effect=sqlite3.OperationalError("injected insert failure"),
    ):
        with pytest.raises(sqlite3.OperationalError, match="injected"):
            create(settings, payload)  # type: ignore[operator]
    assert _files(settings, kind) == set()


def test_validation_happens_before_preview_write(tmp_path: Path) -> None:
    settings = _settings(tmp_path)

    with pytest.raises(ValueError, match="tag_group"):
        library_ocs.create_oc(
            settings,
            {"en_name": "alice", "preview_base64": ONE_PIXEL},
        )
    with pytest.raises(ValueError, match="zh_aliases"):
        library_ocs.create_oc(
            settings,
            {
                "en_name": "alice",
                "tag_group": "1girl",
                "zh_aliases": "not-a-list",
                "preview_base64": ONE_PIXEL,
            },
        )
    with pytest.raises(ValueError, match="zh_names"):
        library_cr.create_cr(
            settings,
            {"name": "character", "zh_names": "not-a-list", "image_base64": ONE_PIXEL},
        )

    assert _files(settings, "oc") == set()
    assert _files(settings, "cr") == set()


def test_cr_create_update_validation_and_delete(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    created = library_cr.create_cr(
        settings,
        {"name": "character", "zh_names": ["角色"], "image_base64": ONE_PIXEL},
    )

    with pytest.raises(ValueError, match="zh_names"):
        library_cr.update_cr(settings, created["id"], {"zh_names": "not-a-list"})

    updated = library_cr.update_cr(
        settings,
        created["id"],
        {"name": "character updated", "zh_names": ["新角色"]},
    )
    assert updated is not None
    assert updated["name"] == "character updated"
    assert updated["zh_names"] == ["新角色"]
    assert library_cr.delete_cr(settings, created["id"])
    assert library_cr.get_cr(settings, created["id"]) is None


def test_artist_update_uses_unique_file_and_rolls_back_on_database_failure(
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    created = library_artists.create_artist(
        settings,
        {
            "name": "artist",
            "artist_string": "artist tag",
            "preview_base64": ONE_PIXEL,
        },
    )
    original = library_tables.find_one(settings, "artists", created["id"], "name")
    assert original is not None
    original_path = Path(original["preview_path"])
    original_payload = original_path.read_bytes()

    with mock.patch.object(
        library_artists,
        "connect",
        side_effect=sqlite3.OperationalError("injected update failure"),
    ):
        with pytest.raises(sqlite3.OperationalError, match="injected"):
            library_artists.update_artist(
                settings,
                created["id"],
                {"artist_string": "replacement", "preview_base64": ONE_PIXEL},
            )

    unchanged = library_tables.find_one(settings, "artists", created["id"], "name")
    assert unchanged is not None
    assert unchanged["preview_path"] == str(original_path)
    assert original_path.read_bytes() == original_payload
    assert _files(settings, "artists") == {original_path}

    updated = library_artists.update_artist(
        settings,
        created["id"],
        {"artist_string": "replacement", "preview_base64": ONE_PIXEL},
    )
    assert updated is not None
    persisted = library_tables.find_one(settings, "artists", created["id"], "name")
    assert persisted is not None
    replacement_path = Path(persisted["preview_path"])
    assert replacement_path != original_path
    assert replacement_path.exists()
    assert not original_path.exists()
    assert _files(settings, "artists") == {replacement_path}


def test_oc_update_uses_unique_file_and_rolls_back_on_database_failure(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    created = library_ocs.create_oc(
        settings,
        {
            "en_name": "alice",
            "tag_group": "1girl",
            "preview_base64": ONE_PIXEL,
        },
    )
    original = library_tables.find_one(settings, "ocs", created["id"], "en_name")
    assert original is not None
    original_path = Path(original["preview_path"])

    with mock.patch.object(
        library_ocs,
        "connect",
        side_effect=sqlite3.OperationalError("injected update failure"),
    ):
        with pytest.raises(sqlite3.OperationalError, match="injected"):
            library_ocs.update_oc(
                settings,
                created["id"],
                {"tag_group": "1girl, blue eyes", "preview_base64": ONE_PIXEL},
            )

    unchanged = library_tables.find_one(settings, "ocs", created["id"], "en_name")
    assert unchanged is not None
    assert unchanged["preview_path"] == str(original_path)
    assert _files(settings, "oc") == {original_path}

    with pytest.raises(ValueError, match="zh_aliases"):
        library_ocs.update_oc(settings, created["id"], {"zh_aliases": "not-a-list"})
    with pytest.raises(ValueError, match="tag_group"):
        library_ocs.update_oc(settings, created["id"], {"tag_group": " "})

    library_ocs.update_oc(
        settings,
        created["id"],
        {"tag_group": "1girl, blue eyes", "preview_base64": ONE_PIXEL},
    )
    persisted = library_tables.find_one(settings, "ocs", created["id"], "en_name")
    assert persisted is not None
    replacement_path = Path(persisted["preview_path"])
    assert replacement_path != original_path
    assert replacement_path.exists()
    assert not original_path.exists()
    assert _files(settings, "oc") == {replacement_path}


def test_vibe_create_cleans_files_when_document_or_database_write_fails(
    tmp_path: Path,
) -> None:
    settings = _settings(tmp_path)
    payload = {"name": "vibe", "thumbnail": ONE_PIXEL, "encodings": {"v4": "value"}}

    with mock.patch.object(
        library_vibes,
        "atomic_write_text",
        side_effect=OSError("injected document failure"),
    ):
        with pytest.raises(OSError, match="document"):
            library_vibes.create_vibe(settings, payload, "vibe")
    assert _files(settings, "vibes") == set()

    with mock.patch.object(
        library_vibes,
        "connect",
        side_effect=sqlite3.OperationalError("injected insert failure"),
    ):
        with pytest.raises(sqlite3.OperationalError, match="injected"):
            library_vibes.create_vibe(settings, payload, "vibe")
    assert _files(settings, "vibes") == set()


def test_vibe_update_restores_document_when_database_update_fails(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    created = library_vibes.create_vibe(
        settings,
        {"name": "old name", "encodings": {"v4": {"0.5": "value"}}},
        "old name",
    )
    row = library_vibes.find_vibe(settings, created["filename"])
    assert row is not None
    document_path = Path(row["file_path"])
    original_payload = document_path.read_bytes()
    real_connect = library_vibes.connect
    calls = 0

    def fail_third_connect(path: Path):  # type: ignore[no-untyped-def]
        nonlocal calls
        calls += 1
        if calls == 3:
            raise sqlite3.OperationalError("injected update failure")
        return real_connect(path)

    with mock.patch.object(library_vibes, "connect", side_effect=fail_third_connect):
        with pytest.raises(sqlite3.OperationalError, match="injected"):
            library_vibes.update_vibe(
                settings,
                created["filename"],
                {"name": "new name", "default_strength": 0.8},
            )

    assert document_path.read_bytes() == original_payload
    assert json.loads(document_path.read_text(encoding="utf-8"))["name"] == "old name"
    persisted = library_vibes.find_vibe(settings, created["filename"])
    assert persisted is not None
    assert persisted["name"] == "old name"
    assert _files(settings, "vibes") == {document_path}

    updated = library_vibes.update_vibe(
        settings,
        created["filename"],
        {"name": "new name", "default_strength": 0.8},
    )
    assert updated is not None
    assert updated["name"] == "new name"
    assert updated["defaultStrength"] == 0.8
    assert (
        library_vibes.get_vibe_encoding(
            settings,
            created["filename"],
            "v4",
            0.5,
        )
        == "value"
    )


def test_vibe_delete_keeps_files_when_database_delete_fails(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    created = library_vibes.create_vibe(
        settings,
        {"name": "vibe", "thumbnail": ONE_PIXEL},
        "vibe",
    )
    row = library_vibes.find_vibe(settings, created["filename"])
    assert row is not None
    document_path = Path(row["file_path"])
    thumbnail_path = Path(row["thumbnail_path"])
    real_connect = library_vibes.connect
    calls = 0

    def fail_second_connect(path: Path):  # type: ignore[no-untyped-def]
        nonlocal calls
        calls += 1
        if calls == 2:
            raise sqlite3.OperationalError("injected delete failure")
        return real_connect(path)

    with mock.patch.object(library_vibes, "connect", side_effect=fail_second_connect):
        with pytest.raises(sqlite3.OperationalError, match="injected"):
            library_vibes.delete_vibe(settings, created["filename"])

    assert library_vibes.find_vibe(settings, created["filename"]) is not None
    assert document_path.exists()
    assert thumbnail_path.exists()

    assert library_vibes.delete_vibe(settings, created["filename"])
    assert library_vibes.find_vibe(settings, created["filename"]) is None
    assert not document_path.exists()
    assert not thumbnail_path.exists()


def test_delete_keeps_reference_and_file_when_database_delete_fails(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    created = library_artists.create_artist(
        settings,
        {
            "name": "artist",
            "artist_string": "artist tag",
            "preview_base64": ONE_PIXEL,
        },
    )
    row = library_tables.find_one(settings, "artists", created["id"], "name")
    assert row is not None
    preview_path = Path(row["preview_path"])
    real_connect = library_tables.connect
    calls = 0

    def fail_second_connect(path: Path):  # type: ignore[no-untyped-def]
        nonlocal calls
        calls += 1
        if calls == 2:
            raise sqlite3.OperationalError("injected delete failure")
        return real_connect(path)

    with mock.patch.object(library_tables, "connect", side_effect=fail_second_connect):
        with pytest.raises(sqlite3.OperationalError, match="injected"):
            library_artists.delete_artist(settings, created["id"])

    persisted = library_tables.find_one(settings, "artists", created["id"], "name")
    assert persisted is not None
    assert persisted["preview_path"] == str(preview_path)
    assert preview_path.exists()

    assert library_artists.delete_artist(settings, created["id"])
    assert library_tables.find_one(settings, "artists", created["id"], "name") is None
    assert not preview_path.exists()


def test_atomic_asset_replace_failure_preserves_old_file_and_removes_temp(
    tmp_path: Path,
) -> None:
    destination = tmp_path / "asset.png"
    destination.write_bytes(b"old")

    with mock.patch.object(
        library_assets.os,
        "replace",
        side_effect=OSError("injected replace failure"),
    ):
        with pytest.raises(OSError, match="replace"):
            library_assets.atomic_write_bytes(destination, b"new")

    assert destination.read_bytes() == b"old"
    assert list(tmp_path.glob(".*.part")) == []


def test_directory_fsync_is_best_effort(tmp_path: Path) -> None:
    with mock.patch.object(
        library_assets.os,
        "open",
        side_effect=OSError("directory descriptors unsupported"),
    ):
        library_assets._fsync_directory(tmp_path)

    with (
        mock.patch.object(library_assets.os, "open", return_value=42),
        mock.patch.object(
            library_assets.os,
            "fsync",
            side_effect=OSError("directory fsync unsupported"),
        ),
        mock.patch.object(library_assets.os, "close") as close,
    ):
        library_assets._fsync_directory(tmp_path)
    close.assert_called_once_with(42)


def test_vibe_filename_uses_full_identifier_to_avoid_prefix_collisions(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    first = library_assets.unique_filename(settings, "same name", "deadbeef" + "1" * 24)
    second = library_assets.unique_filename(settings, "same name", "deadbeef" + "2" * 24)

    assert first != second
    assert first.endswith(f"{'deadbeef' + '1' * 24}.json")
    assert second.endswith(f"{'deadbeef' + '2' * 24}.json")


def test_library_table_names_are_allowlisted(tmp_path: Path) -> None:
    settings = _settings(tmp_path)
    with pytest.raises(ValueError, match="unsupported"):
        library_tables.find_one(settings, "sqlite_master", "x", "name")
    with pytest.raises(ValueError, match="unsupported"):
        library_tables.delete_by_key(settings, "sqlite_master", "x", "name")
