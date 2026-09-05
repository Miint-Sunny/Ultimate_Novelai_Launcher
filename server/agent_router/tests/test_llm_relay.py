"""Host relay ``POST /api/agent/llm/chat``: sidecar contract (§2) plus the host deltas (§2.5).

上游一律 MockTransport,不得打真 API。红线:密钥不出宿主(请求体没有 key,问题响应与
流里都不能出现);流开始前的 400 兼容重试只发生在生成任何字节之前;没有备用槽位。
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from agent_router import llm_relay, model_provider
from agent_router.access import AgentAccess
from agent_router.llm.stream import RelayChannel, drain_relay
from agent_router.router import router
from cloud_backend.identity import Principal

SECRET = "relay-secret-key"
REGISTRY: dict[str, dict[str, Any]] = {
    "fake-model": {
        # /v1beta is normalised to /v1 for the openai protocol, like get_model does.
        "base_url": "https://provider.test/v1beta",
        "api_key": SECRET,
        "proxy": "",
        "protocol": "openai",
        "extra_body": {"thinking": {"type": "enabled"}},
        "model_settings": {"max_tokens": 4096, "temperature": 0.3},
        "supports_tools": True,
        "supports_vision": True,
    },
    "claude-native": {
        "base_url": "https://anthropic.test",
        "api_key": SECRET,
        "proxy": "",
        "protocol": "anthropic",
    },
}
CHOICES: dict[str, dict[str, Any]] = {
    "fake": {"label": "Fake Model", "model": "fake-model", "aliases": ["fk"]},
    "native": {"label": "Native", "model": "claude-native", "aliases": []},
}
CHUNK = {
    "id": "chunk-1",
    "object": "chat.completion.chunk",
    "created": 1,
    "model": "fake-model",
    "choices": [
        {"index": 0, "delta": {"role": "assistant", "content": "你好"}, "finish_reason": None}
    ],
}
USAGE_CHUNK = {
    "id": "chunk-1",
    "object": "chat.completion.chunk",
    "created": 1,
    "model": "fake-model",
    "choices": [],
    "usage": {"prompt_tokens": 12, "completion_tokens": 3, "total_tokens": 15},
}
TOOL = {
    "type": "function",
    "function": {
        "name": "novelai_generate",
        "description": "生成一张图",
        "parameters": {"type": "object", "properties": {"prompt": {"type": "string"}}},
    },
}


def _sse(*blocks: dict[str, Any], done: bool = True) -> bytes:
    text = "".join(f"data: {json.dumps(block, ensure_ascii=False)}\n\n" for block in blocks)
    if done:
        text += "data: [DONE]\n\n"
    return text.encode("utf-8")


def _request_body(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "messages": [{"role": "user", "content": "画一只猫"}],
        "tools": [TOOL],
        "temperature": 0.7,
        "prompt_cache_key": "session-1",
        "extra_body": {"reasoning": {"effort": "high"}},
    }
    body.update(overrides)
    return body


def _user_access() -> AgentAccess:
    return AgentAccess(Principal.user("owner", "tenant"))


@pytest.fixture
def registry(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        model_provider,
        "_load_registry_and_choices",
        lambda: (REGISTRY, CHOICES, "openai", "fake"),
    )
    monkeypatch.setattr(llm_relay, "_active_streams", {})
    monkeypatch.setattr(llm_relay, "_clients", {})


@pytest.fixture
def app(registry: None) -> FastAPI:
    application = FastAPI()
    application.include_router(router)
    application.state.agent_authenticator = lambda _request: _user_access()
    application.state.agent_paid_authorizer = lambda _access: True
    return application


def _install_upstream(
    monkeypatch: pytest.MonkeyPatch,
    handler: Callable[[httpx.Request], httpx.Response],
) -> list[httpx.Request]:
    seen: list[httpx.Request] = []

    def recording(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    client = httpx.AsyncClient(transport=httpx.MockTransport(recording))
    monkeypatch.setattr(llm_relay, "get_stream_client", lambda _target: client)
    return seen


def _stream_response(*blocks: dict[str, Any], done: bool = True) -> httpx.Response:
    return httpx.Response(
        200,
        headers={"content-type": "text/event-stream"},
        content=_sse(*blocks, done=done),
    )


async def _post(app: FastAPI, body: dict[str, Any]) -> httpx.Response:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.post("/api/agent/llm/chat", json=body)


async def test_relays_chunks_and_owns_model_stream_and_headers(
    app: FastAPI, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen = _install_upstream(monkeypatch, lambda _r: _stream_response(CHUNK, USAGE_CHUNK))

    response = await _post(app, _request_body())

    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("text/event-stream")
    assert response.headers["x-llm-slot"] == "fake"
    assert response.headers["x-llm-model"] == "fake-model"
    assert response.headers["x-llm-provider"] == "openai"
    blocks = [line for line in response.text.split("\n\n") if line]
    assert json.loads(blocks[0].removeprefix("data: ")) == CHUNK
    assert json.loads(blocks[1].removeprefix("data: ")) == USAGE_CHUNK
    assert blocks[2] == "data: [DONE]"
    assert SECRET not in response.text

    assert len(seen) == 1
    upstream = seen[0]
    assert str(upstream.url) == "https://provider.test/v1/chat/completions"
    assert upstream.headers["authorization"] == f"Bearer {SECRET}"
    assert upstream.headers["accept"] == "text/event-stream"
    sent = json.loads(upstream.content)
    assert sent["model"] == "fake-model"
    assert sent["stream"] is True
    assert sent["stream_options"] == {"include_usage": True}
    assert sent["tools"] == [TOOL]
    assert sent["tool_choice"] == "auto"
    assert sent["prompt_cache_key"] == "session-1"
    # Client thinking switches survive; the deployment's extra_body is layered on top.
    assert sent["reasoning"] == {"effort": "high"}
    assert sent["thinking"] == {"type": "enabled"}
    # Registry model_settings are defaults only: the request's temperature wins.
    assert sent["temperature"] == 0.7
    assert sent["max_tokens"] == 4096
    assert "slot" not in sent


async def test_choice_aliases_resolve_and_unknown_model_is_422(
    app: FastAPI, monkeypatch: pytest.MonkeyPatch
) -> None:
    _install_upstream(monkeypatch, lambda _r: _stream_response(CHUNK))

    for name in ("fk", "Fake Model", "fake-model", ""):
        response = await _post(app, _request_body(model=name))
        assert response.status_code == 200, (name, response.text)
        assert response.headers["x-llm-slot"] == "fake"

    response = await _post(app, _request_body(model="nope"))
    assert response.status_code == 422
    assert response.headers["content-type"].startswith("application/problem+json")
    problem = response.json()
    assert problem["code"] == "unknown_model"
    assert problem["retryable"] is False
    assert problem["context"] == {"model": "nope"}


async def test_native_protocol_choice_is_unsupported(
    app: FastAPI, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen = _install_upstream(monkeypatch, lambda _r: _stream_response(CHUNK))

    response = await _post(app, _request_body(model="native"))

    assert response.status_code == 503
    problem = response.json()
    assert problem["code"] == "llm_stream_provider_unsupported"
    assert problem["retryable"] is False
    assert problem["context"] == {"provider": "anthropic", "model": "native"}
    assert seen == []


async def test_backup_slot_does_not_exist_on_the_host(
    app: FastAPI, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen = _install_upstream(monkeypatch, lambda _r: _stream_response(CHUNK))

    response = await _post(app, _request_body(slot="backup"))

    assert response.status_code == 503
    assert response.json()["code"] == "llm_not_configured"
    assert seen == []


@pytest.mark.parametrize(
    ("status", "retryable"),
    [(502, True), (429, True), (401, False), (404, False)],
)
async def test_upstream_status_before_first_byte_is_a_problem(
    app: FastAPI, monkeypatch: pytest.MonkeyPatch, status: int, retryable: bool
) -> None:
    body = json.dumps({"error": {"message": f"nope {SECRET}"}}).encode()
    _install_upstream(monkeypatch, lambda _r: httpx.Response(status, content=body))

    response = await _post(app, _request_body())

    assert response.status_code == 503
    problem = response.json()
    assert problem["code"] == "llm_upstream_failed"
    assert problem["retryable"] is retryable
    assert problem["context"] == {"upstream_status": status, "slot": "fake"}
    assert SECRET not in response.text


async def test_400_retries_once_without_optional_keys(
    app: FastAPI, monkeypatch: pytest.MonkeyPatch
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        sent = json.loads(request.content)
        if "prompt_cache_key" in sent or "stream_options" in sent:
            return httpx.Response(400, json={"error": "unknown parameter"})
        return _stream_response(CHUNK)

    seen = _install_upstream(monkeypatch, handler)

    response = await _post(app, _request_body())

    assert response.status_code == 200, response.text
    assert len(seen) == 2
    retried = json.loads(seen[1].content)
    assert "prompt_cache_key" not in retried
    assert "stream_options" not in retried
    assert retried["stream"] is True


async def test_400_on_the_retry_is_final(app: FastAPI, monkeypatch: pytest.MonkeyPatch) -> None:
    seen = _install_upstream(monkeypatch, lambda _r: httpx.Response(400, json={"error": "x"}))

    response = await _post(app, _request_body())

    assert response.status_code == 503
    assert response.json()["code"] == "llm_upstream_failed"
    assert response.json()["retryable"] is False
    assert len(seen) == 2


async def test_unreachable_upstream_is_retryable(
    app: FastAPI, monkeypatch: pytest.MonkeyPatch
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    _install_upstream(monkeypatch, handler)

    response = await _post(app, _request_body())

    assert response.status_code == 503
    problem = response.json()
    assert problem["code"] == "llm_upstream_unreachable"
    assert problem["retryable"] is True


async def test_json_completion_is_folded_into_one_chunk(
    app: FastAPI, monkeypatch: pytest.MonkeyPatch
) -> None:
    completion = {
        "id": "cmpl-1",
        "object": "chat.completion",
        "created": 7,
        "model": "fake-model",
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": "call-1",
                            "type": "function",
                            "function": {"name": "novelai_generate", "arguments": "{}"},
                        }
                    ],
                },
                "finish_reason": "tool_calls",
            }
        ],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
    }
    _install_upstream(monkeypatch, lambda _r: httpx.Response(200, json=completion))

    response = await _post(app, _request_body())

    assert response.status_code == 200
    blocks = [line for line in response.text.split("\n\n") if line]
    chunk = json.loads(blocks[0].removeprefix("data: "))
    assert chunk["object"] == "chat.completion.chunk"
    assert chunk["choices"][0]["delta"]["tool_calls"][0]["index"] == 0
    assert chunk["choices"][0]["finish_reason"] == "tool_calls"
    assert chunk["usage"]["total_tokens"] == 2
    assert blocks[1] == "data: [DONE]"


async def test_missing_done_marker_and_crlf_are_repaired(
    app: FastAPI, monkeypatch: pytest.MonkeyPatch
) -> None:
    raw = b"data: " + json.dumps(CHUNK).encode() + b"\r\n\r\n"
    _install_upstream(
        monkeypatch,
        lambda _r: httpx.Response(200, headers={"content-type": "text/event-stream"}, content=raw),
    )

    response = await _post(app, _request_body())

    assert response.status_code == 200
    assert "\r" not in response.text
    assert response.text.endswith("data: [DONE]\n\n")


@pytest.mark.parametrize(
    "body",
    [
        _request_body(unknown_field=1),
        _request_body(extra_body={"model": "override"}),
        _request_body(
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "image_url", "image_url": {"url": "https://x.test/cat.png"}}
                    ],
                }
            ]
        ),
        _request_body(messages=[{"role": "tool", "content": "no id"}]),
        _request_body(temperature=3.5),
    ],
)
async def test_contract_violations_are_422(
    app: FastAPI, monkeypatch: pytest.MonkeyPatch, body: dict[str, Any]
) -> None:
    seen = _install_upstream(monkeypatch, lambda _r: _stream_response(CHUNK))

    response = await _post(app, body)

    assert response.status_code == 422, response.text
    assert seen == []


async def test_identity_and_paid_gates_apply(app: FastAPI, monkeypatch: pytest.MonkeyPatch) -> None:
    seen = _install_upstream(monkeypatch, lambda _r: _stream_response(CHUNK))

    app.state.agent_paid_authorizer = lambda _access: False
    assert (await _post(app, _request_body())).status_code == 402

    del app.state.agent_authenticator
    assert (await _post(app, _request_body())).status_code == 503
    assert seen == []


async def test_concurrent_streams_per_owner_are_capped(
    app: FastAPI, monkeypatch: pytest.MonkeyPatch
) -> None:
    _install_upstream(monkeypatch, lambda _r: _stream_response(CHUNK))
    key = llm_relay.owner_key(_user_access())
    llm_relay._active_streams[key] = llm_relay.MAX_STREAMS_PER_OWNER

    response = await _post(app, _request_body())

    assert response.status_code == 429
    assert response.headers["retry-after"] == "2"
    problem = response.json()
    assert problem["code"] == "llm_stream_concurrency_exceeded"
    assert problem["retryable"] is True

    llm_relay._active_streams.clear()
    assert (await _post(app, _request_body())).status_code == 200
    # A finished stream releases its slot.
    assert llm_relay.active_stream_count(key) == 0


async def test_failed_open_releases_the_concurrency_slot(
    app: FastAPI, monkeypatch: pytest.MonkeyPatch
) -> None:
    _install_upstream(monkeypatch, lambda _r: httpx.Response(500, content=b"boom"))
    key = llm_relay.owner_key(_user_access())

    assert (await _post(app, _request_body())).status_code == 503
    assert llm_relay.active_stream_count(key) == 0


def test_owner_key_distinguishes_service_principals() -> None:
    user = llm_relay.owner_key(_user_access())
    bot = llm_relay.owner_key(
        AgentAccess(Principal.bot("legacy-agent-bot", "tenant"), trusted_service=True)
    )
    assert user == "owner:owner"
    assert bot == "owner:legacy-agent-bot"
    assert user != bot


async def test_drain_cancels_the_producer_when_the_client_leaves() -> None:
    channel = RelayChannel()
    started = asyncio.Event()

    async def producer_body() -> None:
        started.set()
        try:
            while True:
                await channel.put("data: {}\n\n")
                await asyncio.sleep(0.01)
        finally:
            channel.close()

    producer = asyncio.create_task(producer_body())
    stream = drain_relay(channel, producer)
    first = await stream.__anext__()
    assert first.startswith("data: ")
    await started.wait()
    await stream.aclose()

    assert producer.cancelled() or producer.done()


def test_get_stream_target_reports_misconfiguration(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        model_provider,
        "_load_registry_and_choices",
        lambda: ({}, {"fake": {"label": "Fake", "model": "missing"}}, "openai", "fake"),
    )
    with pytest.raises(ValueError):
        model_provider.get_stream_target("")
    with pytest.raises(LookupError):
        model_provider.get_stream_target("ghost")
