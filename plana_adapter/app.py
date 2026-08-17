"""Plana 协议适配器的 ASGI 应用。

三个端点做形状翻译,其余走通用透传:

- ``POST /api/bot/auth/generate``  截获后端多返的 poll_token,只回 {code, expires_in}
- ``POST /api/bot/auth/check``     补回代管的 poll_token 再转发
- ``POST /api/bot/generate``       顶层 image_backend 下沉进 params,代发 Idempotency-Key
- ``GET  /api/bot/task/{id}``      翻成后端的 POST /api/bot/task,并映射状态词
- ``*   /{path}``                  其余请求:Bearer→X-Bot-Session 桥接后原样转发

适配器不持久化任何东西,不解析业务语义;它只搬运字节 + 补三处协议差异。
"""

from __future__ import annotations

import secrets
from collections.abc import Callable
from contextlib import asynccontextmanager
from typing import Any

import httpx
from fastapi import FastAPI, Request, Response, WebSocket
from fastapi.responses import JSONResponse

from .config import AdapterConfig, load_config
from .pending_codes import PendingCodeStore
from .ws_proxy import proxy_bot_socket

# 后端多出的状态词 → Plana 词表(queued/starting/generating/completed/failed/cancelled)。
_STATUS_TO_PLANA = {
    "cancelling": "generating",
    "interrupted": "failed",
}

# 通用透传时不转发的逐跳/危险头(其余原样带上)。
_HOP_BY_HOP = frozenset(
    {
        "host",
        "content-length",
        "connection",
        "keep-alive",
        "transfer-encoding",
        "upgrade",
        "proxy-authorization",
        "proxy-authenticate",
        "te",
        "trailer",
    }
)


def _bearer(authorization: str) -> str:
    value = (authorization or "").strip()
    if value.lower().startswith("bearer "):
        return value[7:].strip()
    return ""


def _forward_headers(request: Request, session_id: str) -> dict[str, str]:
    """构造转发给上游的头:去掉逐跳头,把 Bearer 会话桥成 X-Bot-Session。"""
    headers = {
        key: value
        for key, value in request.headers.items()
        if key.lower() not in _HOP_BY_HOP
    }
    # 后端的库/统计/vibe 端点读 X-Bot-Session,不认 Bearer;桥接一次修复一大片。
    if session_id:
        headers["X-Bot-Session"] = session_id
    return headers


def create_app(
    config: AdapterConfig | None = None,
    *,
    client: httpx.AsyncClient | None = None,
    token_factory: Callable[[], str] = lambda: secrets.token_hex(16),
    ws_connect: Any = None,
) -> FastAPI:
    cfg = config or load_config()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        owns_client = client is None
        http = client or httpx.AsyncClient(
            base_url=cfg.upstream_base,
            timeout=cfg.request_timeout,
        )
        app.state.http = http
        app.state.pending = PendingCodeStore(max_entries=cfg.max_pending_codes)
        try:
            yield
        finally:
            if owns_client:
                await http.aclose()

    app = FastAPI(title="Plana Protocol Adapter", lifespan=lifespan)

    def _pending(app_: FastAPI) -> PendingCodeStore:
        return app_.state.pending

    def _http(app_: FastAPI) -> httpx.AsyncClient:
        return app_.state.http

    async def _relay_json(
        resp: httpx.Response,
        transform: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
    ) -> Response:
        try:
            body = resp.json()
        except ValueError:
            return Response(
                content=resp.content,
                status_code=resp.status_code,
                media_type=resp.headers.get("content-type"),
            )
        if transform and isinstance(body, dict):
            body = transform(body)
        return JSONResponse(content=body, status_code=resp.status_code)

    @app.get("/healthz")
    async def healthz() -> dict[str, Any]:
        return {"ok": True, "pending_codes": len(_pending(app))}

    @app.post("/api/bot/auth/generate")
    async def auth_generate(request: Request) -> Response:
        resp = await _http(app).post("/api/bot/auth/generate")
        if resp.status_code != 200:
            return await _relay_json(resp)
        body = resp.json()
        code = str(body.get("code") or "")
        poll_token = str(body.get("poll_token") or "")
        if code and poll_token:
            _pending(app).put(code, poll_token)
        # 只把 Plana 认识的字段回给它(剥掉 poll_token)。
        trimmed = {k: v for k, v in body.items() if k != "poll_token"}
        return JSONResponse(content=trimmed, status_code=200)

    @app.post("/api/bot/auth/check")
    async def auth_check(request: Request) -> Response:
        payload = await _read_json(request)
        code = str((payload or {}).get("code") or "")
        forward: dict[str, Any] = {"code": code}
        # 客户端若自带 poll_token 则尊重;否则补回代管的那个。
        poll_token = str((payload or {}).get("poll_token") or "") or (
            _pending(app).get(code) or ""
        )
        if poll_token:
            forward["poll_token"] = poll_token
        resp = await _http(app).post("/api/bot/auth/check", json=forward)
        if resp.status_code == 200:
            try:
                if resp.json().get("verified"):
                    _pending(app).discard(code)
            except ValueError:
                pass
        return await _relay_json(resp)

    @app.post("/api/bot/generate")
    async def bot_generate(request: Request) -> Response:
        payload = await _read_json(request) or {}
        params = dict(payload.get("params") or {})
        # 顶层 image_backend 下沉进 params(后端只从 params 读)。
        top_backend = payload.get("image_backend")
        if top_backend and "image_backend" not in params:
            params["image_backend"] = top_backend
        forward = {"session_id": payload.get("session_id", ""), "params": params}
        session_id = str(payload.get("session_id") or "") or _bearer(
            request.headers.get("authorization", "")
        )
        # 后端开启配额账本时要求 Idempotency-Key;每次生成用唯一键(Plana 循环
        # 生成是同参数连抽,不能用 params hash,否则会被判成重放)。
        headers = _forward_headers(request, session_id)
        headers.setdefault("Idempotency-Key", token_factory())
        headers["content-type"] = "application/json"
        resp = await _http(app).post(
            "/api/bot/generate",
            json=forward,
            headers=headers,
            timeout=cfg.generate_timeout,
        )
        return await _relay_json(resp)

    @app.get("/api/bot/task/{task_id}")
    async def bot_task(task_id: str, request: Request) -> Response:
        session_id = _bearer(request.headers.get("authorization", "")) or request.headers.get(
            "x-bot-session", ""
        )
        resp = await _http(app).post(
            "/api/bot/task",
            json={"task_id": task_id, "session_id": session_id},
        )

        def _map_status(body: dict[str, Any]) -> dict[str, Any]:
            status = body.get("status")
            if isinstance(status, str):
                body["status"] = _STATUS_TO_PLANA.get(status, status)
            return body

        return await _relay_json(resp, transform=_map_status)

    @app.websocket("/ws/bot")
    async def bot_socket(websocket: WebSocket) -> None:
        # 两边的身份绑定方式不同,由 ws_proxy 转译(详见该模块 docstring)。
        await proxy_bot_socket(
            websocket,
            upstream_base=cfg.upstream_base,
            status_mapping=_STATUS_TO_PLANA,
            connect=ws_connect,
        )

    @app.api_route(
        "/{path:path}",
        methods=["GET", "POST", "PUT", "DELETE", "PATCH"],
    )
    async def passthrough(path: str, request: Request) -> Response:
        session_id = _bearer(request.headers.get("authorization", ""))
        headers = _forward_headers(request, session_id)
        raw = await request.body()
        upstream = await _http(app).request(
            request.method,
            "/" + path,
            content=raw or None,
            headers=headers,
            params=dict(request.query_params),
        )
        return Response(
            content=upstream.content,
            status_code=upstream.status_code,
            media_type=upstream.headers.get("content-type"),
        )

    return app


async def _read_json(request: Request) -> dict[str, Any] | None:
    try:
        data = await request.json()
    except Exception:
        return None
    return data if isinstance(data, dict) else None


__all__ = ["create_app"]
