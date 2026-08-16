"""CNBComfyPool 控制面：钉扎出站客户端接线与失败封闭行为。"""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import pytest

from agent_router import cnb_comfy_pool
from agent_router.cnb_comfy_pool import CNBComfyPool
from cloud_backend.errors import InvalidRequestError


class _JsonStub:
    def __init__(self, responses: list[Any]) -> None:
        self.responses = responses
        self.calls: list[dict[str, Any]] = []

    async def post_json(self, url, *, headers, payload, timeout):
        self.calls.append(
            {"url": url, "headers": dict(headers), "payload": payload, "timeout": timeout}
        )
        result = self.responses.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


class _BinaryStub:
    def __init__(self, responses: list[Any]) -> None:
        self.responses = responses
        self.calls: list[dict[str, Any]] = []

    async def get(self, url, *, headers, timeout, max_bytes):
        self.calls.append(
            {"url": url, "headers": dict(headers), "timeout": timeout, "max_bytes": max_bytes}
        )
        result = self.responses.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


def _response(status: int, body: Any) -> SimpleNamespace:
    encoded = body if isinstance(body, bytes) else json.dumps(body).encode()
    return SimpleNamespace(status=status, body=encoded)


def _pool(tmp_path) -> CNBComfyPool:
    return CNBComfyPool(
        name="test",
        accounts=[{"repo": "org/repo", "token": "cnb-token", "name": "acct"}],
        store_path=tmp_path / "store.json",
    )


def _install(monkeypatch, json_stub: _JsonStub, binary_stub: _BinaryStub) -> None:
    monkeypatch.setattr(
        cnb_comfy_pool, "_outbound_clients", lambda: (json_stub, binary_stub)
    )


def test_no_bare_aiohttp_left_in_module() -> None:
    # 控制面带 Authorization 凭据出网，必须停留在钉扎客户端上。
    import inspect

    source = inspect.getsource(cnb_comfy_pool)
    assert "import aiohttp" not in source
    assert "aiohttp.ClientSession" not in source


@pytest.mark.asyncio
async def test_cnb_api_request_sends_token_and_maps_errors(tmp_path, monkeypatch) -> None:
    json_stub = _JsonStub([_response(200, {"ok": True}), _response(403, {"msg": "denied"})])
    binary_stub = _BinaryStub([_response(200, {"list": []})])
    _install(monkeypatch, json_stub, binary_stub)
    pool = _pool(tmp_path)

    data = await pool.cnb_api_request(
        "POST", "https://api.cnb.cool/x/-/workspace/start", "cnb-token", {"branch": "main"}
    )
    assert data == {"ok": True}
    assert json_stub.calls[0]["headers"]["Authorization"] == "cnb-token"
    assert json_stub.calls[0]["payload"] == {"branch": "main"}

    listed = await pool.cnb_api_request(
        "GET", "https://api.cnb.cool/workspace/list?slug=org%2Frepo", "cnb-token"
    )
    assert listed == {"list": []}
    assert binary_stub.calls[0]["headers"]["Authorization"] == "cnb-token"

    with pytest.raises(Exception, match="CNB API 403"):
        await pool.cnb_api_request(
            "POST", "https://api.cnb.cool/workspace/stop", "cnb-token", {"sn": "1"}
        )


@pytest.mark.asyncio
async def test_cnb_api_request_propagates_policy_rejection(tmp_path, monkeypatch) -> None:
    rejection = InvalidRequestError("outbound host resolves to a forbidden address")
    _install(monkeypatch, _JsonStub([rejection]), _BinaryStub([rejection]))
    pool = _pool(tmp_path)

    # 策略拒绝原样上抛：控制面绝不把内网/非法地址当成普通失败重试。
    with pytest.raises(InvalidRequestError):
        await pool.cnb_api_request("POST", "https://evil.internal/start", "t", {})
    with pytest.raises(InvalidRequestError):
        await pool.cnb_api_request("GET", "https://evil.internal/list", "t")


@pytest.mark.asyncio
async def test_healthcheck_requires_comfy_shape_and_fails_closed(
    tmp_path, monkeypatch
) -> None:
    healthy_system = {
        "system": {"comfyui_version": "0.3.71"},
        "devices": [{"name": "cuda"}],
    }
    object_info = {"KSampler": {}}
    cases: list[tuple[list[Any], bool]] = [
        ([_response(200, healthy_system), _response(200, object_info)], True),
        ([_response(500, {})], False),
        ([_response(200, healthy_system), _response(200, {})], False),
        ([_response(200, {"system": {}, "devices": []}), _response(200, object_info)], False),
        ([_response(200, b"not-json{")], False),
        ([InvalidRequestError("forbidden address")], False),
        ([ConnectionError("down")], False),
    ]
    for responses, expected in cases:
        binary_stub = _BinaryStub(list(responses))
        _install(monkeypatch, _JsonStub([]), binary_stub)
        pool = _pool(tmp_path)
        assert await pool.healthcheck("https://ws.cnb.run") is expected, responses


@pytest.mark.asyncio
async def test_queue_helpers_use_pinned_clients(tmp_path, monkeypatch) -> None:
    json_stub = _JsonStub([_response(200, {}), _response(200, {})])
    binary_stub = _BinaryStub(
        [
            _response(200, {"queue_running": [], "queue_pending": []}),
            _response(200, {"pid": {"outputs": {}}}),
        ]
    )
    _install(monkeypatch, json_stub, binary_stub)
    pool = _pool(tmp_path)

    queue = await pool.get_queue("https://ws.cnb.run")
    assert queue == {"queue_running": [], "queue_pending": []}
    history = await pool.get_history("https://ws.cnb.run")
    assert "pid" in history
    await pool.delete_queue_items("https://ws.cnb.run", ["pid-1", " ", ""])
    await pool.interrupt("https://ws.cnb.run")

    assert [c["url"] for c in binary_stub.calls] == [
        "https://ws.cnb.run/queue",
        "https://ws.cnb.run/history",
    ]
    assert json_stub.calls[0]["url"] == "https://ws.cnb.run/queue"
    assert json_stub.calls[0]["payload"] == {"delete": ["pid-1"]}
    assert json_stub.calls[1]["url"] == "https://ws.cnb.run/interrupt"


@pytest.mark.asyncio
async def test_queue_helpers_raise_on_upstream_errors(tmp_path, monkeypatch) -> None:
    json_stub = _JsonStub([_response(500, b"boom")])
    binary_stub = _BinaryStub([_response(503, b"unavailable")])
    _install(monkeypatch, json_stub, binary_stub)
    pool = _pool(tmp_path)

    with pytest.raises(Exception, match="读取队列失败: 503"):
        await pool.get_queue("https://ws.cnb.run")
    with pytest.raises(Exception, match="中断运行任务失败: 500"):
        await pool.interrupt("https://ws.cnb.run")


@pytest.mark.asyncio
async def test_delete_queue_items_skips_network_when_empty(tmp_path, monkeypatch) -> None:
    json_stub = _JsonStub([])
    _install(monkeypatch, json_stub, _BinaryStub([]))
    pool = _pool(tmp_path)
    await pool.delete_queue_items("https://ws.cnb.run", ["", "  "])
    assert json_stub.calls == []
