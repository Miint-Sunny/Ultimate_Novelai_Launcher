"""适配器翻译层测试。

用一个内存假上游(FastAPI)挂到 httpx ASGITransport 上,再把该 client 注入
适配器,端到端验证协议翻译 —— 不碰真实后端、无网络。
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest
from fastapi import FastAPI, Header, Request
from fastapi.responses import JSONResponse

from plana_adapter.app import create_app
from plana_adapter.config import AdapterConfig
from plana_adapter.pending_codes import PendingCodeStore

CONFIG = AdapterConfig(
    upstream_base="http://upstream.test",
    host="127.0.0.1",
    port=8765,
    request_timeout=5.0,
    generate_timeout=5.0,
    max_pending_codes=100,
)


def _build_fake_upstream() -> tuple[FastAPI, dict[str, Any]]:
    """一个记录收到内容的假后端,行为对齐真实宿主的相关端点。"""
    upstream = FastAPI()
    calls: dict[str, Any] = {"generate_headers": None, "generate_body": None}

    @upstream.post("/api/bot/auth/generate")
    async def gen() -> dict[str, Any]:
        return {"code": "ABC123", "poll_token": "P" * 40, "expires_in": 300}

    @upstream.post("/api/bot/auth/check")
    async def check(payload: dict[str, Any]) -> Any:
        # 真实后端:缺 poll_token → 422;这里模拟"有 token 且已验证才发 session"。
        if not payload.get("poll_token"):
            return JSONResponse(status_code=422, content={"detail": "poll_token required"})
        if payload.get("code") == "ABC123" and payload["poll_token"] == "P" * 40:
            return {"verified": True, "session_id": "sess-xyz"}
        return {"verified": False, "session_id": None}

    @upstream.post("/api/bot/generate")
    async def generate(
        request: Request,
        idempotency_key: str = Header(default="", alias="Idempotency-Key"),
    ) -> dict[str, Any]:
        calls["generate_body"] = await request.json()
        calls["generate_headers"] = dict(request.headers)
        calls["generate_idempotency"] = idempotency_key
        return {"success": True, "task_id": "task-1", "message": "ok"}

    @upstream.post("/api/bot/task")
    async def task(payload: dict[str, Any]) -> dict[str, Any]:
        calls["task_body"] = payload
        return {
            "success": True,
            "status": "interrupted",
            "step": 3,
            "total_steps": 28,
            "result": None,
            "error": "boom",
            "queue_position": 0,
        }

    @upstream.get("/api/vibes/list")
    async def vibes_list(request: Request) -> dict[str, Any]:
        calls["vibes_headers"] = dict(request.headers)
        return {"vibes": []}

    return upstream, calls


def _adapter_client(upstream: FastAPI) -> tuple[httpx.AsyncClient, FastAPI]:
    upstream_client = httpx.AsyncClient(
        transport=httpx.ASGITransport(app=upstream),
        base_url=CONFIG.upstream_base,
    )
    adapter = create_app(
        CONFIG,
        client=upstream_client,
        token_factory=lambda: "fixed-idem-key",
    )
    return upstream_client, adapter


@pytest.mark.asyncio
async def test_generate_hides_poll_token_and_check_restores_it() -> None:
    upstream, _ = _build_fake_upstream()
    _, adapter = _adapter_client(upstream)
    transport = httpx.ASGITransport(app=adapter)
    async with adapter.router.lifespan_context(adapter):
        async with httpx.AsyncClient(
            transport=transport, base_url="http://adapter.test"
        ) as client:
            issued = await client.post("/api/bot/auth/generate")
            # Plana 只看到 code + expires_in,poll_token 被适配器藏起来。
            assert issued.status_code == 200
            assert issued.json() == {"code": "ABC123", "expires_in": 300}

            # Plana 只发 {code};适配器补回代管的 poll_token → 上游放行。
            checked = await client.post("/api/bot/auth/check", json={"code": "ABC123"})
            assert checked.status_code == 200
            assert checked.json() == {"verified": True, "session_id": "sess-xyz"}


@pytest.mark.asyncio
async def test_check_without_pending_token_fails_like_upstream() -> None:
    upstream, _ = _build_fake_upstream()
    _, adapter = _adapter_client(upstream)
    transport = httpx.ASGITransport(app=adapter)
    async with adapter.router.lifespan_context(adapter):
        async with httpx.AsyncClient(
            transport=transport, base_url="http://adapter.test"
        ) as client:
            # 没有先 generate(适配器无代管 token)→ 上游 422 透传。
            resp = await client.post("/api/bot/auth/check", json={"code": "ZZZ999"})
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_generate_sinks_image_backend_and_sends_idempotency_key() -> None:
    upstream, calls = _build_fake_upstream()
    _, adapter = _adapter_client(upstream)
    transport = httpx.ASGITransport(app=adapter)
    async with adapter.router.lifespan_context(adapter):
        async with httpx.AsyncClient(
            transport=transport, base_url="http://adapter.test"
        ) as client:
            resp = await client.post(
                "/api/bot/generate",
                json={
                    "session_id": "sess-xyz",
                    "params": {"positivePrompt": "cat"},
                    "image_backend": "novelai",
                },
                headers={"Authorization": "Bearer sess-xyz"},
            )
    assert resp.status_code == 200
    assert resp.json()["task_id"] == "task-1"
    # 顶层 image_backend 已下沉进 params。
    assert calls["generate_body"]["params"]["image_backend"] == "novelai"
    # 适配器代发了 Idempotency-Key。
    assert calls["generate_idempotency"] == "fixed-idem-key"
    # Bearer 会话被桥成 X-Bot-Session。
    assert calls["generate_headers"].get("x-bot-session") == "sess-xyz"


@pytest.mark.asyncio
async def test_task_translates_path_and_maps_status() -> None:
    upstream, calls = _build_fake_upstream()
    _, adapter = _adapter_client(upstream)
    transport = httpx.ASGITransport(app=adapter)
    async with adapter.router.lifespan_context(adapter):
        async with httpx.AsyncClient(
            transport=transport, base_url="http://adapter.test"
        ) as client:
            resp = await client.get(
                "/api/bot/task/task-1",
                headers={"Authorization": "Bearer sess-xyz"},
            )
    assert resp.status_code == 200
    body = resp.json()
    # GET /bot/task/{id} 被翻成 POST /bot/task,Bearer → body session_id。
    assert calls["task_body"] == {"task_id": "task-1", "session_id": "sess-xyz"}
    # 后端的 interrupted 被映射成 Plana 词表的 failed。
    assert body["status"] == "failed"
    assert body["step"] == 3


@pytest.mark.asyncio
async def test_passthrough_bridges_bearer_to_x_bot_session() -> None:
    upstream, calls = _build_fake_upstream()
    _, adapter = _adapter_client(upstream)
    transport = httpx.ASGITransport(app=adapter)
    async with adapter.router.lifespan_context(adapter):
        async with httpx.AsyncClient(
            transport=transport, base_url="http://adapter.test"
        ) as client:
            resp = await client.get(
                "/api/vibes/list",
                headers={"Authorization": "Bearer sess-xyz"},
            )
    assert resp.status_code == 200
    assert resp.json() == {"vibes": []}
    # 通用透传也把 Bearer 桥成了 X-Bot-Session(修复库/统计一大片端点)。
    assert calls["vibes_headers"].get("x-bot-session") == "sess-xyz"


def test_pending_code_store_ttl_and_bound() -> None:
    clock = {"t": 0.0}
    store = PendingCodeStore(ttl_seconds=10, max_entries=2, clock=lambda: clock["t"])
    store.put("A", "tok-a")
    store.put("B", "tok-b")
    assert store.get("A") == "tok-a"
    # 超上限逐出最旧。
    store.put("C", "tok-c")
    assert store.get("A") is None
    assert store.get("C") == "tok-c"
    # TTL 过期。
    clock["t"] = 100.0
    assert store.get("B") is None
    assert len(store) == 0
