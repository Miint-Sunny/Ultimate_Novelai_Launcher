"""`/ws/bot` 的双向代理。

Plana 与本宿主在 WS 上的身份绑定方式不同,这是两边唯一无法靠 HTTP 翻译抹平的差异:

- Plana:匿名连接,连上后发 ``{"action":"bind_session","session_id":...}``
- 本宿主:握手期从子协议 ``bot-session.<sid>`` 取会话,**收到 bind_session 会 close 4403**

代理在中间转译:对下游同时接受两种方言(有子协议就直接用,没有就等第一条
bind_session),对上游一律用宿主要求的子协议连接。绑定完成后纯字节泵,只在
``task_update`` 上做一次状态词映射(与 HTTP 侧的 ``_STATUS_TO_PLANA`` 同源)。

WS 在 Plana 协议里是**可选**链路(客户端有 2.5s 轮询兜底),所以这里任何失败都
以"关闭连接"收场,让客户端自己退回轮询,绝不把错误伪装成正常进度。
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from typing import Any

import websockets
from fastapi import WebSocket, WebSocketDisconnect
from websockets.typing import Subprotocol

# 等待下游发出 bind_session 的上限:超过就认为对方不会绑定,关掉。
BIND_TIMEOUT_SECONDS = 10.0

_SUBPROTOCOL_PREFIX = "bot-session."

# 关闭码:4400 协议错误(没按约定绑定),4401 上游拒绝会话。
CLOSE_PROTOCOL_ERROR = 4400
CLOSE_UPSTREAM_REJECTED = 4401


def upstream_ws_url(upstream_base: str) -> str:
    """http(s)://host → ws(s)://host/ws/bot(宿主的 WS 不带 /api 前缀)。"""

    base = upstream_base.rstrip("/")
    if base.startswith("https://"):
        base = "wss://" + base[len("https://") :]
    elif base.startswith("http://"):
        base = "ws://" + base[len("http://") :]
    return f"{base}/ws/bot"


def offered_session(websocket: WebSocket) -> str:
    """下游若用本宿主方言(子协议)连接,直接取出其中的会话。"""

    raw = websocket.headers.get("sec-websocket-protocol", "")
    for value in raw.split(","):
        candidate = value.strip()
        if candidate.startswith(_SUBPROTOCOL_PREFIX):
            return candidate[len(_SUBPROTOCOL_PREFIX) :]
    return ""


def map_status_for_plana(message: dict[str, Any], mapping: dict[str, str]) -> dict[str, Any]:
    status = message.get("status")
    if isinstance(status, str) and status in mapping:
        message["status"] = mapping[status]
    return message


async def _client_to_upstream(client: WebSocket, upstream: Any) -> None:
    while True:
        raw = await client.receive_text()
        try:
            data = json.loads(raw)
        except ValueError:
            # 非 JSON 一律不转发:宿主只认 JSON 消息,转发只会让它断开。
            continue
        if isinstance(data, dict) and data.get("action") == "bind_session":
            # 绑定已在握手期完成;再转发给宿主会被 close(4403)。
            continue
        await upstream.send(raw)


async def _upstream_to_client(upstream: Any, client: WebSocket, mapping: dict[str, str]) -> None:
    async for raw in upstream:
        text = raw if isinstance(raw, str) else raw.decode("utf-8", "replace")
        try:
            data = json.loads(text)
        except ValueError:
            await client.send_text(text)
            continue
        if isinstance(data, dict):
            data = map_status_for_plana(data, mapping)
            await client.send_json(data)
        else:
            await client.send_text(text)


async def proxy_bot_socket(
    client: WebSocket,
    *,
    upstream_base: str,
    status_mapping: dict[str, str],
    connect: Any = None,
) -> None:
    """接受下游连接、建立上游连接,然后双向泵到任一端关闭。"""

    subprotocol_session = offered_session(client)
    if subprotocol_session:
        # 本宿主方言:回显子协议,无需等 bind_session。
        await client.accept(subprotocol=f"{_SUBPROTOCOL_PREFIX}{subprotocol_session}")
        session_id = subprotocol_session
    else:
        await client.accept()
        try:
            first = await asyncio.wait_for(client.receive_text(), BIND_TIMEOUT_SECONDS)
        except (TimeoutError, asyncio.TimeoutError, WebSocketDisconnect):
            await client.close(code=CLOSE_PROTOCOL_ERROR, reason="bind_session required")
            return
        try:
            payload = json.loads(first)
        except ValueError:
            payload = None
        if not isinstance(payload, dict) or payload.get("action") != "bind_session":
            await client.close(code=CLOSE_PROTOCOL_ERROR, reason="bind_session required")
            return
        session_id = str(payload.get("session_id") or "")

    if not session_id:
        await client.close(code=CLOSE_PROTOCOL_ERROR, reason="missing session_id")
        return

    connector = connect or websockets.connect
    try:
        upstream_cm = connector(
            upstream_ws_url(upstream_base),
            subprotocols=[Subprotocol(f"{_SUBPROTOCOL_PREFIX}{session_id}")],
        )
    except Exception:
        await client.close(code=CLOSE_UPSTREAM_REJECTED, reason="upstream unavailable")
        return

    try:
        async with upstream_cm as upstream:
            pumps = [
                asyncio.create_task(_client_to_upstream(client, upstream)),
                asyncio.create_task(_upstream_to_client(upstream, client, status_mapping)),
            ]
            done, pending = await asyncio.wait(pumps, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
            for task in done:
                # 泵内的异常在这里浮现(连接关闭属正常收场,吞掉)。
                with contextlib.suppress(
                    WebSocketDisconnect,
                    websockets.exceptions.ConnectionClosed,
                    asyncio.CancelledError,
                ):
                    task.result()
    except Exception:
        # 上游握手失败(会话失效 → 宿主 close 4401)也走这里。
        with contextlib.suppress(RuntimeError):
            await client.close(code=CLOSE_UPSTREAM_REJECTED, reason="upstream closed")
        return

    with contextlib.suppress(RuntimeError):
        await client.close()


__all__ = [
    "BIND_TIMEOUT_SECONDS",
    "CLOSE_PROTOCOL_ERROR",
    "CLOSE_UPSTREAM_REJECTED",
    "map_status_for_plana",
    "offered_session",
    "proxy_bot_socket",
    "upstream_ws_url",
]
