from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from sidecar.api import mount_api
from sidecar.local_settings import read_local_settings, write_local_settings
from sidecar.persistence import Database
from sidecar.process_control import ProcessControl
from sidecar.runtime import AppRuntime
from sidecar.security import AuthManager
from sidecar.services.backup import BackupService


def _app(runtime: AppRuntime) -> FastAPI:
    @asynccontextmanager
    async def lifespan(_: FastAPI):
        await runtime.startup()
        try:
            yield
        finally:
            await runtime.shutdown()

    app = FastAPI(lifespan=lifespan)
    mount_api(app, runtime)
    return app


def _runtime(
    root: Path,
    *,
    max_backup_bytes: int = 10 * 1024**3,
) -> tuple[AppRuntime, ProcessControl]:
    database = Database(root / "sidecar.sqlite3")
    backups = BackupService(
        database,
        root / "assets",
        max_uncompressed_bytes=max_backup_bytes,
    )
    controller = ProcessControl()
    runtime = AppRuntime(
        security=AuthManager("session-token"),
        backups=backups,
        process_control=controller,
    )
    runtime.register("backups", backups)
    return runtime, controller


def test_backup_api_is_authenticated_strict_and_directory_confined() -> None:
    with TemporaryDirectory() as temporary:
        runtime, _controller = _runtime(Path(temporary))
        headers = {"Authorization": "Bearer session-token"}
        with TestClient(_app(runtime)) as client:
            denied = client.get("/api/v1/backups")
            invalid = client.post(
                "/api/v1/backups",
                headers=headers,
                json={"include_assets": False, "unexpected": True},
            )
            created = client.post(
                "/api/v1/backups",
                headers=headers,
                json={"include_assets": False},
            )
            listed = client.get("/api/v1/backups", headers=headers)
            validated = client.post(
                f"/api/v1/backups/{created.json()['backup_id']}/validate",
                headers=headers,
            )
            traversal = client.post(
                "/api/v1/backups/escape:outside.zip/validate",
                headers=headers,
            )
            denied_delete = client.delete(
                f"/api/v1/backups/{created.json()['filename']}",
            )
            traversal_delete = client.delete(
                "/api/v1/backups/..%3Aoutside.zip",
                headers=headers,
            )
            deleted = client.delete(
                f"/api/v1/backups/{created.json()['backup_id']}",
                headers=headers,
            )
            listed_after_delete = client.get("/api/v1/backups", headers=headers)

        assert denied.status_code == 401
        assert invalid.status_code == 422
        assert created.status_code == 201
        assert created.json()["includes_settings"] is True
        assert listed.json()["count"] == 1
        assert validated.status_code == 200
        assert validated.json()["valid"] is True
        assert validated.json()["backup"]["backup_id"] == created.json()["backup_id"]
        assert traversal.status_code == 400
        assert traversal.json()["code"] == "invalid_backup_reference"
        assert denied_delete.status_code == 401
        assert traversal_delete.status_code == 400
        assert traversal_delete.json()["code"] == "invalid_backup_reference"
        assert deleted.status_code == 200
        assert deleted.json()["deleted"] is True
        assert deleted.json()["filename"] == created.json()["filename"]
        assert deleted.json()["reclaimed_bytes"] == created.json()["archive_bytes"]
        assert listed_after_delete.json()["count"] == 0


def test_restore_drains_then_requests_restart_and_restores_settings() -> None:
    with TemporaryDirectory() as temporary:
        root = Path(temporary)
        write_local_settings(root, {"llm_provider": "openai", "llm_model": "before"})
        runtime, controller = _runtime(root)
        headers = {"Authorization": "Bearer session-token"}
        with TestClient(_app(runtime)) as client:
            created = client.post(
                "/api/v1/backups",
                headers=headers,
                json={"include_assets": False},
            )
            write_local_settings(root, {"llm_provider": "gemini", "llm_model": "after"})
            restored = client.post(
                f"/api/v1/backups/{created.json()['filename']}/restore",
                headers=headers,
            )

        assert restored.status_code == 200
        assert restored.json()["draining"] is True
        assert restored.json()["restart_required"] is True
        assert restored.json()["safety_backup_filename"].endswith(".zip")
        assert controller.draining is True
        assert controller.shutdown_requested is True
        assert read_local_settings(root) == {
            "llm_provider": "openai",
            "llm_model": "before",
        }


def test_restore_requests_restart_when_background_drain_does_not_finish() -> None:
    with TemporaryDirectory() as temporary:
        runtime, controller = _runtime(Path(temporary))
        headers = {"Authorization": "Bearer session-token"}
        with TestClient(_app(runtime)) as client:
            created = client.post(
                "/api/v1/backups",
                headers=headers,
                json={"include_assets": False},
            )
            with patch.object(runtime, "begin_drain", AsyncMock(return_value=False)):
                refused = client.post(
                    f"/api/v1/backups/{created.json()['filename']}/restore",
                    headers=headers,
                )

        assert refused.status_code == 503
        assert refused.json()["code"] == "restore_restart_required"
        assert refused.json()["retryable"] is True
        assert controller.shutdown_requested is True


def test_invalid_restore_is_rejected_before_maintenance() -> None:
    with TemporaryDirectory() as temporary:
        root = Path(temporary)
        runtime, controller = _runtime(root)
        headers = {"Authorization": "Bearer session-token"}
        with TestClient(_app(runtime)) as client:
            invalid = root / "backups" / "invalid.zip"
            invalid.write_bytes(b"not a zip archive")

            refused = client.post(
                "/api/v1/backups/invalid.zip/restore",
                headers=headers,
            )

            assert refused.status_code == 400
            assert refused.json()["code"] == "invalid_backup"
            assert runtime.ready is True
            assert runtime.mutations.draining is False
            assert controller.draining is False
            assert controller.shutdown_requested is False


def test_insufficient_storage_problem_discloses_actionable_capacity_details() -> None:
    with TemporaryDirectory() as temporary:
        runtime, _controller = _runtime(Path(temporary), max_backup_bytes=1)
        headers = {"Authorization": "Bearer session-token"}
        with TestClient(_app(runtime)) as client:
            refused = client.post(
                "/api/v1/backups",
                headers=headers,
                json={"include_assets": False},
            )

        assert refused.status_code == 507
        assert refused.headers["content-type"].startswith("application/problem+json")
        assert refused.json()["code"] == "insufficient_storage"
        assert refused.json()["detail"] != "an internal error occurred"
        assert refused.json()["context"]["required_bytes"] > 1
