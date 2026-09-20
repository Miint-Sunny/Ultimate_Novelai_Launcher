"""导演工具(`/ai/augment-image`)的载荷契约与失败路径。

上游一律 fake(MockTransport),不得打真 API。两条红线:
计费端点失败绝不重试、绝不换传输格式;本地能判定的坏请求要在发出去**之前**拦下,
没花钱的错误不能伪装成上游故障。
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
    DIRECTOR_MAX_INPUT_PIXELS,
    DIRECTOR_TOOL_TYPES,
    NovelAIError,
    augment_image,
)
from sidecar.runtime import AppRuntime
from sidecar.security import AuthManager, OutboundPolicy


def _png(width: int, height: int, tail: bytes) -> bytes:
    return (
        b"\x89PNG\r\n\x1a\n"
        + struct.pack(">I", 13)
        + b"IHDR"
        + struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
        + b"\x00\x00\x00\x00"
        + tail
    )


SOURCE_PNG = _png(832, 1216, b"REST-OF-SOURCE")
RESULT_PNG = _png(832, 1216, b"REST-OF-RESULT")
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


class DirectorToolCatalogTests(unittest.TestCase):
    def test_catalog_matches_the_official_enum(self) -> None:
        # 取值来自官方前端枚举(2026-09-21);spec 里 req_type 是自由字符串,
        # 所以这张表就是我们的唯一口径,改动要有出处。
        self.assertEqual(
            DIRECTOR_TOOL_TYPES,
            frozenset(
                {
                    "bg-removal",
                    "lineart",
                    "sketch",
                    "colorize",
                    "emotion",
                    "declutter",
                }
            ),
        )

    def test_input_budget_is_area_based(self) -> None:
        # 按面积而不是边长:横竖两种取向都合法。
        self.assertEqual(DIRECTOR_MAX_INPUT_PIXELS, 1536 * 2048)


class AugmentImageClientTests(unittest.IsolatedAsyncioTestCase):
    async def _call(
        self,
        handler: Any,
        *,
        req_type: str = "lineart",
        image: str = SOURCE_B64,
        prompt: str = "",
        defry: int = 0,
        settings: Settings | None = None,
    ) -> bytes:
        pool = _pool(handler)
        try:
            return await augment_image(
                settings=settings or _settings(),
                image=image,
                req_type=req_type,
                prompt=prompt,
                defry=defry,
                http=pool,
                outbound_policy=_policy(),
            )
        finally:
            await pool.close()

    async def test_success_sends_json_and_unzips_the_result(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            # 官方返回 201,不是 200;解包路径必须认它。
            return httpx.Response(201, content=_zip_bytes(RESULT_PNG))

        result = await self._call(handler)

        self.assertEqual(result, RESULT_PNG)
        self.assertEqual(len(requests), 1)
        sent = requests[0]
        self.assertEqual(str(sent.url), "https://image.novelai.net/ai/augment-image")
        self.assertEqual(sent.headers["content-type"], "application/json")
        self.assertEqual(sent.headers["accept"], "application/zip")
        body = json.loads(sent.content)
        # 宽高是从源图 PNG 头读出来的,不由调用方提供。
        self.assertEqual(body["width"], 832)
        self.assertEqual(body["height"], 1216)
        self.assertEqual(body["req_type"], "lineart")
        self.assertEqual(body["image"], SOURCE_B64)
        # 不吃 prompt 的工具一个多余字段都不发。
        self.assertNotIn("prompt", body)
        self.assertNotIn("defry", body)

    async def test_colorize_and_emotion_carry_prompt_and_defry(self) -> None:
        bodies: list[dict[str, Any]] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            bodies.append(json.loads(request.content))
            return httpx.Response(201, content=_zip_bytes(RESULT_PNG))

        await self._call(handler, req_type="colorize", prompt="warm palette", defry=2)
        await self._call(handler, req_type="emotion", prompt="happy", defry=5)

        self.assertEqual(bodies[0]["prompt"], "warm palette")
        self.assertEqual(bodies[0]["defry"], 2)
        self.assertEqual(bodies[1]["req_type"], "emotion")
        self.assertEqual(bodies[1]["prompt"], "happy")
        self.assertEqual(bodies[1]["defry"], 5)

    async def _assert_rejected_before_any_request(self, **kwargs: Any) -> NovelAIError:
        async def handler(request: httpx.Request) -> httpx.Response:
            raise AssertionError("must be rejected locally, before any billable call")

        with self.assertRaises(NovelAIError) as raised:
            await self._call(handler, **kwargs)
        # status_code 0 = 本地判定,路由层据此回 400 而不是「上游故障」。
        self.assertEqual(raised.exception.status_code, 0)
        return raised.exception

    async def test_unknown_tool_is_rejected_before_any_request(self) -> None:
        await self._assert_rejected_before_any_request(req_type="pixel-snap")

    async def test_missing_token_is_rejected_before_any_request(self) -> None:
        await self._assert_rejected_before_any_request(settings=_settings(""))

    async def test_invalid_base64_is_rejected_before_any_request(self) -> None:
        await self._assert_rejected_before_any_request(image="not base64 at all!!")

    async def test_non_png_is_rejected_before_any_request(self) -> None:
        jpeg_ish = base64.b64encode(b"\xff\xd8\xff\xe0not-a-png").decode("ascii")
        await self._assert_rejected_before_any_request(image=jpeg_ish)

    async def test_oversized_input_is_rejected_before_any_request(self) -> None:
        huge = base64.b64encode(_png(4096, 4096, b"TOO-BIG")).decode("ascii")
        error = await self._assert_rejected_before_any_request(image=huge)
        self.assertIn("4096x4096", str(error))

    async def _assert_no_retry(self, status: int) -> tuple[int, int]:
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(status, json={"message": f"upstream said {status}"})

        with self.assertRaises(NovelAIError) as raised:
            await self._call(handler)
        return raised.exception.status_code, len(requests)

    async def test_billing_class_402_never_retries(self) -> None:
        status, count = await self._assert_no_retry(402)
        self.assertEqual(status, 402)
        self.assertEqual(count, 1)

    async def test_bad_request_400_never_retries_in_another_shape(self) -> None:
        # 超分那条有「服务端不认新格式就回退旧 schema」的白名单;导演工具
        # 没有第二种形状,400 就是终点,不许借机再发一次。
        status, count = await self._assert_no_retry(400)
        self.assertEqual(status, 400)
        self.assertEqual(count, 1)

    async def test_server_error_500_never_retries(self) -> None:
        status, count = await self._assert_no_retry(500)
        self.assertEqual(status, 500)
        self.assertEqual(count, 1)

    async def test_rate_limited_429_retries_once_with_the_same_body(self) -> None:
        sleeps: list[float] = []
        bodies: list[bytes] = []

        async def fake_sleep(seconds: float) -> None:
            sleeps.append(seconds)

        async def handler(request: httpx.Request) -> httpx.Response:
            bodies.append(request.content)
            return httpx.Response(429, json={"message": "slow down"})

        with mock.patch.object(nai_client, "_rate_limit_sleep", fake_sleep):
            with self.assertRaises(NovelAIError) as raised:
                await self._call(handler)

        self.assertEqual(raised.exception.status_code, 429)
        self.assertEqual(len(bodies), 2)
        # 重发的必须是一模一样的请求体,不是换了形状的另一次可计费请求。
        self.assertEqual(bodies[0], bodies[1])
        self.assertEqual(sleeps, [nai_client.RATE_LIMIT_BACKOFF_SECONDS])

    async def test_non_zip_success_raises(self) -> None:
        async def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(201, content=b"not a zip")

        with self.assertRaises(NovelAIError):
            await self._call(handler)


class DirectorRouteTests(unittest.IsolatedAsyncioTestCase):
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
            return httpx.Response(201, content=_zip_bytes(RESULT_PNG))

        pool = _pool(handler)
        runtime = self._runtime(pool, mock_generation=False)
        auth = {"Authorization": "Bearer process-token"}
        with TestClient(self._app(runtime)) as client:  # type: ignore[misc]
            unauthorized = client.post(
                "/api/v1/director/augment",
                json={"image": SOURCE_B64, "req_type": "lineart"},
            )
            ok = client.post(
                "/api/v1/director/augment",
                headers=auth,
                json={"image": SOURCE_B64, "req_type": "lineart"},
            )
            bad_tool = client.post(
                "/api/v1/director/augment",
                headers=auth,
                json={"image": SOURCE_B64, "req_type": "pixel-snap"},
            )
            unknown_field = client.post(
                "/api/v1/director/augment",
                headers=auth,
                json={"image": SOURCE_B64, "req_type": "lineart", "scale": 4},
            )
            out_of_range = client.post(
                "/api/v1/director/augment",
                headers=auth,
                json={"image": SOURCE_B64, "req_type": "emotion", "defry": 9},
            )

        self.assertEqual(unauthorized.status_code, 401)
        self.assertEqual(ok.status_code, 200)
        body = ok.json()
        self.assertEqual(body["width"], 832)
        self.assertEqual(body["height"], 1216)
        self.assertEqual(body["req_type"], "lineart")
        self.assertEqual(base64.b64decode(body["image"]), RESULT_PNG)
        # 严格模型:未知工具、未知字段、越界 defry 都必须被拒。
        self.assertEqual(bad_tool.status_code, 422)
        self.assertEqual(unknown_field.status_code, 422)
        self.assertEqual(out_of_range.status_code, 422)

    def test_mock_generation_returns_source_without_calling_upstream(self) -> None:
        async def handler(request: httpx.Request) -> httpx.Response:
            raise AssertionError("mock_generation must not reach the paid endpoint")

        pool = _pool(handler)
        runtime = self._runtime(pool, mock_generation=True)
        with TestClient(self._app(runtime)) as client:  # type: ignore[misc]
            response = client.post(
                "/api/v1/director/augment",
                headers={"Authorization": "Bearer process-token"},
                json={"image": SOURCE_B64, "req_type": "declutter"},
            )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(base64.b64decode(body["image"]), SOURCE_PNG)
        self.assertEqual((body["width"], body["height"]), (832, 1216))

    def test_local_rejection_is_a_400_not_an_upstream_failure(self) -> None:
        async def handler(request: httpx.Request) -> httpx.Response:
            raise AssertionError("a non-PNG must never reach the paid endpoint")

        pool = _pool(handler)
        runtime = self._runtime(pool, mock_generation=False)
        with TestClient(self._app(runtime)) as client:  # type: ignore[misc]
            response = client.post(
                "/api/v1/director/augment",
                headers={"Authorization": "Bearer process-token"},
                json={
                    "image": base64.b64encode(b"\xff\xd8\xffnope").decode("ascii"),
                    "req_type": "sketch",
                },
            )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["code"], "invalid_director_request")

    def test_upstream_failure_carries_the_status_and_does_not_retry(self) -> None:
        calls: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            return httpx.Response(402, json={"message": "not enough anlas"})

        pool = _pool(handler)
        runtime = self._runtime(pool, mock_generation=False)
        with TestClient(self._app(runtime)) as client:  # type: ignore[misc]
            response = client.post(
                "/api/v1/director/augment",
                headers={"Authorization": "Bearer process-token"},
                json={"image": SOURCE_B64, "req_type": "bg-removal"},
            )

        self.assertEqual(len(calls), 1)
        self.assertEqual(response.status_code, 503)
        payload = response.json()
        self.assertEqual(payload["code"], "director_upstream_failed")
        # Problem Details 把附加信息放在 context 里,不是 details。
        self.assertEqual(payload["context"]["upstream_status"], 402)
        # ⚠ 路由传的是 retryable=False,但 problems.py 对 503 一律置真
        #   (`exc.retryable or status in {429, 503}`),超分那条同样如此。
        #   所以**前端不能拿 retryable 当"可以再发一次"**:这是计费端点,
        #   真正的判据是 context.upstream_status。钉住现状,免得哪天默默变了。
        self.assertTrue(payload["retryable"])
        self.assertEqual(response.headers["content-type"], "application/problem+json")


if __name__ == "__main__":
    unittest.main()
