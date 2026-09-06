"""Native slots on the sidecar: anthropic / gemini are translated, keys stay inside (B4).

上游一律 MockTransport。红线不变:主槽位只在**发出任何字节之前**失败才切备用;
密钥只进上游请求头,流和问题响应里都不能出现;客户端永远只看 OpenAI chunk。
"""

from __future__ import annotations

import json
import unittest
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from sidecar.api import mount_api
from sidecar.application import SettingsStore, TaskSupervisor
from sidecar.config import Settings
from sidecar.infrastructure import HttpClientPool
from sidecar.llm.stream import LlmStreamSession, open_llm_stream
from sidecar.runtime import AppRuntime
from sidecar.security import AuthManager, OutboundPolicy

ANTHROPIC_BASE = "https://anthropic.example"
GEMINI_BASE = "https://gemini.example"
BACKUP_BASE = "https://backup.example/v1"
OPENAI_CHUNK = {
    "id": "chunk-1",
    "object": "chat.completion.chunk",
    "created": 1,
    "model": "backup-model",
    "choices": [{"index": 0, "delta": {"content": "备用"}, "finish_reason": None}],
}


def _settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "host": "127.0.0.1",
        "port": 0,
        "data_dir": Path("/tmp"),
        "nai_token": "",
        "nai_base_url": "https://image.novelai.net",
        "llm_provider": "anthropic",
        "llm_base_url": ANTHROPIC_BASE,
        "llm_api_key": "primary-key",
        "llm_model": "primary-model",
        "llm_backup_provider": "openai",
        "llm_backup_base_url": BACKUP_BASE,
        "llm_backup_api_key": "backup-key",
        "llm_backup_model": "backup-model",
        "mock_generation": False,
        "sidecar_auth_token": "process-token",
    }
    values.update(overrides)
    return Settings(**values)


def _policy(scope: str) -> OutboundPolicy:
    return OutboundPolicy(scope, resolver=lambda _host, _port: ["93.184.216.34"])


def _pool(handler: Any) -> HttpClientPool:
    shared = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return HttpClientPool(default_client=shared, long_running_client=shared)


def _sse(*payloads: dict[str, Any], event_names: bool = False) -> httpx.Response:
    text = "".join(
        (f"event: {payload.get('type')}\n" if event_names else "")
        + f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
        for payload in payloads
    )
    return httpx.Response(
        200, headers={"content-type": "text/event-stream"}, content=text.encode("utf-8")
    )


def _anthropic_stream() -> httpx.Response:
    return _sse(
        {
            "type": "message_start",
            "message": {"id": "msg_1", "model": "claude-x", "usage": {"input_tokens": 3}},
        },
        {"type": "content_block_start", "index": 0, "content_block": {"type": "text"}},
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
        event_names=True,
    )


def _gemini_stream() -> httpx.Response:
    return _sse(
        {
            "candidates": [
                {"content": {"parts": [{"text": "先想", "thought": True}, {"text": "好"}]}}
            ]
        },
        {
            "candidates": [
                {
                    "content": {
                        "parts": [{"functionCall": {"name": "novelai_generate", "args": {}}}]
                    },
                    "finishReason": "STOP",
                }
            ],
            "usageMetadata": {
                "promptTokenCount": 2,
                "candidatesTokenCount": 3,
                "totalTokenCount": 5,
            },
        },
    )


def _fields(**overrides: Any) -> dict[str, Any]:
    fields: dict[str, Any] = {"messages": [{"role": "user", "content": "画一只猫"}]}
    fields.update(overrides)
    return fields


async def _collect(session: LlmStreamSession) -> str:
    parts: list[str] = []
    async with session:
        async for chunk in session.iter_sse():
            parts.append(chunk)
    return "".join(parts)


def _deltas(text: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for block in text.split("\n\n"):
        if not block.startswith("data: ") or block == "data: [DONE]":
            continue
        chunk = json.loads(block.removeprefix("data: "))
        if chunk["choices"]:
            out.append(chunk["choices"][0]["delta"])
    return out


class NativeSlotStreamTests(unittest.IsolatedAsyncioTestCase):
    async def test_anthropic_primary_is_translated_and_keeps_the_key_upstream(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return _anthropic_stream()

        pool = _pool(handler)
        try:
            session = await open_llm_stream(
                settings=_settings(),
                fields=_fields(max_tokens=512, reasoning_effort="low"),
                http=pool,
                policy_factory=_policy,
            )
            self.assertEqual(session.info.slot, "primary")
            self.assertEqual(session.info.provider, "anthropic")
            self.assertFalse(session.info.failed_over)
            text = await _collect(session)
        finally:
            await pool.close()

        self.assertEqual(len(requests), 1)
        upstream = requests[0]
        self.assertEqual(str(upstream.url), f"{ANTHROPIC_BASE}/v1/messages")
        self.assertEqual(upstream.headers["x-api-key"], "primary-key")
        self.assertEqual(upstream.headers["anthropic-version"], "2023-06-01")
        sent = json.loads(upstream.content)
        self.assertEqual(sent["model"], "primary-model")
        self.assertTrue(sent["stream"])
        self.assertEqual(sent["thinking"], {"type": "enabled", "budget_tokens": 2048})
        self.assertGreater(sent["max_tokens"], 2048)
        self.assertEqual(
            sent["messages"], [{"role": "user", "content": [{"type": "text", "text": "画一只猫"}]}]
        )

        self.assertEqual(_deltas(text), [{"content": "你好"}, {}])
        self.assertIn('"finish_reason":"stop"', text)
        self.assertIn('"total_tokens":7', text)
        self.assertTrue(text.endswith("data: [DONE]\n\n"))
        self.assertNotIn("primary-key", text)
        self.assertNotIn("degraded", text)

    async def test_gemini_primary_is_translated_with_safety_off_and_tool_calls(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return _gemini_stream()

        pool = _pool(handler)
        try:
            session = await open_llm_stream(
                settings=_settings(llm_provider="gemini", llm_base_url=GEMINI_BASE),
                fields=_fields(
                    tools=[{"type": "function", "function": {"name": "novelai_generate"}}]
                ),
                http=pool,
                policy_factory=_policy,
            )
            self.assertEqual(session.info.provider, "gemini")
            text = await _collect(session)
        finally:
            await pool.close()

        upstream = requests[0]
        self.assertEqual(upstream.url.path, "/v1beta/models/primary-model:streamGenerateContent")
        self.assertEqual(upstream.url.params.get("alt"), "sse")
        self.assertEqual(upstream.headers["x-goog-api-key"], "primary-key")
        sent = json.loads(upstream.content)
        self.assertEqual(sent["generationConfig"]["thinkingConfig"], {"includeThoughts": True})
        self.assertTrue(all(item["threshold"] == "OFF" for item in sent["safetySettings"]))
        self.assertEqual(sent["toolConfig"], {"functionCallingConfig": {"mode": "AUTO"}})

        deltas = _deltas(text)
        self.assertEqual(deltas[0], {"reasoning_content": "先想"})
        self.assertEqual(deltas[1], {"content": "好"})
        self.assertEqual(deltas[2]["tool_calls"][0]["function"]["name"], "novelai_generate")
        self.assertIn('"finish_reason":"tool_calls"', text)
        self.assertTrue(text.endswith("data: [DONE]\n\n"))
        self.assertNotIn("primary-key", text)

    async def test_native_primary_failing_before_first_byte_uses_the_openai_backup(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            if request.url.host == "anthropic.example":
                return httpx.Response(529, json={"type": "error", "error": {"type": "overloaded"}})
            return httpx.Response(
                200,
                headers={"content-type": "text/event-stream"},
                # The openai path relays bytes verbatim, so keep the text unescaped.
                content=(
                    f"data: {json.dumps(OPENAI_CHUNK, ensure_ascii=False)}\n\ndata: [DONE]\n\n"
                ).encode(),
            )

        pool = _pool(handler)
        try:
            session = await open_llm_stream(
                settings=_settings(), fields=_fields(), http=pool, policy_factory=_policy
            )
            self.assertEqual(session.info.slot, "backup")
            self.assertEqual(session.info.provider, "openai")
            self.assertTrue(session.info.failed_over)
            text = await _collect(session)
        finally:
            await pool.close()

        self.assertEqual(
            [request.url.host for request in requests], ["anthropic.example", "backup.example"]
        )
        self.assertTrue(
            text.startswith('event: degraded\ndata: {"reason":"llm_backup","slot":"backup"}\n\n')
        )
        self.assertIn("备用", text)
        self.assertEqual(requests[1].headers["authorization"], "Bearer backup-key")


class NativeSlotRouteTests(unittest.TestCase):
    """Through the canonical route: the provider is reported, the dialect is OpenAI."""

    def _runtime(self, pool: HttpClientPool, **overrides: Any) -> AppRuntime:
        values: dict[str, Any] = {
            "llm_provider": "gemini",
            "llm_base_url": "http://127.0.0.1:9",
            "llm_network_scope": "loopback",
            "llm_backup_api_key": "",
        }
        values.update(overrides)
        return AppRuntime(
            settings=SettingsStore(_settings(**values), loader=None),
            security=AuthManager("process-token"),
            http=pool,
            tasks=TaskSupervisor(),
        )

    def _app(self, runtime: AppRuntime) -> FastAPI:
        @asynccontextmanager
        async def lifespan(_: FastAPI):
            await runtime.startup()
            try:
                yield
            finally:
                await runtime.shutdown()

        app = FastAPI(lifespan=lifespan)
        mount_api(app, runtime, include_v0_compat=False)
        return app

    def test_gemini_slot_streams_openai_chunks_with_provider_header(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return _gemini_stream()

        pool = _pool(handler)
        with TestClient(self._app(self._runtime(pool))) as client:  # type: ignore[misc]
            response = client.post(
                "/api/v1/agent/llm/chat",
                headers={"Authorization": "Bearer process-token"},
                json={"messages": [{"role": "user", "content": "hi"}]},
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.headers["x-llm-provider"], "gemini")
        self.assertEqual(response.headers["x-llm-slot"], "primary")
        self.assertEqual(requests[0].url.path, "/v1beta/models/primary-model:streamGenerateContent")
        self.assertEqual(_deltas(response.text)[1], {"content": "好"})
        self.assertTrue(response.text.endswith("data: [DONE]\n\n"))
        self.assertNotIn("primary-key", response.text)
