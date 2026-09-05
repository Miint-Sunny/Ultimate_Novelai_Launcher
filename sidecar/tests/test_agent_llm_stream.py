"""Streaming LLM relay for the client-side harness: wire contract and failure paths.

上游一律 MockTransport,不得打真 API。红线:主槽位只在**发出任何字节之前**失败才切
备用槽位;流中断不换槽位、不重发;出站策略拒绝不得换凭据重试;密钥不出 sidecar。
"""

from __future__ import annotations

import asyncio
import json
import unittest
from collections.abc import AsyncIterator
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
from sidecar.llm.client import LLMNotConfiguredError
from sidecar.llm.stream import (
    LlmStreamSession,
    LlmStreamUnreachableError,
    LlmStreamUnsupportedError,
    LlmStreamUpstreamError,
    build_chat_body,
    completion_to_chunk,
    open_llm_stream,
)
from sidecar.runtime import AppRuntime
from sidecar.security import AuthManager, OutboundPolicy, OutboundPolicyError

PRIMARY_BASE = "https://llm.example/v1"
BACKUP_BASE = "https://backup.example/v1"
CHUNK = {
    "id": "chunk-1",
    "object": "chat.completion.chunk",
    "created": 1,
    "model": "primary-model",
    "choices": [
        {"index": 0, "delta": {"role": "assistant", "content": "你好"}, "finish_reason": None}
    ],
}
USAGE_CHUNK = {
    "id": "chunk-1",
    "object": "chat.completion.chunk",
    "created": 1,
    "model": "primary-model",
    "choices": [],
    "usage": {"prompt_tokens": 12, "completion_tokens": 3, "total_tokens": 15},
}


def _sse(*blocks: dict[str, Any], done: bool = True) -> bytes:
    text = "".join(f"data: {json.dumps(block, ensure_ascii=False)}\n\n" for block in blocks)
    if done:
        text += "data: [DONE]\n\n"
    return text.encode("utf-8")


def _settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "host": "127.0.0.1",
        "port": 0,
        "data_dir": Path("/tmp"),
        "nai_token": "",
        "nai_base_url": "https://image.novelai.net",
        "llm_base_url": PRIMARY_BASE,
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


def _stream_response(content: Any, status: int = 200) -> httpx.Response:
    return httpx.Response(status, headers={"content-type": "text/event-stream"}, content=content)


class BuildChatBodyTests(unittest.TestCase):
    def test_sidecar_owned_keys_win_over_extra_body(self) -> None:
        slot = _settings().llm_slots()[0]
        body = build_chat_body(
            slot,
            _fields(
                tools=[{"type": "function", "function": {"name": "f", "parameters": {}}}],
                prompt_cache_key="session-1",
                temperature=0.7,
                extra_body={"model": "hijack", "stream": False, "thinking": {"type": "enabled"}},
            ),
        )
        self.assertEqual(body["model"], "primary-model")
        self.assertTrue(body["stream"])
        self.assertEqual(body["stream_options"], {"include_usage": True})
        self.assertEqual(body["tool_choice"], "auto")
        self.assertEqual(body["prompt_cache_key"], "session-1")
        self.assertEqual(body["temperature"], 0.7)
        # 供应商私有开关原样透传,保留键被丢弃而不是覆盖
        self.assertEqual(body["thinking"], {"type": "enabled"})

    def test_no_tools_means_no_tool_choice(self) -> None:
        slot = _settings().llm_slots()[0]
        body = build_chat_body(slot, _fields())
        self.assertNotIn("tools", body)
        self.assertNotIn("tool_choice", body)


class CompletionToChunkTests(unittest.TestCase):
    def test_message_becomes_single_delta_with_indexed_tool_calls(self) -> None:
        completion = {
            "id": "cmpl-1",
            "created": 5,
            "model": "m",
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
                                "function": {"name": "f", "arguments": "{}"},
                            }
                        ],
                    },
                    "finish_reason": "tool_calls",
                }
            ],
            "usage": {"total_tokens": 9},
        }
        chunk = completion_to_chunk(completion)
        self.assertEqual(chunk["object"], "chat.completion.chunk")
        delta = chunk["choices"][0]["delta"]
        self.assertNotIn("content", delta)
        self.assertEqual(delta["tool_calls"][0]["index"], 0)
        self.assertEqual(delta["tool_calls"][0]["id"], "call-1")
        self.assertEqual(chunk["choices"][0]["finish_reason"], "tool_calls")
        self.assertEqual(chunk["usage"], {"total_tokens": 9})


class OpenLlmStreamTests(unittest.IsolatedAsyncioTestCase):
    async def test_relays_provider_chunks_and_sends_the_contracted_body(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return _stream_response(_sse(CHUNK, USAGE_CHUNK))

        pool = _pool(handler)
        try:
            session = await open_llm_stream(
                settings=_settings(),
                fields=_fields(
                    tools=[
                        {
                            "type": "function",
                            "function": {
                                "name": "get_studio_parameters",
                                "parameters": {"type": "object", "properties": {}},
                            },
                        }
                    ],
                    prompt_cache_key="session-1",
                ),
                http=pool,
                policy_factory=_policy,
            )
            self.assertEqual(session.info.slot, "primary")
            self.assertEqual(session.info.model, "primary-model")
            self.assertFalse(session.info.failed_over)
            text = await _collect(session)
        finally:
            await pool.close()

        self.assertEqual(text, _sse(CHUNK, USAGE_CHUNK).decode("utf-8"))
        self.assertEqual(len(requests), 1)
        request = requests[0]
        self.assertEqual(str(request.url), f"{PRIMARY_BASE}/chat/completions")
        self.assertEqual(request.headers["authorization"], "Bearer primary-key")
        self.assertEqual(request.headers["accept"], "text/event-stream")
        body = json.loads(request.content)
        self.assertEqual(body["model"], "primary-model")
        self.assertTrue(body["stream"])
        self.assertEqual(body["stream_options"], {"include_usage": True})
        self.assertEqual(body["tool_choice"], "auto")
        self.assertEqual(body["tools"][0]["function"]["name"], "get_studio_parameters")
        self.assertEqual(body["prompt_cache_key"], "session-1")

    async def test_missing_done_marker_and_crlf_are_normalised(self) -> None:
        raw = b"data: " + json.dumps(CHUNK).encode() + b"\r\n\r\n"

        pool = _pool(lambda request: _stream_response(raw))
        try:
            session = await open_llm_stream(
                settings=_settings(), fields=_fields(), http=pool, policy_factory=_policy
            )
            text = await _collect(session)
        finally:
            await pool.close()

        self.assertNotIn("\r", text)
        self.assertTrue(text.endswith("data: [DONE]\n\n"))
        self.assertIn(json.dumps(CHUNK), text)

    async def test_json_completion_is_converted_to_one_chunk(self) -> None:
        completion = {
            "id": "cmpl-1",
            "created": 1,
            "model": "primary-model",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": "直接答"},
                    "finish_reason": "stop",
                }
            ],
        }

        pool = _pool(lambda request: httpx.Response(200, json=completion))
        try:
            session = await open_llm_stream(
                settings=_settings(), fields=_fields(), http=pool, policy_factory=_policy
            )
            text = await _collect(session)
        finally:
            await pool.close()

        blocks = [block for block in text.split("\n\n") if block]
        self.assertEqual(len(blocks), 2)
        chunk = json.loads(blocks[0].removeprefix("data: "))
        self.assertEqual(chunk["object"], "chat.completion.chunk")
        self.assertEqual(chunk["choices"][0]["delta"]["content"], "直接答")
        self.assertEqual(blocks[1], "data: [DONE]")

    async def test_primary_failure_before_any_byte_fails_over_to_backup(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            if request.url.host == "llm.example":
                return httpx.Response(503, json={"error": "overloaded"})
            return _stream_response(_sse(CHUNK))

        pool = _pool(handler)
        try:
            session = await open_llm_stream(
                settings=_settings(), fields=_fields(), http=pool, policy_factory=_policy
            )
            self.assertEqual(session.info.slot, "backup")
            self.assertEqual(session.info.model, "backup-model")
            self.assertTrue(session.info.failed_over)
            text = await _collect(session)
        finally:
            await pool.close()

        self.assertEqual(
            [request.url.host for request in requests], ["llm.example", "backup.example"]
        )
        self.assertEqual(requests[1].headers["authorization"], "Bearer backup-key")
        self.assertTrue(
            text.startswith('event: degraded\ndata: {"reason":"llm_backup","slot":"backup"}\n\n')
        )
        self.assertTrue(text.endswith("data: [DONE]\n\n"))

    async def test_midstream_failure_is_an_error_event_and_never_fails_over(self) -> None:
        requests: list[httpx.Request] = []

        async def broken() -> AsyncIterator[bytes]:
            yield _sse(CHUNK, done=False)
            raise httpx.ReadTimeout("upstream went away")

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return _stream_response(broken())

        pool = _pool(handler)
        try:
            session = await open_llm_stream(
                settings=_settings(), fields=_fields(), http=pool, policy_factory=_policy
            )
            text = await _collect(session)
        finally:
            await pool.close()

        self.assertEqual(len(requests), 1)
        self.assertIn(json.dumps(CHUNK, ensure_ascii=False), text)
        self.assertIn("event: error\n", text)
        error = json.loads(text.rsplit("data: ", 1)[1].strip())
        self.assertEqual(error["code"], "llm_stream_interrupted")
        self.assertTrue(error["retryable"])
        self.assertEqual(error["slot"], "primary")
        self.assertNotIn("data: [DONE]", text)

    async def test_400_on_optional_fields_retries_the_same_slot_once_without_them(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            body = json.loads(request.content)
            if "prompt_cache_key" in body or "stream_options" in body:
                return httpx.Response(
                    400, json={"error": "Unsupported parameter: prompt_cache_key"}
                )
            return _stream_response(_sse(CHUNK))

        pool = _pool(handler)
        try:
            session = await open_llm_stream(
                settings=_settings(),
                fields=_fields(prompt_cache_key="session-1"),
                http=pool,
                policy_factory=_policy,
            )
            self.assertEqual(session.info.slot, "primary")
            self.assertFalse(session.info.failed_over)
            await _collect(session)
        finally:
            await pool.close()

        self.assertEqual([request.url.host for request in requests], ["llm.example", "llm.example"])
        retried = json.loads(requests[1].content)
        self.assertNotIn("prompt_cache_key", retried)
        self.assertNotIn("stream_options", retried)
        self.assertTrue(retried["stream"])

    async def test_non_400_failure_never_retries_the_same_slot(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(401, json={"error": "bad key"})

        pool = _pool(handler)
        try:
            with self.assertRaises(LlmStreamUpstreamError) as raised:
                await open_llm_stream(
                    settings=_settings(),
                    fields=_fields(prompt_cache_key="session-1"),
                    http=pool,
                    policy_factory=_policy,
                )
        finally:
            await pool.close()

        self.assertEqual(
            [request.url.host for request in requests], ["llm.example", "backup.example"]
        )
        self.assertEqual(raised.exception.status_code, 401)
        self.assertEqual(raised.exception.slot, "backup")
        self.assertFalse(raised.exception.retryable)

    async def test_explicit_slot_selection_never_touches_the_other_slot(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            if request.url.host == "llm.example":
                return httpx.Response(500)
            return _stream_response(_sse(CHUNK))

        pool = _pool(handler)
        try:
            backup = await open_llm_stream(
                settings=_settings(),
                fields=_fields(),
                http=pool,
                slot="backup",
                policy_factory=_policy,
            )
            self.assertEqual(backup.info.slot, "backup")
            self.assertFalse(backup.info.failed_over)
            await _collect(backup)
            with self.assertRaises(LlmStreamUpstreamError) as raised:
                await open_llm_stream(
                    settings=_settings(),
                    fields=_fields(),
                    http=pool,
                    slot="primary",
                    policy_factory=_policy,
                )
        finally:
            await pool.close()

        self.assertEqual(
            [request.url.host for request in requests], ["backup.example", "llm.example"]
        )
        self.assertEqual(raised.exception.status_code, 500)
        self.assertTrue(raised.exception.retryable)

    async def test_unsupported_primary_provider_uses_backup_or_fails(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return _stream_response(_sse(CHUNK))

        pool = _pool(handler)
        try:
            session = await open_llm_stream(
                settings=_settings(llm_provider="anthropic"),
                fields=_fields(),
                http=pool,
                policy_factory=_policy,
            )
            self.assertEqual(session.info.slot, "backup")
            self.assertTrue(session.info.failed_over)
            await _collect(session)
            with self.assertRaises(LlmStreamUnsupportedError):
                await open_llm_stream(
                    settings=_settings(llm_provider="gemini", llm_backup_api_key=""),
                    fields=_fields(),
                    http=pool,
                    policy_factory=_policy,
                )
        finally:
            await pool.close()

        self.assertEqual([request.url.host for request in requests], ["backup.example"])

    async def test_unconfigured_llm_and_missing_backup_are_rejected_locally(self) -> None:
        pool = _pool(lambda request: httpx.Response(200))
        try:
            with self.assertRaises(LLMNotConfiguredError):
                await open_llm_stream(
                    settings=_settings(llm_api_key="", llm_backup_api_key=""),
                    fields=_fields(),
                    http=pool,
                    policy_factory=_policy,
                )
            with self.assertRaises(LLMNotConfiguredError):
                await open_llm_stream(
                    settings=_settings(llm_backup_api_key=""),
                    fields=_fields(),
                    http=pool,
                    slot="backup",
                    policy_factory=_policy,
                )
        finally:
            await pool.close()

    async def test_transport_failure_on_every_slot_is_retryable_unreachable(self) -> None:
        async def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("no route", request=request)

        pool = _pool(handler)
        try:
            with self.assertRaises(LlmStreamUnreachableError) as raised:
                await open_llm_stream(
                    settings=_settings(), fields=_fields(), http=pool, policy_factory=_policy
                )
        finally:
            await pool.close()
        self.assertTrue(raised.exception.retryable)

    async def test_outbound_policy_rejection_never_tries_another_credential(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return _stream_response(_sse(CHUNK))

        pool = _pool(handler)
        try:
            with self.assertRaises(OutboundPolicyError):
                await open_llm_stream(
                    settings=_settings(),
                    fields=_fields(),
                    http=pool,
                    policy_factory=lambda _scope: OutboundPolicy("loopback"),
                )
        finally:
            await pool.close()
        self.assertEqual(requests, [])


class AgentChatRouteTests(unittest.TestCase):
    """The canonical route: auth, strict wire models, Problem Details, headers."""

    LOOPBACK_BASE = "http://127.0.0.1:9/v1"

    def _runtime(self, pool: HttpClientPool, **overrides: Any) -> AppRuntime:
        values: dict[str, Any] = {
            "llm_base_url": self.LOOPBACK_BASE,
            "llm_network_scope": "loopback",
            "llm_backup_api_key": "",
        }
        values.update(overrides)
        settings = _settings(**values)
        return AppRuntime(
            settings=SettingsStore(settings, loader=None),
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

    def _post(
        self, client: TestClient, body: dict[str, Any], *, auth: bool = True
    ) -> httpx.Response:
        headers = {"Authorization": "Bearer process-token"} if auth else {}
        return client.post("/api/v1/agent/llm/chat", headers=headers, json=body)

    def test_relays_stream_with_slot_headers_and_without_leaking_the_key(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return _stream_response(_sse(CHUNK, USAGE_CHUNK))

        pool = _pool(handler)
        runtime = self._runtime(pool)
        with TestClient(self._app(runtime)) as client:  # type: ignore[misc]
            unauthorized = self._post(
                client, {"messages": [{"role": "user", "content": "hi"}]}, auth=False
            )
            ok = self._post(
                client,
                {
                    "messages": [
                        {"role": "system", "content": "你是画师"},
                        {"role": "user", "content": [{"type": "text", "text": "画猫"}]},
                    ],
                    "tools": [
                        {
                            "type": "function",
                            "function": {
                                "name": "update_studio_parameters",
                                "description": "改参数",
                                "parameters": {
                                    "type": "object",
                                    "properties": {"steps": {"type": "integer"}},
                                },
                            },
                        }
                    ],
                    "prompt_cache_key": "session-1",
                    "reasoning_effort": "low",
                    "extra_body": {"thinking": {"type": "enabled"}},
                },
            )

        self.assertEqual(unauthorized.status_code, 401)
        self.assertEqual(ok.status_code, 200)
        self.assertTrue(ok.headers["content-type"].startswith("text/event-stream"))
        self.assertEqual(ok.headers["x-llm-slot"], "primary")
        self.assertEqual(ok.headers["x-llm-model"], "primary-model")
        self.assertEqual(ok.headers["x-llm-provider"], "openai")
        self.assertEqual(ok.text, _sse(CHUNK, USAGE_CHUNK).decode("utf-8"))
        leaked = "primary-key"
        self.assertNotIn(leaked, ok.text)
        self.assertNotIn(leaked, json.dumps(dict(ok.headers)))
        self.assertEqual(len(requests), 1)
        sent = json.loads(requests[0].content)
        self.assertEqual(sent["model"], "primary-model")
        self.assertEqual(sent["messages"][1]["content"][0]["text"], "画猫")
        self.assertEqual(sent["tools"][0]["function"]["name"], "update_studio_parameters")
        self.assertEqual(sent["reasoning_effort"], "low")
        self.assertEqual(sent["thinking"], {"type": "enabled"})
        self.assertNotIn("slot", sent)

    def test_strict_wire_models_reject_bad_shapes(self) -> None:
        pool = _pool(lambda request: _stream_response(_sse(CHUNK)))
        runtime = self._runtime(pool)
        user = {"role": "user", "content": "hi"}
        cases = {
            "unknown_field": {"messages": [user], "model": "gpt"},
            "reserved_extra_body": {"messages": [user], "extra_body": {"model": "gpt"}},
            "remote_image_url": {
                "messages": [
                    {
                        "role": "user",
                        "content": [{"type": "image_url", "image_url": {"url": "https://x/y.png"}}],
                    }
                ]
            },
            "tool_message_without_call_id": {"messages": [{"role": "tool", "content": "r"}]},
            "assistant_without_anything": {"messages": [{"role": "assistant"}]},
            "empty_messages": {"messages": []},
            "bad_slot": {"messages": [user], "slot": "tertiary"},
        }
        with TestClient(self._app(runtime)) as client:  # type: ignore[misc]
            for name, body in cases.items():
                with self.subTest(case=name):
                    response = self._post(client, body)
                    self.assertEqual(response.status_code, 422)
                    self.assertEqual(response.headers["content-type"], "application/problem+json")

    def test_unconfigured_and_unsupported_slots_are_problem_details(self) -> None:
        pool = _pool(lambda request: _stream_response(_sse(CHUNK)))
        body = {"messages": [{"role": "user", "content": "hi"}]}

        with TestClient(self._app(self._runtime(pool, llm_api_key=""))) as client:  # type: ignore[misc]
            unconfigured = self._post(client, body)
        with TestClient(self._app(self._runtime(pool, llm_provider="anthropic"))) as client:  # type: ignore[misc]
            unsupported = self._post(client, body)

        self.assertEqual(unconfigured.status_code, 503)
        self.assertEqual(unconfigured.json()["code"], "llm_not_configured")
        self.assertEqual(unsupported.status_code, 503)
        self.assertEqual(unsupported.json()["code"], "llm_stream_provider_unsupported")
        self.assertEqual(unsupported.json()["detail"].count("primary-key"), 0)

    def test_upstream_failure_before_stream_is_a_problem_with_status(self) -> None:
        pool = _pool(lambda request: httpx.Response(500, json={"error": "boom"}))
        with TestClient(self._app(self._runtime(pool))) as client:  # type: ignore[misc]
            response = self._post(client, {"messages": [{"role": "user", "content": "hi"}]})

        self.assertEqual(response.status_code, 503)
        problem = response.json()
        self.assertEqual(problem["code"], "llm_upstream_failed")
        self.assertTrue(problem["retryable"])
        self.assertEqual(problem["context"]["upstream_status"], 500)
        self.assertEqual(problem["context"]["slot"], "primary")

    def test_draining_sidecar_refuses_paid_turns(self) -> None:
        pool = _pool(lambda request: _stream_response(_sse(CHUNK)))
        runtime = self._runtime(pool)
        asyncio.run(runtime.tasks.begin_drain())
        with TestClient(self._app(runtime)) as client:  # type: ignore[misc]
            response = self._post(client, {"messages": [{"role": "user", "content": "hi"}]})
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.headers["content-type"], "application/problem+json")


if __name__ == "__main__":
    unittest.main()
