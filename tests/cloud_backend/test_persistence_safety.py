from __future__ import annotations

import asyncio
import base64
import os
import sqlite3
import stat
from collections.abc import Callable
from pathlib import Path

import aiosqlite
import pytest

from cloud_backend.infrastructure import (
    CloudJobResultStore,
    SQLiteCloudJobRepository,
    SQLiteQuotaRepository,
    SQLiteWorkshopQuotaRepository,
)
from cloud_backend.infrastructure.secure_sqlite import (
    FileIdentity,
    SecureSQLiteFile,
    StorageIntegrityError,
    assert_directory_identity,
    check_component_version,
    require_table_columns,
)

RepositoryFactory = Callable[[Path], object]
_PNG = b"\x89PNG\r\n\x1a\nsecure-result"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "factory",
    [SQLiteCloudJobRepository, SQLiteQuotaRepository, SQLiteWorkshopQuotaRepository],
)
async def test_sqlite_repositories_reject_database_symlinks_without_mutating_target(
    tmp_path: Path,
    factory: RepositoryFactory,
) -> None:
    target = tmp_path / "outside.db"
    with sqlite3.connect(target) as connection:
        connection.execute("CREATE TABLE sentinel(value TEXT NOT NULL)")
        connection.execute("INSERT INTO sentinel VALUES ('unchanged')")
    before = target.read_bytes()
    linked = tmp_path / "linked.db"
    linked.symlink_to(target)

    repository = factory(linked)
    with pytest.raises(StorageIntegrityError, match="regular file"):
        await repository.initialize()  # type: ignore[attr-defined]

    assert target.read_bytes() == before
    with sqlite3.connect(target) as connection:
        assert connection.execute("SELECT value FROM sentinel").fetchone() == ("unchanged",)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "factory",
    [SQLiteCloudJobRepository, SQLiteQuotaRepository, SQLiteWorkshopQuotaRepository],
)
async def test_sqlite_repositories_reject_corrupt_databases_without_replacing_them(
    tmp_path: Path,
    factory: RepositoryFactory,
) -> None:
    path = tmp_path / "corrupt.db"
    payload = b"this is not a SQLite database"
    path.write_bytes(payload)

    repository = factory(path)
    with pytest.raises(StorageIntegrityError, match="quick_check"):
        await repository.initialize()  # type: ignore[attr-defined]

    assert path.read_bytes() == payload
    assert repository.ready is False  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_future_component_schema_is_rejected_before_job_schema_mutation(
    tmp_path: Path,
) -> None:
    path = tmp_path / "future.db"
    with sqlite3.connect(path) as connection:
        connection.execute(
            """
            CREATE TABLE cloud_backend_schema_versions (
                component TEXT PRIMARY KEY,
                version INTEGER NOT NULL
            ) WITHOUT ROWID
            """
        )
        connection.execute(
            "INSERT INTO cloud_backend_schema_versions VALUES ('cloud_jobs', 999)"
        )

    repository = SQLiteCloudJobRepository(path)
    with pytest.raises(StorageIntegrityError, match="not supported"):
        await repository.initialize()

    with sqlite3.connect(path) as connection:
        tables = {
            str(row[0])
            for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
        }
    assert tables == {"cloud_backend_schema_versions"}


@pytest.mark.asyncio
async def test_new_sqlite_database_is_private_and_workshop_overlay_can_start_empty(
    tmp_path: Path,
) -> None:
    path = tmp_path / "new" / "workshop.db"
    repository = SQLiteWorkshopQuotaRepository(path)

    await repository.initialize()

    assert repository.ready is True
    if os.name != "nt":
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert not path.is_symlink()


@pytest.mark.asyncio
async def test_repository_rejects_parent_directory_replacement_after_initialize(
    tmp_path: Path,
) -> None:
    root = tmp_path / "database-root"
    repository = SQLiteQuotaRepository(root / "quota.db")
    await repository.initialize()
    original = tmp_path / "original-database-root"
    root.rename(original)
    root.mkdir()

    with pytest.raises(StorageIntegrityError, match="directory changed"):
        await repository.journal_mode()

    assert not (root / "quota.db").exists()
    assert (original / "quota.db").is_file()


@pytest.mark.asyncio
async def test_result_store_rejects_symlink_root_without_touching_target(tmp_path: Path) -> None:
    target = tmp_path / "outside-results"
    target.mkdir()
    sentinel = target / "sentinel.txt"
    sentinel.write_text("unchanged", encoding="utf-8")
    linked = tmp_path / "results"
    linked.symlink_to(target, target_is_directory=True)

    store = CloudJobResultStore(linked)
    with pytest.raises(StorageIntegrityError, match="real directory"):
        await store.initialize()

    assert sentinel.read_text(encoding="utf-8") == "unchanged"
    assert list(target.iterdir()) == [sentinel]


@pytest.mark.asyncio
async def test_result_store_rejects_root_replacement_after_initialize(tmp_path: Path) -> None:
    root = tmp_path / "results"
    store = CloudJobResultStore(root)
    await store.initialize()
    original = tmp_path / "original-results"
    root.rename(original)
    root.mkdir()

    encoded = base64.b64encode(_PNG).decode("ascii")
    with pytest.raises(StorageIntegrityError, match="changed"):
        await store.save_base64("job", encoded)

    assert list(root.iterdir()) == []
    assert list(original.iterdir()) == []


@pytest.mark.asyncio
async def test_sqlite_auxiliary_symlink_is_rejected(tmp_path: Path) -> None:
    repository = SQLiteCloudJobRepository(tmp_path / "jobs.db")
    await repository.initialize()
    target = tmp_path / "outside-wal"
    target.write_bytes(b"sentinel")
    wal = Path(f"{repository.path}-wal")
    await asyncio.to_thread(_replace_with_symlink, wal, target)

    with pytest.raises(StorageIntegrityError, match="auxiliary"):
        await repository.journal_mode()

    assert target.read_bytes() == b"sentinel"
    os.unlink(wal)


def test_directory_identity_rejects_missing_and_non_directory_paths(tmp_path: Path) -> None:
    expected = FileIdentity(device=1, inode=1)
    with pytest.raises(StorageIntegrityError, match="directory is missing"):
        assert_directory_identity(tmp_path / "missing", expected)

    not_directory = tmp_path / "file"
    not_directory.write_bytes(b"not-a-directory")
    with pytest.raises(StorageIntegrityError, match="real directory"):
        assert_directory_identity(not_directory, expected)


@pytest.mark.asyncio
async def test_secure_sqlite_rejects_unprepared_and_invalid_schema_metadata(
    tmp_path: Path,
) -> None:
    guarded = SecureSQLiteFile(tmp_path / "unprepared.db")
    assert guarded.initialized is False
    with pytest.raises(StorageIntegrityError, match="has not been prepared"):
        async with guarded.connect():
            pass

    async with aiosqlite.connect(":memory:") as connection:
        await connection.execute(
            """
            CREATE TABLE cloud_backend_schema_versions (
                component TEXT PRIMARY KEY,
                version INTEGER NOT NULL
            )
            """
        )
        await check_component_version(connection, component="missing", supported=1)
        await connection.execute(
            "INSERT INTO cloud_backend_schema_versions VALUES ('broken', 'not-an-integer')"
        )
        with pytest.raises(StorageIntegrityError, match="version is invalid"):
            await check_component_version(connection, component="broken", supported=1)

        await connection.execute("CREATE TABLE wrong_shape (id INTEGER PRIMARY KEY)")
        with pytest.raises(StorageIntegrityError, match="schema mismatch"):
            await require_table_columns(connection, "wrong_shape", ("id", "owner"))


def _replace_with_symlink(path: Path, target: Path) -> None:
    if os.path.lexists(path):
        os.unlink(path)
    os.symlink(target, path)
