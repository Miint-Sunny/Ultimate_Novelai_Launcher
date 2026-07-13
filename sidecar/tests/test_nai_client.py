from __future__ import annotations

import io
import unittest
import zipfile
from pathlib import Path

import httpx

from sidecar.config import Settings
from sidecar.infrastructure import HttpClientPool
from sidecar.nai import client
from sidecar.nai.client import (
    NovelAIError,
    _sanitize_for_log,
    build_official_payload,
    parse_anlas_subscription,
)
from sidecar.nai.models import GenerationParams
from sidecar.security import OutboundPolicy


def _settings(nai_token: str = "") -> Settings:
    return Settings(
        host="127.0.0.1",
        port=38176,
        data_dir=Path("/tmp"),
        nai_token=nai_token,
        nai_base_url="https://image.novelai.net",
        llm_base_url="",
        llm_api_key="",
        llm_model="",
        mock_generation=False,
    )


class SanitizeForLogTests(unittest.TestCase):
    def test_redacts_token_and_authorization_keys(self) -> None:
        cleaned = _sanitize_for_log(
            {"Authorization": "Bearer secret-value", "token": "secret", "keep": "ok"}
        )
        self.assertEqual(cleaned["Authorization"], "***")
        self.assertEqual(cleaned["token"], "***")
        self.assertEqual(cleaned["keep"], "ok")

    def test_recurses_into_nested_structures(self) -> None:
        cleaned = _sanitize_for_log({"nested": [{"TOKEN": "secret"}, {"safe": "value"}]})
        self.assertEqual(cleaned["nested"][0]["TOKEN"], "***")
        self.assertEqual(cleaned["nested"][1]["safe"], "value")

    def test_truncates_long_strings(self) -> None:
        long_value = "a" * 600
        self.assertEqual(_sanitize_for_log({"image": long_value})["image"], "<600 chars>")

    def test_short_strings_untouched(self) -> None:
        self.assertEqual(_sanitize_for_log("hello"), "hello")


class BuildOfficialPayloadTests(unittest.TestCase):
    def test_structure_and_explicit_seed(self) -> None:
        params = GenerationParams(seed=42)
        payload = build_official_payload("1girl, smile", "bad anatomy", params)
        self.assertEqual(payload["input"], "1girl, smile")
        self.assertEqual(payload["model"], params.model)
        self.assertEqual(payload["action"], "generate")
        parameters = payload["parameters"]
        self.assertEqual(parameters["seed"], 42)
        self.assertEqual(parameters["width"], params.width)
        self.assertEqual(parameters["height"], params.height)
        self.assertEqual(parameters["negative_prompt"], "bad anatomy")
        self.assertEqual(parameters["v4_prompt"]["caption"]["base_caption"], "1girl, smile")
        self.assertEqual(parameters["v4_negative_prompt"]["caption"]["base_caption"], "bad anatomy")

    def test_random_seed_when_none(self) -> None:
        payload = build_official_payload("x", "", GenerationParams(seed=None))
        seed = payload["parameters"]["seed"]
        self.assertIsInstance(seed, int)
        self.assertGreaterEqual(seed, 0)
        self.assertLessEqual(seed, 2**32 - 1)


class ParseAnlasSubscriptionTests(unittest.TestCase):
    def test_parses_steps_and_opus(self) -> None:
        out = parse_anlas_subscription(
            {
                "trainingStepsLeft": {"fixedTrainingStepsLeft": 100, "purchasedTrainingSteps": 50},
                "tier": 3,
                "active": True,
            }
        )
        self.assertEqual(out["fixedTrainingStepsLeft"], 100)
        self.assertEqual(out["purchasedTrainingSteps"], 50)
        self.assertTrue(out["isOpus"])

    def test_defaults_when_missing(self) -> None:
        out = parse_anlas_subscription({})
        self.assertEqual(out["fixedTrainingStepsLeft"], 0)
        self.assertEqual(out["purchasedTrainingSteps"], 0)
        self.assertFalse(out["isOpus"])

    def test_not_opus_when_inactive(self) -> None:
        self.assertFalse(parse_anlas_subscription({"tier": 3, "active": False})["isOpus"])


class TokenGuardAndZipTests(unittest.IsolatedAsyncioTestCase):
    async def test_generate_requires_token(self) -> None:
        with self.assertRaises(NovelAIError):
            await client.generate_image_from_payload(settings=_settings(""), payload={})

    async def test_encode_vibe_requires_token(self) -> None:
        with self.assertRaises(NovelAIError):
            await client.encode_vibe(
                settings=_settings(""), image="x", information_extracted=0.5, model="m"
            )

    async def test_upscale_requires_token(self) -> None:
        with self.assertRaises(NovelAIError):
            await client.upscale_image(
                settings=_settings(""), image="x", width=64, height=64, scale=2
            )

    async def test_fetch_anlas_requires_token(self) -> None:
        with self.assertRaises(NovelAIError):
            await client.fetch_anlas(_settings(""))

    async def test_extract_image_from_zip(self) -> None:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as archive:
            archive.writestr("image_0.png", b"PNGDATA")
        self.assertEqual(await client._extract_image_from_zip(buf.getvalue()), b"PNGDATA")

    async def test_extract_image_from_bad_zip(self) -> None:
        with self.assertRaises(NovelAIError):
            await client._extract_image_from_zip(b"not a zip")

    async def test_generation_uses_injected_lifecycle_pool(self) -> None:
        archive_bytes = io.BytesIO()
        with zipfile.ZipFile(archive_bytes, "w") as archive:
            archive.writestr("image_0.png", b"PNGDATA")
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(200, content=archive_bytes.getvalue())

        shared = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        pool = HttpClientPool(default_client=shared, long_running_client=shared)
        try:
            image = await client.generate_image_from_payload(
                settings=_settings("test-token"),
                payload={"input": "cat"},
                http=pool,
                outbound_policy=OutboundPolicy(
                    "public",
                    resolver=lambda _host, _port: ["93.184.216.34"],
                ),
            )
        finally:
            await pool.close()

        self.assertEqual(image, b"PNGDATA")
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0].headers["authorization"], "Bearer test-token")


if __name__ == "__main__":
    unittest.main()
