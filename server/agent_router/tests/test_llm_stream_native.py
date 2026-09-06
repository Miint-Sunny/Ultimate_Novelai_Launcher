"""Native slots stream too: Anthropic / Gemini requests and stream translation (B4).

红线:翻译只发生在两端(请求体、流事件),客户端永远只看 OpenAI chunk;密钥只进上游头;
被安全系统整段拦截时给非瞬态 ``error`` 事件而不是空流(空流会让客户端白退避三次)。
上游一律 MockTransport。
"""

from __future__ import annotations

import base64
import json
from collections.abc import Callable
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from agent_router import llm_relay, model_provider
from agent_router.access import AgentAccess
from agent_router.llm.stream import LlmStreamUnsupportedError, NativeStreamError
from agent_router.llm.stream_native import (
    GEMINI_SAFETY_OFF,
    AnthropicTranslator,
    GeminiTranslator,
    anthropic_messages,
    build_anthropic_request,
    build_gemini_request,
    build_upstream_request,
    gemini_contents,
)
from agent_router.router import router
from cloud_backend.identity import Principal

SECRET = "native-secret-key"
PNG = "data:image/png;base64," + base64.b64encode(b"\x89PNG fake").decode()
TOOL = {
    "type": "function",
    "function": {
        "name": "novelai_generate",
        "description": "生成一张图",
        "parameters": {
            "type": "object",
            "properties": {
                "prompt": {"type": "string"},
                "seed": {"anyOf": [{"type": "integer"}, {"type": "null"}]},
            },
            "required": ["prompt"],
            "additionalProperties": False,
        },
    },
}
CONVERSATION: list[dict[str, Any]] = [
    {"role": "system", "content": "你是画师助手"},
    {"role": "assistant", "content": "孤立的开头轮"},
    {
        "role": "user",
        "content": [
            {"type": "text", "text": "照着这张画"},
            {"type": "image_url", "image_url": {"url": PNG}},
        ],
    },
    {
        "role": "assistant",
        "content": "好的",
        "tool_calls": [
            {
                "id": "call_1",
                "type": "function",
                "function": {"name": "novelai_generate", "arguments": '{"prompt": "1girl"}'},
            }
        ],
    },
    {"role": "tool", "tool_call_id": "call_1", "content": "生成完成"},
    {"role": "user", "content": "再来一张"},
]


def _fields(**overrides: Any) -> dict[str, Any]:
    fields: dict[str, Any] = {"messages": [{"role": "user", "content": "画一只猫"}]}
    fields.update(overrides)
    return fields


# ---------------------------------------------------------------------------
# Anthropic
# ---------------------------------------------------------------------------


def test_anthropic_messages_follow_the_messages_api_shape() -> None:
    system, messages = anthropic_messages(CONVERSATION)

    assert system == [{"type": "text", "text": "你是画师助手"}]
    # The orphan assistant opener is dropped; the tool result and the next user
    # text fold into one user turn (strict alternation).
    assert [m["role"] for m in messages] == ["user", "assistant", "user"]
    assert messages[0]["content"] == [
        {"type": "text", "text": "照着这张画"},
        {
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "image/png",
                "data": PNG.split(",", 1)[1],
            },
        },
    ]
    assert messages[1]["content"] == [
        {"type": "text", "text": "好的"},
        {
            "type": "tool_use",
            "id": "call_1",
            "name": "novelai_generate",
            "input": {"prompt": "1girl"},
        },
    ]
    assert messages[2]["content"] == [
        {"type": "tool_result", "tool_use_id": "call_1", "content": "生成完成"},
        {"type": "text", "text": "再来一张"},
    ]


def test_anthropic_request_maps_tools_thinking_and_namespaced_extra_body() -> None:
    upstream = build_anthropic_request(
        model="claude-x",
        base_url="https://anthropic.test/",
        api_key=SECRET,
        fields=_fields(
            tools=[TOOL],
            tool_choice="required",
            max_tokens=1000,
            temperature=0.7,
            reasoning_effort="high",
            extra_body={
                # OpenAI-gateway switch: not part of the Anthropic wire, ignored.
                "thinking": {"type": "enabled"},
                "anthropic": {"top_k": 5, "model": "hijack", "messages": []},
            },
        ),
    )

    assert upstream.url == "https://anthropic.test/v1/messages"
    assert upstream.headers["x-api-key"] == SECRET
    assert upstream.headers["anthropic-version"] == "2023-06-01"
    assert upstream.headers["Accept"] == "text/event-stream"
    body = upstream.body
    assert body["model"] == "claude-x"
    assert body["stream"] is True
    assert body["tools"] == [
        {
            "name": "novelai_generate",
            "description": "生成一张图",
            "input_schema": TOOL["function"]["parameters"],
        }
    ]
    assert body["tool_choice"] == {"type": "any"}
    assert body["thinking"] == {"type": "enabled", "budget_tokens": 16384}
    # max_tokens must exceed the thinking budget; temperature is not allowed with thinking.
    assert body["max_tokens"] == 16384 + 4096
    assert "temperature" not in body
    assert body["top_k"] == 5
    assert body["messages"] == [{"role": "user", "content": [{"type": "text", "text": "画一只猫"}]}]
    assert isinstance(upstream.translator, AnthropicTranslator)


def test_anthropic_request_without_thinking_keeps_temperature_and_defaults() -> None:
    upstream = build_anthropic_request(
        model="claude-x",
        base_url="https://anthropic.test",
        api_key=SECRET,
        fields=_fields(temperature=0.2, reasoning_effort="none"),
    )
    assert upstream.body["temperature"] == 0.2
    assert upstream.body["max_tokens"] == 4096
    assert "thinking" not in upstream.body
    assert "tools" not in upstream.body


def test_anthropic_translator_turns_events_into_openai_chunks() -> None:
    translator = AnthropicTranslator()
    events = [
        {
            "type": "message_start",
            "message": {
                "id": "msg_1",
                "model": "claude-x",
                "usage": {"input_tokens": 10, "cache_read_input_tokens": 2, "output_tokens": 1},
            },
        },
        {"type": "ping"},
        {"type": "content_block_start", "index": 0, "content_block": {"type": "thinking"}},
        {
            "type": "content_block_delta",
            "index": 0,
            "delta": {"type": "thinking_delta", "thinking": "让我想想"},
        },
        {"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta"}},
        {"type": "content_block_stop", "index": 0},
        {"type": "content_block_start", "index": 1, "content_block": {"type": "text", "text": ""}},
        {
            "type": "content_block_delta",
            "index": 1,
            "delta": {"type": "text_delta", "text": "你好"},
        },
        {
            "type": "content_block_start",
            "index": 2,
            "content_block": {"type": "tool_use", "id": "toolu_1", "name": "novelai_generate"},
        },
        {
            "type": "content_block_delta",
            "index": 2,
            "delta": {"type": "input_json_delta", "partial_json": '{"prompt":'},
        },
        {
            "type": "content_block_delta",
            "index": 2,
            "delta": {"type": "input_json_delta", "partial_json": ' "cat"}'},
        },
        {"type": "content_block_stop", "index": 2},
        {
            "type": "message_delta",
            "delta": {"stop_reason": "tool_use"},
            "usage": {"output_tokens": 30},
        },
        {"type": "message_stop"},
    ]

    chunks: list[dict[str, Any]] = []
    for event in events:
        chunks.extend(translator.feed(json.dumps(event)))
    assert translator.finish() == []

    deltas = [c["choices"][0]["delta"] for c in chunks if c["choices"]]
    assert deltas[0] == {"reasoning_content": "让我想想"}
    assert deltas[1] == {"content": "你好"}
    assert deltas[2] == {
        "tool_calls": [
            {
                "index": 0,
                "id": "toolu_1",
                "type": "function",
                "function": {"name": "novelai_generate", "arguments": ""},
            }
        ]
    }
    assert deltas[3] == {"tool_calls": [{"index": 0, "function": {"arguments": '{"prompt":'}}]}
    assert deltas[4] == {"tool_calls": [{"index": 0, "function": {"arguments": ' "cat"}'}}]}
    assert chunks[-2]["choices"][0]["finish_reason"] == "tool_calls"
    assert chunks[-1]["choices"] == []
    assert chunks[-1]["usage"] == {"prompt_tokens": 12, "completion_tokens": 30, "total_tokens": 42}
    assert all(c["id"] == "msg_1" and c["model"] == "claude-x" for c in chunks)


def test_anthropic_translator_folds_a_whole_message() -> None:
    translator = AnthropicTranslator()
    chunks = (
        translator.feed_json(
            {
                "type": "message",
                "id": "msg_2",
                "model": "claude-x",
                "content": [
                    {"type": "text", "text": "画好了"},
                    {
                        "type": "tool_use",
                        "id": "toolu_9",
                        "name": "novelai_generate",
                        "input": {"a": 1},
                    },
                ],
                "stop_reason": "end_turn",
                "usage": {"input_tokens": 5, "output_tokens": 7},
            }
        )
        + translator.finish()
    )

    assert chunks[0]["choices"][0]["delta"] == {"content": "画好了"}
    call = chunks[1]["choices"][0]["delta"]["tool_calls"][0]
    assert call["id"] == "toolu_9"
    assert json.loads(call["function"]["arguments"]) == {"a": 1}
    assert chunks[2]["choices"][0]["finish_reason"] == "stop"
    assert chunks[3]["usage"]["total_tokens"] == 12


@pytest.mark.parametrize(
    ("error_type", "retryable"),
    [("overloaded_error", True), ("api_error", True), ("invalid_request_error", False)],
)
def test_anthropic_error_events_stop_the_stream(error_type: str, retryable: bool) -> None:
    translator = AnthropicTranslator()
    with pytest.raises(NativeStreamError) as caught:
        translator.feed(
            json.dumps({"type": "error", "error": {"type": error_type, "message": "x"}})
        )
    assert caught.value.retryable is retryable
    assert caught.value.code == "llm_upstream_error"


# ---------------------------------------------------------------------------
# Gemini
# ---------------------------------------------------------------------------


def test_gemini_contents_recover_function_names_for_tool_results() -> None:
    system, contents = gemini_contents(CONVERSATION)

    assert system == [{"text": "你是画师助手"}]
    assert [c["role"] for c in contents] == ["user", "model", "user"]
    assert contents[0]["parts"] == [
        {"text": "照着这张画"},
        {"inlineData": {"mimeType": "image/png", "data": PNG.split(",", 1)[1]}},
    ]
    assert contents[1]["parts"] == [
        {"text": "好的"},
        {"functionCall": {"name": "novelai_generate", "args": {"prompt": "1girl"}}},
    ]
    assert contents[2]["parts"] == [
        {"functionResponse": {"name": "novelai_generate", "response": {"result": "生成完成"}}},
        {"text": "再来一张"},
    ]


def test_gemini_request_maps_tools_thinking_safety_and_namespaced_extra_body() -> None:
    upstream = build_gemini_request(
        model="gemini-x",
        base_url="https://gemini.test",
        api_key=SECRET,
        fields=_fields(
            tools=[TOOL],
            tool_choice="required",
            temperature=0.4,
            max_tokens=2048,
            reasoning_effort="high",
            extra_body={"gemini": {"generationConfig": {"topK": 3}, "contents": []}},
        ),
    )

    assert (
        upstream.url == "https://gemini.test/v1beta/models/gemini-x:streamGenerateContent?alt=sse"
    )
    assert upstream.headers["x-goog-api-key"] == SECRET
    body = upstream.body
    declaration = body["tools"][0]["functionDeclarations"][0]
    assert declaration["name"] == "novelai_generate"
    # JSON-schema noise Gemini rejects is cleaned: anyOf/null -> nullable, no additionalProperties.
    assert declaration["parameters"]["properties"]["seed"] == {"type": "integer", "nullable": True}
    assert "additionalProperties" not in declaration["parameters"]
    assert body["toolConfig"] == {"functionCallingConfig": {"mode": "ANY"}}
    assert body["generationConfig"] == {
        "temperature": 0.4,
        "maxOutputTokens": 2048,
        "thinkingConfig": {"includeThoughts": True, "thinkingBudget": 16384},
        "topK": 3,
    }
    assert body["safetySettings"] == list(GEMINI_SAFETY_OFF)
    assert body["contents"] == [{"role": "user", "parts": [{"text": "画一只猫"}]}]
    assert isinstance(upstream.translator, GeminiTranslator)


def test_gemini_request_respects_versioned_bases_and_host_safety_choice() -> None:
    upstream = build_gemini_request(
        model="gemini-x",
        base_url="https://aiplatform.googleapis.com/v1beta1/publishers/google",
        api_key=SECRET,
        fields=_fields(reasoning_effort="none"),
        safety_settings=[],
    )
    assert upstream.url.startswith(
        "https://aiplatform.googleapis.com/v1beta1/publishers/google/models/gemini-x:"
    )
    assert "safetySettings" not in upstream.body
    assert upstream.body["generationConfig"] == {"thinkingConfig": {"thinkingBudget": 0}}


def test_gemini_translator_turns_chunks_into_openai_chunks() -> None:
    translator = GeminiTranslator()
    payloads = [
        {
            "responseId": "resp_1",
            "modelVersion": "gemini-x-001",
            "candidates": [
                {
                    "content": {
                        "role": "model",
                        "parts": [{"text": "先想一下", "thought": True}, {"text": "你好"}],
                    }
                }
            ],
        },
        {
            "candidates": [
                {
                    "content": {
                        "parts": [{"functionCall": {"name": "novelai_generate", "args": {"p": 1}}}]
                    },
                    "finishReason": "STOP",
                }
            ],
            "usageMetadata": {
                "promptTokenCount": 20,
                "candidatesTokenCount": 5,
                "thoughtsTokenCount": 3,
                "totalTokenCount": 28,
            },
        },
    ]

    chunks: list[dict[str, Any]] = []
    for payload in payloads:
        chunks.extend(translator.feed(json.dumps(payload)))
    chunks.extend(translator.finish())

    deltas = [c["choices"][0]["delta"] for c in chunks if c["choices"]]
    assert deltas[0] == {"reasoning_content": "先想一下"}
    assert deltas[1] == {"content": "你好"}
    assert deltas[2]["tool_calls"][0]["id"] == "call_0"
    assert deltas[2]["tool_calls"][0]["function"] == {
        "name": "novelai_generate",
        "arguments": '{"p": 1}',
    }
    assert chunks[-2]["choices"][0]["finish_reason"] == "tool_calls"
    assert chunks[-1]["usage"] == {"prompt_tokens": 20, "completion_tokens": 8, "total_tokens": 28}
    assert chunks[0]["id"] == "resp_1"
    assert chunks[0]["model"] == "gemini-x-001"


def test_gemini_block_without_output_is_a_final_error() -> None:
    translator = GeminiTranslator()
    with pytest.raises(NativeStreamError) as caught:
        translator.feed(json.dumps({"candidates": [{"finishReason": "SAFETY", "content": {}}]}))
    assert caught.value.retryable is False

    with pytest.raises(NativeStreamError):
        GeminiTranslator().feed(
            json.dumps({"promptFeedback": {"blockReason": "PROHIBITED_CONTENT"}})
        )

    # A block after some output just ends the turn as content_filter.
    partial = GeminiTranslator()
    partial.feed(json.dumps({"candidates": [{"content": {"parts": [{"text": "一半"}]}}]}))
    assert partial.feed(json.dumps({"candidates": [{"finishReason": "SAFETY"}]})) == []
    assert partial.finish()[0]["choices"][0]["finish_reason"] == "content_filter"


def test_unknown_protocol_is_unsupported_before_any_request() -> None:
    with pytest.raises(LlmStreamUnsupportedError):
        build_upstream_request(
            "mystery", model="m", base_url="https://x.test", api_key="k", fields=_fields()
        )


# ---------------------------------------------------------------------------
# Through the cloud host route
# ---------------------------------------------------------------------------

REGISTRY: dict[str, dict[str, Any]] = {
    "claude-native": {
        "base_url": "https://anthropic.test",
        "api_key": SECRET,
        "proxy": "",
        "protocol": "anthropic",
    },
    "gemini-native": {
        "base_url": "https://gemini.test/v1beta",
        "api_key": SECRET,
        "proxy": "",
        "protocol": "gemini",
    },
}
CHOICES: dict[str, dict[str, Any]] = {
    "native": {"label": "Native", "model": "claude-native", "aliases": []},
    "gemini": {"label": "Gemini", "model": "gemini-native", "aliases": []},
}


@pytest.fixture
def app(monkeypatch: pytest.MonkeyPatch) -> FastAPI:
    monkeypatch.setattr(
        model_provider,
        "_load_registry_and_choices",
        lambda: (REGISTRY, CHOICES, "openai", "native"),
    )
    monkeypatch.setattr(llm_relay, "_active_streams", {})
    monkeypatch.setattr(llm_relay, "_clients", {})
    application = FastAPI()
    application.include_router(router)
    application.state.agent_authenticator = lambda _request: AgentAccess(
        Principal.user("owner", "tenant")
    )
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


def _sse_events(*events: dict[str, Any]) -> bytes:
    return "".join(
        f"event: {event['type']}\ndata: {json.dumps(event, ensure_ascii=False)}\n\n"
        for event in events
    ).encode("utf-8")


async def _post(app: FastAPI, body: dict[str, Any]) -> httpx.Response:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.post("/api/agent/llm/chat", json=body)


def _blocks(text: str) -> list[str]:
    return [block for block in text.split("\n\n") if block]


async def test_anthropic_choice_streams_translated_chunks(
    app: FastAPI, monkeypatch: pytest.MonkeyPatch
) -> None:
    upstream = _sse_events(
        {
            "type": "message_start",
            "message": {"id": "msg_1", "model": "claude-x", "usage": {"input_tokens": 3}},
        },
        {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
        {
            "type": "content_block_delta",
            "index": 0,
            "delta": {"type": "text_delta", "text": "你好"},
        },
        {
            "type": "message_delta",
            "delta": {"stop_reason": "end_turn"},
            "usage": {"output_tokens": 4},
        },
        {"type": "message_stop"},
    )
    seen = _install_upstream(
        monkeypatch,
        lambda _r: httpx.Response(
            200, headers={"content-type": "text/event-stream"}, content=upstream
        ),
    )

    response = await _post(app, {"messages": [{"role": "user", "content": "hi"}], "tools": [TOOL]})

    assert response.status_code == 200, response.text
    assert response.headers["x-llm-provider"] == "anthropic"
    assert response.headers["x-llm-slot"] == "native"
    blocks = _blocks(response.text)
    assert json.loads(blocks[0].removeprefix("data: "))["choices"][0]["delta"] == {
        "content": "你好"
    }
    assert json.loads(blocks[1].removeprefix("data: "))["choices"][0]["finish_reason"] == "stop"
    assert json.loads(blocks[2].removeprefix("data: "))["usage"]["total_tokens"] == 7
    assert blocks[3] == "data: [DONE]"
    assert SECRET not in response.text

    assert len(seen) == 1
    assert str(seen[0].url) == "https://anthropic.test/v1/messages"
    assert seen[0].headers["x-api-key"] == SECRET
    sent = json.loads(seen[0].content)
    assert sent["model"] == "claude-native"
    assert sent["stream"] is True
    assert sent["max_tokens"] == 4096
    assert sent["tools"][0]["input_schema"] == TOOL["function"]["parameters"]


async def test_gemini_choice_streams_with_the_host_safety_settings(
    app: FastAPI, monkeypatch: pytest.MonkeyPatch
) -> None:
    upstream = (
        b'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]},"finishReason":"STOP"}],'
        b'"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1,"totalTokenCount":2}}\n\n'
    )
    seen = _install_upstream(
        monkeypatch,
        lambda _r: httpx.Response(
            200, headers={"content-type": "text/event-stream"}, content=upstream
        ),
    )

    response = await _post(
        app, {"messages": [{"role": "user", "content": "hi"}], "model": "gemini"}
    )

    assert response.status_code == 200, response.text
    assert response.headers["x-llm-provider"] == "gemini"
    blocks = _blocks(response.text)
    assert json.loads(blocks[0].removeprefix("data: "))["choices"][0]["delta"] == {"content": "hi"}
    assert blocks[-1] == "data: [DONE]"

    assert str(seen[0].url) == (
        "https://gemini.test/v1beta/models/gemini-native:streamGenerateContent?alt=sse"
    )
    assert seen[0].headers["x-goog-api-key"] == SECRET
    sent = json.loads(seen[0].content)
    assert sent["generationConfig"]["thinkingConfig"] == {"includeThoughts": True}
    assert sent["safetySettings"], "the host disables Gemini safety filters by default"
    assert all(entry["threshold"] == "OFF" for entry in sent["safetySettings"])


async def test_native_error_event_ends_the_stream_without_done(
    app: FastAPI, monkeypatch: pytest.MonkeyPatch
) -> None:
    upstream = _sse_events(
        {"type": "message_start", "message": {"id": "msg_1", "model": "claude-x", "usage": {}}},
        {
            "type": "content_block_delta",
            "index": 0,
            "delta": {"type": "text_delta", "text": "一半"},
        },
        {"type": "error", "error": {"type": "overloaded_error", "message": "busy"}},
    )
    _install_upstream(
        monkeypatch,
        lambda _r: httpx.Response(
            200, headers={"content-type": "text/event-stream"}, content=upstream
        ),
    )

    response = await _post(app, {"messages": [{"role": "user", "content": "hi"}]})

    assert response.status_code == 200
    blocks = _blocks(response.text)
    assert json.loads(blocks[0].removeprefix("data: "))["choices"][0]["delta"] == {
        "content": "一半"
    }
    assert blocks[1].startswith("event: error\n")
    error = json.loads(blocks[1].split("data: ", 1)[1])
    assert error["code"] == "llm_upstream_error"
    assert error["retryable"] is True
    assert "data: [DONE]" not in response.text
