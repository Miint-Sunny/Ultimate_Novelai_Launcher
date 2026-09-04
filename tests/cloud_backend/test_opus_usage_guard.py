"""宿主钱包保护(P5-5):opus_usage_exhausted 第四道闸的接线与失败路径。

计价函数本身的翻转已有 test_legacy_v5_support 锚定;这里测的是**接线**:
usage 判定、60s 单飞缓存、fail-closed 方向、策略切换,以及入口、统计和
paid worker 出队调用点真正吃到这个布尔。
付费上游(/user/subscription 与生成)一律 fake。
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import importlib.util
import sys
import time
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

from cloud_backend.infrastructure import (
    CloudJobResultStore,
    SQLiteCloudJobRepository,
)
from cloud_backend.identity import ResourceOwner
from cloud_backend.legacy_adapter import LegacyQuotaLedger
from cloud_backend.opus_usage import (
    OpusExhaustedPolicy,
    OpusUsageCache,
    is_usage_exhausted,
    parse_policy,
)

ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / "server"


@pytest.fixture(scope="module")
def legacy_app() -> ModuleType:
    previous_config = sys.modules.get("config")
    sys.path.insert(0, str(SERVER))
    config_spec = importlib.util.spec_from_file_location("config", SERVER / "config.example.py")
    assert config_spec and config_spec.loader
    config = importlib.util.module_from_spec(config_spec)
    sys.modules["config"] = config
    config_spec.loader.exec_module(config)
    config.JOB_CAPABILITY_SECRET = bytes(range(32))

    app_spec = importlib.util.spec_from_file_location("legacy_opus_guard_app", SERVER / "app.py")
    assert app_spec and app_spec.loader
    module = importlib.util.module_from_spec(app_spec)
    sys.modules["legacy_opus_guard_app"] = module
    app_spec.loader.exec_module(module)
    yield module
    sys.modules.pop("legacy_opus_guard_app", None)
    if previous_config is not None:
        sys.modules["config"] = previous_config


@pytest.fixture(autouse=True)
async def isolated_persistent_jobs(
    legacy_app: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    # 端点会先 _ensure_cloud_job_storage();默认落 server/data/cloud_jobs.db,
    # 不换掉的话测试任务会被持久化,下一次运行命中幂等重放(造过一次这个坑)。
    jobs = SQLiteCloudJobRepository(tmp_path / "jobs.db")
    results = CloudJobResultStore(tmp_path / "results")
    await jobs.initialize()
    await results.initialize()
    monkeypatch.setattr(legacy_app, "_cloud_jobs", jobs)
    monkeypatch.setattr(legacy_app, "_cloud_job_results", results)
    monkeypatch.setattr(legacy_app, "_generation_upstream_tasks", {})
    monkeypatch.setattr(legacy_app, "_generation_admitting", 0)
    monkeypatch.setattr(legacy_app, "_generation_tasks", {})
    monkeypatch.setattr(legacy_app, "_user_pending", {})


# ---- usage 判定 ----


def test_usage_percent_zero_or_negative_means_exhausted() -> None:
    assert is_usage_exhausted({"percent": 0, "isNegative": False}) is True
    assert is_usage_exhausted({"percent": 12, "isNegative": True}) is True


def test_usage_percent_above_100_is_not_exhausted() -> None:
    # 官方上线时发过一次性加成,170 见过实测;只有 0 才算空。
    assert is_usage_exhausted({"percent": 170, "isNegative": False}) is False
    assert is_usage_exhausted({"percent": 1, "isNegative": False}) is False


def test_missing_or_malformed_usage_is_exhausted() -> None:
    # 拿不到/形状不对不能当「条是满的」——这是钱包方向上的 fail-closed。
    assert is_usage_exhausted(None) is True
    assert is_usage_exhausted({}) is True
    assert is_usage_exhausted({"percent": "很多", "isNegative": False}) is True
    assert is_usage_exhausted({"percent": True}) is True  # bool 不是数值


# ---- 策略解析 ----


def test_policy_defaults_to_reject_and_falls_back_on_garbage() -> None:
    assert parse_policy(None) is OpusExhaustedPolicy.REJECT
    assert parse_policy("") is OpusExhaustedPolicy.REJECT
    assert parse_policy("charge") is OpusExhaustedPolicy.CHARGE
    assert parse_policy("REJECT") is OpusExhaustedPolicy.REJECT
    # 拼错单词绝不能变成放宽:回落到安全默认。
    assert parse_policy("charqe") is OpusExhaustedPolicy.REJECT
    assert parse_policy(123) is OpusExhaustedPolicy.REJECT


# ---- 缓存(fake fetcher + 可注入时钟,不打任何上游) ----


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


@pytest.mark.asyncio
async def test_cache_hit_within_ttl_does_not_refetch() -> None:
    calls: list[int] = []

    async def fetcher() -> dict[str, bool]:
        calls.append(1)
        return {"tok-a": False}

    clock = FakeClock()
    cache = OpusUsageCache(fetcher, ttl_seconds=60.0, clock=clock)

    first = await cache.snapshot()
    second = await cache.snapshot()

    assert first.exhausted is False and first.data_available is True
    assert second is first  # 命中同一份快照
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_cache_expires_and_refetches() -> None:
    states: list[dict[str, bool]] = [{"tok-a": False}, {"tok-a": True}]

    async def fetcher() -> dict[str, bool]:
        return states.pop(0)

    clock = FakeClock()
    cache = OpusUsageCache(fetcher, ttl_seconds=60.0, clock=clock)

    assert (await cache.snapshot()).exhausted is False
    clock.now += 59.9
    assert (await cache.snapshot()).exhausted is False  # 仍在 TTL 内
    clock.now += 0.2
    assert (await cache.snapshot()).exhausted is True  # 过期重查拿到新状态
    assert states == []


@pytest.mark.asyncio
async def test_fetch_failure_is_fail_closed_and_cached_for_the_ttl() -> None:
    calls: list[int] = []

    async def fetcher() -> dict[str, bool]:
        calls.append(1)
        raise RuntimeError("subscription endpoint down")

    clock = FakeClock()
    cache = OpusUsageCache(fetcher, ttl_seconds=60.0, clock=clock)

    snapshot = await cache.snapshot()
    assert snapshot.exhausted is True
    assert snapshot.data_available is False

    await cache.snapshot()
    assert len(calls) == 1  # 失败也占一个 TTL,不反复敲打挂掉的上游

    clock.now += 60.1
    retry = await cache.snapshot()  # 窗口过后自动重试,失败依旧转成保守快照
    assert len(calls) == 2
    assert retry.exhausted is True
    assert retry.data_available is False


@pytest.mark.asyncio
async def test_empty_token_pool_is_fail_closed() -> None:
    async def fetcher() -> dict[str, bool]:
        return {}

    cache = OpusUsageCache(fetcher, ttl_seconds=60.0, clock=FakeClock())
    snapshot = await cache.snapshot()
    assert snapshot.exhausted is True
    assert snapshot.data_available is False


@pytest.mark.asyncio
async def test_mixed_token_pool_counts_as_exhausted() -> None:
    # 任一账号条空(含该账号查询失败)即按耗尽处理:混合池宁可错杀可见的免费,
    # 不可放过不可见的扣钱。单 token 部署无此歧义。
    async def mixed() -> dict[str, bool]:
        return {"healthy": False, "empty": True}

    cache = OpusUsageCache(mixed, ttl_seconds=60.0, clock=FakeClock())
    assert (await cache.snapshot()).exhausted is True

    async def all_healthy() -> dict[str, bool]:
        return {"a": False, "b": False}

    healthy_cache = OpusUsageCache(all_healthy, ttl_seconds=60.0, clock=FakeClock())
    assert (await healthy_cache.snapshot()).exhausted is False


@pytest.mark.asyncio
async def test_concurrent_misses_single_flight() -> None:
    import asyncio

    calls = 0
    gate = asyncio.Event()

    async def fetcher() -> dict[str, bool]:
        nonlocal calls
        calls += 1
        await gate.wait()
        return {"tok-a": False}

    cache = OpusUsageCache(fetcher, ttl_seconds=60.0, clock=FakeClock())
    first = asyncio.create_task(cache.snapshot())
    await asyncio.sleep(0)
    second = asyncio.create_task(cache.snapshot())
    await asyncio.sleep(0)
    gate.set()

    assert (await first).exhausted is False
    assert (await second).exhausted is False
    assert calls == 1  # 并发未命中只打一次上游


# ---- 调用点接线(端点级;生成与 subscription 全 fake) ----


def _fake_usage_cache(exhausted: bool) -> OpusUsageCache:
    async def fetcher() -> dict[str, bool]:
        return {"host-token": exhausted}

    # 固定时钟:永不过期,monkeypatch 窗口内行为确定。
    return OpusUsageCache(fetcher, ttl_seconds=60.0, clock=lambda: 0.0)


V5_PARAMS = {
    "positivePrompt": "cat",
    "model": "nai-diffusion-5-full",
    "width": 832,
    "height": 1216,
    "steps": 28,
}


class MutableUsageCache:
    def __init__(self, *, exhausted: bool = False) -> None:
        self.exhausted = exhausted
        self.fetches = 0
        self.clock = FakeClock()
        self.cache = OpusUsageCache(self._fetch, ttl_seconds=60.0, clock=self.clock)

    async def _fetch(self) -> dict[str, bool]:
        self.fetches += 1
        return {"host-token": self.exhausted}

    def expire_with(self, *, exhausted: bool) -> None:
        self.exhausted = exhausted
        self.clock.now += 60.1


class BlockingUsageCache:
    def __init__(self) -> None:
        self.calls = 0
        self.worker_check_started = asyncio.Event()
        self.resume_worker = asyncio.Event()

    async def is_exhausted(self) -> bool:
        self.calls += 1
        if self.calls == 1:
            return False
        self.worker_check_started.set()
        await self.resume_worker.wait()
        return True


class FakePaidTokenManager:
    def __init__(self) -> None:
        self.acquisitions = 0
        self.need_anlas: list[bool] = []
        self.releases = 0

    async def acquire_token(self, *, need_anlas: bool) -> str:
        self.acquisitions += 1
        self.need_anlas.append(need_anlas)
        return "paid-token"

    async def release_token(self, _token: str) -> None:
        self.releases += 1

    async def record_success(self, _token: str) -> None:
        return None

    async def record_error(self, _token: str, error: str) -> None:
        assert error


class FakeQuotaLedger:
    enabled = True

    def __init__(self) -> None:
        self.reservations = 0

    async def reserve(
        self,
        record: dict[str, Any],
        _principal: Any,
        *,
        units: int,
        idempotency_key: str,
    ) -> None:
        assert idempotency_key
        self.reservations += 1
        record["quota_reservation_id"] = f"reservation-{self.reservations}"
        record["quota_units"] = max(1, units)

    async def settle(
        self,
        record: dict[str, Any],
        _principal: Any,
        *,
        succeeded: bool,
        job_id: str,
    ) -> None:
        assert record["quota_reservation_id"]
        assert isinstance(succeeded, bool)
        assert job_id

    async def increase_reservation(
        self,
        record: dict[str, Any],
        _principal: Any,
        *,
        units: int,
    ) -> None:
        record["quota_units"] = units


def _install_paid_worker_fakes(
    legacy_app: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    *,
    quota_ledger: Any | None = None,
) -> tuple[FakePaidTokenManager, list[dict[str, Any]]]:
    queue: asyncio.Queue[tuple[str, dict[str, Any], int]] = asyncio.Queue()
    token_manager = FakePaidTokenManager()
    upstream_calls: list[dict[str, Any]] = []

    async def no_workers() -> None:
        return None

    async def no_broadcast() -> None:
        return None

    async def no_stats(*_args: Any, **_kwargs: Any) -> None:
        return None

    async def fake_generate(
        params: dict[str, Any],
        _progress_callback: Any,
        token: str,
        recaptcha_token: str | None = None,
    ) -> str:
        task = next(
            record
            for record in legacy_app._generation_tasks.values()
            if record.get("params") is params
        )
        upstream_calls.append(
            {
                "params": dict(params),
                "token": token,
                "recaptcha_token": recaptcha_token,
                "quota_units": task.get("quota_units"),
            }
        )
        return base64.b64encode(b"\x89PNG\r\n\x1a\nfake-image").decode("ascii")

    monkeypatch.setattr(legacy_app, "_image_queue", queue)
    monkeypatch.setattr(legacy_app, "_generation_websockets", {})
    monkeypatch.setattr(legacy_app, "_running_count", 0)
    monkeypatch.setattr(legacy_app, "_current_task", 0)
    monkeypatch.setattr(legacy_app, "trial_pool", None)
    monkeypatch.setattr(legacy_app, "token_manager", token_manager)
    monkeypatch.setattr(legacy_app, "start_novelai_workers", no_workers)
    monkeypatch.setattr(legacy_app, "_broadcast_queue_position_update", no_broadcast)
    monkeypatch.setattr(legacy_app, "_record_web_stats", no_stats)
    monkeypatch.setattr(legacy_app, "_record_generation_duration", no_stats)
    monkeypatch.setattr(legacy_app, "generate_novelai_image_stream", fake_generate)
    monkeypatch.setattr(
        legacy_app,
        "_quota_ledger",
        quota_ledger if quota_ledger is not None else FakeQuotaLedger(),
    )
    return token_manager, upstream_calls


async def _submit_bot_generation(
    legacy_app: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    params: dict[str, Any],
    *,
    idempotency_key: str,
) -> str:
    import httpx

    owner = legacy_app.BotSession("owner-session", "code", "owner", 1.0, time.time())
    monkeypatch.setattr(legacy_app.bot_auth_manager, "sessions", {owner.session_id: owner})
    monkeypatch.setattr(legacy_app.bot_auth_manager, "tasks", {})
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=legacy_app.app),
        base_url="http://test",
    ) as client:
        response = await client.post(
            "/api/bot/generate",
            json={"session_id": owner.session_id, "params": params},
            headers={"Idempotency-Key": idempotency_key},
        )
    assert response.status_code == 200
    return str(response.json()["task_id"])


async def _run_one_paid_worker(legacy_app: ModuleType) -> None:
    worker = asyncio.create_task(legacy_app.novelai_worker(0, "worker-token"))
    try:
        await asyncio.wait_for(legacy_app._image_queue.join(), timeout=2.0)
        await asyncio.sleep(0)
        if worker.done():
            await worker
    finally:
        worker.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await worker


@pytest.mark.asyncio
async def test_generate_rejects_v5_when_bar_empty_by_default(
    legacy_app: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    import httpx

    owner = legacy_app.BotSession("owner-session", "code", "owner", 1.0, time.time())
    monkeypatch.setattr(legacy_app.bot_auth_manager, "sessions", {owner.session_id: owner})
    monkeypatch.setattr(legacy_app, "_generation_tasks", {})
    monkeypatch.delenv("HOST_OPUS_EXHAUSTED_POLICY", raising=False)
    monkeypatch.setattr(legacy_app, "_opus_usage_cache", _fake_usage_cache(exhausted=True))
    enqueued: list[dict[str, Any]] = []

    async def fake_enqueue(*args: Any, **kwargs: Any) -> tuple[str, int, bool]:
        enqueued.append({"args": args, "kwargs": kwargs})
        return "never", 1, True

    monkeypatch.setattr(legacy_app, "enqueue_generation", fake_enqueue)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=legacy_app.app),
        base_url="http://test",
    ) as client:
        response = await client.post(
            "/api/bot/generate",
            json={"session_id": "owner-session", "params": dict(V5_PARAMS)},
            headers={"Idempotency-Key": "opus-reject"},
        )

    assert response.status_code == 503
    assert "宿主" in response.json()["detail"]
    assert enqueued == []  # 拒绝发生在预留与入队之前,不留任务也不留账


@pytest.mark.asyncio
async def test_generate_charges_v5_when_policy_is_charge(
    legacy_app: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    import asyncio as real_asyncio

    import httpx

    owner = legacy_app.BotSession("owner-session", "code", "owner", 1.0, time.time())
    monkeypatch.setattr(legacy_app.bot_auth_manager, "sessions", {owner.session_id: owner})
    monkeypatch.setattr(legacy_app, "_generation_tasks", {})
    monkeypatch.setenv("HOST_OPUS_EXHAUSTED_POLICY", "charge")
    monkeypatch.setattr(legacy_app, "_opus_usage_cache", _fake_usage_cache(exhausted=True))
    enqueued: list[dict[str, Any]] = []

    async def fake_enqueue(params, user_id="", allow_boost=True, *, resource, task_id=None,
                           task_metadata=None, idempotency_key=None, request_hash=None):
        enqueued.append({"params": dict(params), "metadata": dict(task_metadata or {})})
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
        legacy_app._task_access.bind_record(record, resource)
        legacy_app._generation_tasks[task_id] = record
        await legacy_app._cloud_jobs.create(
            job_id=task_id,
            resource=resource,
            request_hash=request_hash,
            payload={"model": "test"},
            idempotency_key=idempotency_key,
            total_steps=1,
        )
        return task_id, 1, True

    monkeypatch.setattr(legacy_app, "enqueue_generation", fake_enqueue)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=legacy_app.app),
        base_url="http://test",
    ) as client:
        charged = await client.post(
            "/api/bot/generate",
            json={"session_id": "owner-session", "params": dict(V5_PARAMS)},
            headers={"Idempotency-Key": "opus-charge"},
        )
        await real_asyncio.sleep(0)

    assert charged.status_code == 200
    assert len(enqueued) == 1
    # 条空翻转 is_free:同一请求在条满时计价 0(元数据只剩 max(1,..) 下限),
    # 现在按真实 Anlas 价入账(832×1216/28 步 V5 = 30 点,远高于下限 1)。
    assert enqueued[0]["metadata"]["quota_units"] == 30


@pytest.mark.asyncio
async def test_generate_keeps_v4_free_and_v5_free_when_bar_healthy(
    legacy_app: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    import asyncio as real_asyncio

    import httpx

    owner = legacy_app.BotSession("owner-session", "code", "owner", 1.0, time.time())
    monkeypatch.setattr(legacy_app.bot_auth_manager, "sessions", {owner.session_id: owner})
    monkeypatch.setattr(legacy_app, "_generation_tasks", {})
    monkeypatch.delenv("HOST_OPUS_EXHAUSTED_POLICY", raising=False)
    monkeypatch.setattr(legacy_app, "_opus_usage_cache", _fake_usage_cache(exhausted=True))
    enqueued: list[dict[str, Any]] = []

    async def fake_enqueue(params, user_id="", allow_boost=True, *, resource, task_id=None,
                           task_metadata=None, idempotency_key=None, request_hash=None):
        enqueued.append({"params": dict(params), "metadata": dict(task_metadata or {})})
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
        legacy_app._task_access.bind_record(record, resource)
        legacy_app._generation_tasks[task_id] = record
        await legacy_app._cloud_jobs.create(
            job_id=task_id,
            resource=resource,
            request_hash=request_hash,
            payload={"model": "test"},
            idempotency_key=idempotency_key,
            total_steps=1,
        )
        return task_id, 1, True

    monkeypatch.setattr(legacy_app, "enqueue_generation", fake_enqueue)

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=legacy_app.app),
        base_url="http://test",
    ) as client:
        # 同一个「条空」状态下:V4.5 与体力条无关,照旧免费放行(闸门只属于 V5)。
        legacy_params = dict(V5_PARAMS, model="nai-diffusion-4-5-full")
        legacy = await client.post(
            "/api/bot/generate",
            json={"session_id": "owner-session", "params": legacy_params},
            headers={"Idempotency-Key": "opus-legacy"},
        )
        await real_asyncio.sleep(0)

    assert legacy.status_code == 200
    # 免费口径不变:计价为 0,任务元数据里只被 max(1, ...) 的下限抬到 1。
    assert enqueued[0]["metadata"]["quota_units"] == 1

    # 条健康时 V5 也照旧免费。
    monkeypatch.setattr(legacy_app, "_opus_usage_cache", _fake_usage_cache(exhausted=False))
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=legacy_app.app),
        base_url="http://test",
    ) as client:
        healthy = await client.post(
            "/api/bot/generate",
            json={"session_id": "owner-session", "params": dict(V5_PARAMS)},
            headers={"Idempotency-Key": "opus-healthy"},
        )
        await real_asyncio.sleep(0)

    assert healthy.status_code == 200
    assert enqueued[1]["metadata"]["quota_units"] == 1  # 同样只是元数据下限


@pytest.mark.asyncio
async def test_web_stats_records_paid_cost_when_bar_empty(
    legacy_app: ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # 调用点 2(_record_web_stats):条空时统计按真实扣费入账,不再记「免费」假账。
    monkeypatch.setattr(legacy_app, "_STATS_DB", tmp_path / "stats.sqlite3")
    monkeypatch.setattr(legacy_app, "_opus_usage_cache", _fake_usage_cache(exhausted=True))

    import aiosqlite

    async with aiosqlite.connect(str(tmp_path / "stats.sqlite3")) as db:
        await db.execute(
            "CREATE TABLE points_spent(timestamp TEXT, stats_key TEXT, user_id TEXT, "
            "group_id TEXT, points INTEGER, reason TEXT)"
        )
        await db.execute(
            "CREATE TABLE calls(timestamp TEXT, stats_key TEXT, user_id TEXT, "
            "group_id TEXT, type TEXT)"
        )
        await db.commit()

    params = dict(V5_PARAMS)
    await legacy_app._record_web_stats("bot-owner", params)

    async with aiosqlite.connect(str(tmp_path / "stats.sqlite3")) as db:
        rows = await db.execute_fetchall("SELECT points FROM points_spent")
    assert rows == [(30,)]


# ---- paid worker 出队闸(长队列与 boost 回退共用) ----


@pytest.mark.asyncio
async def test_paid_worker_rejects_queued_v5_when_usage_expires_to_empty(
    legacy_app: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    token_manager, upstream_calls = _install_paid_worker_fakes(legacy_app, monkeypatch)
    usage = MutableUsageCache(exhausted=False)
    monkeypatch.delenv("HOST_OPUS_EXHAUSTED_POLICY", raising=False)
    monkeypatch.setattr(legacy_app, "_opus_usage_cache", usage.cache)

    task_id = await _submit_bot_generation(
        legacy_app,
        monkeypatch,
        dict(V5_PARAMS),
        idempotency_key="worker-opus-reject",
    )
    assert usage.fetches == 1
    assert legacy_app._generation_tasks[task_id]["status"] == "queued"

    usage.expire_with(exhausted=True)
    await _run_one_paid_worker(legacy_app)

    task = legacy_app._generation_tasks[task_id]
    job = await legacy_app._cloud_jobs.get(task_id)
    assert task["status"] == "failed"
    assert task["error"] == (
        "宿主 Opus 额度已耗尽,V5 生成暂停以保护宿主钱包;"
        "请联系管理员或改用非 V5 模型"
    )
    assert job is not None and job.status is legacy_app.JobStatus.FAILED
    assert job.provider_attempted is False
    assert job.quota_settled is True
    assert job.cost_committed is False
    assert legacy_app._user_pending["web_owner"] == 0
    assert "params" not in task
    assert usage.fetches == 2
    assert token_manager.acquisitions == 0
    assert upstream_calls == []


@pytest.mark.asyncio
async def test_paid_worker_preserves_cancel_during_opus_cache_check(
    legacy_app: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    token_manager, upstream_calls = _install_paid_worker_fakes(legacy_app, monkeypatch)
    usage = BlockingUsageCache()
    monkeypatch.delenv("HOST_OPUS_EXHAUSTED_POLICY", raising=False)
    monkeypatch.setattr(legacy_app, "_opus_usage_cache", usage)

    task_id = await _submit_bot_generation(
        legacy_app,
        monkeypatch,
        dict(V5_PARAMS),
        idempotency_key="worker-opus-cancel-race",
    )
    worker = asyncio.create_task(legacy_app.novelai_worker(0, "worker-token"))
    try:
        await asyncio.wait_for(usage.worker_check_started.wait(), timeout=2.0)

        import httpx

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=legacy_app.app),
            base_url="http://test",
        ) as client:
            cancelled = await client.delete(
                f"/api/task/{task_id}",
                params={"session_id": "owner-session"},
            )
        assert cancelled.status_code == 200

        usage.resume_worker.set()
        await asyncio.wait_for(legacy_app._image_queue.join(), timeout=2.0)
        await asyncio.sleep(0)
        if worker.done():
            await worker
    finally:
        usage.resume_worker.set()
        worker.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await worker

    task = legacy_app._generation_tasks[task_id]
    job = await legacy_app._cloud_jobs.get(task_id)
    assert task["status"] == "cancelled"
    assert job is not None and job.status is legacy_app.JobStatus.CANCELLED
    assert job.provider_attempted is False
    assert legacy_app._user_pending["web_owner"] == 0
    assert token_manager.acquisitions == 0
    assert upstream_calls == []


@pytest.mark.asyncio
async def test_paid_worker_preserves_cancel_winning_failed_transition_race(
    legacy_app: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    token_manager, upstream_calls = _install_paid_worker_fakes(legacy_app, monkeypatch)
    usage = MutableUsageCache(exhausted=False)
    monkeypatch.delenv("HOST_OPUS_EXHAUSTED_POLICY", raising=False)
    monkeypatch.setattr(legacy_app, "_opus_usage_cache", usage.cache)

    task_id = await _submit_bot_generation(
        legacy_app,
        monkeypatch,
        dict(V5_PARAMS),
        idempotency_key="worker-opus-cancel-transition-race",
    )
    usage.expire_with(exhausted=True)

    failed_transition_started = asyncio.Event()
    resume_failed_transition = asyncio.Event()
    original_notify = legacy_app._notify_task_update

    async def block_failed_transition(
        notified_task_id: str,
        status: str,
        *args: Any,
        **kwargs: Any,
    ) -> None:
        if notified_task_id == task_id and status == "failed":
            failed_transition_started.set()
            await resume_failed_transition.wait()
        await original_notify(notified_task_id, status, *args, **kwargs)

    monkeypatch.setattr(legacy_app, "_notify_task_update", block_failed_transition)
    worker = asyncio.create_task(legacy_app.novelai_worker(0, "worker-token"))
    try:
        await asyncio.wait_for(failed_transition_started.wait(), timeout=2.0)

        import httpx

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=legacy_app.app),
            base_url="http://test",
        ) as client:
            cancelled = await client.delete(
                f"/api/task/{task_id}",
                params={"session_id": "owner-session"},
            )
        assert cancelled.status_code == 200

        resume_failed_transition.set()
        await asyncio.wait_for(legacy_app._image_queue.join(), timeout=2.0)
        await asyncio.sleep(0)
        assert worker.done() is False
    finally:
        resume_failed_transition.set()
        worker.cancel()
        with contextlib.suppress(asyncio.CancelledError, legacy_app.JobStateConflictError):
            await worker

    task = legacy_app._generation_tasks[task_id]
    job = await legacy_app._cloud_jobs.get(task_id)
    assert task["status"] == "cancelled"
    assert job is not None and job.status is legacy_app.JobStatus.CANCELLED
    assert job.provider_attempted is False
    assert job.quota_settled is True
    assert legacy_app._user_pending["web_owner"] == 0
    assert token_manager.acquisitions == 0
    assert upstream_calls == []


@pytest.mark.asyncio
async def test_paid_worker_and_cancel_decrement_pending_only_once_when_cleanup_wins(
    legacy_app: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    token_manager, upstream_calls = _install_paid_worker_fakes(legacy_app, monkeypatch)
    usage = MutableUsageCache(exhausted=False)
    monkeypatch.delenv("HOST_OPUS_EXHAUSTED_POLICY", raising=False)
    monkeypatch.setattr(legacy_app, "_opus_usage_cache", usage.cache)

    task_id = await _submit_bot_generation(
        legacy_app,
        monkeypatch,
        dict(V5_PARAMS),
        idempotency_key="worker-opus-pending-race",
    )
    legacy_app._user_pending["web_owner"] = 2
    usage.expire_with(exhausted=True)

    failed_transition_started = asyncio.Event()
    resume_failed_transition = asyncio.Event()
    original_notify = legacy_app._notify_task_update

    async def block_failed_transition(
        notified_task_id: str,
        status: str,
        *args: Any,
        **kwargs: Any,
    ) -> None:
        if notified_task_id == task_id and status == "failed":
            failed_transition_started.set()
            await resume_failed_transition.wait()
        await original_notify(notified_task_id, status, *args, **kwargs)

    cancel_persisted = asyncio.Event()
    resume_cancel = asyncio.Event()
    original_request_cancel = legacy_app._cloud_jobs.request_cancel

    async def block_cancel_after_persist(job_id: str) -> Any:
        result = await original_request_cancel(job_id)
        cancel_persisted.set()
        await resume_cancel.wait()
        return result

    monkeypatch.setattr(legacy_app, "_notify_task_update", block_failed_transition)
    monkeypatch.setattr(legacy_app._cloud_jobs, "request_cancel", block_cancel_after_persist)
    worker = asyncio.create_task(legacy_app.novelai_worker(0, "worker-token"))
    cancel_request: asyncio.Task[Any] | None = None
    try:
        await asyncio.wait_for(failed_transition_started.wait(), timeout=2.0)

        import httpx

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=legacy_app.app),
            base_url="http://test",
        ) as client:
            cancel_request = asyncio.create_task(
                client.delete(
                    f"/api/task/{task_id}",
                    params={"session_id": "owner-session"},
                )
            )
            await asyncio.wait_for(cancel_persisted.wait(), timeout=2.0)
            resume_failed_transition.set()
            await asyncio.wait_for(legacy_app._image_queue.join(), timeout=2.0)
            assert legacy_app._user_pending["web_owner"] == 1

            resume_cancel.set()
            cancelled = await asyncio.wait_for(cancel_request, timeout=2.0)
        assert cancelled.status_code == 200
        assert legacy_app._user_pending["web_owner"] == 1
        assert worker.done() is False
    finally:
        resume_failed_transition.set()
        resume_cancel.set()
        if cancel_request is not None and not cancel_request.done():
            cancel_request.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await cancel_request
        worker.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await worker

    task = legacy_app._generation_tasks[task_id]
    job = await legacy_app._cloud_jobs.get(task_id)
    assert task["status"] == "cancelled"
    assert task["_pending_decremented"] is True
    assert job is not None and job.status is legacy_app.JobStatus.CANCELLED
    assert token_manager.acquisitions == 0
    assert upstream_calls == []


@pytest.mark.asyncio
async def test_paid_worker_survives_transient_pre_provider_terminal_failure(
    legacy_app: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    token_manager, upstream_calls = _install_paid_worker_fakes(legacy_app, monkeypatch)
    usage = MutableUsageCache(exhausted=False)
    monkeypatch.delenv("HOST_OPUS_EXHAUSTED_POLICY", raising=False)
    monkeypatch.setattr(legacy_app, "_opus_usage_cache", usage.cache)

    rejected_task_id = await _submit_bot_generation(
        legacy_app,
        monkeypatch,
        dict(V5_PARAMS),
        idempotency_key="worker-opus-transient-terminal-failure",
    )
    generated_task_id = await _submit_bot_generation(
        legacy_app,
        monkeypatch,
        dict(V5_PARAMS, model="nai-diffusion-4-5-full"),
        idempotency_key="worker-opus-after-terminal-failure",
    )
    usage.expire_with(exhausted=True)

    original_notify = legacy_app._notify_task_update
    failed_once = False

    async def fail_first_terminal_write(
        notified_task_id: str,
        status: str,
        *args: Any,
        **kwargs: Any,
    ) -> None:
        nonlocal failed_once
        if notified_task_id == rejected_task_id and status == "failed" and not failed_once:
            failed_once = True
            raise RuntimeError("transient terminal write failure")
        await original_notify(notified_task_id, status, *args, **kwargs)

    monkeypatch.setattr(legacy_app, "_notify_task_update", fail_first_terminal_write)
    worker = asyncio.create_task(legacy_app.novelai_worker(0, "worker-token"))
    try:
        await asyncio.wait_for(legacy_app._image_queue.join(), timeout=2.0)
        await asyncio.sleep(0)
        assert worker.done() is False
    finally:
        worker.cancel()
        with contextlib.suppress(asyncio.CancelledError, RuntimeError):
            await worker

    rejected = legacy_app._generation_tasks[rejected_task_id]
    generated = legacy_app._generation_tasks[generated_task_id]
    rejected_job = await legacy_app._cloud_jobs.get(rejected_task_id)
    generated_job = await legacy_app._cloud_jobs.get(generated_task_id)
    assert failed_once is True
    assert rejected["status"] == "failed"
    assert rejected_job is not None and rejected_job.status is legacy_app.JobStatus.FAILED
    assert rejected_job.quota_settled is True
    assert generated["status"] == "completed"
    assert generated_job is not None and generated_job.status is legacy_app.JobStatus.SUCCEEDED
    assert len(upstream_calls) == 1
    assert upstream_calls[0]["params"]["model"] == "nai-diffusion-4-5-full"
    assert token_manager.acquisitions == 1
    assert legacy_app._user_pending["web_owner"] == 0


@pytest.mark.asyncio
async def test_paid_worker_charge_updates_v5_quota_metadata_before_upstream(
    legacy_app: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    token_manager, upstream_calls = _install_paid_worker_fakes(legacy_app, monkeypatch)
    usage = MutableUsageCache(exhausted=False)
    monkeypatch.setenv("HOST_OPUS_EXHAUSTED_POLICY", "charge")
    monkeypatch.setattr(legacy_app, "_opus_usage_cache", usage.cache)

    task_id = await _submit_bot_generation(
        legacy_app,
        monkeypatch,
        dict(V5_PARAMS),
        idempotency_key="worker-opus-charge",
    )
    assert legacy_app._generation_tasks[task_id]["quota_units"] == 1

    usage.expire_with(exhausted=True)
    await _run_one_paid_worker(legacy_app)

    task = legacy_app._generation_tasks[task_id]
    job = await legacy_app._cloud_jobs.get(task_id)
    assert task["status"] == "completed"
    assert task["quota_units"] == 30
    assert job is not None and job.provider_attempted is True
    assert job.quota_settled is True
    assert job.cost_committed is True
    assert len(upstream_calls) == 1
    assert upstream_calls[0]["quota_units"] == 30
    assert token_manager.acquisitions == 1
    assert token_manager.need_anlas == [True]
    assert token_manager.releases == 1
    assert usage.fetches == 2


@pytest.mark.asyncio
async def test_paid_worker_charge_reprices_real_reservation_and_persisted_job(
    legacy_app: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ledger = LegacyQuotaLedger(tmp_path / "quota.db", enabled=True)
    await ledger.initialize()
    resource = ResourceOwner(legacy_app._BOT_TASK_TENANT_ID, "owner")
    await ledger.repository.provision_account(resource, available_units=100)
    token_manager, upstream_calls = _install_paid_worker_fakes(
        legacy_app,
        monkeypatch,
        quota_ledger=ledger,
    )
    usage = MutableUsageCache(exhausted=False)
    monkeypatch.setenv("HOST_OPUS_EXHAUSTED_POLICY", "charge")
    monkeypatch.setattr(legacy_app, "_opus_usage_cache", usage.cache)

    task_id = await _submit_bot_generation(
        legacy_app,
        monkeypatch,
        dict(V5_PARAMS),
        idempotency_key="worker-opus-charge-real-ledger",
    )
    reservation_id = legacy_app._generation_tasks[task_id]["quota_reservation_id"]
    assert (await ledger.repository.get_balance(resource)).available_units == 99

    usage.expire_with(exhausted=True)
    await _run_one_paid_worker(legacy_app)

    import aiosqlite

    async with aiosqlite.connect(str(ledger.repository.path)) as connection:
        reservation = await connection.execute_fetchall(
            "SELECT units, state FROM cloud_quota_reservations WHERE id = ?",
            (reservation_id,),
        )
    task = legacy_app._generation_tasks[task_id]
    job = await legacy_app._cloud_jobs.get(task_id)
    assert task["status"] == "completed"
    assert task["quota_units"] == 30
    assert job is not None and job.cost_units == 30
    assert job.provider_attempted is True
    assert job.cost_committed is True
    assert reservation == [(30, "captured")]
    assert (await ledger.repository.get_balance(resource)).available_units == 70
    assert len(upstream_calls) == 1
    assert token_manager.need_anlas == [True]


@pytest.mark.asyncio
async def test_paid_worker_charge_fails_before_upstream_when_reprice_exceeds_balance(
    legacy_app: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    ledger = LegacyQuotaLedger(tmp_path / "quota.db", enabled=True)
    await ledger.initialize()
    resource = ResourceOwner(legacy_app._BOT_TASK_TENANT_ID, "owner")
    await ledger.repository.provision_account(resource, available_units=1)
    token_manager, upstream_calls = _install_paid_worker_fakes(
        legacy_app,
        monkeypatch,
        quota_ledger=ledger,
    )
    usage = MutableUsageCache(exhausted=False)
    monkeypatch.setenv("HOST_OPUS_EXHAUSTED_POLICY", "charge")
    monkeypatch.setattr(legacy_app, "_opus_usage_cache", usage.cache)

    task_id = await _submit_bot_generation(
        legacy_app,
        monkeypatch,
        dict(V5_PARAMS),
        idempotency_key="worker-opus-charge-insufficient",
    )
    reservation_id = legacy_app._generation_tasks[task_id]["quota_reservation_id"]
    assert (await ledger.repository.get_balance(resource)).available_units == 0

    usage.expire_with(exhausted=True)
    await _run_one_paid_worker(legacy_app)

    import aiosqlite

    async with aiosqlite.connect(str(ledger.repository.path)) as connection:
        reservation = await connection.execute_fetchall(
            "SELECT units, state FROM cloud_quota_reservations WHERE id = ?",
            (reservation_id,),
        )
    task = legacy_app._generation_tasks[task_id]
    job = await legacy_app._cloud_jobs.get(task_id)
    assert task["status"] == "failed"
    assert "额度不足" in task["error"]
    assert job is not None and job.provider_attempted is False
    assert job.quota_settled is True
    assert reservation == [(1, "refunded")]
    assert (await ledger.repository.get_balance(resource)).available_units == 1
    assert token_manager.acquisitions == 0
    assert upstream_calls == []


@pytest.mark.asyncio
async def test_paid_worker_ignores_empty_opus_usage_for_non_v5(
    legacy_app: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    token_manager, upstream_calls = _install_paid_worker_fakes(legacy_app, monkeypatch)
    usage = MutableUsageCache(exhausted=True)
    monkeypatch.delenv("HOST_OPUS_EXHAUSTED_POLICY", raising=False)
    monkeypatch.setattr(legacy_app, "_opus_usage_cache", usage.cache)

    params = dict(V5_PARAMS, model="nai-diffusion-4-5-full")
    task_id = await _submit_bot_generation(
        legacy_app,
        monkeypatch,
        params,
        idempotency_key="worker-opus-non-v5",
    )
    await _run_one_paid_worker(legacy_app)

    task = legacy_app._generation_tasks[task_id]
    job = await legacy_app._cloud_jobs.get(task_id)
    assert task["status"] == "completed"
    assert job is not None and job.provider_attempted is True
    assert len(upstream_calls) == 1
    assert token_manager.acquisitions == 1
    assert token_manager.need_anlas == [False]
    assert usage.fetches == 0


@pytest.mark.asyncio
async def test_boost_fallback_is_rejected_by_the_paid_worker_gate(
    legacy_app: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    token_manager, upstream_calls = _install_paid_worker_fakes(legacy_app, monkeypatch)
    usage = MutableUsageCache(exhausted=True)
    monkeypatch.delenv("HOST_OPUS_EXHAUSTED_POLICY", raising=False)
    monkeypatch.setattr(legacy_app, "_opus_usage_cache", usage.cache)

    class EmptyTrialPool:
        async def acquire(self) -> None:
            return None

    monkeypatch.setattr(legacy_app, "trial_pool", EmptyTrialPool())
    params = dict(V5_PARAMS)
    task_id = "boost-opus-reject"
    user_id = "web_owner"
    resource = legacy_app.ResourceOwner(legacy_app._BOT_TASK_TENANT_ID, "owner")
    request_hash = legacy_app._generation_request_hash(params)
    await legacy_app._cloud_jobs.create(
        job_id=task_id,
        resource=resource,
        request_hash=request_hash,
        payload=legacy_app._persistent_generation_payload(params),
        idempotency_key="boost-opus-reject",
        quota_reservation_id="boost-reservation",
        cost_units=1,
        total_steps=28,
    )
    task_record = {
        "task_id": task_id,
        "status": "queued",
        "params": params,
        "user_id": user_id,
        "created_at": time.time(),
        "step": 0,
        "total_steps": 28,
        "result": None,
        "error": None,
        "task_seq": 1,
        "quota_reservation_id": "boost-reservation",
        "quota_units": 1,
    }
    legacy_app._task_access.bind_record(task_record, resource)
    legacy_app._generation_tasks[task_id] = task_record
    legacy_app._user_pending[user_id] = 1

    await legacy_app._boost_handle(task_id, params, 1)
    assert legacy_app._image_queue.qsize() == 1
    assert task_record["status"] == "queued"

    await _run_one_paid_worker(legacy_app)

    job = await legacy_app._cloud_jobs.get(task_id)
    assert task_record["status"] == "failed"
    assert job is not None and job.provider_attempted is False
    assert job.quota_settled is True
    assert legacy_app._user_pending[user_id] == 0
    assert "params" not in task_record
    assert usage.fetches == 1
    assert token_manager.acquisitions == 0
    assert upstream_calls == []
