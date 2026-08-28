from __future__ import annotations

import asyncio
import base64
import io
import unittest
import zipfile
from pathlib import Path
from typing import Any

import httpx
import msgpack

from sidecar.config import Settings
from sidecar.infrastructure import HttpClientPool
from sidecar.nai.client import (
    NovelAIStreamError,
    _build_stream_multipart_body,
    _prepare_stream_payload,
    generate_image_from_payload_stream,
)
from sidecar.security import OutboundPolicy

_STREAM_PATH = "/ai/generate-image-stream"
_ZIP_PATH = "/ai/generate-image"


def _settings(nai_token: str | None = None) -> Settings:
    return Settings(
        host="127.0.0.1",
        port=38176,
        data_dir=Path("/tmp"),
        nai_token="test-token" if nai_token is None else nai_token,
        nai_base_url="https://image.novelai.net",
        llm_base_url="",
        llm_api_key="",
        llm_model="",
        mock_generation=False,
    )


def _policy() -> OutboundPolicy:
    return OutboundPolicy(
        "public",
        resolver=lambda _host, _port: ["93.184.216.34"],
    )


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


def _infill_payload() -> dict[str, Any]:
    payload = _i2i_payload()
    payload["action"] = "infill"
    payload["parameters"]["mask"] = base64.b64encode(b"RAW-MASK-BYTES").decode("ascii")
    return payload


def _frame(message: dict[str, Any]) -> bytes:
    data = msgpack.packb(message, use_bin_type=True)
    assert data is not None
    return len(data).to_bytes(4, "big") + data


def _zip_bytes(data: bytes = b"ZIP-IMAGE") -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("image_0.png", data)
    return buffer.getvalue()


def _split(body: bytes, chunk_size: int) -> list[bytes]:
    return [body[i : i + chunk_size] for i in range(0, len(body), chunk_size)]


class PrepareStreamPayloadTests(unittest.TestCase):
    def test_extracts_binary_fields_and_references_part_names(self) -> None:
        prepared = _prepare_stream_payload(_infill_payload())
        assert prepared is not None
        stream_payload, parts = prepared
        names = [part.name for part in parts]
        self.assertEqual(names, ["image", "mask"])
        self.assertEqual(parts[0].data, b"RAW-IMAGE-BYTES")
        self.assertEqual(parts[1].data, b"RAW-MASK-BYTES")
        # The JSON no longer carries base64; it references the part names.
        self.assertEqual(stream_payload["parameters"]["image"], "image")
        self.assertEqual(stream_payload["parameters"]["mask"], "mask")
        self.assertEqual(stream_payload["parameters"]["stream"], "msgpack")
        # The input payload is not mutated (fallback may still need it).
        self.assertIn("image", _infill_payload()["parameters"])

    def test_reference_images_become_ref_multiple_parts(self) -> None:
        payload = _i2i_payload()
        payload["parameters"]["reference_image_multiple"] = [
            base64.b64encode(b"VIBE-A").decode("ascii"),
            base64.b64encode(b"VIBE-B").decode("ascii"),
        ]
        prepared = _prepare_stream_payload(payload)
        assert prepared is not None
        stream_payload, parts = prepared
        self.assertEqual(
            [part.name for part in parts],
            ["image", "ref_multiple_0", "ref_multiple_1"],
        )
        self.assertEqual(
            stream_payload["parameters"]["reference_image_multiple"],
            ["ref_multiple_0", "ref_multiple_1"],
        )

    def test_undecodable_reference_entry_stays_in_json(self) -> None:
        payload = _i2i_payload()
        payload["parameters"]["reference_image_multiple"] = ["not-base64!!"]
        prepared = _prepare_stream_payload(payload)
        assert prepared is not None
        stream_payload, parts = prepared
        self.assertEqual([part.name for part in parts], ["image"])
        self.assertEqual(
            stream_payload["parameters"]["reference_image_multiple"],
            ["not-base64!!"],
        )

    def test_text_only_payload_returns_none(self) -> None:
        payload = {
            "input": "cat",
            "parameters": {"steps": 28, "width": 832, "height": 1216},
        }
        self.assertIsNone(_prepare_stream_payload(payload))

    def test_undecodable_image_returns_none_to_keep_json_path(self) -> None:
        payload = _i2i_payload()
        payload["parameters"]["image"] = "not-base64!!"
        self.assertIsNone(_prepare_stream_payload(payload))

    def test_missing_parameters_returns_none(self) -> None:
        self.assertIsNone(_prepare_stream_payload({"input": "cat"}))


class MultipartBodyTests(unittest.TestCase):
    def test_body_structure_matches_captured_client_shape(self) -> None:
        payload = _infill_payload()
        prepared = _prepare_stream_payload(payload)
        assert prepared is not None
        stream_payload, parts = prepared
        body, boundary = _build_stream_multipart_body(stream_payload, parts)

        self.assertTrue(boundary.startswith("----WebKitFormBoundary"))
        header, rest = body.split(b"\r\n\r\n", 1)
        self.assertIn(f'Content-Disposition: form-data; name="{parts[0].name}"'.encode(), header)
        self.assertIn(b'filename="blob"', header)
        self.assertIn(b"Content-Type: image/png", header)
        # The binary part carries the raw bytes, not their base64 encoding.
        self.assertNotIn(base64.b64encode(b"RAW-IMAGE-BYTES"), body)
        self.assertIn(b"RAW-IMAGE-BYTES", body)
        self.assertIn(b"RAW-MASK-BYTES", body)
        # The request part is last and is compact JSON without the binaries.
        request_marker = b'name="request"'
        self.assertGreater(body.rfind(request_marker), body.rfind(b"RAW-MASK-BYTES"))
        request_start = body.index(request_marker)
        json_start = body.index(b"\r\n\r\n", request_start) + 4
        json_end = body.index(b"\r\n--", json_start)
        import json as json_module

        request_json = json_module.loads(body[json_start:json_end])
        self.assertEqual(request_json["parameters"]["image"], "image")
        self.assertEqual(request_json["parameters"]["mask"], "mask")
        self.assertEqual(request_json["parameters"]["stream"], "msgpack")
        self.assertTrue(body.endswith(f"--{boundary}--\r\n".encode()))


class StreamGenerationTests(unittest.IsolatedAsyncioTestCase):
    def _pool(self, handler) -> HttpClientPool:
        shared = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        return HttpClientPool(default_client=shared, long_running_client=shared)

    async def test_frames_stream_progress_and_final_image(self) -> None:
        frames = (
            _frame({"step_ix": 0, "image": b"STEP-1"})
            + _frame({"step_ix": 13, "image": b"STEP-14"})
            + _frame({"image": b"FINAL"})
        )
        requests: list[httpx.Request] = []
        progress: list[float] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(200, content=frames)

        async def on_progress(value: float) -> None:
            progress.append(value)

        pool = self._pool(handler)
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
        self.assertEqual(progress, [1 / 28, 14 / 28, 1.0])
        self.assertEqual(len(requests), 1)
        stream_request = requests[0]
        self.assertEqual(stream_request.url.path, _STREAM_PATH)
        self.assertEqual(stream_request.headers["authorization"], "Bearer test-token")
        self.assertIn("multipart/form-data; boundary=", stream_request.headers["content-type"])

    async def test_text_only_payload_stays_on_the_json_zip_path(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(200, content=_zip_bytes())

        pool = self._pool(handler)
        try:
            image = await generate_image_from_payload_stream(
                settings=_settings(),
                payload={"input": "cat", "parameters": {"steps": 4}},
                http=pool,
                outbound_policy=_policy(),
            )
        finally:
            await pool.close()

        self.assertEqual(image, b"ZIP-IMAGE")
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0].url.path, _ZIP_PATH)
        self.assertEqual(requests[0].headers["content-type"], "application/json")

    async def test_business_error_after_frames_is_terminal_without_fallback(self) -> None:
        frames = (
            _frame({"step_ix": 0, "image": b"STEP-1"})
            + _frame({"code": 402, "message": "Anlas required"})
        )
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(200, content=frames)

        pool = self._pool(handler)
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

        self.assertIn("402", str(raised.exception))
        self.assertIn("Anlas required", str(raised.exception))
        self.assertEqual(raised.exception.status_code, 402)
        self.assertFalse(raised.exception.retry_safe)
        # No JSON+ZIP retry: a received frame means NovelAI engaged, and a
        # repeat request could double-charge.
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0].url.path, _STREAM_PATH)

    async def test_first_frame_business_error_is_also_terminal(self) -> None:
        frames = _frame({"code": 400, "message": "validation failed"})

        async def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=frames)

        pool = self._pool(handler)
        try:
            with self.assertRaises(NovelAIStreamError):
                await generate_image_from_payload_stream(
                    settings=_settings(),
                    payload=_i2i_payload(),
                    http=pool,
                    outbound_policy=_policy(),
                )
        finally:
            await pool.close()

    async def test_undecodable_frame_is_skipped_and_stream_continues(self) -> None:
        garbage = b"\x00\xff\xee not-msgpack"
        frames = (
            _frame({"step_ix": 0, "image": b"STEP-1"})
            + len(garbage).to_bytes(4, "big")
            + garbage
            + _frame({"image": b"FINAL"})
        )

        async def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=frames)

        pool = self._pool(handler)
        try:
            image = await generate_image_from_payload_stream(
                settings=_settings(),
                payload=_i2i_payload(),
                http=pool,
                outbound_policy=_policy(),
            )
        finally:
            await pool.close()

        self.assertEqual(image, b"FINAL")

    async def test_garbage_length_prefix_falls_back_to_json_zip(self) -> None:
        # A 200 body that is not length-prefixed msgpack (for example an
        # interceptor's HTML) produces an absurd frame length; zero decoded
        # frames means the JSON+ZIP retry is safe.
        garbage = b"<!doctype html><html>interceptor</html>"
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            if request.url.path == _STREAM_PATH:
                return httpx.Response(200, content=garbage)
            return httpx.Response(200, content=_zip_bytes(b"FALLBACK-IMAGE"))

        pool = self._pool(handler)
        try:
            image = await generate_image_from_payload_stream(
                settings=_settings(),
                payload=_i2i_payload(),
                http=pool,
                outbound_policy=_policy(),
            )
        finally:
            await pool.close()

        self.assertEqual(image, b"FALLBACK-IMAGE")
        self.assertEqual([r.url.path for r in requests], [_STREAM_PATH, _ZIP_PATH])

    async def test_http_error_on_stream_endpoint_falls_back(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            if request.url.path == _STREAM_PATH:
                return httpx.Response(400, json={"message": "bad stream request"})
            return httpx.Response(200, content=_zip_bytes(b"FALLBACK-IMAGE"))

        pool = self._pool(handler)
        try:
            image = await generate_image_from_payload_stream(
                settings=_settings(),
                payload=_i2i_payload(),
                http=pool,
                outbound_policy=_policy(),
            )
        finally:
            await pool.close()

        self.assertEqual(image, b"FALLBACK-IMAGE")
        self.assertEqual([r.url.path for r in requests], [_STREAM_PATH, _ZIP_PATH])
        # The fallback must send the original base64 JSON, not the part-name
        # rewrite of the stream payload.
        import json as json_module

        fallback_body = json_module.loads(requests[1].content)
        expected_image = _i2i_payload()["parameters"]["image"]
        self.assertEqual(fallback_body["parameters"]["image"], expected_image)

    async def test_transport_error_falls_back_to_json_zip(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            if request.url.path == _STREAM_PATH:
                raise httpx.ConnectError("stream endpoint unreachable")
            return httpx.Response(200, content=_zip_bytes(b"FALLBACK-IMAGE"))

        pool = self._pool(handler)
        try:
            image = await generate_image_from_payload_stream(
                settings=_settings(),
                payload=_i2i_payload(),
                http=pool,
                outbound_policy=_policy(),
            )
        finally:
            await pool.close()

        self.assertEqual(image, b"FALLBACK-IMAGE")
        self.assertEqual([r.url.path for r in requests], [_STREAM_PATH, _ZIP_PATH])

    async def test_midstream_timeout_is_terminal_without_fallback(self) -> None:
        requests: list[httpx.Request] = []

        async def content():
            yield _frame({"step_ix": 0, "image": b"STEP-1"})
            raise httpx.ReadTimeout("read timed out")

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            if request.url.path == _STREAM_PATH:
                return httpx.Response(200, content=content())
            return httpx.Response(200, content=_zip_bytes(b"NEVER"))

        pool = self._pool(handler)
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

    async def test_empty_stream_falls_back_to_json_zip(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            if request.url.path == _STREAM_PATH:
                return httpx.Response(200, content=b"")
            return httpx.Response(200, content=_zip_bytes(b"FALLBACK-IMAGE"))

        pool = self._pool(handler)
        try:
            image = await generate_image_from_payload_stream(
                settings=_settings(),
                payload=_i2i_payload(),
                http=pool,
                outbound_policy=_policy(),
            )
        finally:
            await pool.close()

        self.assertEqual(image, b"FALLBACK-IMAGE")
        self.assertEqual([r.url.path for r in requests], [_STREAM_PATH, _ZIP_PATH])

    async def test_half_packets_split_across_chunks_still_decode(self) -> None:
        frames = (
            _frame({"step_ix": 0, "image": b"A" * 64})
            + _frame({"step_ix": 1, "image": b"B" * 64})
            + _frame({"image": b"FINAL"})
        )
        # Byte-sized fragments cut every frame -- including its length prefix --
        # into halves, exercising the incremental framing buffer.
        fragments = _split(frames, 7)

        async def content():
            for fragment in fragments:
                yield fragment

        async def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=content())

        progress: list[float] = []

        async def on_progress(value: float) -> None:
            progress.append(value)

        pool = self._pool(handler)
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
        self.assertEqual(progress, [1 / 28, 2 / 28, 1.0])

    async def test_cancellation_propagates_and_closes_the_stream(self) -> None:
        progress_seen = asyncio.Event()
        generator_finalized = asyncio.Event()

        async def content():
            try:
                yield _frame({"step_ix": 0, "image": b"STEP-1"})
                await asyncio.Event().wait()
            finally:
                generator_finalized.set()

        async def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=content())

        async def on_progress(value: float) -> None:
            progress_seen.set()

        pool = self._pool(handler)
        try:
            task = asyncio.create_task(
                generate_image_from_payload_stream(
                    settings=_settings(),
                    payload=_i2i_payload(),
                    http=pool,
                    outbound_policy=_policy(),
                    on_progress=on_progress,
                )
            )
            await asyncio.wait_for(progress_seen.wait(), timeout=5.0)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertTrue(generator_finalized.is_set())
        finally:
            await pool.close()

    async def test_missing_token_is_rejected_before_any_request(self) -> None:
        async def handler(request: httpx.Request) -> httpx.Response:
            raise AssertionError("no request may leave the process without a token")

        pool = self._pool(handler)
        try:
            from sidecar.nai.client import NovelAIError

            with self.assertRaises(NovelAIError):
                await generate_image_from_payload_stream(
                    settings=_settings(""),
                    payload=_i2i_payload(),
                    http=pool,
                    outbound_policy=_policy(),
                )
        finally:
            await pool.close()


if __name__ == "__main__":
    unittest.main()
