from __future__ import annotations

import unittest
from pathlib import Path

from sidecar.config import Settings
from sidecar.llm import client as llm
from sidecar.llm.client import (
    LLMConversionError,
    LLMNotConfiguredError,
    _extract_content,
    _extract_json_object,
    require_llm,
)


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


if __name__ == "__main__":
    unittest.main()
