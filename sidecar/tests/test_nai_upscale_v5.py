"""V5 扩散超分(multipart + 回退白名单)的失败路径与载荷契约。

上游一律 fake(MockTransport),不得打真 API。计费红线是核心断言:
只有 400/404/405/422 允许回退旧 schema,401/402/429/5xx 换格式重发
等于重复扣费,一条都不许重试。
"""

from __future__ import annotations

import base64
import io
import json
import struct
import unittest
import zipfile
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from unittest import mock

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from sidecar.api import mount_api
from sidecar.application import SettingsStore
from sidecar.config import Settings
from sidecar.infrastructure import HttpClientPool
from sidecar.nai import client as nai_client
from sidecar.nai.client import (
    NovelAIError,
    png_dimensions,
    upscale_image_v5,
)
from sidecar.runtime import AppRuntime
from sidecar.security import AuthManager, OutboundPolicy

SOURCE_PNG = (
    b"\x89PNG\r\n\x1a\n"
    + struct.pack(">I", 13)
    + b"IHDR"
    + struct.pack(">IIBBBBB", 832, 1216, 8, 2, 0, 0, 0)
    + b"\x00\x00\x00\x00"
    + b"REST-OF-SOURCE"
)
RESULT_PNG = (
    b"\x89PNG\r\n\x1a\n"
    + struct.pack(">I", 13)
    + b"IHDR"
    + struct.pack(">IIBBBBB", 1664, 2432, 8, 2, 0, 0, 0)
    + b"\x00\x00\x00\x00"
    + b"REST-OF-RESULT"
)
SOURCE_B64 = base64.b64encode(SOURCE_PNG).decode("ascii")


def _zip_bytes(data: bytes) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("image_0.png", data)
    return buffer.getvalue()


def _policy() -> OutboundPolicy:
    return OutboundPolicy(
        "public",
        resolver=lambda _host, _port: ["93.184.216.34"],
    )


def _settings(nai_token: str | None = None) -> Settings:
    return Settings(
        host="127.0.0.1",
        port=0,
        data_dir=Path("/tmp"),
        nai_token="test-token" if nai_token is None else nai_token,
        nai_base_url="https://image.novelai.net",
        llm_base_url="",
        llm_api_key="",
        llm_model="",
        mock_generation=False,
    )


def _pool(handler: Any) -> HttpClientPool:
    shared = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return HttpClientPool(default_client=shared, long_running_client=shared)


class PngDimensionsTests(unittest.TestCase):
    def test_reads_ihdr_dimensions(self) -> None:
        self.assertEqual(png_dimensions(SOURCE_PNG), (832, 1216))
        self.assertEqual(png_dimensions(RESULT_PNG), (1664, 2432))

    def test_rejects_non_png_and_truncated_headers(self) -> None:
        self.assertIsNone(png_dimensions(b"not a png at all"))
        self.assertIsNone(png_dimensions(SOURCE_PNG[:16]))
        zeroed = bytearray(SOURCE_PNG)
        zeroed[16:24] = b"\x00" * 8
        self.assertIsNone(png_dimensions(bytes(zeroed)))


class UpscaleV5ClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_success_uses_multipart_and_unzips_result(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(200, content=_zip_bytes(RESULT_PNG))

        pool = _pool(handler)
        try:
            result = await upscale_image_v5(
                settings=_settings(),
                image=SOURCE_B64,
                http=pool,
                outbound_policy=_policy(),
            )
        finally:
            await pool.close()

        self.assertEqual(result, RESULT_PNG)
        self.assertEqual(len(requests), 1)
        request = requests[0]
        self.assertEqual(str(request.url), "https://image.novelai.net/ai/upscale")
        self.assertEqual(request.headers["authorization"], "Bearer test-token")
        self.assertEqual(request.headers["accept"], "application/x-zip-compressed")
        self.assertIn(
            "multipart/form-data; boundary=----WebKitFormBoundary",
            request.headers["content-type"],
        )
        body = request.content
        # 源图按原始字节走 part,绝不付 base64 的 33% 膨胀
        self.assertIn(SOURCE_PNG, body)
        self.assertNotIn(SOURCE_B64.encode(), body)
        # request part 的 JSON 指向 part 名,与生成路径的 multipart 约定一致
        # (装配用紧凑分隔器,键值间无空格)
        request_json_start = body.index(b'"image":"image"')
        self.assertGreater(request_json_start, body.index(SOURCE_PNG))
        header, rest = body.split(b"\r\n\r\n", 1)
        self.assertIn(b'name="image"', header)
        self.assertIn(b'filename="blob"', header)
        self.assertIn(b"Content-Type: image/png", header)
        request_marker = body.index(b'name="request"')
        request_body_start = body.index(b"\r\n\r\n", request_marker) + 4
        request_body_end = body.index(b"\r\n--", request_body_start)
        payload = json.loads(body[request_body_start:request_body_end])
        self.assertEqual(payload["image"], "image")
        self.assertEqual(payload["model"], "nai-diffusion-5-curated")
        self.assertEqual(payload["declared_blur_sigma"], 0)

    async def test_base_url_is_an_explicit_parameter(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(200, content=_zip_bytes(RESULT_PNG))

        pool = _pool(handler)
        try:
            await upscale_image_v5(
                settings=_settings(),
                image=SOURCE_B64,
                base_url="https://upscale-mirror.example.test",
                http=pool,
                outbound_policy=_policy(),
            )
        finally:
            await pool.close()

        self.assertEqual(str(requests[0].url), "https://upscale-mirror.example.test/ai/upscale")

    async def test_unrecognized_new_format_400_falls_back_to_legacy_schema(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            if b"multipart/form-data" in request.headers.get("content-type", "").encode():
                return httpx.Response(400, json={"message": "legacy payload required"})
            return httpx.Response(200, content=_zip_bytes(RESULT_PNG))

        pool = _pool(handler)
        try:
            result = await upscale_image_v5(
                settings=_settings(),
                image=SOURCE_B64,
                http=pool,
                outbound_policy=_policy(),
            )
        finally:
            await pool.close()

        self.assertEqual(result, RESULT_PNG)
        self.assertEqual(len(requests), 2)
        fallback = requests[1]
        self.assertEqual(fallback.headers["content-type"], "application/json")
        fallback_body = json.loads(fallback.content)
        # 旧 schema:base64 图 + 从源图 PNG 头取的宽高 + 2× 档
        self.assertEqual(fallback_body["image"], SOURCE_B64)
        self.assertEqual(fallback_body["width"], 832)
        self.assertEqual(fallback_body["height"], 1216)
        self.assertEqual(fallback_body["scale"], 2)

    async def _assert_no_fallback(self, status: int) -> tuple[int, int]:
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(status, json={"message": f"upstream said {status}"})

        pool = _pool(handler)
        try:
            with self.assertRaises(NovelAIError) as raised:
                await upscale_image_v5(
                    settings=_settings(),
                    image=SOURCE_B64,
                    http=pool,
                    outbound_policy=_policy(),
                )
        finally:
            await pool.close()
        return raised.exception.status_code, len(requests)

    async def test_billing_class_402_never_retries_in_another_format(self) -> None:
        status, request_count = await self._assert_no_fallback(402)
        self.assertEqual(status, 402)
        self.assertEqual(request_count, 1)

    async def test_server_error_500_never_retries(self) -> None:
        status, request_count = await self._assert_no_fallback(500)
        self.assertEqual(status, 500)
        self.assertEqual(request_count, 1)

    async def test_rate_limited_429_retries_once_in_the_same_format_only(self) -> None:
        sleeps: list[float] = []

        async def fake_sleep(seconds: float) -> None:
            sleeps.append(seconds)

        with mock.patch.object(nai_client, "_rate_limit_sleep", fake_sleep):
            status, request_count = await self._assert_no_fallback(429)
        self.assertEqual(status, 429)
        # 同一个 multipart 请求等 2.5 s 后重发一次;第二次 429 为最终结果,
        # 绝不借机换旧 schema(那是另一次可计费的请求)。
        self.assertEqual(request_count, 2)
        self.assertEqual(sleeps, [nai_client.RATE_LIMIT_BACKOFF_SECONDS])

    async def test_non_v5_model_is_rejected_before_any_request(self) -> None:
        async def handler(request: httpx.Request) -> httpx.Response:
            raise AssertionError("non-V5 model must be rejected locally")

        pool = _pool(handler)
        try:
            with self.assertRaises(NovelAIError) as raised:
                await upscale_image_v5(
                    settings=_settings(),
                    image=SOURCE_B64,
                    model="nai-diffusion-4-5-full",
                    http=pool,
                    outbound_policy=_policy(),
                )
        finally:
            await pool.close()
        self.assertIn("standalone upscaling", str(raised.exception))

    async def test_missing_token_is_rejected_before_any_request(self) -> None:
        async def handler(request: httpx.Request) -> httpx.Response:
            raise AssertionError("no request may leave without a token")

        pool = _pool(handler)
        try:
            with self.assertRaises(NovelAIError):
                await upscale_image_v5(
                    settings=_settings(""),
                    image=SOURCE_B64,
                    http=pool,
                    outbound_policy=_policy(),
                )
        finally:
            await pool.close()

    async def test_invalid_base64_is_rejected(self) -> None:
        pool = _pool(lambda request: httpx.Response(200))
        try:
            with self.assertRaises(NovelAIError):
                await upscale_image_v5(
                    settings=_settings(),
                    image="not-base64!!",
                    http=pool,
                    outbound_policy=_policy(),
                )
        finally:
            await pool.close()

    async def test_non_zip_success_raises(self) -> None:
        async def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=b"not a zip")

        pool = _pool(handler)
        try:
            with self.assertRaises(NovelAIError):
                await upscale_image_v5(
                    settings=_settings(),
                    image=SOURCE_B64,
                    http=pool,
                    outbound_policy=_policy(),
                )
        finally:
            await pool.close()

    async def test_fallback_requires_a_png_source(self) -> None:
        non_png_b64 = base64.b64encode(b"jpeg-maybe-but-not-png").decode("ascii")

        async def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(404, json={"message": "legacy path moved"})

        pool = _pool(handler)
        try:
            with self.assertRaises(NovelAIError) as raised:
                await upscale_image_v5(
                    settings=_settings(),
                    image=non_png_b64,
                    http=pool,
                    outbound_policy=_policy(),
                )
        finally:
            await pool.close()
        self.assertIn("PNG", str(raised.exception))


class UpscaleV5RouteTests(unittest.IsolatedAsyncioTestCase):
    def _runtime(self, pool: HttpClientPool, *, mock_generation: bool) -> AppRuntime:
        settings = Settings(
            host="127.0.0.1",
            port=0,
            data_dir=Path("/tmp"),
            nai_token="nai-secret",
            nai_base_url="https://image.novelai.net",
            llm_base_url="",
            llm_api_key="",
            llm_model="",
            mock_generation=mock_generation,
            sidecar_auth_token="process-token",
        )
        return AppRuntime(
            settings=SettingsStore(settings, loader=None),
            security=AuthManager("process-token"),
            http=pool,
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

    def test_route_contract_authentication_shape_and_strictness(self) -> None:
        async def handler(request: httpx.Request) -> httpx.Response:
            assert b"multipart" in request.headers["content-type"].encode()
            return httpx.Response(200, content=_zip_bytes(RESULT_PNG))

        pool = _pool(handler)
        runtime = self._runtime(pool, mock_generation=False)
        with TestClient(self._app(runtime)) as client:  # type: ignore[misc]
            unauthorized = client.post("/api/v1/upscale/v5", json={"image": SOURCE_B64})
            ok = client.post(
                "/api/v1/upscale/v5",
                headers={"Authorization": "Bearer process-token"},
                json={"image": SOURCE_B64, "declared_blur_sigma": 0},
            )
            bad_model = client.post(
                "/api/v1/upscale/v5",
                headers={"Authorization": "Bearer process-token"},
                json={"image": SOURCE_B64, "model": "nai-diffusion-4-5-full"},
            )
            unknown_field = client.post(
                "/api/v1/upscale/v5",
                headers={"Authorization": "Bearer process-token"},
                json={"image": SOURCE_B64, "scale": 4},
            )

        self.assertEqual(unauthorized.status_code, 401)
        self.assertEqual(ok.status_code, 200)
        body = ok.json()
        self.assertEqual(body["width"], 1664)
        self.assertEqual(body["height"], 2432)
        self.assertEqual(body["model"], "nai-diffusion-5-curated")
        self.assertEqual(base64.b64decode(body["image"]), RESULT_PNG)
        # 严格模型:非 V5 模型与未知字段都必须被拒
        self.assertEqual(bad_model.status_code, 422)
        self.assertEqual(unknown_field.status_code, 422)

    def test_mock_generation_returns_source_with_parsed_dimensions(self) -> None:
        pool = _pool(lambda request: httpx.Response(500))
        runtime = self._runtime(pool, mock_generation=True)
        with TestClient(self._app(runtime)) as client:  # type: ignore[misc]
            response = client.post(
                "/api/v1/upscale/v5",
                headers={"Authorization": "Bearer process-token"},
                json={"image": SOURCE_B64},
            )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["width"], 832)
        self.assertEqual(base64.b64decode(body["image"]), SOURCE_PNG)


if __name__ == "__main__":
    unittest.main()
