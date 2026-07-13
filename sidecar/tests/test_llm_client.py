from __future__ import annotations

import unittest
from dataclasses import replace
from pathlib import Path

import httpx

from sidecar.config import Settings
from sidecar.infrastructure import HttpClientPool
from sidecar.llm import client as llm
from sidecar.llm.client import (
    LLMConversionError,
    LLMNotConfiguredError,
    _extract_content,
    _extract_json_object,
    require_llm,
)
from sidecar.security import OutboundPolicyError


def _settings(configured: bool) -> Settings:
    return Settings(
        host="127.0.0.1",
        port=38176,
        data_dir=Path("/tmp"),
        nai_token="",
        nai_base_url="https://image.novelai.net",
        llm_base_url="https://llm.example/v1" if configured else "",
        llm_api_key="redacted-test-key" if configured else "",
        llm_model="test-model" if configured else "",
        mock_generation=False,
    )


class RequireLlmTests(unittest.TestCase):
    def test_raises_when_unconfigured(self) -> None:
        with self.assertRaises(LLMNotConfiguredError):
            require_llm(_settings(False))

    def test_ok_when_configured(self) -> None:
        require_llm(_settings(True))  # should not raise


class ExtractContentTests(unittest.TestCase):
    def test_extracts_and_strips(self) -> None:
        self.assertEqual(_extract_content({"choices": [{"message": {"content": "  hi  "}}]}), "hi")

    def test_raises_when_no_choices(self) -> None:
        with self.assertRaises(LLMConversionError):
            _extract_content({"choices": []})

    def test_raises_when_content_empty(self) -> None:
        with self.assertRaises(LLMConversionError):
            _extract_content({"choices": [{"message": {"content": "   "}}]})


class ExtractJsonObjectTests(unittest.TestCase):
    def test_passthrough_when_already_object(self) -> None:
        self.assertEqual(_extract_json_object('{"a": 1}'), '{"a": 1}')

    def test_extracts_embedded_object(self) -> None:
        self.assertEqual(_extract_json_object('prefix {"a": 1} suffix'), '{"a": 1}')

    def test_raises_when_no_object(self) -> None:
        with self.assertRaises(LLMConversionError):
            _extract_json_object("no json here")


class ChatGuardTests(unittest.IsolatedAsyncioTestCase):
    async def test_chat_completion_requires_config(self) -> None:
        with self.assertRaises(LLMNotConfiguredError):
            await llm.chat_completion(settings=_settings(False), messages=[])

    async def test_convert_natural_requires_config(self) -> None:
        from sidecar.nai.models import GenerationParams

        with self.assertRaises(LLMNotConfiguredError):
            await llm.convert_natural_to_tags(
                settings=_settings(False),
                user_input="画一个女孩",
                fallback_params=GenerationParams(),
                fallback_negative="",
            )


class ProviderTransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_all_provider_adapters_use_the_shared_pool(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            if request.url.path.endswith("/v1/messages"):
                return httpx.Response(
                    200,
                    json={"content": [{"type": "text", "text": "anthropic-ok"}]},
                )
            if request.url.path.endswith(":generateContent"):
                return httpx.Response(
                    200,
                    json={"candidates": [{"content": {"parts": [{"text": "gemini-ok"}]}}]},
                )
            return httpx.Response(
                200,
                json={"choices": [{"message": {"content": "openai-ok"}}]},
            )

        shared = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        pool = HttpClientPool(default_client=shared, long_running_client=shared)
        try:
            results: dict[str, str] = {}
            for provider in ("openai", "anthropic", "gemini"):
                settings = Settings(
                    host="127.0.0.1",
                    port=38176,
                    data_dir=Path("/tmp"),
                    nai_token="",
                    nai_base_url="https://image.novelai.net",
                    llm_base_url="http://127.0.0.1:8080",
                    llm_api_key=f"{provider}-key",
                    llm_model="test-model",
                    mock_generation=False,
                    llm_provider=provider,
                    llm_network_scope="loopback",
                )
                results[provider] = await llm.llm_chat_text(
                    settings=settings,
                    messages=[{"role": "user", "content": "hello"}],
                    http=pool,
                )
        finally:
            await pool.close()

        self.assertEqual(
            results,
            {
                "openai": "openai-ok",
                "anthropic": "anthropic-ok",
                "gemini": "gemini-ok",
            },
        )
        self.assertEqual(len(requests), 3)
        self.assertEqual(requests[0].headers["authorization"], "Bearer openai-key")
        self.assertEqual(requests[1].headers["x-api-key"], "anthropic-key")
        self.assertEqual(requests[2].headers["x-goog-api-key"], "gemini-key")

    async def test_backup_only_slot_is_not_promoted_to_primary(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(
                200,
                json={"choices": [{"message": {"content": "backup-ok"}}]},
            )

        settings = replace(
            _settings(False),
            llm_backup_base_url="http://127.0.0.1:8081/v1",
            llm_backup_api_key="backup-key",
            llm_backup_model="backup-model",
            llm_backup_network_scope="loopback",
        )
        shared = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        pool = HttpClientPool(default_client=shared, long_running_client=shared)
        try:
            with self.assertRaises(LLMNotConfiguredError):
                await llm.llm_chat_text(
                    settings=settings,
                    messages=[{"role": "user", "content": "hello"}],
                    http=pool,
                )
        finally:
            await pool.close()

        self.assertEqual(requests, [])

    async def test_local_network_policy_error_does_not_try_backup(self) -> None:
        calls = 0

        async def handler(_request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            return httpx.Response(200)

        settings = Settings(
            host="127.0.0.1",
            port=38176,
            data_dir=Path("/tmp"),
            nai_token="",
            nai_base_url="https://image.novelai.net",
            llm_base_url="http://127.0.0.1:8080/v1",
            llm_api_key="primary-key",
            llm_model="primary-model",
            mock_generation=False,
            llm_network_scope="public",
            llm_backup_base_url="http://127.0.0.1:8081/v1",
            llm_backup_api_key="backup-key",
            llm_backup_model="backup-model",
            llm_backup_network_scope="loopback",
        )
        shared = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        pool = HttpClientPool(default_client=shared, long_running_client=shared)
        try:
            with self.assertRaises(OutboundPolicyError):
                await llm.llm_chat_text(
                    settings=settings,
                    messages=[{"role": "user", "content": "hello"}],
                    http=pool,
                )
        finally:
            await pool.close()
        self.assertEqual(calls, 0)

    async def test_trusted_lan_scope_uses_the_configured_cidr_only(self) -> None:
        calls = 0

        async def handler(_request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            return httpx.Response(
                200,
                json={"choices": [{"message": {"content": "lan-ok"}}]},
            )

        settings = replace(
            _settings(True),
            llm_base_url="http://10.23.4.5:8080/v1",
            llm_network_scope="trusted-lan",
            llm_trusted_networks=("10.23.0.0/16",),
        )
        shared = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        pool = HttpClientPool(default_client=shared, long_running_client=shared)
        try:
            result = await llm.llm_chat_text(
                settings=settings,
                messages=[{"role": "user", "content": "hello"}],
                http=pool,
            )
        finally:
            await pool.close()
        self.assertEqual(result, "lan-ok")
        self.assertEqual(calls, 1)


if __name__ == "__main__":
    unittest.main()
