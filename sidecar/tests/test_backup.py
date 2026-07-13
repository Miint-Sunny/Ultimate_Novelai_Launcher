from __future__ import annotations

import asyncio
import hashlib
import json
import os
import sqlite3
import stat
import tempfile
import threading
import unittest
import zipfile
from collections import namedtuple
from pathlib import Path
from typing import Any
from unittest.mock import patch

from backend_core.errors import ConflictError, InvalidArgumentError
from sidecar.composition import build_runtime
from sidecar.config import Settings
from sidecar.local_settings import read_local_settings, write_local_settings
from sidecar.persistence import Database
from sidecar.services import backup as backup_module
from sidecar.services.assets import AssetService
from sidecar.services.backup import (
    MANIFEST_NAME,
    RESTORE_INTENT_NAME,
    SETTINGS_NAME,
    BackupNotFoundError,
    BackupService,
    BackupStorageError,
    BackupValidationError,
    RestoreFailedError,
    RestoreRecoveryError,
    UnsupportedBackupVersionError,
)
from sidecar.services.jobs import JobService


class _SimulatedProcessCrash(BaseException):
    pass


class BackupServiceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.database = Database(self.root / "app.sqlite3")
        self.jobs = JobService(self.database)
        await self.jobs.initialize()
        self.assets = AssetService(self.database, self.root / "assets", reserve_bytes=0)
        await self.assets.initialize()
        self.backups = BackupService(
            self.database,
            self.assets.root,
            asset_service=self.assets,
        )

    async def asyncTearDown(self) -> None:
        self.temporary.cleanup()

    async def test_versioned_backup_and_restore_roundtrip(self) -> None:
        write_local_settings(
            self.root,
            {"llm_provider": "anthropic", "llm_model": "claude-test"},
        )
        original_job = (await self.jobs.create_job({"prompt": "original"})).job
        await self.assets.store_bytes("original", "original.bin", b"original")
        backup = await self.backups.create_backup()
        self.assertEqual(backup.manifest.version, 1)
        self.assertEqual(
            backup.manifest.schema_version,
            self.database.migrations.latest_version,
        )
        self.assertEqual(await self.backups.validate_backup(backup.archive_path), backup.manifest)

        await self.jobs.create_job({"prompt": "later"})
        await self.assets.store_bytes("later", "later.bin", b"later")
        write_local_settings(
            self.root,
            {"llm_provider": "openai", "llm_model": "gpt-later"},
        )
        restored = await self.backups.restore_backup(backup.archive_path)
        jobs = await self.jobs.list_jobs()
        assets = await self.assets.list_assets()
        self.assertEqual([job.id for job in jobs], [original_job.id])
        self.assertEqual([asset.id for asset in assets], ["original"])
        self.assertFalse((self.assets.root / "later.bin").exists())
        self.assertTrue(restored.safety_backup_path.is_file())
        self.assertEqual(
            read_local_settings(self.root),
            {"llm_provider": "anthropic", "llm_model": "claude-test"},
        )

    async def test_backup_settings_are_sanitized_and_never_include_secrets(self) -> None:
        (self.root / SETTINGS_NAME).write_text(
            json.dumps(
                {
                    "llm_provider": "openai",
                    "llm_model": "safe-model",
                    "llm_api_key": "must-not-leak",
                    "nai_token": "must-not-leak-either",
                    "unknown": "discard-me",
                }
            ),
            encoding="utf-8",
        )

        backup = await self.backups.create_backup(include_assets=False)

        with zipfile.ZipFile(backup.archive_path) as archive:
            archived_settings = json.loads(archive.read(SETTINGS_NAME))
        self.assertEqual(
            archived_settings,
            {"llm_provider": "openai", "llm_model": "safe-model"},
        )
        self.assertNotIn("must-not-leak", backup.archive_path.read_bytes().decode("latin-1"))

    async def test_backup_holds_asset_snapshot_guard_until_archive_is_complete(self) -> None:
        await self.assets.store_bytes("first", "first.bin", b"first")
        entered_archive = threading.Event()
        release_archive = threading.Event()
        real_write = backup_module._write_backup_zip

        def paused_write(*args: Any, **kwargs: Any) -> None:
            entered_archive.set()
            if not release_archive.wait(timeout=2):
                raise TimeoutError("test did not release backup archive writer")
            real_write(*args, **kwargs)

        with patch(
            "sidecar.services.backup._write_backup_zip",
            side_effect=paused_write,
        ):
            backup_task = asyncio.create_task(self.backups.create_backup())
            self.assertTrue(await asyncio.to_thread(entered_archive.wait, 2))
            concurrent_write = asyncio.create_task(
                self.assets.store_bytes("later", "later.bin", b"later")
            )
            await asyncio.sleep(0.02)
            self.assertFalse(concurrent_write.done())
            release_archive.set()
            backup = await backup_task
            await concurrent_write

        with zipfile.ZipFile(backup.archive_path) as archive:
            names = set(archive.namelist())
            archived_database = self.root / "archived.sqlite3"
            archived_database.write_bytes(archive.read("database.sqlite3"))
        self.assertIn("assets/first.bin", names)
        self.assertNotIn("assets/later.bin", names)
        with sqlite3.connect(archived_database) as connection:
            asset_ids = {
                str(row[0]) for row in connection.execute("SELECT id FROM assets ORDER BY id")
            }
        self.assertEqual(asset_ids, {"first"})

    async def test_legacy_v1_backup_without_settings_leaves_current_settings(self) -> None:
        write_local_settings(self.root, {"llm_provider": "openai", "llm_model": "original"})
        backup = await self.backups.create_backup(include_assets=False)
        legacy = self.root / "legacy-v1.zip"
        _drop_zip_entry(backup.archive_path, legacy, SETTINGS_NAME)
        self.assertFalse(
            any(
                entry.path == SETTINGS_NAME
                for entry in (await self.backups.validate_backup(legacy)).files
            )
        )

        write_local_settings(self.root, {"llm_provider": "gemini", "llm_model": "current"})
        await self.backups.restore_backup(legacy)

        self.assertEqual(
            read_local_settings(self.root),
            {"llm_provider": "gemini", "llm_model": "current"},
        )

    async def test_backup_reference_cannot_escape_backup_directory(self) -> None:
        for reference in ("../outside.zip", "/tmp/outside.zip", "..%2foutside.zip"):
            with self.assertRaisesRegex(Exception, "backup reference"):
                await self.backups.resolve_backup(reference)

    async def test_database_only_restore_leaves_asset_files_in_place(self) -> None:
        original = (await self.jobs.create_job({"prompt": "original"})).job
        backup = await self.backups.create_backup(include_assets=False)
        await self.jobs.create_job({"prompt": "later"})
        untracked = self.assets.root / "keep.bin"
        untracked.write_bytes(b"keep")
        await self.backups.restore_backup(backup.archive_path)
        self.assertEqual([job.id for job in await self.jobs.list_jobs()], [original.id])
        self.assertEqual(untracked.read_bytes(), b"keep")

    async def test_path_traversal_is_rejected_before_extraction(self) -> None:
        archive = self.root / "traversal.zip"
        with zipfile.ZipFile(archive, "w") as output:
            output.writestr("../outside.txt", b"owned")
        with self.assertRaises(BackupValidationError):
            await self.backups.stage_restore(archive)
        self.assertFalse((self.root / "outside.txt").exists())

    async def test_symbolic_link_member_is_rejected(self) -> None:
        archive = self.root / "symlink.zip"
        link = zipfile.ZipInfo("assets/link")
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        with zipfile.ZipFile(archive, "w") as output:
            output.writestr(link, "../../outside")
        with self.assertRaises(BackupValidationError):
            await self.backups.stage_restore(archive)

    async def test_member_checksum_tampering_is_rejected(self) -> None:
        await self.assets.store_bytes("asset", "asset.bin", b"good")
        valid = await self.backups.create_backup()
        tampered = self.root / "tampered.zip"
        _rewrite_zip(valid.archive_path, tampered, {"assets/asset.bin": b"evil"})
        with self.assertRaises(BackupValidationError):
            await self.backups.validate_backup(tampered)

    async def test_backup_with_logically_damaged_schema_is_rejected(self) -> None:
        valid = await self.backups.create_backup(include_assets=False)
        damaged_database = self.root / "damaged.sqlite3"
        with zipfile.ZipFile(valid.archive_path) as archive:
            damaged_database.write_bytes(archive.read("database.sqlite3"))
        with sqlite3.connect(damaged_database) as connection:
            connection.execute("PRAGMA journal_mode = DELETE")
            connection.execute("DROP INDEX idx_generation_jobs_fifo")
            connection.commit()
        damaged = self.root / "damaged-schema.zip"
        _rewrite_zip(
            valid.archive_path,
            damaged,
            {"database.sqlite3": damaged_database.read_bytes()},
            update_manifest=True,
        )
        with self.assertRaisesRegex(BackupValidationError, "schema"):
            await self.backups.validate_backup(damaged)

    async def test_future_backup_format_is_rejected(self) -> None:
        valid = await self.backups.create_backup(include_assets=False)
        with zipfile.ZipFile(valid.archive_path) as source:
            manifest = json.loads(source.read(MANIFEST_NAME))
        manifest["version"] = 99
        future = self.root / "future.zip"
        _rewrite_zip(
            valid.archive_path,
            future,
            {MANIFEST_NAME: json.dumps(manifest).encode("utf-8")},
        )
        with self.assertRaises(UnsupportedBackupVersionError):
            await self.backups.validate_backup(future)

    async def test_failed_install_rolls_back_database_and_assets(self) -> None:
        write_local_settings(self.root, {"llm_provider": "openai", "llm_model": "original"})
        original = (await self.jobs.create_job({"prompt": "original"})).job
        await self.assets.store_bytes("original", "original.bin", b"original")
        backup = await self.backups.create_backup()
        later = (await self.jobs.create_job({"prompt": "later"})).job
        await self.assets.store_bytes("later", "later.bin", b"later")
        write_local_settings(self.root, {"llm_provider": "gemini", "llm_model": "later"})

        real_initialize = self.database.initialize
        calls = 0

        async def fail_installed_database_once() -> list[int]:
            nonlocal calls
            calls += 1
            if calls == 2:
                raise RuntimeError("simulated post-swap failure")
            return await real_initialize()

        with patch.object(self.database, "initialize", side_effect=fail_installed_database_once):
            with self.assertRaises(RestoreFailedError):
                await self.backups.restore_backup(backup.archive_path)

        self.assertEqual(
            {job.id for job in await self.jobs.list_jobs()},
            {original.id, later.id},
        )
        self.assertEqual(
            {asset.id for asset in await self.assets.list_assets()},
            {"original", "later"},
        )
        self.assertEqual((self.assets.root / "later.bin").read_bytes(), b"later")
        self.assertEqual(
            read_local_settings(self.root),
            {"llm_provider": "gemini", "llm_model": "later"},
        )

    async def test_prepared_restore_recovers_after_every_canonical_rename(self) -> None:
        stages = (
            "database_to_rollback",
            "database_to_canonical",
            "assets_to_rollback",
            "assets_to_canonical",
            "settings_to_rollback",
            "settings_to_canonical",
        )
        for stage in stages:
            with self.subTest(stage=stage), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                database = Database(root / "app.sqlite3")
                jobs = JobService(database)
                await jobs.initialize()
                assets = AssetService(database, root / "assets", reserve_bytes=0)
                await assets.initialize()
                backups = BackupService(database, assets.root, disk_reserve_bytes=0)

                first = (await jobs.create_job({"prompt": "backup"})).job
                await assets.store_bytes("backup", "backup.bin", b"backup")
                write_local_settings(
                    root,
                    {"llm_provider": "openai", "llm_model": "backup"},
                )
                backup = await backups.create_backup()

                current = (await jobs.create_job({"prompt": "current"})).job
                await assets.store_bytes("current", "current.bin", b"current")
                write_local_settings(
                    root,
                    {"llm_provider": "gemini", "llm_model": "current"},
                )

                real_replace = backup_module._durable_replace
                crashed = False

                def crash_after_selected_rename(
                    source: str | Path,
                    target: str | Path,
                    replace: object = real_replace,
                    selected_stage: str = stage,
                    database_path: Path = database.path,
                    assets_path: Path = assets.root,
                    local_settings_path: Path = root / SETTINGS_NAME,
                ) -> None:
                    nonlocal crashed
                    assert callable(replace)
                    replace(source, target)
                    if _is_selected_restore_rename(
                        selected_stage,
                        Path(source),
                        Path(target),
                        database_path,
                        assets_path,
                        local_settings_path,
                    ):
                        crashed = True
                        raise _SimulatedProcessCrash

                with patch(
                    "sidecar.services.backup._durable_replace",
                    side_effect=crash_after_selected_rename,
                ):
                    with self.assertRaises(_SimulatedProcessCrash):
                        await backups.restore_backup(backup.archive_path)
                self.assertTrue(crashed)
                self.assertTrue((root / RESTORE_INTENT_NAME).is_file())
                if stage == "database_to_rollback":
                    self.assertFalse(database.path.exists())
                if stage == "database_to_canonical":
                    database.path.with_name(f"{database.path.name}-wal").write_bytes(
                        b"uncommitted candidate WAL"
                    )

                restarted_database = Database(database.path)
                restarted_backups = BackupService(
                    restarted_database,
                    assets.root,
                    disk_reserve_bytes=0,
                )
                # This is deliberately before any Database.initialize call.
                await restarted_backups.recover_interrupted_restore()
                restarted_jobs = JobService(restarted_database)
                await restarted_jobs.initialize()
                restarted_assets = AssetService(
                    restarted_database,
                    assets.root,
                    reserve_bytes=0,
                )
                await restarted_assets.initialize()

                self.assertEqual(
                    {job.id for job in await restarted_jobs.list_jobs()},
                    {first.id, current.id},
                )
                self.assertEqual(
                    {asset.id for asset in await restarted_assets.list_assets()},
                    {"backup", "current"},
                )
                self.assertEqual((assets.root / "current.bin").read_bytes(), b"current")
                self.assertEqual(
                    read_local_settings(root),
                    {"llm_provider": "gemini", "llm_model": "current"},
                )
                self.assertFalse((root / RESTORE_INTENT_NAME).exists())
                self.assertEqual(_restore_artifacts(root), [])
                self.assertFalse(database.path.with_name(f"{database.path.name}-wal").exists())

    async def test_committed_restore_survives_crash_before_cleanup(self) -> None:
        write_local_settings(self.root, {"llm_provider": "openai", "llm_model": "backup"})
        first = (await self.jobs.create_job({"prompt": "backup"})).job
        await self.assets.store_bytes("backup", "backup.bin", b"backup")
        backup = await self.backups.create_backup()

        await self.jobs.create_job({"prompt": "current"})
        await self.assets.store_bytes("current", "current.bin", b"current")
        write_local_settings(self.root, {"llm_provider": "gemini", "llm_model": "current"})

        with patch.object(
            self.backups,
            "_finish_committed_restore",
            side_effect=_SimulatedProcessCrash,
        ):
            with self.assertRaises(_SimulatedProcessCrash):
                await self.backups.restore_backup(backup.archive_path)

        intent = json.loads((self.root / RESTORE_INTENT_NAME).read_text(encoding="utf-8"))
        self.assertEqual(intent["phase"], "committed")
        restarted_database = Database(self.database.path)
        restarted_backups = BackupService(
            restarted_database,
            self.assets.root,
            disk_reserve_bytes=0,
        )
        await restarted_backups.recover_interrupted_restore()
        restarted_jobs = JobService(restarted_database)
        await restarted_jobs.initialize()
        restarted_assets = AssetService(
            restarted_database,
            self.assets.root,
            reserve_bytes=0,
        )
        await restarted_assets.initialize()

        self.assertEqual([job.id for job in await restarted_jobs.list_jobs()], [first.id])
        self.assertEqual(
            [asset.id for asset in await restarted_assets.list_assets()],
            ["backup"],
        )
        self.assertEqual(
            read_local_settings(self.root),
            {"llm_provider": "openai", "llm_model": "backup"},
        )
        self.assertFalse((self.root / RESTORE_INTENT_NAME).exists())
        self.assertEqual(_restore_artifacts(self.root), [])

    async def test_concurrent_initialize_cannot_recover_an_active_restore(self) -> None:
        await self.jobs.create_job({"prompt": "backup"})
        backup = await self.backups.create_backup()
        await self.jobs.create_job({"prompt": "current"})

        entered_install = threading.Event()
        release_install = threading.Event()
        real_install = self.backups._install_restore_candidates

        def paused_install(paths: Any) -> None:
            entered_install.set()
            if not release_install.wait(timeout=2):
                raise TimeoutError("test did not release restore installation")
            real_install(paths)

        with patch.object(
            self.backups,
            "_install_restore_candidates",
            side_effect=paused_install,
        ):
            restore = asyncio.create_task(self.backups.restore_backup(backup.archive_path))
            self.assertTrue(await asyncio.to_thread(entered_install.wait, 2))
            concurrent_initialize = asyncio.create_task(self.backups.initialize())
            await asyncio.sleep(0.02)
            self.assertFalse(concurrent_initialize.done())
            release_install.set()
            await restore
            await concurrent_initialize

        self.assertFalse((self.root / RESTORE_INTENT_NAME).exists())

    async def test_ambiguous_restore_state_fails_before_database_creation(self) -> None:
        await self.database.close()
        token = "a" * 32
        rollback = self.database.path.with_name(f".{self.database.path.name}.rollback-{token}")
        os.replace(self.database.path, rollback)
        restarted_database = Database(self.database.path)
        restarted = BackupService(restarted_database, self.assets.root, disk_reserve_bytes=0)

        with self.assertRaisesRegex(RestoreRecoveryError, "without a durable intent"):
            await restarted.initialize()
        self.assertFalse(self.database.path.exists())
        self.assertTrue(rollback.exists())
        self.assertFalse(restarted_database.ready)

    async def test_malformed_restore_intent_fails_closed_before_database_creation(self) -> None:
        await self.database.close()
        self.database.path.unlink()
        (self.root / RESTORE_INTENT_NAME).write_text(
            json.dumps(
                {
                    "format": "ultimate-novelai-launcher-restore-intent",
                    "version": 1,
                    "token": "b" * 32,
                    "phase": "prepared",
                    "includes_assets": True,
                    "includes_settings": True,
                    "originals": {
                        "database": True,
                        "assets": True,
                        "settings": True,
                    },
                    "database_path": "/tmp/attacker-controlled.sqlite3",
                }
            ),
            encoding="utf-8",
        )
        restarted_database = Database(self.database.path)
        restarted = BackupService(restarted_database, self.assets.root, disk_reserve_bytes=0)

        with self.assertRaisesRegex(RestoreRecoveryError, "invalid shape"):
            await restarted.initialize()
        self.assertFalse(self.database.path.exists())
        self.assertFalse(restarted_database.ready)

    def test_composition_registers_restore_recovery_before_database(self) -> None:
        settings = Settings(
            host="127.0.0.1",
            port=0,
            data_dir=self.root / "composition",
            nai_token="",
            nai_base_url="https://image.novelai.net",
            llm_base_url="",
            llm_api_key="",
            llm_model="",
            mock_generation=True,
            sidecar_auth_token="test-session-token",
        )
        resources = build_runtime(
            settings,
            reload_from_environment=False,
        ).runtime.resource_names
        self.assertLess(resources.index("restore_recovery"), resources.index("database"))

    async def test_backup_limits_destinations_and_missing_inputs(self) -> None:
        with self.assertRaises(ValueError):
            BackupService(self.database, self.assets.root, max_entries=1)
        with self.assertRaises(ValueError):
            BackupService(self.database, self.assets.root, max_uncompressed_bytes=0)
        with self.assertRaises(ValueError):
            BackupService(self.database, self.assets.root, max_compression_ratio=0)
        with self.assertRaises(ValueError):
            BackupService(self.database, self.assets.root, disk_reserve_bytes=-1)
        with self.assertRaises(ValueError):
            BackupService(self.database, self.assets.root, quota_bytes=0)

        missing = self.root / "missing.zip"
        with self.assertRaises(BackupValidationError):
            await self.backups.stage_restore(missing)
        with self.assertRaises(BackupNotFoundError):
            await self.backups.resolve_backup("missing.zip")
        with self.assertRaises(BackupNotFoundError):
            await self.backups.resolve_backup("00000000-0000-0000-0000-000000000001")
        with self.assertRaises(InvalidArgumentError):
            await self.backups.resolve_backup(1)  # type: ignore[arg-type]

        existing = self.root / "existing.zip"
        existing.write_bytes(b"already here")
        with self.assertRaises(ConflictError):
            await self.backups.create_backup(existing)
        with self.assertRaises(InvalidArgumentError):
            await self.backups.create_backup(self.assets.root / "inside.zip")

    async def test_managed_quota_counts_existing_backups_and_manual_delete_recovers(
        self,
    ) -> None:
        managed = self.root / "managed"
        first_service = BackupService(
            self.database,
            managed / "assets",
            managed_root=managed,
            backup_dir=managed / "backups",
            staging_root=managed / "staging",
            disk_reserve_bytes=0,
        )
        first = await first_service.create_backup(include_assets=False)
        first_size = first.archive_path.stat().st_size
        headroom = max(64, first_size // 2)
        quota = first_size + headroom
        managed_assets = AssetService(
            self.database,
            managed / "assets",
            managed_root=managed,
            quota_bytes=quota,
            reserve_bytes=0,
        )
        await managed_assets.initialize()
        limited = BackupService(
            self.database,
            managed_assets.root,
            asset_service=managed_assets,
            managed_root=managed,
            backup_dir=managed / "backups",
            staging_root=managed / "staging",
            quota_bytes=quota,
            disk_reserve_bytes=0,
        )

        with self.assertRaises(BackupStorageError) as backup_full:
            await limited.create_backup(include_assets=False)
        self.assertEqual(backup_full.exception.details["quota_bytes"], quota)
        with self.assertRaisesRegex(Exception, "quota"):
            await managed_assets.store_bytes("blocked", "blocked.bin", b"x" * (headroom + 1))

        deleted = await limited.delete_backup(first.archive_path.name)
        self.assertEqual(deleted.filename, first.archive_path.name)
        self.assertEqual(deleted.reclaimed_bytes, first_size)
        self.assertFalse(first.archive_path.exists())

        await managed_assets.store_bytes("allowed", "allowed.bin", b"x")
        replacement = await limited.create_backup(include_assets=False)
        self.assertTrue(replacement.archive_path.is_file())

    async def test_backup_and_staging_roots_reject_symlinks_and_replacement(self) -> None:
        outside = self.root / "outside-backup-target"
        outside.mkdir()
        sentinel = outside / "sentinel.txt"
        sentinel.write_text("keep", encoding="utf-8")
        linked_backup = self.root / "linked-backups"
        linked_staging = self.root / "linked-staging"
        try:
            linked_backup.symlink_to(outside, target_is_directory=True)
            linked_staging.symlink_to(outside, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("symbolic links are unavailable")

        with self.assertRaisesRegex(InvalidArgumentError, "backup directory"):
            await BackupService(
                self.database,
                self.assets.root,
                backup_dir=linked_backup,
                staging_root=self.root / "safe-staging",
            ).initialize()
        with self.assertRaisesRegex(InvalidArgumentError, "staging"):
            await BackupService(
                self.database,
                self.assets.root,
                backup_dir=self.root / "safe-backups",
                staging_root=linked_staging,
            ).initialize()
        self.assertEqual(sentinel.read_text(encoding="utf-8"), "keep")

        valid = await self.backups.create_backup(include_assets=False)
        original_backup_dir = self.backups.backup_dir.with_name("backups-original")
        self.backups.backup_dir.rename(original_backup_dir)
        self.backups.backup_dir.symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(InvalidArgumentError, "backup directory changed"):
            await self.backups.create_backup(include_assets=False)
        self.assertEqual(sentinel.read_text(encoding="utf-8"), "keep")
        self.backups.backup_dir.unlink()
        original_backup_dir.rename(self.backups.backup_dir)

        original_staging = self.backups.staging_root.with_name("staging-original")
        self.backups.staging_root.rename(original_staging)
        self.backups.staging_root.symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(InvalidArgumentError, "staging.*changed"):
            await self.backups.validate_backup(valid.archive_path)
        self.assertEqual(sentinel.read_text(encoding="utf-8"), "keep")

    async def test_backup_filesystem_helpers_fail_closed(self) -> None:
        external_archive = self.root / "external-backup.zip"
        external = await self.backups.create_backup(
            external_archive,
            include_assets=False,
        )
        self.assertEqual(external.archive_path, external_archive)
        self.assertEqual(await self.backups.validate_backup(external_archive), external.manifest)

        legacy_staging = self.root / "legacy-staging"
        legacy_staging.mkdir()
        backup_module.RestoreStaging(
            path=legacy_staging,
            archive_path=external_archive,
            manifest=external.manifest,
        ).cleanup()
        self.assertFalse(legacy_staging.exists())

        uninitialized = BackupService(self.database, self.assets.root)
        for require_identity in (
            uninitialized._require_managed_root_identity,
            uninitialized._require_backup_dir_identity,
            uninitialized._require_staging_root_identity,
        ):
            with self.assertRaisesRegex(InvalidArgumentError, "not been initialized"):
                require_identity()
        missing_assets = BackupService(self.database, self.root / "missing-assets")
        self.assertEqual(missing_assets._asset_files(), [])

        helper_root = self.root / "helper-root"
        helper_root.mkdir()
        root_identity = backup_module._directory_identity(helper_root)
        with self.assertRaisesRegex(InvalidArgumentError, "is missing"):
            backup_module._assert_service_directory(
                self.root / "missing-helper-root",
                root_identity,
                "helper root",
            )
        regular_file = self.root / "not-a-directory"
        regular_file.write_bytes(b"file")
        with self.assertRaisesRegex(InvalidArgumentError, "not a regular directory"):
            backup_module._directory_identity(regular_file)

        outside_child = self.root / "outside-child"
        outside_child.write_bytes(b"keep")
        backup_module._remove_service_child(
            helper_root,
            root_identity,
            outside_child,
            (outside_child.stat().st_dev, outside_child.stat().st_ino),
            False,
        )
        self.assertTrue(outside_child.exists())
        missing_child = helper_root / "missing"
        backup_module._remove_service_child(
            helper_root,
            root_identity,
            missing_child,
            (0, 0),
            False,
        )
        backup_module._remove_service_child_if_present(
            helper_root,
            root_identity,
            missing_child,
            False,
        )
        wrong_identity = helper_root / "wrong-identity"
        wrong_identity.write_bytes(b"keep")
        backup_module._remove_service_child(
            helper_root,
            root_identity,
            wrong_identity,
            (0, 0),
            False,
        )
        self.assertTrue(wrong_identity.exists())

        byte_tree = self.root / "byte-tree"
        (byte_tree / "nested").mkdir(parents=True)
        (byte_tree / "nested/data.bin").write_bytes(b"123")
        try:
            (byte_tree / "linked.bin").symlink_to(byte_tree / "nested/data.bin")
        except (OSError, NotImplementedError):
            pass
        self.assertEqual(backup_module._regular_file_bytes(byte_tree), 3)
        self.assertEqual(backup_module._regular_file_bytes(self.root / "missing-tree"), 0)

        large_intent = self.root / "large-intent.json"
        large_intent.write_bytes(b"x" * 4097)
        with self.assertRaisesRegex(RestoreRecoveryError, "maximum size"):
            backup_module._read_restore_intent(large_intent)
        unreadable_intent = self.root / "unreadable-intent.json"
        unreadable_intent.write_bytes(b"\xff")
        with self.assertRaisesRegex(RestoreRecoveryError, "unreadable"):
            backup_module._read_restore_intent(unreadable_intent)
        duplicate_intent = self.root / "duplicate-intent.json"
        duplicate_intent.write_text('{"version":1,"version":1}', encoding="utf-8")
        with self.assertRaisesRegex(RestoreRecoveryError, "duplicate"):
            backup_module._read_restore_intent(duplicate_intent)
        invalid_originals = self.root / "invalid-originals.json"
        intent_payload = backup_module.RestoreIntent(
            token="a" * 32,
            phase="prepared",
            includes_assets=True,
            includes_settings=True,
            original_database_exists=True,
            original_assets_exists=True,
            original_settings_exists=True,
        ).to_dict()
        intent_payload["originals"] = {"database": True}
        invalid_originals.write_text(json.dumps(intent_payload), encoding="utf-8")
        with self.assertRaisesRegex(RestoreRecoveryError, "original-path metadata"):
            backup_module._read_restore_intent(invalid_originals)
        cleanup_paths = self.backups._restore_path_sets(
            backup_module.RestoreIntent(
                token="c" * 32,
                phase="prepared",
                includes_assets=True,
                includes_settings=True,
                original_database_exists=True,
                original_assets_exists=True,
                original_settings_exists=True,
            )
        )
        self.backups._remove_restore_candidates(cleanup_paths)

        intent_path = self.root / "remove-intent.json"
        intent_path.write_text("{}", encoding="utf-8")
        invalid_temporary = intent_path.with_name(f".{intent_path.name}.{'b' * 32}.part")
        invalid_temporary.mkdir()
        with self.assertRaisesRegex(RestoreRecoveryError, "unexpected type"):
            backup_module._remove_restore_intent(intent_path, "b" * 32)

        self.backups.restore_intent_path.mkdir()
        with self.assertRaisesRegex(RestoreRecoveryError, "not a regular file"):
            self.backups._recover_interrupted_restore_sync()
        self.backups.restore_intent_path.rmdir()
        invalid_intent_temporary = self.root / "..restore-intent.json.not-a-token.part"
        invalid_intent_temporary.write_bytes(b"keep")
        with self.assertRaisesRegex(RestoreRecoveryError, "invalid transaction token"):
            self.backups._remove_restore_intent_temporaries()
        self.assertTrue(invalid_intent_temporary.exists())
        invalid_restore_artifact = self.root / f".{self.database.path.name}.restore-not-a-token"
        invalid_restore_artifact.write_bytes(b"keep")
        with self.assertRaisesRegex(RestoreRecoveryError, "invalid transaction token"):
            self.backups._matching_restore_artifacts("restore")
        self.assertTrue(invalid_restore_artifact.exists())

        linked_kind = self.root / "linked-kind"
        try:
            linked_kind.symlink_to(regular_file)
        except (OSError, NotImplementedError):
            pass
        else:
            self.assertEqual(backup_module._path_kind(linked_kind), "symlink")
        with self.assertRaises(RestoreRecoveryError):
            backup_module._require_kind(self.root / "missing-kind", "file", "missing")
        with self.assertRaises(RestoreRecoveryError):
            backup_module._remove_owned_path(helper_root, "file", "helper")

    async def test_create_and_restore_preserve_configured_disk_reserve(self) -> None:
        DiskUsage = namedtuple("DiskUsage", "total used free")
        limited = BackupService(
            self.database,
            self.assets.root,
            disk_reserve_bytes=1024,
        )
        with patch(
            "sidecar.services.backup.shutil.disk_usage",
            return_value=DiskUsage(4096, 3072, 1024),
        ):
            with self.assertRaises(BackupStorageError):
                await limited.create_backup(include_assets=False)

        valid = await self.backups.create_backup(include_assets=False)
        with patch(
            "sidecar.services.backup.shutil.disk_usage",
            return_value=DiskUsage(4096, 3072, 1024),
        ):
            with self.assertRaises(BackupStorageError):
                await limited.stage_restore(valid.archive_path)

    async def test_list_resolve_and_staging_context_cleanup(self) -> None:
        valid = await self.backups.create_backup(include_assets=False)
        invalid = self.backups.backup_dir / "broken.zip"
        invalid.write_bytes(b"not a zip")
        listed = await self.backups.list_backups()
        self.assertEqual([item.archive_path for item in listed], [valid.archive_path])
        self.assertEqual(
            await self.backups.resolve_backup(valid.manifest.backup_id),
            valid.archive_path,
        )
        self.assertEqual(
            await self.backups.resolve_backup(valid.archive_path.name),
            valid.archive_path,
        )

        staging = await self.backups.stage_restore(valid.archive_path)
        staging_path = staging.path
        with staging as entered:
            self.assertEqual(entered.database_path, staging_path / "database.sqlite3")
            self.assertEqual(entered.assets_path, staging_path / "assets")
            self.assertEqual(entered.settings_path, staging_path / SETTINGS_NAME)
            self.assertTrue(staging_path.exists())
        self.assertFalse(staging_path.exists())

    async def test_malformed_zip_and_manifest_matrix_is_rejected(self) -> None:
        unreadable = self.root / "unreadable.zip"
        unreadable.write_bytes(b"not a zip")
        with self.assertRaises(BackupValidationError):
            await self.backups.validate_backup(unreadable)

        missing_manifest = self.root / "missing-manifest.zip"
        with zipfile.ZipFile(missing_manifest, "w") as archive:
            archive.writestr("database.sqlite3", b"not sqlite")
        with self.assertRaises(BackupValidationError):
            await self.backups.validate_backup(missing_manifest)

        invalid_json = self.root / "invalid-json.zip"
        with zipfile.ZipFile(invalid_json, "w") as archive:
            archive.writestr(MANIFEST_NAME, b"{")
        with self.assertRaises(BackupValidationError):
            await self.backups.validate_backup(invalid_json)

        valid = await self.backups.create_backup(include_assets=False)
        with zipfile.ZipFile(valid.archive_path) as archive:
            manifest = json.loads(archive.read(MANIFEST_NAME))
        mutations = (
            {"format": "unknown"},
            {"version": "one"},
            {"backup_id": "not-a-uuid"},
            {"created_at": "not-a-date"},
            {"created_at": "2026-01-01T00:00:00"},
            {"includes_assets": "yes"},
            {"files": "not-a-list"},
            {"files": ["not-an-object"]},
        )
        for index, mutation in enumerate(mutations):
            changed = dict(manifest)
            changed.update(mutation)
            target = self.root / f"bad-manifest-{index}.zip"
            _rewrite_zip(
                valid.archive_path,
                target,
                {MANIFEST_NAME: json.dumps(changed).encode("utf-8")},
            )
            with self.subTest(mutation=mutation), self.assertRaises(BackupValidationError):
                await self.backups.validate_backup(target)

    async def test_entry_count_and_duplicate_archive_paths_are_rejected(self) -> None:
        crowded = self.root / "crowded.zip"
        with zipfile.ZipFile(crowded, "w") as archive:
            archive.writestr(MANIFEST_NAME, b"{}")
            archive.writestr("database.sqlite3", b"x")
            archive.writestr("extra", b"x")
        limited = BackupService(
            self.database,
            self.assets.root,
            max_entries=2,
        )
        with self.assertRaises(BackupValidationError):
            await limited.validate_backup(crowded)

        duplicate = self.root / "duplicate.zip"
        with zipfile.ZipFile(duplicate, "w") as archive:
            archive.writestr(MANIFEST_NAME, b"{}")
            archive.writestr("database.sqlite3", b"one")
            with self.assertWarns(UserWarning):
                archive.writestr("database.sqlite3", b"two")
        with self.assertRaises(BackupValidationError):
            await self.backups.validate_backup(duplicate)


def _rewrite_zip(
    source_path: Path,
    destination: Path,
    replacements: dict[str, bytes],
    *,
    update_manifest: bool = False,
) -> None:
    if update_manifest:
        with zipfile.ZipFile(source_path, "r") as source:
            manifest = json.loads(source.read(MANIFEST_NAME))
        for entry in manifest["files"]:
            payload = replacements.get(entry["path"])
            if payload is not None:
                entry["byte_size"] = len(payload)
                entry["sha256"] = hashlib.sha256(payload).hexdigest()
        replacements = {
            **replacements,
            MANIFEST_NAME: json.dumps(manifest).encode("utf-8"),
        }
    with (
        zipfile.ZipFile(source_path, "r") as source,
        zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED) as output,
    ):
        for info in source.infolist():
            payload = replacements.get(info.filename, source.read(info.filename))
            output.writestr(info.filename, payload)


def _drop_zip_entry(source_path: Path, destination: Path, entry_name: str) -> None:
    with zipfile.ZipFile(source_path, "r") as source:
        manifest = json.loads(source.read(MANIFEST_NAME))
        manifest["files"] = [entry for entry in manifest["files"] if entry["path"] != entry_name]
        with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED) as output:
            for info in source.infolist():
                if info.filename in {entry_name, MANIFEST_NAME}:
                    continue
                output.writestr(info.filename, source.read(info.filename))
            output.writestr(MANIFEST_NAME, json.dumps(manifest).encode("utf-8"))


def _is_selected_restore_rename(
    stage: str,
    source: Path,
    target: Path,
    database_path: Path,
    assets_path: Path,
    local_settings_path: Path,
) -> bool:
    canonical = {
        "database": database_path,
        "assets": assets_path,
        "settings": local_settings_path,
    }
    resource, destination = stage.split("_to_", maxsplit=1)
    path = canonical[resource]
    if destination == "rollback":
        return source == path and target.name.startswith(f".{path.name}.rollback-")
    return target == path and source.name.startswith(f".{path.name}.restore-")


def _restore_artifacts(root: Path) -> list[str]:
    return sorted(
        path.name
        for path in root.iterdir()
        if (".restore-" in path.name and path.name != ".restore-staging")
        or ".rollback-" in path.name
        or path.name == RESTORE_INTENT_NAME
    )


if __name__ == "__main__":
    unittest.main()
