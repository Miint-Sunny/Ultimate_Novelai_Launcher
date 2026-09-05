"""HTTP 429 on the paid NovelAI paths: one same-format retry, never a transport switch.

上游一律 MockTransport。红线:429 只允许**同一个请求**在等 2.5 s 后重发一次,第二次
429 就是最终结果;不得借机换成 JSON+ZIP 或旧超分 schema(那是另一次可计费的请求)。
其他状态码沿用既有规则,不多发一次。
"""

from __future__ import annotations

import base64
import io
import unittest
import zipfile
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any
from unittest import mock

import httpx
import msgpack

from sidecar.config import Settings
from sidecar.infrastructure import HttpClientPool
from sidecar.nai import client as nai_client
from sidecar.nai.client import (
    NovelAIError,
    NovelAIStreamError,
    encode_vibe,
    generate_image_from_payload,
    generate_image_from_payload_stream,
    upscale_image_v5,
)
from sidecar.security import OutboundPolicy

STREAM_PATH = "/ai/generate-image-stream"
ZIP_PATH = "/ai/generate-image"


def _settings() -> Settings:
    return Settings(
        host="127.0.0.1",
        port=38176,
        data_dir=Path("/tmp"),
        nai_token="test-token",
        nai_base_url="https://image.novelai.net",
        llm_base_url="",
        llm_api_key="",
        llm_model="",
        mock_generation=False,
    )


def _policy() -> OutboundPolicy:
    return OutboundPolicy("public", resolver=lambda _host, _port: ["93.184.216.34"])


def _pool(handler: Any) -> HttpClientPool:
    shared = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return HttpClientPool(default_client=shared, long_running_client=shared)


def _zip_bytes(data: bytes) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("image_0.png", data)
    return buffer.getvalue()


def _frame(message: dict[str, Any]) -> bytes:
    data = msgpack.packb(message, use_bin_type=True)
    assert data is not None
    return len(data).to_bytes(4, "big") + data


def _text_payload() -> dict[str, Any]:
    return {"input": "cat", "model": "nai-diffusion-5-full", "parameters": {"steps": 28}}


def _i2i_payload() -> dict[str, Any]:
    return {
        "input": "cat",
        "model": "nai-diffusion-4-5-full",
        "action": "img2img",
        "parameters": {
            "steps": 28,
            "width": 832,
            "height": 1216,
            "strength": 0.6,
            "image": base64.b64encode(b"RAW-IMAGE-BYTES").decode("ascii"),
        },
    }


class _SleepRecorder:
    def __init__(self) -> None:
        self.calls: list[float] = []

    async def __call__(self, seconds: float) -> None:
        self.calls.append(seconds)


class _RateLimitCase(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.sleeps = _SleepRecorder()
        patcher = mock.patch.object(nai_client, "_rate_limit_sleep", self.sleeps)
        patcher.start()
        self.addCleanup(patcher.stop)


class JsonPathRateLimitTests(_RateLimitCase):
    async def test_generate_retries_the_same_request_once_after_429(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            if len(requests) == 1:
                return httpx.Response(429, json={"message": "slow down"})
            return httpx.Response(200, content=_zip_bytes(b"IMAGE"))

        pool = _pool(handler)
        try:
            image = await generate_image_from_payload(
                settings=_settings(),
                payload=_text_payload(),
                http=pool,
                outbound_policy=_policy(),
            )
        finally:
            await pool.close()

        self.assertEqual(image, b"IMAGE")
        self.assertEqual([request.url.path for request in requests], [ZIP_PATH, ZIP_PATH])
        self.assertEqual(requests[0].content, requests[1].content)
        self.assertEqual(self.sleeps.calls, [nai_client.RATE_LIMIT_BACKOFF_SECONDS])

    async def test_second_429_is_final(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(429, json={"message": "still busy"})

        pool = _pool(handler)
        try:
            with self.assertRaises(NovelAIError) as raised:
                await generate_image_from_payload(
                    settings=_settings(),
                    payload=_text_payload(),
                    http=pool,
                    outbound_policy=_policy(),
                )
        finally:
            await pool.close()

        self.assertEqual(raised.exception.status_code, 429)
        self.assertEqual(len(requests), 2)
        self.assertEqual(self.sleeps.calls, [nai_client.RATE_LIMIT_BACKOFF_SECONDS])

    async def _single_failure(self, status: int) -> tuple[int, int]:
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(status, json={"message": "no"})

        pool = _pool(handler)
        try:
            with self.assertRaises(NovelAIError) as raised:
                await generate_image_from_payload(
                    settings=_settings(),
                    payload=_text_payload(),
                    http=pool,
                    outbound_policy=_policy(),
                )
        finally:
            await pool.close()
        return raised.exception.status_code, len(requests)

    async def test_other_failures_never_get_a_second_request(self) -> None:
        for status in (402, 500, 401):
            with self.subTest(status=status):
                seen_status, request_count = await self._single_failure(status)
                self.assertEqual(seen_status, status)
                self.assertEqual(request_count, 1)
        self.assertEqual(self.sleeps.calls, [])

    async def test_encode_vibe_retries_once(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            if len(requests) == 1:
                return httpx.Response(429)
            return httpx.Response(200, content=b"VECTOR")

        pool = _pool(handler)
        try:
            encoded = await encode_vibe(
                settings=_settings(),
                image=base64.b64encode(b"PNG").decode("ascii"),
                information_extracted=0.5,
                model="nai-diffusion-4-5-full",
                http=pool,
                outbound_policy=_policy(),
            )
        finally:
            await pool.close()

        self.assertEqual(base64.b64decode(encoded), b"VECTOR")
        self.assertEqual([request.url.path for request in requests], ["/ai/encode-vibe"] * 2)
        self.assertEqual(self.sleeps.calls, [nai_client.RATE_LIMIT_BACKOFF_SECONDS])


class StreamPathRateLimitTests(_RateLimitCase):
    async def test_stream_429_is_resent_on_the_stream_endpoint_not_json(self) -> None:
        requests: list[httpx.Request] = []
        progress: list[float] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            if request.url.path == ZIP_PATH:
                raise AssertionError("a rate limit must not switch to the JSON+ZIP endpoint")
            if len(requests) == 1:
                return httpx.Response(429, json={"message": "slow down"})
            return httpx.Response(
                200,
                content=_frame({"step_ix": 0, "image": b"STEP-1"}) + _frame({"image": b"FINAL"}),
            )

        async def on_progress(value: float) -> None:
            progress.append(value)

        pool = _pool(handler)
        try:
            image = await generate_image_from_payload_stream(
                settings=_settings(),
                payload=_i2i_payload(),
                http=pool,
                outbound_policy=_policy(),
                on_progress=on_progress,
            )
        finally:
            await pool.close()

        self.assertEqual(image, b"FINAL")
        self.assertEqual([request.url.path for request in requests], [STREAM_PATH, STREAM_PATH])
        self.assertEqual(requests[0].content, requests[1].content)
        self.assertEqual(self.sleeps.calls, [nai_client.RATE_LIMIT_BACKOFF_SECONDS])
        self.assertTrue(progress)

    async def test_double_429_on_the_stream_is_final_without_json_fallback(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(429, json={"message": "still busy"})

        pool = _pool(handler)
        try:
            with self.assertRaises(NovelAIStreamError) as raised:
                await generate_image_from_payload_stream(
                    settings=_settings(),
                    payload=_i2i_payload(),
                    http=pool,
                    outbound_policy=_policy(),
                )
        finally:
            await pool.close()

        self.assertEqual(raised.exception.status_code, 429)
        self.assertFalse(raised.exception.retry_safe)
        self.assertEqual([request.url.path for request in requests], [STREAM_PATH, STREAM_PATH])
        self.assertEqual(self.sleeps.calls, [nai_client.RATE_LIMIT_BACKOFF_SECONDS])

    async def test_other_pre_frame_failures_keep_the_json_fallback_without_sleeping(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            if request.url.path == STREAM_PATH:
                return httpx.Response(503, json={"message": "stream down"})
            return httpx.Response(200, content=_zip_bytes(b"FALLBACK"))

        pool = _pool(handler)
        try:
            image = await generate_image_from_payload_stream(
                settings=_settings(),
                payload=_i2i_payload(),
                http=pool,
                outbound_policy=_policy(),
            )
        finally:
            await pool.close()

        self.assertEqual(image, b"FALLBACK")
        self.assertEqual([request.url.path for request in requests], [STREAM_PATH, ZIP_PATH])
        self.assertEqual(self.sleeps.calls, [])

    async def test_429_after_a_frame_is_not_possible_but_frames_still_block_retries(self) -> None:
        """A business error after frames keeps the no-retry rule (unchanged behaviour)."""

        requests: list[httpx.Request] = []

        async def body() -> AsyncIterator[bytes]:
            yield _frame({"step_ix": 0, "image": b"STEP-1"})
            yield _frame({"code": 429, "message": "busy mid-stream"})

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(200, content=body())

        pool = _pool(handler)
        try:
            with self.assertRaises(NovelAIStreamError) as raised:
                await generate_image_from_payload_stream(
                    settings=_settings(),
                    payload=_i2i_payload(),
                    http=pool,
                    outbound_policy=_policy(),
                )
        finally:
            await pool.close()

        self.assertFalse(raised.exception.retry_safe)
        self.assertEqual(len(requests), 1)
        self.assertEqual(self.sleeps.calls, [])


class UpscaleRateLimitTests(_RateLimitCase):
    SOURCE_B64 = base64.b64encode(b"SOURCE-PNG-BYTES").decode("ascii")

    async def test_upscale_429_is_resent_as_the_same_multipart_request(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            if len(requests) == 1:
                return httpx.Response(429, json={"message": "slow down"})
            return httpx.Response(200, content=_zip_bytes(b"UPSCALED"))

        pool = _pool(handler)
        try:
            result = await upscale_image_v5(
                settings=_settings(),
                image=self.SOURCE_B64,
                http=pool,
                outbound_policy=_policy(),
            )
        finally:
            await pool.close()

        self.assertEqual(result, b"UPSCALED")
        self.assertEqual(len(requests), 2)
        for request in requests:
            self.assertIn("multipart/form-data", request.headers["content-type"])
        self.assertEqual(requests[0].content, requests[1].content)
        self.assertEqual(self.sleeps.calls, [nai_client.RATE_LIMIT_BACKOFF_SECONDS])

    async def test_double_429_never_falls_back_to_the_legacy_schema(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(429, json={"message": "still busy"})

        pool = _pool(handler)
        try:
            with self.assertRaises(NovelAIError) as raised:
                await upscale_image_v5(
                    settings=_settings(),
                    image=self.SOURCE_B64,
                    http=pool,
                    outbound_policy=_policy(),
                )
        finally:
            await pool.close()

        self.assertEqual(raised.exception.status_code, 429)
        self.assertEqual(len(requests), 2)
        for request in requests:
            self.assertIn("multipart/form-data", request.headers["content-type"])
        self.assertEqual(self.sleeps.calls, [nai_client.RATE_LIMIT_BACKOFF_SECONDS])


if __name__ == "__main__":
    unittest.main()
