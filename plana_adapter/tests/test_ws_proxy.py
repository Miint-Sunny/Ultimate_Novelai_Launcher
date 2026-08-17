"""WS 代理测试。

用假的上游连接器(不起真网络)驱动代理,验证两种下游方言的绑定、bind_session
不被转发给宿主(会 4403)、以及状态词映射。
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from fastapi.testclient import TestClient

from plana_adapter.app import create_app
from plana_adapter.config import AdapterConfig
from plana_adapter.ws_proxy import (
    CLOSE_PROTOCOL_ERROR,
    map_status_for_plana,
    offered_session,
    upstream_ws_url,
)

CONFIG = AdapterConfig(
    upstream_base="http://upstream.test",
    host="127.0.0.1",
    port=8765,
    request_timeout=5.0,
    generate_timeout=5.0,
    max_pending_codes=100,
)


class FakeUpstream:
    """最小的上游 WS 替身:记录收到的消息,按脚本回发。"""

    def __init__(self, script: list[str], record: dict[str, Any]) -> None:
        self._script = list(script)
        self._record = record
        self._queue: asyncio.Queue[str | None] = asyncio.Queue()

    async def send(self, raw: str) -> None:
        self._record.setdefault("sent", []).append(raw)

    def __aiter__(self) -> FakeUpstream:
        return self

    async def __anext__(self) -> str:
        if self._script:
            return self._script.pop(0)
        # 脚本放完就挂起,让另一条泵决定何时收场。
        await asyncio.Event().wait()
        raise StopAsyncIteration


class FakeConnect:
    """替代 websockets.connect 的异步上下文管理器。"""

    def __init__(self, script: list[str], record: dict[str, Any]) -> None:
        self._script = script
        self._record = record

    def __call__(self, url: str, **kwargs: Any) -> FakeConnect:
        self._record["url"] = url
        self._record["subprotocols"] = [str(value) for value in kwargs.get("subprotocols", [])]
        return self

    async def __aenter__(self) -> FakeUpstream:
        return FakeUpstream(self._script, self._record)

    async def __aexit__(self, *exc: Any) -> None:
        return None


def test_upstream_ws_url_scheme_swap() -> None:
    assert upstream_ws_url("https://host.example") == "wss://host.example/ws/bot"
    assert upstream_ws_url("http://127.0.0.1:9000/") == "ws://127.0.0.1:9000/ws/bot"


def test_status_mapping_only_touches_known_words() -> None:
    mapping = {"cancelling": "generating", "interrupted": "failed"}
    assert map_status_for_plana({"status": "interrupted"}, mapping)["status"] == "failed"
    assert map_status_for_plana({"status": "completed"}, mapping)["status"] == "completed"
    assert map_status_for_plana({"step": 1}, mapping) == {"step": 1}


def test_plana_dialect_binds_then_relays_with_status_mapping() -> None:
    record: dict[str, Any] = {}
    connect = FakeConnect(
        [json.dumps({"action": "task_update", "status": "interrupted", "error": "boom"})],
        record,
    )
    app = create_app(CONFIG, ws_connect=connect)

    with TestClient(app).websocket_connect("/ws/bot") as ws:
        # Plana 方言:匿名连上,首条消息绑定会话。
        ws.send_text(json.dumps({"action": "bind_session", "session_id": "sess-1"}))
        ws.send_text(json.dumps({"action": "subscribe_task", "task_id": "t-1"}))
        message = ws.receive_json()

    # 上游用宿主要求的子协议连接。
    assert record["url"] == "ws://upstream.test/ws/bot"
    assert record["subprotocols"] == ["bot-session.sess-1"]
    # bind_session 不能转发给宿主(会 close 4403);subscribe_task 要转发。
    sent_actions = [json.loads(raw)["action"] for raw in record.get("sent", [])]
    assert "bind_session" not in sent_actions
    assert "subscribe_task" in sent_actions
    # 宿主的 interrupted 被映射成 Plana 词表的 failed。
    assert message["status"] == "failed"


def test_host_dialect_subprotocol_is_echoed_and_needs_no_bind() -> None:
    record: dict[str, Any] = {}
    connect = FakeConnect([json.dumps({"action": "task_update", "status": "completed"})], record)
    app = create_app(CONFIG, ws_connect=connect)

    with TestClient(app).websocket_connect(
        "/ws/bot", subprotocols=["bot-session.sess-2"]
    ) as ws:
        message = ws.receive_json()

    # 子协议方言:无需 bind_session,会话直接从子协议取。
    assert record["subprotocols"] == ["bot-session.sess-2"]
    assert message["status"] == "completed"


def test_first_message_must_be_bind_session() -> None:
    record: dict[str, Any] = {}
    app = create_app(CONFIG, ws_connect=FakeConnect([], record))

    with pytest.raises(Exception):  # noqa: B017 - 客户端侧表现为连接被关闭
        with TestClient(app).websocket_connect("/ws/bot") as ws:
            ws.send_text(json.dumps({"action": "subscribe_task", "task_id": "t-1"}))
            ws.receive_json()

    # 没有绑定就不会去连上游。
    assert "url" not in record


def test_offered_session_parses_subprotocol_header() -> None:
    class _WS:
        headers = {"sec-websocket-protocol": "foo, bot-session.abc123"}

    assert offered_session(_WS()) == "abc123"  # type: ignore[arg-type]

    class _Empty:
        headers: dict[str, str] = {}

    assert offered_session(_Empty()) == ""  # type: ignore[arg-type]


def test_close_code_constant_is_protocol_error() -> None:
    assert CLOSE_PROTOCOL_ERROR == 4400
