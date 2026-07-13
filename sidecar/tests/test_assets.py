from __future__ import annotations

import tempfile
import unittest
from collections import namedtuple
from contextlib import asynccontextmanager
from pathlib import Path
from unittest.mock import patch

from backend_core.errors import InvalidArgumentError
from sidecar.persistence import Database
from sidecar.services.assets import (
    AssetConflictError,
    AssetNotFoundError,
    AssetService,
    InsufficientStorageError,
    StorageStatus,
)


class AssetServiceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.database = Database(self.root / "app.sqlite3")
        self.service = AssetService(
            self.database, self.root / "assets", quota_bytes=20, reserve_bytes=0
        )
        await self.service.initialize()

    async def asyncTearDown(self) -> None:
        self.temporary.cleanup()

    async def test_quota_failure_never_deletes_existing_assets(self) -> None:
        first = await self.service.store_bytes("one", "images/one.png", b"12345")
        with self.assertRaises(InsufficientStorageError) as raised:
            await self.service.store_bytes("two", "images/two.png", b"x" * 16)
        self.assertEqual(raised.exception.code_value, "insufficient_storage")
        self.assertTrue((self.service.root / first.relative_path).is_file())
        self.assertIsNotNone(await self.service.get_asset("one"))
        self.assertFalse((self.service.root / "images/two.png").exists())

    async def test_one_gib_reserve_is_enforced_without_cleanup(self) -> None:
        service = AssetService(
            self.database,
            self.service.root,
            quota_bytes=10 * 1024**3,
            reserve_bytes=1024**3,
        )
        await service.initialize()
        DiskUsage = namedtuple("DiskUsage", "total used free")
        with patch(
            "sidecar.services.assets.shutil.disk_usage",
            return_value=DiskUsage(10 * 1024**3, 9 * 1024**3, 1024**3),
        ):
            with self.assertRaises(InsufficientStorageError):
                await service.ensure_capacity(1)

    async def test_untracked_files_still_count_toward_the_ten_gib_quota(self) -> None:
        orphan = self.service.root / "untracked.bin"
        orphan.write_bytes(b"x" * 18)
        with self.assertRaises(InsufficientStorageError):
            await self.service.store_bytes("new", "new.bin", b"123")
        self.assertTrue(orphan.exists())

    async def test_complete_managed_data_directory_counts_toward_asset_quota(self) -> None:
        managed = self.root / "managed"
        managed.mkdir()
        (managed / "backups").mkdir()
        (managed / "migration-backups").mkdir()
        (managed / "backups/existing.zip").write_bytes(b"b" * 4)
        (managed / "migration-backups/pre.sqlite3").write_bytes(b"m" * 4)
        (managed / "sidecar.sqlite3").write_bytes(b"d" * 4)
        (managed / "settings.json").write_bytes(b"s" * 4)
        isolated = AssetService(
            self.database,
            managed / "assets",
            managed_root=managed,
            quota_bytes=20,
            reserve_bytes=0,
        )
        await isolated.initialize()

        with self.assertRaises(InsufficientStorageError) as raised:
            await isolated.store_bytes("new", "new.bin", b"12345")

        catalog_bytes = raised.exception.details["catalog_bytes"]
        self.assertIsInstance(catalog_bytes, int)
        assert isinstance(catalog_bytes, int)
        self.assertGreaterEqual(catalog_bytes, 16)
        self.assertFalse((managed / "assets/new.bin").exists())

    async def test_reconciliation_marks_missing_recovers_and_catalogs_orphans(self) -> None:
        record = await self.service.store_bytes("known", "known.bin", b"known")
        known_path = self.service.root / record.relative_path
        known_path.unlink()
        loose_path = self.service.root / "nested/loose.bin"
        loose_path.parent.mkdir(parents=True)
        loose_path.write_bytes(b"loose")

        first = await self.service.reconcile_orphans()
        self.assertEqual(first.missing_asset_ids, ("known",))
        self.assertEqual(len(first.orphan_asset_ids), 1)
        self.assertTrue(loose_path.exists())
        self.assertEqual((await self.service.require_asset("known")).status, "missing")

        known_path.write_bytes(b"known-again")
        second = await self.service.reconcile_orphans()
        recovered = await self.service.require_asset("known")
        self.assertEqual(second.recovered_asset_ids, ("known",))
        self.assertEqual(recovered.status, "available")
        self.assertEqual(recovered.byte_size, len(b"known-again"))

    async def test_reconciliation_removes_only_service_temporary_files(self) -> None:
        temporary = self.service.root / (".image.png." + "a" * 32 + ".part")
        user_owned = self.service.root / "draft.part"
        temporary.write_bytes(b"partial")
        user_owned.write_bytes(b"keep")

        await self.service.reconcile_orphans()

        self.assertFalse(temporary.exists())
        self.assertTrue(user_owned.exists())

    async def test_remove_from_catalog_does_not_remove_file(self) -> None:
        record = await self.service.store_bytes("known", "known.bin", b"known")
        self.assertTrue(await self.service.remove_from_catalog(record.id))
        self.assertTrue((self.service.root / record.relative_path).exists())
        report = await self.service.reconcile_orphans()
        self.assertEqual(len(report.orphan_asset_ids), 1)

    async def test_asset_paths_cannot_escape_the_root(self) -> None:
        with self.assertRaises(InvalidArgumentError):
            await self.service.store_bytes("bad", "../outside.bin", b"bad")
        self.assertFalse((self.root / "outside.bin").exists())

    async def test_asset_root_symlink_and_post_start_replacement_are_rejected(self) -> None:
        outside = self.root / "outside-assets"
        outside.mkdir()
        linked_root = self.root / "linked-assets"
        try:
            linked_root.symlink_to(outside, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("symbolic links are unavailable")
        linked = AssetService(self.database, linked_root, quota_bytes=20, reserve_bytes=0)
        with self.assertRaisesRegex(InvalidArgumentError, "regular directory"):
            await linked.initialize()

        original = self.service.root.with_name("assets-original")
        self.service.root.rename(original)
        self.service.root.symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(InvalidArgumentError, "root changed"):
            await self.service.store_bytes("escape", "generated/escape.bin", b"escape")
        self.assertFalse((outside / "generated/escape.bin").exists())

    async def test_register_existing_file_and_catalog_queries(self) -> None:
        path = self.service.root / "nested/existing.png"
        path.parent.mkdir(parents=True)
        path.write_bytes(b"existing")
        record = await self.service.register_asset(
            "registered",
            path,
            kind="reference",
            metadata={"safe": True},
        )
        self.assertEqual(record.relative_path, "nested/existing.png")
        self.assertEqual(record.media_type, "image/png")
        self.assertEqual(record.to_dict()["metadata"], {"safe": True})
        self.assertEqual(self.service.asset_path(record), path.resolve())
        self.assertEqual(
            [asset.id for asset in await self.service.list_assets(statuses=["available"])],
            ["registered"],
        )
        with self.assertRaises(AssetNotFoundError):
            await self.service.require_asset("missing")

    async def test_register_enforces_status_quota_and_root_containment(self) -> None:
        path = self.service.root / "large.bin"
        path.write_bytes(b"x" * 21)
        with self.assertRaises(InsufficientStorageError):
            await self.service.register_asset("large", path)
        with self.assertRaises(InvalidArgumentError):
            await self.service.register_asset("bad-status", path, status="deleted")
        outside = self.root / "outside.bin"
        outside.write_bytes(b"outside")
        with self.assertRaises(InvalidArgumentError):
            await self.service.register_asset("outside", outside)
        with self.assertRaises(InvalidArgumentError):
            await self.service.register_asset("directory", self.service.root)

    async def test_conflicts_replace_delete_and_page_validation(self) -> None:
        first = await self.service.store_bytes("first", "same.bin", b"one")
        with self.assertRaises(AssetConflictError):
            await self.service.store_bytes("second", "same.bin", b"two")
        with self.assertRaises(AssetConflictError):
            await self.service.store_bytes("first", "same.bin", b"replacement")
        replaced = await self.service.store_bytes("first", "same.bin", b"replacement", replace=True)
        self.assertNotEqual(replaced.sha256, first.sha256)
        self.assertEqual((self.service.root / "same.bin").read_bytes(), b"replacement")
        self.assertFalse(await self.service.delete_asset("missing"))
        self.assertTrue(await self.service.delete_asset("first"))
        self.assertFalse((self.service.root / "same.bin").exists())
        with self.assertRaises(InvalidArgumentError):
            await self.service.list_assets(limit=0)
        with self.assertRaises(InvalidArgumentError):
            await self.service.list_assets(limit=1001)
        with self.assertRaises(InvalidArgumentError):
            await self.service.list_assets(offset=-1)
        with self.assertRaises(InvalidArgumentError):
            await self.service.list_assets(statuses=["deleted"])

    async def test_catalog_failure_rolls_back_staged_asset_delete(self) -> None:
        record = await self.service.store_bytes("rollback", "rollback.bin", b"keep")
        path = self.service.asset_path(record)

        @asynccontextmanager
        async def fail_transaction(*_args, **_kwargs):  # type: ignore[no-untyped-def]
            raise RuntimeError("database unavailable")
            yield  # pragma: no cover

        with patch.object(self.database, "transaction", fail_transaction):
            with self.assertRaisesRegex(RuntimeError, "database unavailable"):
                await self.service.delete_asset(record.id)

        self.assertEqual(path.read_bytes(), b"keep")
        self.assertIsNotNone(await self.service.get_asset(record.id))
        self.assertEqual(list(path.parent.glob(".*.part")), [])

    async def test_reconciliation_restores_precommit_delete_intent_after_crash(self) -> None:
        record = await self.service.store_bytes("recover", "nested/recover.bin", b"keep")
        path = self.service.asset_path(record)

        @asynccontextmanager
        async def fail_transaction(*_args, **_kwargs):  # type: ignore[no-untyped-def]
            raise RuntimeError("simulated process loss before catalog commit")
            yield  # pragma: no cover

        with (
            patch.object(self.database, "transaction", fail_transaction),
            patch("sidecar.services.assets._rollback_delete_intent", return_value=None),
        ):
            with self.assertRaisesRegex(RuntimeError, "process loss"):
                await self.service.delete_asset(record.id)

        self.assertFalse(path.exists())
        self.assertIsNotNone(await self.service.get_asset(record.id))
        self.assertTrue(self.service._delete_intent_root.exists())

        report = await self.service.reconcile_orphans()

        self.assertEqual(report.missing_asset_ids, ())
        self.assertEqual(path.read_bytes(), b"keep")
        self.assertFalse(self.service._delete_intent_root.exists())

    async def test_reconciliation_finishes_postcommit_delete_intent_after_crash(self) -> None:
        record = await self.service.store_bytes("finish", "finish.bin", b"remove")
        path = self.service.asset_path(record)
        with patch("sidecar.services.assets._finish_delete_intent", return_value=None):
            self.assertTrue(await self.service.delete_asset(record.id))

        self.assertFalse(path.exists())
        self.assertIsNone(await self.service.get_asset(record.id))
        self.assertTrue(self.service._delete_intent_root.exists())

        report = await self.service.reconcile_orphans()

        self.assertEqual(report.orphan_asset_ids, ())
        self.assertFalse(self.service._delete_intent_root.exists())

    async def test_storage_status_contract_and_argument_validation(self) -> None:
        status = StorageStatus(
            requested_bytes=3,
            catalog_bytes=8,
            quota_bytes=10,
            disk_free_bytes=5,
            reserve_bytes=3,
        )
        self.assertFalse(status.can_allocate)
        self.assertEqual(status.to_dict()["quota_remaining_bytes"], 2)
        for kwargs in ({"requested_bytes": -1}, {"replacing_catalog_bytes": -1}):
            with self.assertRaises(InvalidArgumentError):
                await self.service.storage_status(**kwargs)
        with self.assertRaises(ValueError):
            AssetService(self.database, self.service.root, quota_bytes=0)
        with self.assertRaises(InvalidArgumentError):
            await self.service.store_bytes(
                "bad-type",
                "bad.bin",
                bytearray(b"x"),  # type: ignore[arg-type]
            )
        with self.assertRaises(InvalidArgumentError):
            await self.service.store_bytes(
                "metadata",
                "metadata.bin",
                b"x",
                metadata={"x": object()},  # type: ignore[dict-item]
            )

    async def test_managed_root_and_health_checks_fail_closed(self) -> None:
        uninitialized = AssetService(
            self.database,
            self.root / "uninitialized-assets",
            managed_root=self.root / "uninitialized-managed",
            quota_bytes=20,
            reserve_bytes=0,
        )
        with self.assertRaisesRegex(InvalidArgumentError, "has not been initialized"):
            uninitialized._assert_root()
        with self.assertRaisesRegex(InvalidArgumentError, "has not been initialized"):
            uninitialized._assert_managed_root()

        outside_managed = self.root / "outside-managed"
        outside_managed.mkdir()
        outside_assets = self.root / "outside-assets-for-managed-test"
        outside_assets.mkdir()
        escaped = AssetService(
            self.database,
            outside_assets,
            managed_root=outside_managed,
            quota_bytes=20,
            reserve_bytes=0,
        )
        with self.assertRaisesRegex(InvalidArgumentError, "inside the managed"):
            await escaped.initialize()

        self.assertTrue((await self.service.ensure_capacity(1)).can_allocate)
        with patch.object(self.database, "check", return_value=False):
            self.assertFalse(await self.service.check())
        DiskUsage = namedtuple("DiskUsage", "total used free")
        reserved = AssetService(
            self.database,
            self.service.root,
            quota_bytes=20,
            reserve_bytes=1,
        )
        await reserved.initialize()
        with patch(
            "sidecar.services.assets.shutil.disk_usage",
            return_value=DiskUsage(10, 10, 0),
        ):
            self.assertFalse(await reserved.check())
        with patch("sidecar.services.assets._write_file_sync", side_effect=OSError("disk")):
            self.assertFalse(await self.service.check())

        managed = self.root / "replaceable-managed"
        managed.mkdir()
        managed_service = AssetService(
            self.database,
            managed / "assets",
            managed_root=managed,
            quota_bytes=20,
            reserve_bytes=0,
        )
        await managed_service.initialize()
        original = managed.with_name("replaceable-managed-original")
        managed.rename(original)
        with self.assertRaisesRegex(InvalidArgumentError, "managed data directory is missing"):
            managed_service._assert_managed_root()
        managed.mkdir()
        with self.assertRaisesRegex(InvalidArgumentError, "managed data directory changed"):
            managed_service._assert_managed_root()


if __name__ == "__main__":
    unittest.main()
