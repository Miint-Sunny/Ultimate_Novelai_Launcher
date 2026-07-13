from __future__ import annotations

import asyncio
import base64
import importlib.util
import io
import json
import sys
import time
import zipfile
from pathlib import Path
from types import ModuleType
from typing import Any

import aiosqlite
import httpx
import pytest

from backend_core.jobs import JobStatus
from cloud_backend.identity import Principal, ResourceOwner
from cloud_backend.infrastructure import (
    CloudJobResultStore,
    SecureJsonObjectStore,
    SQLiteCloudJobRepository,
    SQLiteWorkshopQuotaRepository,
    StorageIntegrityError,
)
from cloud_backend.pairing import PairingCodeRegistry

ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / "server"
PNG = b"\x89PNG\r\n\x1a\nlegacy-test"
ALT_PNG = b"\x89PNG\r\n\x1a\nlegacy-different"


@pytest.fixture(scope="module")
def legacy_server() -> ModuleType:
    previous_config = sys.modules.get("config")
    sys.path.insert(0, str(SERVER))
    config_spec = importlib.util.spec_from_file_location("config", SERVER / "config.example.py")
    assert config_spec and config_spec.loader
    config = importlib.util.module_from_spec(config_spec)
    sys.modules["config"] = config
    config_spec.loader.exec_module(config)
    config.JOB_CAPABILITY_SECRET = bytes(range(32))

    app_spec = importlib.util.spec_from_file_location(
        "legacy_server_integration_app",
        SERVER / "app.py",
    )
    assert app_spec and app_spec.loader
    module = importlib.util.module_from_spec(app_spec)
    sys.modules["legacy_server_integration_app"] = module
    app_spec.loader.exec_module(module)
    yield module

    sys.modules.pop("legacy_server_integration_app", None)
    if previous_config is None:
        sys.modules.pop("config", None)
    else:
        sys.modules["config"] = previous_config


def _client(module: ModuleType) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=module.app),
        base_url="http://legacy.test",
    )


@pytest.fixture(autouse=True)
async def isolated_persistent_jobs(
    legacy_server: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    jobs = SQLiteCloudJobRepository(tmp_path / "jobs.db")
    results = CloudJobResultStore(tmp_path / "results")
    await jobs.initialize()
    await results.initialize()
    monkeypatch.setattr(legacy_server, "_cloud_jobs", jobs)
    monkeypatch.setattr(legacy_server, "_cloud_job_results", results)
    monkeypatch.setattr(legacy_server, "_generation_upstream_tasks", {})
    monkeypatch.setattr(legacy_server, "_generation_admitting", 0)
    monkeypatch.setattr(legacy_server, "_generation_tasks", {})
    monkeypatch.setattr(legacy_server, "_user_pending", {})
    monkeypatch.setattr(
        legacy_server.bot_auth_manager,
        "_session_store",
        SecureJsonObjectStore(tmp_path / "sessions.json"),
    )
    monkeypatch.setattr(legacy_server.bot_auth_manager, "sessions", {})
    monkeypatch.setattr(
        legacy_server.bot_auth_manager,
        "pairing",
        PairingCodeRegistry(),
    )


async def _create_job(
    module: ModuleType,
    *,
    job_id: str,
    resource: ResourceOwner,
    status: JobStatus = JobStatus.QUEUED,
    request_payload: dict[str, Any] | None = None,
) -> None:
    payload = request_payload or {"prompt": "cat"}
    await module._cloud_jobs.create(
        job_id=job_id,
        resource=resource,
        request_hash=module._generation_request_hash(payload),
        payload={"model": "test"},
        idempotency_key=None,
        total_steps=1,
    )
    if status is not JobStatus.QUEUED:
        await module._cloud_jobs.transition(job_id, status)


async def _configure_workshop(
    module: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> tuple[SQLiteWorkshopQuotaRepository, Any]:
    stats = tmp_path / "workshop-stats.db"
    async with aiosqlite.connect(stats) as connection:
        await connection.execute(
            """
            CREATE TABLE user_quotas (
                user_id TEXT PRIMARY KEY,
                daily_limit INTEGER NOT NULL,
                daily_balance INTEGER NOT NULL,
                extra_balance INTEGER NOT NULL,
                last_refresh_date TEXT
            )
            """
        )
        await connection.execute("INSERT INTO user_quotas VALUES ('owner', 1, 1, 0, '2026-07-13')")
        await connection.commit()
    repository = SQLiteWorkshopQuotaRepository(stats)
    await repository.initialize()
    owner = module.BotSession("owner-session", "code", "owner", 1.0, time.time())
    monkeypatch.setattr(module.bot_auth_manager, "sessions", {owner.session_id: owner})
    monkeypatch.setattr(module, "_workshop_quota", repository)
    monkeypatch.setattr(module, "_STATS_DB", stats)
    monkeypatch.setattr(module, "_workshop_tasks", {})
    monkeypatch.setattr(module, "_workshop_background_tasks", {})
    return repository, owner


async def _wait_workshop_terminal(module: ModuleType, task_id: str) -> dict[str, Any]:
    for _ in range(100):
        task = module._workshop_tasks[task_id]
        if task.get("completed_at"):
            return task
        await asyncio.sleep(0.01)
    raise AssertionError("workshop task did not finish")


class FakeWebSocket:
    def __init__(
        self,
        protocol: str,
        disconnect_type: type[Exception],
        *,
        messages: list[dict[str, Any]] | None = None,
    ) -> None:
        self.headers = {"sec-websocket-protocol": protocol}
        self.disconnect_type = disconnect_type
        self.messages = list(messages or [])
        self.accepted_protocol: str | None = None
        self.sent: list[dict[str, Any]] = []
        self.closed: tuple[int, str | None] | None = None

    async def accept(self, subprotocol: str | None = None) -> None:
        self.accepted_protocol = subprotocol

    async def send_json(self, data: dict[str, Any]) -> None:
        self.sent.append(data)

    async def receive_json(self) -> dict[str, Any]:
        if self.messages:
            return self.messages.pop(0)
        raise self.disconnect_type()

    async def close(self, code: int = 1000, reason: str | None = None) -> None:
        self.closed = (code, reason)


class LiveFakeWebSocket(FakeWebSocket):
    def __init__(self, protocol: str, disconnect_type: type[Exception]) -> None:
        super().__init__(protocol, disconnect_type)
        self.incoming: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        self.concurrent_sends = 0
        self.max_concurrent_sends = 0

    async def send_json(self, data: dict[str, Any]) -> None:
        self.concurrent_sends += 1
        self.max_concurrent_sends = max(self.max_concurrent_sends, self.concurrent_sends)
        try:
            await asyncio.sleep(0)
            self.sent.append(data)
        finally:
            self.concurrent_sends -= 1

    async def receive_json(self) -> dict[str, Any]:
        message = await self.incoming.get()
        if message is None:
            raise self.disconnect_type()
        return message


@pytest.mark.asyncio
async def test_bot_pairing_short_code_cannot_be_used_to_steal_session(
    legacy_server: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    poll_token = "browser-only-poll-token-" + "x" * 32
    registry = PairingCodeRegistry(
        code_factory=lambda: "ABC123",
        token_factory=lambda: poll_token,
    )
    monkeypatch.setattr(legacy_server.bot_auth_manager, "pairing", registry)
    monkeypatch.setattr(legacy_server.bot_auth_manager, "sessions", {})
    monkeypatch.setattr(legacy_server.bot_auth_manager, "_save_sessions", lambda: None)
    monkeypatch.setattr(legacy_server._appcfg, "BOT_SHARED_SECRET", "bot-secret", raising=False)

    async with _client(legacy_server) as client:
        generated = await client.post("/api/bot/auth/generate")
        missing_poll_secret = await client.post(
            "/api/bot/auth/check",
            json={"code": "ABC123"},
        )
        unauthorized_bot = await client.post(
            "/api/bot/auth/verify",
            json={"code": "ABC123", "bot_user_id": "owner"},
        )
        verified = await client.post(
            "/api/bot/auth/verify",
            headers={"X-Bot-Secret": "bot-secret"},
            json={"code": "ABC123", "bot_user_id": "owner"},
        )
        stolen = await client.post(
            "/api/bot/auth/check",
            json={"code": "ABC123", "poll_token": "attacker-token-" + "z" * 32},
        )
        consumed = await client.post(
            "/api/bot/auth/check",
            json={"code": "ABC123", "poll_token": poll_token},
        )
        replayed = await client.post(
            "/api/bot/auth/check",
            json={"code": "ABC123", "poll_token": poll_token},
        )

    assert generated.status_code == 200
    assert generated.json() == {
        "code": "ABC123",
        "poll_token": poll_token,
        "expires_in": 300,
    }
    assert missing_poll_secret.status_code == 422
    assert unauthorized_bot.status_code == 401
    assert verified.status_code == 200
    assert verified.json()["success"] is True
    assert stolen.json() == {"verified": False, "session_id": None}
    assert consumed.json()["verified"] is True
    assert consumed.json()["session_id"] == verified.json()["session_id"]
    assert replayed.json() == {"verified": False, "session_id": None}


@pytest.mark.asyncio
async def test_bot_sessions_persist_without_ephemeral_pairing_code(
    legacy_server: ModuleType,
    tmp_path: Path,
) -> None:
    path = tmp_path / "persistent-sessions.json"
    manager = legacy_server.BotAuthManager(path)
    manager.pairing = PairingCodeRegistry(
        code_factory=lambda: "123ABC",
        token_factory=lambda: "browser-secret-" + "p" * 32,
    )
    challenge = manager.generate_auth_code()

    session_id = await manager.verify_auth_code(challenge.code, "owner")

    assert session_id is not None
    stored = json.loads(path.read_text(encoding="utf-8"))
    assert stored[session_id]["session_id"] == session_id
    assert stored[session_id]["bot_user_id"] == "owner"
    assert "auth_code" not in stored[session_id]
    reloaded = legacy_server.BotAuthManager(path)
    assert reloaded.sessions[session_id].auth_code == ""
    assert reloaded.sessions[session_id].bot_user_id == "owner"


def test_bot_session_store_corruption_fails_closed(
    legacy_server: ModuleType,
    tmp_path: Path,
) -> None:
    path = tmp_path / "corrupt-sessions.json"
    path.write_text('{"bad": {"session_id": "different"}}', encoding="utf-8")

    with pytest.raises((RuntimeError, StorageIntegrityError)):
        legacy_server.BotAuthManager(path)


@pytest.mark.asyncio
async def test_bot_pairing_rolls_back_when_session_persistence_fails(
    legacy_server: ModuleType,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = legacy_server.BotAuthManager(tmp_path / "sessions.json")
    manager.pairing = PairingCodeRegistry(
        code_factory=lambda: "C0FFEE",
        token_factory=lambda: "browser-secret-" + "q" * 32,
    )
    challenge = manager.generate_auth_code()

    def fail_save() -> None:
        raise StorageIntegrityError("disk unavailable")

    monkeypatch.setattr(manager, "_save_sessions", fail_save)
    with pytest.raises(StorageIntegrityError, match="disk unavailable"):
        await manager.verify_auth_code(challenge.code, "owner")

    assert manager.sessions == {}
    assert manager.pairing.bind(challenge.code, "retry-session") is True


@pytest.mark.asyncio
async def test_anonymous_generation_returns_capability_and_protects_image(
    legacy_server: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    tasks: dict[str, dict[str, Any]] = {}
    monkeypatch.setattr(legacy_server, "_generation_tasks", tasks)

    async def fake_enqueue(
        params,
        user_id="",
        allow_boost=True,
        *,
        resource,
        task_id=None,
        task_metadata=None,
        idempotency_key=None,
        request_hash=None,
    ):
        digest = request_hash or legacy_server._generation_request_hash(params)
        await legacy_server._cloud_jobs.create(
            job_id=task_id,
            resource=resource,
            request_hash=digest,
            payload={"model": "test"},
            idempotency_key=idempotency_key,
            total_steps=1,
        )
        await legacy_server._cloud_jobs.transition(task_id, JobStatus.RUNNING)
        encoded = base64.b64encode(PNG).decode("ascii")
        metadata = await legacy_server._cloud_job_results.save_base64(task_id, encoded)
        await legacy_server._cloud_jobs.transition(
            task_id,
            JobStatus.SUCCEEDED,
            step=1,
            total_steps=1,
            result=metadata,
        )
        record = {
            "task_id": task_id,
            "status": "completed",
            "result": encoded,
            "step": 1,
            "total_steps": 1,
            "created_at": time.time(),
            "user_id": user_id,
        }
        legacy_server._task_access.bind_record(record, resource)
        tasks[task_id] = record
        return task_id, 0, True

    monkeypatch.setattr(legacy_server, "enqueue_generation", fake_enqueue)
    async with _client(legacy_server) as client:
        created = await client.post("/api/generate", json={"positivePrompt": "cat"})
        assert created.status_code == 200
        payload = created.json()
        token = payload["capability_token"]
        task_id = payload["task_id"]
        tasks.clear()

        assert (await client.get(f"/api/task/{task_id}")).status_code == 401
        result = await client.get(
            f"/api/task/{task_id}",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert result.status_code == 200
    assert base64.b64decode(result.json()["result"]["imageBase64"]) == PNG


@pytest.mark.asyncio
async def test_task_websocket_authenticates_before_accept(
    legacy_server: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    task_id = "socket-job"
    grant = legacy_server._task_access.issue_anonymous(
        job_id=task_id,
        tenant_id=legacy_server._DIRECT_TASK_TENANT_ID,
    )
    task = {
        "task_id": task_id,
        "status": "queued",
        "step": 0,
        "total_steps": 1,
        "result": None,
    }
    legacy_server._task_access.bind_record(task, grant.resource)
    await _create_job(
        legacy_server,
        job_id=task_id,
        resource=grant.resource,
        status=JobStatus.CANCELLED,
    )
    monkeypatch.setattr(legacy_server, "_generation_tasks", {task_id: task})
    monkeypatch.setattr(legacy_server, "_generation_websockets", {})
    valid = FakeWebSocket(
        f"job-capability.{grant.capability_token}",
        legacy_server.WebSocketDisconnect,
    )
    invalid = FakeWebSocket("job-capability.invalid", legacy_server.WebSocketDisconnect)

    await legacy_server.websocket_generation_task(valid, task_id)
    await legacy_server.websocket_generation_task(invalid, task_id)

    assert valid.accepted_protocol == f"job-capability.{grant.capability_token}"
    assert valid.sent[0]["job"]["id"] == task_id
    assert invalid.accepted_protocol is None
    assert invalid.closed == (4401, "authentication required")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "protocol",
    ["", "unrelated.v1", "bot-session.invalid", "bot-session.invalid, bot-session.other"],
)
async def test_bot_websocket_rejects_invalid_session_before_accept(
    legacy_server: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    protocol: str,
) -> None:
    session_id = "a" * 32
    owner = legacy_server.BotSession(
        session_id,
        "",
        "owner",
        time.time(),
        time.time(),
    )
    monkeypatch.setattr(legacy_server.bot_auth_manager, "sessions", {session_id: owner})
    monkeypatch.setattr(legacy_server.bot_auth_manager, "session_websockets", {})
    socket = FakeWebSocket(protocol, legacy_server.WebSocketDisconnect)

    await legacy_server.websocket_bot(socket)

    assert socket.accepted_protocol is None
    assert socket.sent == []
    assert socket.closed == (4401, "authentication required")
    assert legacy_server.bot_auth_manager.session_websockets == {}


@pytest.mark.asyncio
async def test_bot_websocket_binds_during_handshake_and_enforces_task_owner(
    legacy_server: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    owner_session_id = "a" * 32
    attacker_session_id = "b" * 32
    owner = legacy_server.BotSession(
        owner_session_id,
        "",
        "owner",
        time.time(),
        time.time(),
    )
    attacker = legacy_server.BotSession(
        attacker_session_id,
        "",
        "attacker",
        time.time(),
        time.time(),
    )
    monkeypatch.setattr(
        legacy_server.bot_auth_manager,
        "sessions",
        {owner_session_id: owner, attacker_session_id: attacker},
    )
    monkeypatch.setattr(legacy_server.bot_auth_manager, "session_websockets", {})
    monkeypatch.setattr(legacy_server, "_generation_websockets", {})
    task_id = "bot-socket-owner-job"
    await _create_job(
        legacy_server,
        job_id=task_id,
        resource=ResourceOwner(legacy_server._BOT_TASK_TENANT_ID, owner.bot_user_id),
    )
    owner_socket = FakeWebSocket(
        f"bot-session.{owner_session_id}",
        legacy_server.WebSocketDisconnect,
        messages=[{"action": "subscribe_task", "task_id": task_id}],
    )
    attacker_socket = FakeWebSocket(
        f"bot-session.{attacker_session_id}",
        legacy_server.WebSocketDisconnect,
        messages=[{"action": "subscribe_task", "task_id": task_id}],
    )

    await legacy_server.websocket_bot(owner_socket)
    await legacy_server.websocket_bot(attacker_socket)

    assert owner_socket.accepted_protocol == f"bot-session.{owner_session_id}"
    assert owner_socket.sent[0] == {
        "action": "session_bound",
        "success": True,
        "bot_user_id": "owner",
    }
    assert any(message.get("type") == "job_snapshot" for message in owner_socket.sent)
    assert any(
        message.get("action") == "subscribed" and message.get("success") is True
        for message in owner_socket.sent
    )
    assert attacker_socket.sent[0]["action"] == "session_bound"
    assert attacker_socket.sent[1] == {
        "action": "subscribed",
        "task_id": task_id,
        "success": False,
        "error": "not_found",
    }
    assert not any(message.get("type") == "job_snapshot" for message in attacker_socket.sent)
    assert legacy_server.bot_auth_manager.session_websockets == {}
    assert legacy_server._generation_websockets == {}


@pytest.mark.asyncio
async def test_bot_websocket_rejects_real_direct_tenant_job(
    legacy_server: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session_id = "d" * 32
    owner = legacy_server.BotSession(session_id, "", "owner", time.time(), time.time())
    monkeypatch.setattr(legacy_server.bot_auth_manager, "sessions", {session_id: owner})
    monkeypatch.setattr(legacy_server.bot_auth_manager, "session_websockets", {})
    grant = legacy_server._task_access.issue_anonymous(
        job_id="real-direct-job",
        tenant_id=legacy_server._DIRECT_TASK_TENANT_ID,
    )
    await _create_job(
        legacy_server,
        job_id="real-direct-job",
        resource=grant.resource,
    )
    socket = FakeWebSocket(
        f"bot-session.{session_id}",
        legacy_server.WebSocketDisconnect,
        messages=[{"action": "subscribe_task", "task_id": "real-direct-job"}],
    )

    await legacy_server.websocket_bot(socket)

    assert socket.sent[1] == {
        "action": "subscribed",
        "task_id": "real-direct-job",
        "success": False,
        "error": "not_found",
    }
    assert not any(message.get("type") == "job_snapshot" for message in socket.sent)


@pytest.mark.asyncio
async def test_bot_websocket_snapshot_race_is_monotonic_and_ignores_future_cursor(
    legacy_server: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session_id = "e" * 32
    owner = legacy_server.BotSession(session_id, "", "owner", time.time(), time.time())
    monkeypatch.setattr(legacy_server.bot_auth_manager, "sessions", {session_id: owner})
    monkeypatch.setattr(legacy_server.bot_auth_manager, "session_websockets", {})
    task_id = "bot-snapshot-race"
    await _create_job(
        legacy_server,
        job_id=task_id,
        resource=ResourceOwner(legacy_server._BOT_TASK_TENANT_ID, owner.bot_user_id),
    )
    original_snapshot = legacy_server._cloud_jobs.snapshot_with_watermark
    transitioned = False

    async def snapshot_then_transition(job_id: str):
        nonlocal transitioned
        snapshot = await original_snapshot(job_id)
        if not transitioned:
            transitioned = True
            await legacy_server._cloud_jobs.transition(
                job_id,
                JobStatus.RUNNING,
                kind="started",
            )
            await legacy_server._cloud_jobs.transition(
                job_id,
                JobStatus.FAILED,
                kind="failed",
                error="fake failure",
            )
        return snapshot

    monkeypatch.setattr(
        legacy_server._cloud_jobs,
        "snapshot_with_watermark",
        snapshot_then_transition,
    )
    socket = FakeWebSocket(
        f"bot-session.{session_id}",
        legacy_server.WebSocketDisconnect,
        messages=[
            {
                "action": "subscribe_task",
                "task_id": task_id,
                "after_sequence": 999_999,
            }
        ],
    )

    await legacy_server.websocket_bot(socket)

    wire_sequences = [
        int(message.get("sequence", message.get("event", {}).get("sequence")))
        for message in socket.sent
        if "sequence" in message or "sequence" in message.get("event", {})
    ]
    assert wire_sequences == [1, 1, 2, 2, 3, 3]
    assert any(
        message.get("action") == "subscribed" and message.get("success") is True
        for message in socket.sent
    )


@pytest.mark.asyncio
async def test_bot_websocket_streams_live_persisted_events_for_all_owned_job_adapters(
    legacy_server: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    owner_session_id = "c" * 32
    owner = legacy_server.BotSession(
        owner_session_id,
        "",
        "owner",
        time.time(),
        time.time(),
    )
    monkeypatch.setattr(legacy_server.bot_auth_manager, "sessions", {owner_session_id: owner})
    monkeypatch.setattr(legacy_server.bot_auth_manager, "session_websockets", {})
    monkeypatch.setattr(legacy_server, "_generation_websockets", {})
    resource = ResourceOwner(legacy_server._BOT_TASK_TENANT_ID, owner.bot_user_id)
    job_ids = ["owned-direct", "owned-bot", "owned-workshop"]
    for job_id in job_ids:
        await _create_job(
            legacy_server,
            job_id=job_id,
            resource=resource,
            request_payload={"adapter": job_id.removeprefix("owned-")},
        )

    socket = LiveFakeWebSocket(
        f"bot-session.{owner_session_id}",
        legacy_server.WebSocketDisconnect,
    )
    task = asyncio.create_task(legacy_server.websocket_bot(socket))
    for job_id in job_ids:
        await socket.incoming.put(
            {"action": "subscribe_task", "task_id": job_id, "after_sequence": 1}
        )

    subscribed: set[Any] = set()
    for _ in range(100):
        subscribed = {
            message.get("task_id")
            for message in socket.sent
            if message.get("action") == "subscribed" and message.get("success") is True
        }
        if subscribed == set(job_ids):
            break
        await asyncio.sleep(0.01)
    assert subscribed == set(job_ids)

    for job_id in job_ids:
        await legacy_server._cloud_jobs.transition(
            job_id,
            JobStatus.RUNNING,
            kind="started",
        )

    live_started: set[Any] = set()
    for _ in range(100):
        live_started = {
            message["event"]["job_id"]
            for message in socket.sent
            if message.get("type") == "job_event"
            and message.get("event", {}).get("kind") == "started"
        }
        if live_started == set(job_ids):
            break
        await asyncio.sleep(0.01)
    assert live_started == set(job_ids)
    assert socket.max_concurrent_sends == 1
    assert all(
        any(
            message.get("action") == "task_update" and message.get("task_id") == job_id
            for message in socket.sent
        )
        for job_id in job_ids
    )

    await socket.incoming.put(None)
    await asyncio.wait_for(task, timeout=2)
    assert legacy_server.bot_auth_manager.session_websockets == {}
    assert not [
        running
        for running in asyncio.all_tasks()
        if running is not asyncio.current_task()
        and running.get_name().startswith("job-events:")
        and not running.done()
    ]


@pytest.mark.asyncio
async def test_bot_http_adapter_persists_progress_result_and_emits_legacy_once(
    legacy_server: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session_id = "f" * 32
    owner = legacy_server.BotSession(session_id, "", "owner", time.time(), time.time())
    monkeypatch.setattr(legacy_server.bot_auth_manager, "sessions", {session_id: owner})
    monkeypatch.setattr(legacy_server.bot_auth_manager, "tasks", {})
    monkeypatch.setattr(legacy_server.bot_auth_manager, "session_websockets", {})
    monkeypatch.setattr(legacy_server._appcfg, "BOT_SHARED_SECRET", "service-secret", raising=False)
    task_id = "bot-http-adapter"
    await _create_job(
        legacy_server,
        job_id=task_id,
        resource=ResourceOwner(legacy_server._BOT_TASK_TENANT_ID, owner.bot_user_id),
    )
    mirrored = await legacy_server.bot_auth_manager.create_task(
        session_id,
        {"positivePrompt": "cat"},
        task_id=task_id,
    )
    assert mirrored is not None

    socket = LiveFakeWebSocket(
        f"bot-session.{session_id}",
        legacy_server.WebSocketDisconnect,
    )
    socket_task = asyncio.create_task(legacy_server.websocket_bot(socket))
    await socket.incoming.put(
        {"action": "subscribe_task", "task_id": task_id, "after_sequence": 0}
    )
    for _ in range(100):
        if any(
            message.get("action") == "subscribed" and message.get("success") is True
            for message in socket.sent
        ):
            break
        await asyncio.sleep(0.01)
    else:
        raise AssertionError("Bot socket did not subscribe")

    encoded = base64.b64encode(PNG).decode("ascii")
    headers = {"X-Bot-Secret": "service-secret"}
    async with _client(legacy_server) as client:
        progress = await client.post(
            "/api/bot/task/progress",
            headers=headers,
            json={
                "task_id": task_id,
                "step": 1,
                "total_steps": 1,
                "preview": encoded,
            },
        )
        completed = await client.post(
            "/api/bot/task/update",
            headers=headers,
            json={
                "task_id": task_id,
                "status": "completed",
                "result": {"type": "base64", "imageBase64": encoded},
            },
        )
        stored_after_first = {
            path.name for path in legacy_server._cloud_job_results.root.iterdir() if path.is_file()
        }
        duplicate = await client.post(
            "/api/bot/task/update",
            headers=headers,
            json={
                "task_id": task_id,
                "status": "completed",
                "result": {
                    "type": "base64",
                    "imageBase64": base64.b64encode(ALT_PNG).decode("ascii"),
                },
            },
        )
        stored_after_duplicate = {
            path.name for path in legacy_server._cloud_job_results.root.iterdir() if path.is_file()
        }

    assert progress.status_code == 200
    assert completed.status_code == 200
    assert duplicate.status_code == 200
    assert stored_after_duplicate == stored_after_first
    event_kinds: set[Any] = set()
    for _ in range(100):
        event_kinds = {
            message.get("event", {}).get("kind")
            for message in socket.sent
            if message.get("type") == "job_event"
        }
        if {"progress", "provider_attempted", "succeeded"} <= event_kinds:
            break
        await asyncio.sleep(0.01)
    assert {"progress", "provider_attempted", "succeeded"} <= event_kinds
    assert len(
        [
            message
            for message in socket.sent
            if message.get("action") == "task_progress"
            and message.get("task_id") == task_id
        ]
    ) == 1
    assert len(
        [
            message
            for message in socket.sent
            if message.get("action") == "task_update"
            and message.get("task_id") == task_id
            and message.get("status") == "completed"
        ]
    ) == 1
    job = await legacy_server._cloud_jobs.get(task_id)
    assert job is not None
    assert job.status is JobStatus.SUCCEEDED
    assert (job.step, job.total_steps) == (1, 1)
    assert job.result is not None
    assert await legacy_server._cloud_job_results.load_base64(job.result) == encoded

    await socket.incoming.put(None)
    await asyncio.wait_for(socket_task, timeout=2)

    restarted = SQLiteCloudJobRepository(legacy_server._cloud_jobs.path)
    await restarted.initialize()
    monkeypatch.setattr(legacy_server, "_cloud_jobs", restarted)
    monkeypatch.setattr(legacy_server, "_generation_tasks", {})
    monkeypatch.setattr(legacy_server.bot_auth_manager, "tasks", {})
    async with _client(legacy_server) as client:
        restored = await client.post(
            "/api/bot/task",
            json={"task_id": task_id, "session_id": session_id},
        )

    assert restored.status_code == 200
    assert restored.json() == {
        "success": True,
        "status": "completed",
        "queue_position": 0,
        "result": {"type": "base64", "imageBase64": encoded},
        "step": 1,
        "total_steps": 1,
        "error": None,
    }


@pytest.mark.asyncio
async def test_bot_adapter_rejects_unknown_cross_owner_and_invalid_payloads(
    legacy_server: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    owner_session_id = "1" * 32
    attacker_session_id = "2" * 32
    owner = legacy_server.BotSession(
        owner_session_id,
        "",
        "owner",
        time.time(),
        time.time(),
    )
    attacker = legacy_server.BotSession(
        attacker_session_id,
        "",
        "attacker",
        time.time(),
        time.time(),
    )
    monkeypatch.setattr(
        legacy_server.bot_auth_manager,
        "sessions",
        {owner_session_id: owner, attacker_session_id: attacker},
    )
    monkeypatch.setattr(legacy_server.bot_auth_manager, "tasks", {})
    monkeypatch.setattr(legacy_server._appcfg, "BOT_SHARED_SECRET", "service-secret", raising=False)
    task_id = "owner-bound-bot-job"
    await _create_job(
        legacy_server,
        job_id=task_id,
        resource=ResourceOwner(legacy_server._BOT_TASK_TENANT_ID, owner.bot_user_id),
    )
    with pytest.raises(legacy_server.ResourceNotFoundError):
        await legacy_server.bot_auth_manager.create_task(
            attacker_session_id,
            {"positivePrompt": "stolen"},
            task_id=task_id,
        )
    # Simulate a corrupt pre-upgrade memory binding: the service adapter must
    # still recheck the persistent owner before every mutation.
    legacy_server.bot_auth_manager.tasks[task_id] = legacy_server.BotGenerateTask(
        task_id=task_id,
        session_id=attacker_session_id,
        params={},
        created_at=time.time(),
    )
    encoded = base64.b64encode(PNG).decode("ascii")
    headers = {"X-Bot-Secret": "service-secret"}
    async with _client(legacy_server) as client:
        unknown = await client.post(
            "/api/bot/task/progress",
            headers=headers,
            json={"task_id": "missing", "step": 1, "total_steps": 1},
        )
        cross_owner = await client.post(
            "/api/bot/task/progress",
            headers=headers,
            json={"task_id": task_id, "step": 1, "total_steps": 1},
        )
        invalid_responses = [
            await client.post(
                "/api/bot/task/update",
                headers=headers,
                json={"task_id": task_id, "status": "completed"},
            ),
            await client.post(
                "/api/bot/task/update",
                headers=headers,
                json={
                    "task_id": task_id,
                    "status": "queued",
                    "error": "must not persist",
                },
            ),
            await client.post(
                "/api/bot/task/update",
                headers=headers,
                json={
                    "task_id": task_id,
                    "status": "failed",
                    "result": {"type": "base64", "imageBase64": encoded},
                },
            ),
            await client.post(
                "/api/bot/task/progress",
                headers=headers,
                json={"task_id": task_id, "step": 2, "total_steps": 1},
            ),
            await client.post(
                "/api/bot/task/progress",
                headers=headers,
                json={
                    "task_id": task_id,
                    "step": 1,
                    "total_steps": 1,
                    "ignored": True,
                },
            ),
        ]

    assert unknown.status_code == 404
    assert cross_owner.status_code == 404
    assert [response.status_code for response in invalid_responses] == [422] * 5
    unchanged = await legacy_server._cloud_jobs.get(task_id)
    assert unchanged is not None and unchanged.status is JobStatus.QUEUED


@pytest.mark.asyncio
async def test_bot_terminal_updates_settle_quota_exactly_once(
    legacy_server: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session_id = "3" * 32
    owner = legacy_server.BotSession(session_id, "", "owner", time.time(), time.time())
    monkeypatch.setattr(legacy_server.bot_auth_manager, "sessions", {session_id: owner})
    monkeypatch.setattr(legacy_server.bot_auth_manager, "tasks", {})
    monkeypatch.setattr(legacy_server._appcfg, "BOT_SHARED_SECRET", "service-secret", raising=False)
    settlements: list[tuple[str, bool]] = []

    class FakeLedger:
        enabled = True

        async def settle(
            self,
            record: dict[str, Any],
            principal: Principal,
            *,
            succeeded: bool,
            job_id: str,
        ) -> None:
            settlements.append((job_id, succeeded))

    monkeypatch.setattr(legacy_server, "_quota_ledger", FakeLedger())
    resource = ResourceOwner(legacy_server._BOT_TASK_TENANT_ID, owner.bot_user_id)
    for task_id in ("bot-quota-completed", "bot-quota-failed"):
        await legacy_server._cloud_jobs.create(
            job_id=task_id,
            resource=resource,
            request_hash=legacy_server._generation_request_hash({"task_id": task_id}),
            payload={"model": "test"},
            idempotency_key=None,
            quota_reservation_id=f"reservation-{task_id}",
            cost_units=1,
            total_steps=1,
        )
        assert await legacy_server.bot_auth_manager.create_task(
            session_id,
            {},
            task_id=task_id,
        )

    headers = {"X-Bot-Secret": "service-secret"}
    encoded = base64.b64encode(PNG).decode("ascii")
    async with _client(legacy_server) as client:
        for task_id in ("bot-quota-completed", "bot-quota-failed"):
            progress = await client.post(
                "/api/bot/task/progress",
                headers=headers,
                json={"task_id": task_id, "step": 1, "total_steps": 1},
            )
            assert progress.status_code == 200
        completed_body = {
            "task_id": "bot-quota-completed",
            "status": "completed",
            "result": {"type": "base64", "imageBase64": encoded},
        }
        failed_body = {
            "task_id": "bot-quota-failed",
            "status": "failed",
            "error": "provider failed",
        }
        completed = await client.post(
            "/api/bot/task/update",
            headers=headers,
            json=completed_body,
        )
        completed_replay = await client.post(
            "/api/bot/task/update",
            headers=headers,
            json=completed_body,
        )
        failed = await client.post(
            "/api/bot/task/update",
            headers=headers,
            json=failed_body,
        )
        failed_replay = await client.post(
            "/api/bot/task/update",
            headers=headers,
            json=failed_body,
        )

    assert [
        completed.status_code,
        completed_replay.status_code,
        failed.status_code,
        failed_replay.status_code,
    ] == [200, 200, 200, 200]
    assert settlements == [
        ("bot-quota-completed", True),
        ("bot-quota-failed", False),
    ]
    completed_job = await legacy_server._cloud_jobs.get("bot-quota-completed")
    failed_job = await legacy_server._cloud_jobs.get("bot-quota-failed")
    assert completed_job is not None and completed_job.cost_committed
    assert failed_job is not None and failed_job.quota_settled and not failed_job.cost_committed


@pytest.mark.asyncio
async def test_restart_recovers_every_unsettled_terminal_quota_once(
    legacy_server: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settlements: list[tuple[str, bool]] = []
    fail_once = {"recovery-succeeded"}

    class TransientLedger:
        enabled = True

        async def settle(
            self,
            record: dict[str, Any],
            principal: Principal,
            *,
            succeeded: bool,
            job_id: str,
        ) -> None:
            settlements.append((job_id, succeeded))
            if job_id in fail_once:
                fail_once.remove(job_id)
                raise RuntimeError("transient quota settlement failure")

    monkeypatch.setattr(legacy_server, "_quota_ledger", TransientLedger())
    repository = legacy_server._cloud_jobs
    resource = ResourceOwner(legacy_server._DIRECT_TASK_TENANT_ID, "recovery-owner")
    for task_id in (
        "recovery-succeeded",
        "recovery-failed",
        "recovery-cancelled",
        "already-settled",
    ):
        await repository.create(
            job_id=task_id,
            resource=resource,
            request_hash=legacy_server._generation_request_hash({"task_id": task_id}),
            payload={"model": "test"},
            idempotency_key=None,
            quota_reservation_id=f"reservation-{task_id}",
            cost_units=1,
            total_steps=1,
        )

    await repository.transition("recovery-succeeded", JobStatus.RUNNING)
    await repository.mark_provider_attempted("recovery-succeeded")
    await repository.transition("recovery-succeeded", JobStatus.SUCCEEDED)

    await repository.transition("recovery-failed", JobStatus.RUNNING)
    await repository.transition("recovery-failed", JobStatus.FAILED)

    await repository.transition("recovery-cancelled", JobStatus.RUNNING)
    await repository.mark_provider_attempted("recovery-cancelled")
    await repository.request_cancel("recovery-cancelled")
    await repository.transition("recovery-cancelled", JobStatus.CANCELLED)

    await repository.transition("already-settled", JobStatus.CANCELLED)
    await repository.mark_quota_refunded("already-settled")

    # The provider completed, but quota settlement failed before its durable marker.
    await legacy_server._settle_generation_quota("recovery-succeeded")
    unsettled = await repository.get("recovery-succeeded")
    assert unsettled is not None and not unsettled.quota_settled

    restarted = SQLiteCloudJobRepository(repository.path)
    await restarted.initialize()
    monkeypatch.setattr(legacy_server, "_cloud_jobs", restarted)
    assert await restarted.recover_interrupted() == []

    recoverable = await restarted.list_recovery_settlements()
    assert {job.id: job.status for job in recoverable} == {
        "recovery-succeeded": JobStatus.SUCCEEDED,
        "recovery-failed": JobStatus.FAILED,
        "recovery-cancelled": JobStatus.CANCELLED,
    }
    for job in recoverable:
        await legacy_server._settle_generation_quota(job.id)

    succeeded = await restarted.get("recovery-succeeded")
    failed = await restarted.get("recovery-failed")
    cancelled = await restarted.get("recovery-cancelled")
    already_settled = await restarted.get("already-settled")
    assert succeeded is not None and succeeded.cost_committed and succeeded.quota_settled
    assert failed is not None and failed.quota_settled and not failed.cost_committed
    assert cancelled is not None and cancelled.cost_committed and cancelled.quota_settled
    assert already_settled is not None and already_settled.quota_settled
    assert settlements.count(("recovery-succeeded", True)) == 2
    assert settlements.count(("recovery-failed", False)) == 1
    assert settlements.count(("recovery-cancelled", True)) == 1
    assert all(job_id != "already-settled" for job_id, _succeeded in settlements)

    settled_attempts = list(settlements)
    second_recovery = await restarted.list_recovery_settlements()
    assert second_recovery == []
    for job in second_recovery:
        await legacy_server._settle_generation_quota(job.id)
    assert settlements == settled_attempts


@pytest.mark.asyncio
async def test_bot_websocket_rejects_session_rebinding(
    legacy_server: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    owner_session_id = "a" * 32
    attacker_session_id = "b" * 32
    owner = legacy_server.BotSession(
        owner_session_id,
        "",
        "owner",
        time.time(),
        time.time(),
    )
    attacker = legacy_server.BotSession(
        attacker_session_id,
        "",
        "attacker",
        time.time(),
        time.time(),
    )
    monkeypatch.setattr(
        legacy_server.bot_auth_manager,
        "sessions",
        {owner_session_id: owner, attacker_session_id: attacker},
    )
    monkeypatch.setattr(legacy_server.bot_auth_manager, "session_websockets", {})
    socket = FakeWebSocket(
        f"bot-session.{owner_session_id}",
        legacy_server.WebSocketDisconnect,
        messages=[{"action": "bind_session", "session_id": attacker_session_id}],
    )

    await legacy_server.websocket_bot(socket)

    assert socket.sent[0]["bot_user_id"] == owner.bot_user_id
    assert socket.closed == (4403, "session rebinding is not allowed")
    assert legacy_server.bot_auth_manager.session_websockets == {}


@pytest.mark.asyncio
async def test_anonymous_capability_can_cancel_only_its_task(
    legacy_server: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    task_id = "cancel-job"
    grant = legacy_server._task_access.issue_anonymous(
        job_id=task_id,
        tenant_id=legacy_server._DIRECT_TASK_TENANT_ID,
    )
    task = {
        "task_id": task_id,
        "status": "queued",
        "error": None,
        "user_id": "direct",
        "created_at": time.time(),
    }
    legacy_server._task_access.bind_record(task, grant.resource)
    await _create_job(legacy_server, job_id=task_id, resource=grant.resource)
    monkeypatch.setattr(legacy_server, "_generation_tasks", {task_id: task})
    monkeypatch.setattr(legacy_server, "_user_pending", {"direct": 1})

    async with _client(legacy_server) as client:
        anonymous = await client.delete(f"/api/task/{task_id}")
        cancelled = await client.delete(
            f"/api/task/{task_id}",
            headers={"Authorization": f"Bearer {grant.capability_token}"},
        )

    assert anonymous.status_code == 401
    assert cancelled.status_code == 200
    assert task["status"] == "cancelled"


@pytest.mark.asyncio
async def test_bot_task_owner_mismatch_is_404_for_read_and_cancel(
    legacy_server: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    owner = legacy_server.BotSession("owner-session", "code", "owner", 1.0, time.time())
    attacker = legacy_server.BotSession("attacker-session", "code", "attacker", 1.0, time.time())
    monkeypatch.setattr(
        legacy_server.bot_auth_manager,
        "sessions",
        {owner.session_id: owner, attacker.session_id: attacker},
    )
    task = {
        "task_id": "private-job",
        "status": "queued",
        "result": None,
        "step": 0,
        "total_steps": 1,
        "created_at": time.time(),
        "user_id": "web_owner",
    }
    legacy_server._task_access.bind_record(
        task,
        ResourceOwner(legacy_server._BOT_TASK_TENANT_ID, "owner"),
    )
    await _create_job(
        legacy_server,
        job_id="private-job",
        resource=ResourceOwner(legacy_server._BOT_TASK_TENANT_ID, "owner"),
    )
    monkeypatch.setattr(legacy_server, "_generation_tasks", {"private-job": task})

    async with _client(legacy_server) as client:
        denied_read = await client.get("/api/task/private-job?session_id=attacker-session")
        denied_cancel = await client.delete("/api/task/private-job?session_id=attacker-session")
        allowed = await client.get("/api/task/private-job?session_id=owner-session")

    assert denied_read.status_code == 404
    assert denied_cancel.status_code == 404
    assert task["status"] == "queued"
    assert allowed.status_code == 200


@pytest.mark.asyncio
async def test_bot_submit_binds_owner_and_replays_idempotently(
    legacy_server: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    owner = legacy_server.BotSession("owner-session", "code", "owner", 1.0, time.time())
    attacker = legacy_server.BotSession("attacker-session", "code", "attacker", 1.0, time.time())
    monkeypatch.setattr(
        legacy_server.bot_auth_manager,
        "sessions",
        {owner.session_id: owner, attacker.session_id: attacker},
    )
    monkeypatch.setattr(legacy_server.bot_auth_manager, "tasks", {})
    tasks: dict[str, dict[str, Any]] = {}
    monkeypatch.setattr(legacy_server, "_generation_tasks", tasks)
    calls = 0

    async def fake_enqueue(
        params,
        user_id="",
        allow_boost=True,
        *,
        resource,
        task_id=None,
        task_metadata=None,
        idempotency_key=None,
        request_hash=None,
    ):
        nonlocal calls
        calls += 1
        record = {
            "task_id": task_id,
            "status": "queued",
            "result": None,
            "step": 0,
            "total_steps": 1,
            "created_at": time.time(),
            "user_id": user_id,
            **(task_metadata or {}),
        }
        legacy_server._task_access.bind_record(record, resource)
        tasks[task_id] = record
        await legacy_server._cloud_jobs.create(
            job_id=task_id,
            resource=resource,
            request_hash=request_hash,
            payload={"model": "test"},
            idempotency_key=idempotency_key,
            total_steps=1,
        )
        return task_id, 1, True

    monkeypatch.setattr(legacy_server, "enqueue_generation", fake_enqueue)
    request = {"session_id": "owner-session", "params": {"positivePrompt": "cat"}}
    headers = {"Idempotency-Key": "same-submit"}
    async with _client(legacy_server) as client:
        first = await client.post("/api/bot/generate", json=request, headers=headers)
        tasks.clear()
        replay = await client.post("/api/bot/generate", json=request, headers=headers)
        conflict = await client.post(
            "/api/bot/generate",
            json={"session_id": "owner-session", "params": {"positivePrompt": "dog"}},
            headers=headers,
        )
        stolen = await client.post(
            "/api/bot/task",
            json={"task_id": first.json()["task_id"], "session_id": "attacker-session"},
        )

    assert first.status_code == 200
    assert replay.status_code == 200
    assert replay.json()["task_id"] == first.json()["task_id"]
    assert conflict.status_code == 409
    assert stolen.status_code == 404
    assert calls == 1
    job = await legacy_server._cloud_jobs.get(first.json()["task_id"])
    assert job and job.resource.tenant_id == legacy_server._BOT_TASK_TENANT_ID
    assert job.resource.owner_id == "owner"


@pytest.mark.asyncio
async def test_restart_marks_running_interrupted_and_preserves_owner_auth(
    legacy_server: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    owner = legacy_server.BotSession("owner-session", "code", "owner", 1.0, time.time())
    attacker = legacy_server.BotSession("attacker-session", "code", "attacker", 1.0, time.time())
    monkeypatch.setattr(
        legacy_server.bot_auth_manager,
        "sessions",
        {owner.session_id: owner, attacker.session_id: attacker},
    )
    resource = ResourceOwner(legacy_server._BOT_TASK_TENANT_ID, "owner")
    await _create_job(
        legacy_server,
        job_id="crashed-job",
        resource=resource,
        status=JobStatus.RUNNING,
    )
    restarted = SQLiteCloudJobRepository(legacy_server._cloud_jobs.path)
    await restarted.initialize()
    recovered = await restarted.recover_interrupted()
    monkeypatch.setattr(legacy_server, "_cloud_jobs", restarted)
    monkeypatch.setattr(legacy_server, "_generation_tasks", {})

    async with _client(legacy_server) as client:
        allowed = await client.get("/api/task/crashed-job?session_id=owner-session")
        denied = await client.get("/api/task/crashed-job?session_id=attacker-session")

    assert [job.id for job in recovered] == ["crashed-job"]
    assert allowed.status_code == 200
    assert allowed.json()["status"] == "interrupted"
    assert denied.status_code == 404


@pytest.mark.asyncio
async def test_websocket_snapshot_then_sequence_replay(
    legacy_server: ModuleType,
) -> None:
    task_id = "reconnect-job"
    grant = legacy_server._task_access.issue_anonymous(
        job_id=task_id,
        tenant_id=legacy_server._DIRECT_TASK_TENANT_ID,
    )
    await _create_job(legacy_server, job_id=task_id, resource=grant.resource)
    await legacy_server._cloud_jobs.transition(task_id, JobStatus.RUNNING, kind="started")
    await legacy_server._cloud_jobs.transition(
        task_id,
        JobStatus.FAILED,
        kind="failed",
        error="upstream failed",
    )
    socket = FakeWebSocket(
        f"job-capability.{grant.capability_token}",
        legacy_server.WebSocketDisconnect,
    )

    await legacy_server.websocket_generation_task(socket, task_id, after_sequence=2)

    assert socket.sent[0]["type"] == "job_snapshot"
    replayed = [
        message["event"]["sequence"]
        for message in socket.sent
        if message.get("type") == "job_event"
    ]
    # The current snapshot already covers the terminal event at sequence 3.
    assert socket.sent[0]["sequence"] == 3
    assert replayed == []


@pytest.mark.asyncio
async def test_task_websocket_snapshot_race_is_gapless_and_ignores_future_cursor(
    legacy_server: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    task_id = "snapshot-race-job"
    grant = legacy_server._task_access.issue_anonymous(
        job_id=task_id,
        tenant_id=legacy_server._DIRECT_TASK_TENANT_ID,
    )
    await _create_job(legacy_server, job_id=task_id, resource=grant.resource)
    original_snapshot = legacy_server._cloud_jobs.snapshot_with_watermark
    transitioned = False

    async def snapshot_then_transition(job_id: str):
        nonlocal transitioned
        snapshot = await original_snapshot(job_id)
        if not transitioned:
            transitioned = True
            await legacy_server._cloud_jobs.transition(
                job_id,
                JobStatus.RUNNING,
                kind="started",
            )
            await legacy_server._cloud_jobs.transition(
                job_id,
                JobStatus.FAILED,
                kind="failed",
                error="fake failure",
            )
        return snapshot

    monkeypatch.setattr(
        legacy_server._cloud_jobs,
        "snapshot_with_watermark",
        snapshot_then_transition,
    )
    socket = FakeWebSocket(
        f"job-capability.{grant.capability_token}",
        legacy_server.WebSocketDisconnect,
    )

    await legacy_server.websocket_generation_task(
        socket,
        task_id,
        after_sequence=999_999,
    )

    assert socket.sent[0]["type"] == "job_snapshot"
    assert socket.sent[0]["sequence"] == 1
    event_sequences = [
        message["event"]["sequence"]
        for message in socket.sent
        if message.get("type") == "job_event"
    ]
    assert event_sequences == [2, 3]
    wire_sequences = [
        int(message.get("sequence", message.get("event", {}).get("sequence")))
        for message in socket.sent
        if "sequence" in message or "sequence" in message.get("event", {})
    ]
    assert wire_sequences == sorted(wire_sequences)


@pytest.mark.asyncio
async def test_cancel_barrier_before_provider_claim_never_calls_upstream(
    legacy_server: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    task_id = "cancel-race-job"
    grant = legacy_server._task_access.issue_anonymous(
        job_id=task_id,
        tenant_id=legacy_server._DIRECT_TASK_TENANT_ID,
    )
    await _create_job(
        legacy_server,
        job_id=task_id,
        resource=grant.resource,
        status=JobStatus.RUNNING,
    )
    task_record = {"status": "generating", "user_id": "direct"}
    legacy_server._task_access.bind_record(task_record, grant.resource)
    monkeypatch.setattr(legacy_server, "_generation_tasks", {task_id: task_record})
    entered = asyncio.Event()
    release = asyncio.Event()
    original_claim = legacy_server._cloud_jobs.mark_provider_attempted

    async def barrier_claim(job_id: str):
        entered.set()
        await release.wait()
        return await original_claim(job_id)

    monkeypatch.setattr(legacy_server._cloud_jobs, "mark_provider_attempted", barrier_claim)
    provider_called = False

    async def provider() -> bytes:
        nonlocal provider_called
        provider_called = True
        return PNG

    runner = asyncio.create_task(legacy_server._await_generation_upstream(task_id, provider))
    await entered.wait()
    async with _client(legacy_server) as client:
        cancelled = await client.delete(
            f"/api/task/{task_id}",
            headers={"Authorization": f"Bearer {grant.capability_token}"},
        )
    during_race = await legacy_server._cloud_jobs.get(task_id)
    release.set()
    assert await runner is None
    terminal = await legacy_server._cloud_jobs.get(task_id)

    assert cancelled.status_code == 200
    assert during_race and during_race.status is JobStatus.CANCELLING
    assert terminal and terminal.status is JobStatus.CANCELLED
    assert provider_called is False


@pytest.mark.asyncio
async def test_anima_uses_shared_bounded_admission(
    legacy_server: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    release = asyncio.Event()

    async def no_workers() -> None:
        return None

    async def held_anima(task_id, request) -> None:
        await release.wait()

    monkeypatch.setattr(legacy_server, "start_novelai_workers", no_workers)
    monkeypatch.setattr(legacy_server, "_run_anima_task", held_anima)
    monkeypatch.setattr(legacy_server, "_GENERATION_QUEUE_CAPACITY", 1)
    monkeypatch.setattr(legacy_server, "_image_queue", asyncio.Queue(maxsize=1))

    async with _client(legacy_server) as client:
        first = await client.post(
            "/api/generate",
            json={"positivePrompt": "cat", "image_backend": "anima"},
        )
        second = await client.post(
            "/api/generate",
            json={"positivePrompt": "dog", "image_backend": "anima"},
        )
    release.set()
    await asyncio.sleep(0)

    assert first.status_code == 200 and first.json()["success"] is True
    assert second.status_code == 200 and second.json()["success"] is False
    assert len(legacy_server._generation_tasks) == 1


@pytest.mark.asyncio
async def test_workshop_captures_only_after_atomic_result_write(
    legacy_server: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    repository, owner = await _configure_workshop(legacy_server, monkeypatch, tmp_path)

    async def successful_provider(**kwargs):
        return {
            "success": True,
            "image_base64": base64.b64encode(PNG).decode("ascii"),
            "mime_type": "image/png",
            "elapsed": 0.1,
        }

    monkeypatch.setattr(legacy_server, "_workshop_call_big_gpt", successful_provider)
    async with _client(legacy_server) as client:
        created = await client.post(
            "/api/workshop/generate",
            json={
                "session_id": owner.session_id,
                "model": "gpt-image",
                "prompt": "cat",
            },
        )
    task_id = created.json()["task_id"]
    task = await _wait_workshop_terminal(legacy_server, task_id)
    job = await legacy_server._cloud_jobs.get(task_id)

    assert task["status"] == "success"
    assert job is not None and job.status is JobStatus.SUCCEEDED and job.result is not None
    assert job.payload["kind"] == "workshop"
    assert job.payload["prompt"] == "cat"
    assert "session_id" not in job.payload
    assert job.payload["quota"] == {"reservation_id": task_id, "units": 1}
    assert await legacy_server._cloud_job_results.load_bytes(job.result) == PNG
    balance = await repository.balance("owner", quota_date="2026-07-13")
    assert balance.total_available == 0


@pytest.mark.asyncio
async def test_workshop_write_failure_and_cancel_both_refund(
    legacy_server: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    repository, owner = await _configure_workshop(legacy_server, monkeypatch, tmp_path)

    async def successful_provider(**kwargs):
        return {
            "success": True,
            "image_base64": base64.b64encode(PNG).decode("ascii"),
            "mime_type": "image/png",
            "elapsed": 0.1,
        }

    original_save = legacy_server._cloud_job_results.save_base64

    async def failed_write(*args, **kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(legacy_server, "_workshop_call_big_gpt", successful_provider)
    monkeypatch.setattr(legacy_server._cloud_job_results, "save_base64", failed_write)
    async with _client(legacy_server) as client:
        failed = await client.post(
            "/api/workshop/generate",
            json={"session_id": owner.session_id, "model": "gpt-image", "prompt": "cat"},
        )
    failed_task = await _wait_workshop_terminal(legacy_server, failed.json()["task_id"])
    assert failed_task["status"] == "error"
    assert (await repository.balance("owner", quota_date="2026-07-13")).total_available == 1
    monkeypatch.setattr(legacy_server._cloud_job_results, "save_base64", original_save)

    started = asyncio.Event()
    provider_cancelled = asyncio.Event()

    async def held_provider(**kwargs):
        started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            provider_cancelled.set()
            raise

    monkeypatch.setattr(legacy_server, "_workshop_call_big_gpt", held_provider)
    async with _client(legacy_server) as client:
        held = await client.post(
            "/api/workshop/generate",
            json={"session_id": owner.session_id, "model": "gpt-image", "prompt": "dog"},
        )
        await started.wait()
        cancelled = await client.delete(
            f"/api/workshop/tasks/{held.json()['task_id']}?session_id={owner.session_id}"
        )

    assert cancelled.status_code == 200
    assert cancelled.json()["status"] == "cancelled"
    assert provider_cancelled.is_set()
    cancelled_job = await legacy_server._cloud_jobs.get(held.json()["task_id"])
    assert cancelled_job is not None and cancelled_job.status is JobStatus.CANCELLED
    event_kinds = {
        event.kind for event in await legacy_server._cloud_jobs.list_events(held.json()["task_id"])
    }
    assert {
        "submitted",
        "started",
        "provider_started",
        "cancel_requested",
        "cancelled",
    } <= event_kinds
    assert (await repository.balance("owner", quota_date="2026-07-13")).total_available == 1


@pytest.mark.asyncio
async def test_workshop_cancel_during_result_commit_finishes_as_deliverable_success(
    legacy_server: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    repository, owner = await _configure_workshop(legacy_server, monkeypatch, tmp_path)
    save_entered = asyncio.Event()
    allow_save = asyncio.Event()
    original_save = legacy_server._cloud_job_results.save_base64

    async def successful_provider(**kwargs):
        return {
            "success": True,
            "image_base64": base64.b64encode(PNG).decode("ascii"),
            "mime_type": "image/png",
            "elapsed": 0.1,
        }

    async def held_save(*args, **kwargs):
        save_entered.set()
        await allow_save.wait()
        return await original_save(*args, **kwargs)

    monkeypatch.setattr(legacy_server, "_workshop_call_big_gpt", successful_provider)
    monkeypatch.setattr(legacy_server._cloud_job_results, "save_base64", held_save)
    async with _client(legacy_server) as client:
        created = await client.post(
            "/api/workshop/generate",
            json={"session_id": owner.session_id, "model": "gpt-image", "prompt": "cat"},
        )
        task_id = created.json()["task_id"]
        await save_entered.wait()
        cancellation = asyncio.create_task(
            client.delete(f"/api/workshop/tasks/{task_id}?session_id={owner.session_id}")
        )
        for _ in range(100):
            job = await legacy_server._cloud_jobs.get(task_id)
            if job is not None and job.status is JobStatus.CANCELLING:
                break
            await asyncio.sleep(0.001)
        else:
            raise AssertionError("workshop cancellation did not reach cancelling")
        allow_save.set()
        cancelled = await cancellation
        tasks = await client.get(f"/api/workshop/tasks?session_id={owner.session_id}")
        image = await client.get(tasks.json()["tasks"][0]["image_url"])

    job = await legacy_server._cloud_jobs.get(task_id)
    assert cancelled.json()["status"] == "success"
    assert job is not None and job.status is JobStatus.SUCCEEDED
    assert image.status_code == 200 and image.content == PNG
    assert (await repository.balance("owner", quota_date="2026-07-13")).total_available == 0


@pytest.mark.asyncio
async def test_workshop_task_and_image_are_owner_bound(
    legacy_server: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    owner = legacy_server.BotSession("owner-session", "code", "owner", 1.0, time.time())
    attacker = legacy_server.BotSession("attacker-session", "code", "attacker", 1.0, time.time())
    monkeypatch.setattr(
        legacy_server.bot_auth_manager,
        "sessions",
        {owner.session_id: owner, attacker.session_id: attacker},
    )
    metadata = await legacy_server._cloud_job_results.save_base64(
        "ws_private",
        base64.b64encode(PNG).decode("ascii"),
        mime_type="image/png",
    )
    await legacy_server._cloud_jobs.create(
        job_id="ws_private",
        resource=ResourceOwner(legacy_server._BOT_TASK_TENANT_ID, "owner"),
        request_hash="0" * 64,
        payload={
            "kind": "workshop",
            "model": "gpt-image",
            "prompt": "private prompt",
            "aspect_ratio": "auto",
        },
        idempotency_key=None,
        total_steps=1,
    )
    await legacy_server._cloud_jobs.transition("ws_private", JobStatus.RUNNING)
    await legacy_server._cloud_jobs.transition(
        "ws_private",
        JobStatus.SUCCEEDED,
        result=metadata,
        step=1,
        total_steps=1,
    )
    filename = str(metadata["path"])

    async with _client(legacy_server) as client:
        owner_tasks = await client.get("/api/workshop/tasks?session_id=owner-session")
        attacker_tasks = await client.get("/api/workshop/tasks?session_id=attacker-session")
        image_url = owner_tasks.json()["tasks"][0]["image_url"]
        anonymous_image = await client.get(f"/api/workshop/images/{filename}")
        owner_image = await client.get(image_url)
        cross_cancel = await client.delete(
            "/api/workshop/tasks/ws_private?session_id=attacker-session"
        )

    assert owner_tasks.status_code == 200
    assert attacker_tasks.json() == {"tasks": []}
    assert anonymous_image.status_code == 404
    assert cross_cancel.status_code == 404
    assert owner_image.status_code == 200
    assert owner_image.content == PNG
    assert owner_image.headers["cache-control"] == "private, max-age=600"


@pytest.mark.asyncio
async def test_workshop_restart_interrupts_running_cancels_queued_and_refunds(
    legacy_server: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    repository, owner = await _configure_workshop(legacy_server, monkeypatch, tmp_path)
    resource = ResourceOwner(legacy_server._BOT_TASK_TENANT_ID, owner.bot_user_id)
    payload = {
        "kind": "workshop",
        "model": "gpt-image",
        "prompt": "restart me",
        "aspect_ratio": "auto",
    }
    await repository.reserve(
        owner.bot_user_id,
        job_id="ws_running",
        units=1,
        quota_date="2026-07-13",
        result_filename="ws_running.png",
    )
    for job_id in ("ws_running", "ws_queued"):
        await legacy_server._cloud_jobs.create(
            job_id=job_id,
            resource=resource,
            request_hash=("1" if job_id.endswith("running") else "2") * 64,
            payload=payload,
            idempotency_key=None,
            total_steps=1,
        )
    await legacy_server._cloud_jobs.transition("ws_running", JobStatus.RUNNING)
    monkeypatch.setattr(legacy_server, "_workshop_tasks", {})
    monkeypatch.setattr(legacy_server, "_workshop_background_tasks", {})

    recovered = await legacy_server._recover_workshop_jobs()
    captured, refunded = await repository.recover_jobs(set())
    running = await legacy_server._cloud_jobs.get("ws_running")
    queued = await legacy_server._cloud_jobs.get("ws_queued")

    assert {job.id for job in recovered} == {"ws_running", "ws_queued"}
    assert running is not None and running.status is JobStatus.INTERRUPTED
    assert queued is not None and queued.status is JobStatus.CANCELLED
    assert (captured, refunded) == (0, 1)
    assert (await repository.balance("owner", quota_date="2026-07-13")).total_available == 1
    assert (await legacy_server._cloud_jobs.recover_interrupted()) == []
    assert (await legacy_server._cloud_jobs.list_events("ws_running"))[-1].kind == "interrupted"
    assert (await legacy_server._cloud_jobs.list_events("ws_queued"))[-1].kind == (
        "cancelled_on_restart"
    )


@pytest.mark.asyncio
async def test_workshop_restart_captures_committed_result_and_restores_access(
    legacy_server: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    repository, owner = await _configure_workshop(legacy_server, monkeypatch, tmp_path)
    resource = ResourceOwner(legacy_server._BOT_TASK_TENANT_ID, owner.bot_user_id)
    await repository.reserve(
        owner.bot_user_id,
        job_id="ws_recovered",
        units=1,
        quota_date="2026-07-13",
        result_filename="ws_recovered.png",
    )
    await legacy_server._cloud_jobs.create(
        job_id="ws_recovered",
        resource=resource,
        request_hash="3" * 64,
        payload={
            "kind": "workshop",
            "model": "gpt-image",
            "prompt": "persist me",
            "aspect_ratio": "auto",
        },
        idempotency_key=None,
        total_steps=1,
    )
    await legacy_server._cloud_jobs.transition("ws_recovered", JobStatus.RUNNING)
    metadata = await legacy_server._cloud_job_results.save_base64(
        "ws_recovered",
        base64.b64encode(PNG).decode("ascii"),
        mime_type="image/png",
    )
    await legacy_server._cloud_jobs.transition(
        "ws_recovered",
        JobStatus.SUCCEEDED,
        result=metadata,
        step=1,
        total_steps=1,
    )
    monkeypatch.setattr(legacy_server, "_workshop_tasks", {})

    captured, refunded = await repository.recover_jobs({"ws_recovered"})
    async with _client(legacy_server) as client:
        tasks = await client.get(f"/api/workshop/tasks?session_id={owner.session_id}")
        image = await client.get(tasks.json()["tasks"][0]["image_url"])

    assert (captured, refunded) == (1, 0)
    assert (await repository.balance("owner", quota_date="2026-07-13")).total_available == 0
    assert tasks.json()["tasks"][0]["status"] == "success"
    assert image.status_code == 200 and image.content == PNG


@pytest.mark.asyncio
async def test_chunked_auth_body_is_rejected_from_received_size(
    legacy_server: ModuleType,
) -> None:
    async def chunks():
        yield b"{" + b'"x":"' + b"a" * 40_000
        yield b"b" * 40_000 + b'"}'

    async with _client(legacy_server) as client:
        response = await client.post(
            "/api/bot/auth/check",
            content=chunks(),
            headers={"Content-Type": "application/json", "Content-Length": "1"},
        )

    assert response.status_code == 413
    assert response.json()["code"] == "request_body_too_large"


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["/api/vibe/encode", "/api/upscale"])
async def test_chunked_image_operation_body_uses_32_mib_wire_limit(
    legacy_server: ModuleType,
    path: str,
) -> None:
    async def chunks():
        yield b'{"image":"' + b"a" * (17 * 1024 * 1024)
        yield b"b" * (17 * 1024 * 1024)

    async with _client(legacy_server) as client:
        response = await client.post(
            path,
            content=chunks(),
            headers={"Content-Type": "application/json", "Content-Length": "1"},
        )

    assert response.status_code == 413
    assert response.json() == {
        "detail": "request body is too large",
        "code": "request_body_too_large",
        "limit": 32 * 1024 * 1024,
    }


@pytest.mark.asyncio
async def test_legacy_cors_allows_only_configured_exact_origins(
    legacy_server: ModuleType,
) -> None:
    preflight_headers = {
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,x-bot-session",
    }
    async with _client(legacy_server) as client:
        allowed = await client.options(
            "/api/bot/auth/check",
            headers={"Origin": "http://localhost:5173", **preflight_headers},
        )
        denied = await client.options(
            "/api/bot/auth/check",
            headers={"Origin": "https://attacker.example", **preflight_headers},
        )

    assert allowed.status_code == 200
    assert allowed.headers["access-control-allow-origin"] == "http://localhost:5173"
    assert allowed.headers.get("access-control-allow-credentials") is None
    assert denied.status_code == 400
    assert "access-control-allow-origin" not in denied.headers


def test_legacy_cors_configuration_rejects_wildcards_and_url_paths(
    legacy_server: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(legacy_server._appcfg, "LEGACY_CORS_ORIGINS", ["*"], raising=False)
    with pytest.raises(RuntimeError, match="exact bounded origins"):
        legacy_server._configured_legacy_cors_origins()

    monkeypatch.setattr(
        legacy_server._appcfg,
        "LEGACY_CORS_ORIGINS",
        ["https://example.com/application"],
        raising=False,
    )
    with pytest.raises(RuntimeError, match="invalid CORS origin"):
        legacy_server._configured_legacy_cors_origins()


def test_legacy_body_limit_tiers_use_longest_route_prefix(
    legacy_server: ModuleType,
) -> None:
    async def unused_app(scope, receive, send) -> None:
        raise AssertionError("limit lookup must not invoke the app")

    middleware = legacy_server.StreamingBodyLimitMiddleware(
        unused_app,
        default_limit=legacy_server._LEGACY_DEFAULT_BODY_LIMIT,
        path_limits=legacy_server._LEGACY_BODY_PATH_LIMITS,
    )

    assert middleware.limit_for("/api/generate") == 72 * 1024 * 1024
    assert middleware.limit_for("/api/bot/auth/check") == 64 * 1024
    assert middleware.limit_for("/api/bot/task") == 4 * 1024 * 1024
    assert middleware.limit_for("/api/bot/task/update") == 44 * 1024 * 1024
    assert middleware.limit_for("/api/bot/task/progress") == 32 * 1024 * 1024
    assert middleware.limit_for("/api/vibe/encode") == 32 * 1024 * 1024
    assert middleware.limit_for("/api/upscale") == 32 * 1024 * 1024
    assert middleware.limit_for("/api/cr/create") == 32 * 1024 * 1024
    assert middleware.limit_for("/api/agent/web/generate-prompt") == 28 * 1024 * 1024


@pytest.mark.asyncio
async def test_bot_service_operations_fail_closed_without_shared_secret(
    legacy_server: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(legacy_server._appcfg, "BOT_SHARED_SECRET", "", raising=False)
    monkeypatch.setattr(
        legacy_server._appcfg,
        "ALLOW_UNAUTHENTICATED_BOT_SERVICE",
        False,
        raising=False,
    )
    body = {"task_id": "missing", "step": 1, "total_steps": 1}
    async with _client(legacy_server) as client:
        unavailable = await client.post("/api/bot/task/progress", json=body)
        monkeypatch.setattr(
            legacy_server._appcfg,
            "BOT_SHARED_SECRET",
            "service-secret",
            raising=False,
        )
        denied = await client.post("/api/bot/task/progress", json=body)
        allowed = await client.post(
            "/api/bot/task/progress",
            json=body,
            headers={"X-Bot-Secret": "service-secret"},
        )

    assert unavailable.status_code == 503
    assert denied.status_code == 401
    assert allowed.status_code == 404


@pytest.mark.asyncio
async def test_paid_server_key_routes_require_one_verified_owner_and_strict_payloads(
    legacy_server: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    owner = legacy_server.BotSession("owner-session", "code", "owner", 1.0, time.time())
    attacker = legacy_server.BotSession(
        "attacker-session",
        "code",
        "attacker",
        1.0,
        time.time(),
    )
    monkeypatch.setattr(
        legacy_server.bot_auth_manager,
        "sessions",
        {owner.session_id: owner, attacker.session_id: attacker},
    )
    recorded: list[tuple[str, int, str]] = []

    async def recorder(owner_id: str, points: int, reason: str) -> None:
        recorded.append((owner_id, points, reason))

    monkeypatch.setattr(
        legacy_server,
        "_paid_operations",
        legacy_server.PaidOperationService(recorder),
    )
    monkeypatch.setattr(legacy_server, "_get_anlas_only_token", lambda: "fake-token")
    provider_calls: list[str] = []

    async def encode_provider(token: str, req: Any) -> str:
        provider_calls.append(f"vibe:{token}:{req.model}")
        return "encoded-vibe"

    async def upscale_provider(token: str, req: Any) -> Any:
        provider_calls.append(f"upscale:{token}:{req.scale}")
        return legacy_server.UpscaleResponse(success=True, image="upscaled", message="ok")

    async def translate_provider(messages: list, temperature: float, max_tokens: int) -> dict:
        provider_calls.append(f"translate:{temperature}:{max_tokens}:{len(messages)}")
        return {"choices": [{"message": {"content": "猫"}}]}

    async def skip_cache(*args: Any) -> None:
        return None

    monkeypatch.setattr(legacy_server, "_encode_vibe_upstream", encode_provider)
    monkeypatch.setattr(legacy_server, "_upscale_upstream", upscale_provider)
    monkeypatch.setattr(legacy_server, "_call_translate_en2zh_chat", translate_provider)
    monkeypatch.setattr(legacy_server, "_try_cache_public_vibe_encoding", skip_cache)

    encoded_image = base64.b64encode(PNG).decode("ascii")
    vibe_body = {
        "image": encoded_image,
        "information_extracted": 0.5,
        "model": "nai-diffusion-4-5-full",
    }
    upscale_body = {
        "image": encoded_image,
        "width": 832,
        "height": 1216,
        "scale": 4,
    }
    translate_body = {
        "messages": [{"role": "user", "content": "cat"}],
        "temperature": 0.3,
        "max_tokens": 32,
    }

    async with _client(legacy_server) as client:
        anonymous_vibe = await client.post("/api/vibe/encode", json=vibe_body)
        anonymous_upscale = await client.post("/api/upscale", json=upscale_body)
        anonymous_translate = await client.post("/api/translate/en2zh", json=translate_body)
        conflict = await client.post(
            "/api/vibe/encode",
            headers={"X-Bot-Session": owner.session_id},
            json={**vibe_body, "session_id": attacker.session_id},
        )
        extra = await client.post(
            "/api/vibe/encode",
            headers={"X-Bot-Session": owner.session_id},
            json={**vibe_body, "ignored": True},
        )
        invalid_image = await client.post(
            "/api/upscale",
            headers={"X-Bot-Session": owner.session_id},
            json={**upscale_body, "image": "not-base64"},
        )
        invalid_message = await client.post(
            "/api/translate/en2zh",
            headers={"X-Bot-Session": owner.session_id},
            json={
                **translate_body,
                "messages": [{"role": "user", "content": "cat", "ignored": True}],
            },
        )
        valid_vibe = await client.post(
            "/api/vibe/encode",
            headers={"X-Bot-Session": owner.session_id},
            json=vibe_body,
        )
        valid_upscale = await client.post(
            "/api/upscale",
            headers={"X-Bot-Session": owner.session_id},
            json=upscale_body,
        )
        compat_translate = await client.post(
            "/api/translate/en2zh",
            json={**translate_body, "session_id": owner.session_id},
        )

    assert [
        anonymous_vibe.status_code,
        anonymous_upscale.status_code,
        anonymous_translate.status_code,
        conflict.status_code,
    ] == [401, 401, 401, 401]
    assert [extra.status_code, invalid_image.status_code, invalid_message.status_code] == [
        422,
        422,
        422,
    ]
    assert valid_vibe.json() == {"encoding": "encoded-vibe"}
    assert valid_upscale.json() == {"success": True, "image": "upscaled", "message": "ok"}
    assert compat_translate.status_code == 200
    assert provider_calls == [
        "vibe:fake-token:nai-diffusion-4-5-full",
        "upscale:fake-token:4",
        "translate:0.3:32:1",
    ]
    assert recorded == [
        ("owner", 2, "vibe编码"),
        ("owner", 6, "超分辨率(832x1216, 4x)"),
    ]


@pytest.mark.asyncio
async def test_paid_provider_failure_does_not_record_usage(
    legacy_server: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    owner = legacy_server.BotSession("owner-session", "code", "owner", 1.0, time.time())
    monkeypatch.setattr(legacy_server.bot_auth_manager, "sessions", {owner.session_id: owner})
    recorded: list[tuple[str, int, str]] = []

    async def recorder(owner_id: str, points: int, reason: str) -> None:
        recorded.append((owner_id, points, reason))

    async def failed_provider(token: str, req: Any) -> str:
        raise legacy_server.aiohttp.ClientConnectionError("fake failure")

    monkeypatch.setattr(
        legacy_server,
        "_paid_operations",
        legacy_server.PaidOperationService(recorder),
    )
    monkeypatch.setattr(legacy_server, "_get_anlas_only_token", lambda: "fake-token")
    monkeypatch.setattr(legacy_server, "_encode_vibe_upstream", failed_provider)
    encoded_image = base64.b64encode(PNG).decode("ascii")

    async with _client(legacy_server) as client:
        response = await client.post(
            "/api/vibe/encode",
            headers={"X-Bot-Session": owner.session_id},
            json={"image": encoded_image},
        )

    assert response.status_code == 502
    assert recorded == []


@pytest.mark.asyncio
async def test_paid_accounting_failure_returns_non_retryable_503_without_recalling_provider(
    legacy_server: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    owner = legacy_server.BotSession("owner-session", "code", "owner", 1.0, time.time())
    monkeypatch.setattr(legacy_server.bot_auth_manager, "sessions", {owner.session_id: owner})
    monkeypatch.setattr(legacy_server, "_STATS_DB", tmp_path / "missing-schema.db")
    with pytest.raises(aiosqlite.OperationalError):
        await legacy_server._record_web_stats_custom("owner", 2, "vibe")

    recorder_calls = 0

    async def failed_recorder(owner_id: str, points: int, reason: str) -> None:
        nonlocal recorder_calls
        recorder_calls += 1
        raise OSError("stats disk unavailable")

    monkeypatch.setattr(
        legacy_server,
        "_paid_operations",
        legacy_server.PaidOperationService(failed_recorder),
    )
    monkeypatch.setattr(legacy_server, "_get_anlas_only_token", lambda: "fake-token")
    provider_calls: list[str] = []

    async def encode_provider(token: str, req: Any) -> str:
        provider_calls.append("vibe")
        return "already-encoded"

    async def upscale_provider(token: str, req: Any) -> Any:
        provider_calls.append("upscale")
        return legacy_server.UpscaleResponse(success=True, image="upscaled", message="ok")

    monkeypatch.setattr(legacy_server, "_encode_vibe_upstream", encode_provider)
    monkeypatch.setattr(legacy_server, "_upscale_upstream", upscale_provider)
    encoded = base64.b64encode(PNG).decode("ascii")
    headers = {"X-Bot-Session": owner.session_id}
    async with _client(legacy_server) as client:
        vibe = await client.post(
            "/api/vibe/encode",
            headers=headers,
            json={"image": encoded},
        )
        upscale = await client.post(
            "/api/upscale",
            headers=headers,
            json={
                "image": encoded,
                "width": 832,
                "height": 1216,
                "scale": 4,
            },
        )

    assert [vibe.status_code, upscale.status_code] == [503, 503]
    assert "请勿自动重试" in vibe.json()["detail"]
    assert "请勿自动重试" in upscale.json()["detail"]
    assert provider_calls == ["vibe", "upscale"]
    assert recorder_calls == 2


def test_upscale_zip_rejects_excessive_member_count(legacy_server: ModuleType) -> None:
    payload = io.BytesIO()
    with zipfile.ZipFile(payload, "w") as archive:
        for index in range(129):
            archive.writestr(f"member-{index}.txt", b"")

    with pytest.raises(legacy_server.InvalidRequestError, match="too many members"):
        legacy_server._extract_upscale_result(payload.getvalue())


@pytest.mark.asyncio
async def test_agent_router_requires_one_verified_credential_family(
    legacy_server: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    owner = legacy_server.BotSession("owner-session", "code", "owner", 1.0, time.time())
    monkeypatch.setattr(legacy_server.bot_auth_manager, "sessions", {owner.session_id: owner})

    async with _client(legacy_server) as client:
        anonymous = await client.get("/api/agent/models")
        invalid = await client.get(
            "/api/agent/models",
            headers={"X-Bot-Session": "invalid"},
        )
        ordinary = await client.get(
            "/api/agent/models",
            headers={"X-Bot-Session": owner.session_id},
        )
        ambiguous = await client.get(
            f"/api/agent/models?session_id={owner.session_id}",
            headers={"X-Bot-Session": owner.session_id},
        )

    assert anonymous.status_code == 404
    assert invalid.status_code == 404
    assert ordinary.status_code == 200
    assert ambiguous.status_code == 404


@pytest.mark.asyncio
async def test_agent_router_hides_sensitive_operations_from_ordinary_sessions(
    legacy_server: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    owner = legacy_server.BotSession("owner-session", "code", "owner", 1.0, time.time())
    monkeypatch.setattr(legacy_server.bot_auth_manager, "sessions", {owner.session_id: owner})
    headers = {"X-Bot-Session": owner.session_id}

    async with _client(legacy_server) as client:
        model_mutation = await client.post(
            "/api/agent/models",
            json={"target": "deepseek"},
            headers=headers,
        )
        prompts = await client.get("/api/agent/prompts", headers=headers)
        health = await client.get("/api/agent/health", headers=headers)

    assert model_mutation.status_code == 404
    assert prompts.status_code == 404
    assert health.status_code == 404


@pytest.mark.asyncio
async def test_agent_router_rejects_cross_owner_history_and_forged_chat_claims(
    legacy_server: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    owner = legacy_server.BotSession("owner-session", "code", "owner", 1.0, time.time())
    monkeypatch.setattr(legacy_server.bot_auth_manager, "sessions", {owner.session_id: owner})

    async def deny_paid(_access) -> bool:
        return False

    monkeypatch.setattr(legacy_server.app.state, "agent_paid_authorizer", deny_paid)
    headers = {"X-Bot-Session": owner.session_id}
    base_chat = {
        "user_id": "owner",
        "platform": "qq",
        "scene": "private",
        "text": "hello",
    }

    async with _client(legacy_server) as client:
        cross_history = await client.get("/api/agent/history/qq_p_other", headers=headers)
        forged_owner = await client.post(
            "/api/agent/chat",
            json={**base_chat, "user_id": "other"},
            headers=headers,
        )
        forged_key = await client.post(
            "/api/agent/chat",
            json={**base_chat, "user_key": "qq_p_other"},
            headers=headers,
        )

    assert cross_history.status_code == 404
    assert forged_owner.status_code == 404
    assert forged_key.status_code == 404


@pytest.mark.asyncio
async def test_agent_paid_routes_require_live_quota(
    legacy_server: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    repository, owner = await _configure_workshop(legacy_server, monkeypatch, tmp_path)
    access = legacy_server.AgentAccess(
        Principal.user(owner.bot_user_id, legacy_server._BOT_TASK_TENANT_ID)
    )
    missing_access = legacy_server.AgentAccess(
        Principal.user("missing", legacy_server._BOT_TASK_TENANT_ID)
    )

    assert await legacy_server._authorize_agent_paid(access) is True
    assert await legacy_server._authorize_agent_paid(missing_access) is False

    async def deny_paid(_access) -> bool:
        return False

    monkeypatch.setattr(legacy_server.app.state, "agent_paid_authorizer", deny_paid)
    async with _client(legacy_server) as client:
        denied = await client.post(
            "/api/agent/web/generate-prompt",
            json={"user_request": "draw a cat"},
            headers={"X-Bot-Session": owner.session_id},
        )

    assert denied.status_code == 402
    assert (await repository.balance("owner", quota_date="2026-07-13")).total_available == 1


@pytest.mark.asyncio
async def test_agent_admin_and_bot_service_credentials_have_explicit_powers(
    legacy_server: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(legacy_server._appcfg, "ADMIN_TOKEN", "admin-secret", raising=False)
    monkeypatch.setattr(legacy_server._appcfg, "BOT_SHARED_SECRET", "bot-secret", raising=False)

    config = sys.modules["config"]
    monkeypatch.setattr(
        config,
        "switch_model",
        lambda target: ("test", {"label": "test", "model": target or "test"}),
    )

    async with _client(legacy_server) as client:
        forged_admin = await client.post(
            "/api/agent/models",
            json={"target": "model"},
            headers={"X-Admin-Token": "wrong"},
        )
        admin = await client.post(
            "/api/agent/models",
            json={"target": "model"},
            headers={"X-Admin-Token": "admin-secret"},
        )
        bot_read = await client.get(
            "/api/agent/models",
            headers={"X-Bot-Secret": "bot-secret"},
        )
        mixed = await client.get(
            "/api/agent/models",
            headers={
                "X-Admin-Token": "admin-secret",
                "X-Bot-Secret": "bot-secret",
            },
        )

    assert forged_admin.status_code == 404
    assert admin.status_code == 200
    assert admin.json()["active"] == "test"
    assert bot_read.status_code == 200
    assert mixed.status_code == 404


def _configure_legacy_library(
    legacy_server: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> tuple[Any, Any]:
    owner = legacy_server.BotSession("owner-session", "", "alice/team", 1.0, time.time())
    attacker = legacy_server.BotSession("attacker-session", "", "aliceteam", 1.0, time.time())
    monkeypatch.setattr(
        legacy_server.bot_auth_manager,
        "sessions",
        {owner.session_id: owner, attacker.session_id: attacker},
    )
    ownership = legacy_server.LibraryOwnershipService()
    monkeypatch.setattr(legacy_server, "_library_ownership", ownership)
    monkeypatch.setattr(
        legacy_server,
        "_private_library",
        legacy_server.OwnerScopedLibraryStorage(tmp_path / "user_vibes", ownership),
    )
    monkeypatch.setattr(
        legacy_server,
        "_oc_store",
        legacy_server.SafeJsonStore(tmp_path / "oc.json"),
    )
    monkeypatch.setattr(
        legacy_server,
        "_artist_store",
        legacy_server.SafeJsonStore(tmp_path / "artists.json"),
    )
    monkeypatch.setattr(
        legacy_server,
        "_cr_store",
        legacy_server.SafeJsonStore(tmp_path / "cr.json"),
    )
    monkeypatch.setattr(legacy_server, "BOT_VIBES_DIR", tmp_path / "public_vibes")
    monkeypatch.setattr(legacy_server, "ARTIST_IMAGES_DIR", tmp_path / "artist_images")
    monkeypatch.setattr(legacy_server, "CR_IMAGES_DIR", tmp_path / "cr_images")
    return owner, attacker


@pytest.mark.asyncio
async def test_private_library_uses_principal_namespace_and_rejects_credential_conflicts(
    legacy_server: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    owner, attacker = _configure_legacy_library(legacy_server, monkeypatch, tmp_path)

    async with _client(legacy_server) as client:
        uploaded = await client.post(
            "/api/user-vibes/upload",
            headers={"X-Bot-Session": owner.session_id},
            json={
                "session_id": owner.session_id,
                "filename": "private.naiv4vibe",
                "vibe_data": {
                    "id": "private",
                    "name": "owner secret",
                    "image": base64.b64encode(PNG).decode("ascii"),
                },
            },
        )
        owner_read = await client.get(
            "/api/user-vibes/file/private.naiv4vibe",
            headers={"X-Bot-Session": owner.session_id},
        )
        matching_query_and_header = await client.get(
            f"/api/user-vibes/state?session_id={owner.session_id}",
            headers={"X-Bot-Session": owner.session_id},
        )
        cross_owner = await client.get(
            "/api/user-vibes/file/private.naiv4vibe",
            headers={"X-Bot-Session": attacker.session_id},
        )
        owner_thumbnail = await client.get(
            "/api/user-vibes/thumbnail/private.naiv4vibe",
            headers={"X-Bot-Session": owner.session_id},
        )
        cross_owner_thumbnail = await client.get(
            "/api/user-vibes/thumbnail/private.naiv4vibe",
            headers={"X-Bot-Session": attacker.session_id},
        )
        conflicting_query_and_header = await client.get(
            f"/api/user-vibes/state?session_id={owner.session_id}",
            headers={"X-Bot-Session": attacker.session_id},
        )
        duplicate_headers = await client.get(
            "/api/user-vibes/state",
            headers=[
                ("X-Bot-Session", owner.session_id),
                ("X-Bot-Session", owner.session_id),
            ],
        )
        conflict = await client.put(
            "/api/user-vibes/tag-pool",
            headers={"X-Bot-Session": attacker.session_id},
            json={"session_id": owner.session_id, "tags": ["forged"]},
        )
        owner_backup = await client.post(
            "/api/user-artists/backup",
            headers={"X-Bot-Session": owner.session_id},
            json={"session_id": owner.session_id, "artists": [{"name": "private"}]},
        )
        attacker_backup = await client.get(
            "/api/user-artists/backup",
            headers={"X-Bot-Session": attacker.session_id},
        )

    assert uploaded.status_code == 200
    assert owner_read.status_code == 200 and owner_read.json()["name"] == "owner secret"
    assert matching_query_and_header.status_code == 200
    assert cross_owner.status_code == 404
    assert owner_thumbnail.status_code == 200 and owner_thumbnail.content == PNG
    assert owner_thumbnail.headers["cache-control"] == "private, no-cache"
    assert "X-Bot-Session" in owner_thumbnail.headers["vary"]
    assert owner_read.headers["cache-control"] == "private, no-cache"
    assert cross_owner_thumbnail.status_code == 404
    assert conflicting_query_and_header.status_code == 401
    assert duplicate_headers.status_code == 401
    assert conflict.status_code == 401
    assert owner_backup.status_code == 200
    assert attacker_backup.status_code == 200 and attacker_backup.json()["artists"] == []

    owner_principal = legacy_server.Principal.user(
        owner.bot_user_id,
        legacy_server._BOT_TASK_TENANT_ID,
    )
    attacker_principal = legacy_server.Principal.user(
        attacker.bot_user_id,
        legacy_server._BOT_TASK_TENANT_ID,
    )
    owner_dir = legacy_server._private_library.namespace(owner_principal)
    attacker_dir = legacy_server._private_library.namespace(attacker_principal)
    assert owner_dir != attacker_dir
    assert json.loads((owner_dir / ".owner.json").read_text(encoding="utf-8")) == {
        "version": 1,
        "tenant_id": legacy_server._BOT_TASK_TENANT_ID,
        "owner_id": owner.bot_user_id,
    }


@pytest.mark.asyncio
async def test_public_library_reads_stay_public_but_writes_are_owner_bound(
    legacy_server: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    owner, attacker = _configure_legacy_library(legacy_server, monkeypatch, tmp_path)
    owner_headers = {"X-Bot-Session": owner.session_id}
    attacker_headers = {"X-Bot-Session": attacker.session_id}
    await legacy_server._oc_store.save(
        {
            "OC_LEGACY_FORGED": {
                "tag_group": "legacy",
                "created_by": attacker.bot_user_id,
                "images": {},
            }
        }
    )
    await legacy_server._artist_store.save(
        {
            "LEGACY": {
                "artist_string": "legacy",
                "added_by": attacker.bot_user_id,
            }
        }
    )

    async with _client(legacy_server) as client:
        forged_legacy_oc = await client.put(
            "/api/oc/OC_LEGACY_FORGED",
            headers=attacker_headers,
            json={"tag_group": "claimed"},
        )
        forged_legacy_artist = await client.delete(
            "/api/artists/LEGACY",
            headers=attacker_headers,
        )
        anonymous_oc = await client.post(
            "/api/oc/create",
            json={"en_name": "OC_ANON", "tag_group": "anonymous"},
        )
        created_oc = await client.post(
            "/api/oc/create",
            headers=owner_headers,
            json={
                "en_name": "OC_OWNER",
                "tag_group": "owner",
                "created_by": attacker.bot_user_id,
            },
        )
        stolen_oc = await client.put(
            "/api/oc/OC_OWNER",
            headers=attacker_headers,
            json={"tag_group": "stolen", "created_by": attacker.bot_user_id},
        )
        conflict_oc = await client.put(
            "/api/oc/OC_OWNER",
            headers=attacker_headers,
            json={"session_id": owner.session_id, "tag_group": "stolen"},
        )
        owner_oc = await client.put(
            "/api/oc/OC_OWNER",
            headers=owner_headers,
            json={"tag_group": "updated", "created_by": attacker.bot_user_id},
        )

        created_artist = await client.post(
            "/api/artists/create",
            headers=owner_headers,
            json={"name": "A1", "artist_string": "style", "added_by": attacker.bot_user_id},
        )
        stolen_artist = await client.delete(
            "/api/artists/A1",
            headers=attacker_headers,
        )
        public_artist = await client.get("/api/artists/A1")

        created_cr = await client.post(
            "/api/cr/create",
            headers=owner_headers,
            json={
                "name": "reference",
                "image_base64": base64.b64encode(PNG).decode("ascii"),
            },
        )
        stolen_cr = await client.put(
            f"/api/cr/{created_cr.json()['cr']['id']}",
            headers=attacker_headers,
            json={"name": "stolen"},
        )
        public_crs = await client.get("/api/cr/list")

        created_vibe = await client.post(
            "/api/vibes/upload",
            headers=owner_headers,
            json={
                "session_id": owner.session_id,
                "name": "owner-vibe",
                "vibe_data": {
                    "name": "owner-vibe",
                    "owner_id": attacker.bot_user_id,
                    "uploader_id": attacker.bot_user_id,
                },
            },
        )
        vibe_filename = created_vibe.json()["filename"]
        stolen_vibe = await client.put(
            f"/api/vibes/file/{vibe_filename}",
            headers=attacker_headers,
            json={"session_id": attacker.session_id, "name": "stolen"},
        )
        public_vibe = await client.get(f"/api/vibes/file/{vibe_filename}")

    assert forged_legacy_oc.status_code == 404
    assert forged_legacy_artist.status_code == 404
    assert anonymous_oc.status_code == 401
    assert created_oc.status_code == 200
    assert created_oc.json()["oc"]["created_by"] == owner.bot_user_id
    assert stolen_oc.status_code == 404
    assert conflict_oc.status_code == 401
    assert owner_oc.status_code == 200

    stored_oc = await legacy_server._oc_store.load()
    assert stored_oc["OC_OWNER"]["owner_id"] == owner.bot_user_id
    assert stored_oc["OC_OWNER"]["tenant_id"] == legacy_server._BOT_TASK_TENANT_ID
    assert stored_oc["OC_OWNER"]["created_by"] == owner.bot_user_id

    assert created_artist.status_code == 200
    assert created_artist.json()["artist"]["added_by"] == owner.bot_user_id
    assert stolen_artist.status_code == 404
    assert public_artist.status_code == 200

    assert created_cr.status_code == 200
    assert stolen_cr.status_code == 404
    assert public_crs.status_code == 200 and public_crs.json()["total"] == 1

    assert created_vibe.status_code == 200
    assert stolen_vibe.status_code == 404
    assert public_vibe.status_code == 200
    assert public_vibe.json()["owner_id"] == owner.bot_user_id
    assert public_vibe.json()["tenant_id"] == legacy_server._BOT_TASK_TENANT_ID
    assert public_vibe.json()["uploader_id"] == owner.bot_user_id
