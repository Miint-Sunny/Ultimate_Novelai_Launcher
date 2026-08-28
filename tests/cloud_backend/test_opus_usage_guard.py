"""宿主钱包保护(P5-5):opus_usage_exhausted 第四道闸的接线与失败路径。

计价函数本身的翻转已有 test_legacy_v5_support 锚定;这里测的是**接线**:
usage 判定、60s 单飞缓存、fail-closed 方向、策略切换,以及两个调用点
(生成端点的预留计价、_record_web_stats 的记账)真正吃到这个布尔。
付费上游(/user/subscription 与生成)一律 fake。
"""

from __future__ import annotations

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
    assert enqueued[0]["metadata"]["quota_units"] > 1


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
    assert rows and rows[0][0] > 0  # 832x1216/28 步在条空时约 26 点
