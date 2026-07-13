from __future__ import annotations

import asyncio
import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from sidecar.persistence import (
    DEFAULT_MIGRATIONS,
    Database,
    DatabaseIntegrityError,
    DatabaseNotReadyError,
    FutureSchemaError,
    Migration,
    MigrationChecksumError,
    MigrationRunner,
)


class PersistenceTests(unittest.IsolatedAsyncioTestCase):
    async def test_numbered_migrations_and_checksums(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "app.sqlite3"
            database = Database(path)
            versions = [migration.version for migration in DEFAULT_MIGRATIONS]
            self.assertEqual(await database.initialize(), versions)
            self.assertEqual(await database.schema_version(), versions[-1])
            with closing(sqlite3.connect(path)) as connection:
                rows = connection.execute(
                    "SELECT version, checksum FROM schema_migrations ORDER BY version"
                ).fetchall()
                quick_check = connection.execute("PRAGMA quick_check").fetchone()[0]
            self.assertEqual([row[0] for row in rows], versions)
            self.assertEqual(
                [row[1] for row in rows], [migration.checksum for migration in DEFAULT_MIGRATIONS]
            )
            self.assertEqual(quick_check, "ok")

    async def test_legacy_database_is_baselined_after_pre_migration_backup(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            path = root / "app.sqlite3"
            with closing(sqlite3.connect(path)) as connection:
                connection.execute("CREATE TABLE legacy_user_data(value TEXT)")
                connection.execute("INSERT INTO legacy_user_data VALUES ('keep')")
                connection.commit()
            database = Database(path)
            await database.initialize()
            backups = list((root / "migration-backups").glob("*.sqlite3"))
            self.assertEqual(len(backups), 1)
            with closing(sqlite3.connect(path)) as connection:
                value = connection.execute("SELECT value FROM legacy_user_data").fetchone()[0]
            with closing(sqlite3.connect(backups[0])) as connection:
                backup_value = connection.execute("SELECT value FROM legacy_user_data").fetchone()[
                    0
                ]
                has_migrations = connection.execute(
                    "SELECT 1 FROM sqlite_master WHERE name='schema_migrations'"
                ).fetchone()
            self.assertEqual(value, "keep")
            self.assertEqual(backup_value, "keep")
            self.assertIsNone(has_migrations)

    async def test_legacy_generation_history_is_backfilled_into_jobs(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "app.sqlite3"
            with closing(sqlite3.connect(path)) as connection:
                connection.execute(
                    """
                    CREATE TABLE generations (
                        id TEXT PRIMARY KEY, input TEXT NOT NULL, mode TEXT NOT NULL,
                        tags TEXT NOT NULL, negative TEXT NOT NULL, params_json TEXT NOT NULL,
                        image_path TEXT, status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL
                    )
                    """
                )
                connection.execute(
                    """
                    INSERT INTO generations VALUES (
                        'legacy-1', 'cat', 'tags', 'cat, smile', 'bad', '{"steps": 20}',
                        '/old/legacy-1.png', 'success', NULL, '2026-01-01T00:00:00+00:00'
                    )
                    """
                )
                connection.commit()

            await Database(path).initialize()

            with closing(sqlite3.connect(path)) as connection:
                row = connection.execute(
                    "SELECT request_json, result_json, status FROM generation_jobs WHERE id = ?",
                    ("legacy-1",),
                ).fetchone()
                event = connection.execute(
                    "SELECT kind, status FROM job_events WHERE job_id = ?",
                    ("legacy-1",),
                ).fetchone()
            self.assertEqual(row[2], "succeeded")
            self.assertEqual(json.loads(row[0])["tags"], "cat, smile")
            self.assertTrue(json.loads(row[1])["legacy"])
            self.assertEqual(event, ("succeeded", "succeeded"))

    async def test_checksum_drift_stops_startup(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "app.sqlite3"
            await Database(path).initialize()
            with closing(sqlite3.connect(path)) as connection:
                connection.execute(
                    "UPDATE schema_migrations SET checksum='tampered' WHERE version=1"
                )
                connection.commit()
            with self.assertRaises(MigrationChecksumError):
                await Database(path).initialize()

    async def test_gap_in_migration_history_stops_startup(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "app.sqlite3"
            await Database(path).initialize()
            with closing(sqlite3.connect(path)) as connection:
                connection.execute("DELETE FROM schema_migrations WHERE version=1")
                connection.commit()
            with self.assertRaises(MigrationChecksumError):
                await Database(path).initialize()

    async def test_future_schema_stops_before_creating_a_backup(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            path = root / "app.sqlite3"
            await Database(path).initialize()
            with closing(sqlite3.connect(path)) as connection:
                connection.execute("PRAGMA user_version=99")
                connection.commit()
            with self.assertRaises(FutureSchemaError):
                await Database(path).initialize()
            self.assertFalse((root / "migration-backups").exists())

    async def test_failed_migration_rolls_back_the_whole_batch(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "app.sqlite3"
            migrations = (
                Migration(1, "one", ("CREATE TABLE one(value TEXT)",)),
                Migration(2, "broken", ("CREATE TABLE two(value TEXT)", "INVALID SQL")),
            )
            with self.assertRaises(sqlite3.DatabaseError):
                await MigrationRunner(path, migrations=migrations).migrate()
            with closing(sqlite3.connect(path)) as connection:
                names = {
                    row[0]
                    for row in connection.execute(
                        "SELECT name FROM sqlite_master WHERE type='table'"
                    ).fetchall()
                }
            self.assertNotIn("one", names)
            self.assertNotIn("two", names)
            self.assertNotIn("schema_migrations", names)

    async def test_logical_schema_failure_rolls_back_before_commit(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "app.sqlite3"
            with closing(sqlite3.connect(path)) as connection:
                # The names are compatible with the migration SQL, but the
                # affinities/constraints are not. CREATE IF NOT EXISTS must not
                # allow this legacy shape to be committed as the latest schema.
                connection.executescript(
                    """
                    CREATE TABLE generations (
                        id INTEGER PRIMARY KEY, input TEXT, mode TEXT, tags TEXT,
                        negative TEXT, params_json TEXT, image_path TEXT,
                        status TEXT, error TEXT, created_at TEXT
                    );
                    CREATE TABLE tag_translations (
                        tag INTEGER PRIMARY KEY, zh TEXT, source TEXT, updated_at TEXT
                    );
                    """
                )
                connection.commit()

            with self.assertRaisesRegex(DatabaseIntegrityError, "schema mismatch"):
                await MigrationRunner(path).migrate()

            with closing(sqlite3.connect(path)) as connection:
                version = connection.execute("PRAGMA user_version").fetchone()[0]
                names = {
                    row[0]
                    for row in connection.execute(
                        "SELECT name FROM sqlite_master WHERE type='table'"
                    ).fetchall()
                }
            self.assertEqual(version, 0)
            self.assertNotIn("schema_migrations", names)
            self.assertNotIn("generation_jobs", names)

    async def test_database_symlink_is_rejected_before_target_mutation(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            target = root / "outside.sqlite3"
            link = root / "app.sqlite3"
            with closing(sqlite3.connect(target)) as connection:
                connection.execute("CREATE TABLE sentinel(value TEXT)")
                connection.commit()
            try:
                link.symlink_to(target)
            except (OSError, NotImplementedError):
                self.skipTest("symbolic links are unavailable")

            with self.assertRaisesRegex(DatabaseIntegrityError, "regular file"):
                await MigrationRunner(link).migrate()

            self.assertTrue(link.is_symlink())
            with closing(sqlite3.connect(target)) as connection:
                version = connection.execute("PRAGMA user_version").fetchone()[0]
                names = {
                    row[0]
                    for row in connection.execute(
                        "SELECT name FROM sqlite_master WHERE type='table'"
                    ).fetchall()
                }
            self.assertEqual(version, 0)
            self.assertEqual(names, {"sentinel"})

    async def test_only_three_pre_migration_backups_are_retained(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            path = root / "app.sqlite3"
            with closing(sqlite3.connect(path)) as connection:
                connection.execute("CREATE TABLE seed(value TEXT)")
                connection.commit()
            all_migrations = tuple(
                Migration(version, f"migration_{version}", (f"CREATE TABLE t{version}(v TEXT)",))
                for version in range(1, 5)
            )
            for latest in range(1, 5):
                runner = MigrationRunner(path, migrations=all_migrations[:latest], backup_keep=3)
                await runner.migrate()
            backups = list((root / "migration-backups").glob("*.sqlite3"))
            self.assertEqual(len(backups), 3)

    async def test_concurrent_initializers_serialize_the_migration_transaction(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "app.sqlite3"
            first = Database(path)
            second = Database(path)
            results = await asyncio.gather(first.initialize(), second.initialize())
            self.assertEqual(
                sorted(len(result) for result in results),
                [0, len(DEFAULT_MIGRATIONS)],
            )
            self.assertEqual(
                await first.schema_version(),
                DEFAULT_MIGRATIONS[-1].version,
            )

    async def test_connection_requires_successful_initialization(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            database = Database(Path(temp) / "app.sqlite3")
            with self.assertRaises(DatabaseNotReadyError) as raised:
                async with database.connect():
                    pass
            self.assertEqual(raised.exception.code_value, "database_not_ready")

    async def test_live_database_fails_closed_after_file_or_schema_tampering(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)

            missing = Database(root / "missing.sqlite3")
            await missing.initialize()
            missing.path.unlink()
            with self.assertRaisesRegex(DatabaseNotReadyError, "regular file"):
                async with missing.connect():
                    pass
            self.assertFalse(missing.ready)

            future = Database(root / "future.sqlite3")
            await future.initialize()
            with closing(sqlite3.connect(future.path)) as connection:
                connection.execute("PRAGMA user_version = 0")
                connection.commit()
            self.assertFalse(await future.check())
            self.assertFalse(future.ready)

            damaged = Database(root / "damaged.sqlite3")
            await damaged.initialize()
            with closing(sqlite3.connect(damaged.path)) as connection:
                connection.execute("DROP INDEX idx_generation_jobs_fifo")
                connection.commit()
            self.assertFalse(await damaged.check())
            self.assertFalse(damaged.ready)

    async def test_empty_database_version_and_invalid_migration_definitions(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "missing.sqlite3"
            self.assertEqual(await MigrationRunner(path).current_version(), 0)

            with self.assertRaisesRegex(ValueError, "contiguous"):
                MigrationRunner(path, migrations=(Migration(2, "late", ("SELECT 1",)),))
            with self.assertRaisesRegex(ValueError, "at least one statement"):
                MigrationRunner(path, migrations=(Migration(1, "empty", ()),))

    async def test_close_checkpoints_marks_not_ready_and_allows_reinitialize(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            database = Database(Path(temp) / "app.sqlite3")
            await database.initialize()
            await database.checkpoint()
            self.assertTrue(database.ready)
            await database.close()
            self.assertFalse(database.ready)
            with self.assertRaises(DatabaseNotReadyError):
                async with database.connect():
                    pass
            await database.initialize()
            self.assertTrue(database.ready)

    async def test_wal_connection_invariants_and_fifty_concurrent_read_writes(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "app.sqlite3"
            database = Database(path)
            await database.initialize()

            async def write_and_read(index: int) -> None:
                async with database.transaction() as connection:
                    await connection.execute(
                        """
                        INSERT INTO tag_translations(tag, zh, source, updated_at)
                        VALUES (?, ?, 'test', 'now')
                        """,
                        (f"tag-{index}", f"标签-{index}"),
                    )
                async with database.connect() as connection:
                    cursor = await connection.execute(
                        "SELECT zh FROM tag_translations WHERE tag = ?",
                        (f"tag-{index}",),
                    )
                    row = await cursor.fetchone()
                    await cursor.close()
                assert row is not None
                self.assertEqual(row[0], f"标签-{index}")

            await asyncio.gather(*(write_and_read(index) for index in range(50)))
            async with database.connect() as connection:
                journal = await (await connection.execute("PRAGMA journal_mode")).fetchone()
                synchronous = await (await connection.execute("PRAGMA synchronous")).fetchone()
                foreign_keys = await (await connection.execute("PRAGMA foreign_keys")).fetchone()
                timeout = await (await connection.execute("PRAGMA busy_timeout")).fetchone()
                count = await (
                    await connection.execute("SELECT COUNT(*) FROM tag_translations")
                ).fetchone()
            assert journal is not None
            assert synchronous is not None
            assert foreign_keys is not None
            assert timeout is not None
            assert count is not None
            self.assertEqual(str(journal[0]).lower(), "wal")
            self.assertEqual(int(synchronous[0]), 2)
            self.assertEqual(int(foreign_keys[0]), 1)
            self.assertEqual(int(timeout[0]), 10_000)
            self.assertEqual(int(count[0]), 50)

            await database.checkpoint()
            wal_path = path.with_name(path.name + "-wal")
            self.assertTrue(not wal_path.exists() or wal_path.stat().st_size == 0)

    async def test_quick_check_wraps_an_unreadable_database(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "app.sqlite3"
            path.write_bytes(b"this is not sqlite")
            with self.assertRaises(DatabaseIntegrityError):
                await Database(path).initialize()

    async def test_logically_damaged_current_schema_stops_readiness(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "app.sqlite3"
            await Database(path).initialize()
            with closing(sqlite3.connect(path)) as connection:
                connection.execute("DROP INDEX idx_generation_jobs_fifo")
                connection.commit()
            with self.assertRaisesRegex(DatabaseIntegrityError, "index"):
                await Database(path).initialize()

    async def test_invalid_json_in_current_schema_stops_readiness(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "app.sqlite3"
            await Database(path).initialize()
            with closing(sqlite3.connect(path)) as connection:
                connection.execute("PRAGMA ignore_check_constraints = ON")
                connection.execute(
                    """
                    INSERT INTO generation_jobs(
                        id, request_hash, request_json, status, created_at, updated_at
                    ) VALUES ('bad-json', 'hash', '{', 'queued', 'now', 'now')
                    """
                )
                connection.commit()
            with self.assertRaisesRegex(DatabaseIntegrityError, "JSON"):
                await Database(path).initialize()


if __name__ == "__main__":
    unittest.main()
