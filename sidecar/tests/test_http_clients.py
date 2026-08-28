from __future__ import annotations

import asyncio
import unittest

import httpx

from sidecar.infrastructure import (
    HttpClientPool,
    request_with_policy,
    streaming_request_with_policy,
)
from sidecar.security import OutboundPolicy, OutboundPolicyError


class _Resolver:
    def __init__(self, answers: dict[str, list[str]]) -> None:
        self.answers = answers
        self.calls: list[tuple[str, int]] = []

    def __call__(self, host: str, port: int) -> list[str]:
        self.calls.append((host, port))
        return self.answers[host]


class PolicyAwareHttpClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_redirects_are_revalidated_and_drop_cross_origin_credentials(self) -> None:
        resolver = _Resolver(
            {
                "first.example": ["93.184.216.34"],
                "second.example": ["93.184.216.35"],
            }
        )
        policy = OutboundPolicy("public", resolver=resolver)
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            if request.url.host == "first.example":
                return httpx.Response(
                    307,
                    headers={"Location": "https://second.example/final"},
                )
            return httpx.Response(200, json={"ok": True})

        client = httpx.AsyncClient(
            headers={"X-Api-Key": "client-default-secret"},
            transport=httpx.MockTransport(handler),
        )
        try:
            response = await request_with_policy(
                client,
                policy,
                "POST",
                "https://first.example/start",
                headers={
                    "Authorization": "Bearer top-secret",
                    "Content-Type": "application/json",
                    "X-Goog-Api-Key": "gemini-secret",
                },
                json={"prompt": "cat"},
            )
        finally:
            await client.aclose()

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(requests), 2)
        self.assertEqual(requests[0].headers["authorization"], "Bearer top-secret")
        self.assertEqual(requests[0].headers["x-api-key"], "client-default-secret")
        self.assertNotIn("authorization", requests[1].headers)
        self.assertNotIn("x-api-key", requests[1].headers)
        self.assertNotIn("x-goog-api-key", requests[1].headers)
        self.assertEqual(requests[1].method, "POST")
        self.assertEqual(requests[1].content, requests[0].content)
        self.assertEqual(
            resolver.calls,
            [
                ("first.example", 443),
                ("first.example", 443),
                ("second.example", 443),
            ],
        )

    async def test_forbidden_redirect_is_rejected_before_the_next_request(self) -> None:
        resolver = _Resolver(
            {
                "public.example": ["93.184.216.34"],
                "metadata.example": ["169.254.169.254"],
            }
        )
        calls = 0

        async def handler(_request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            return httpx.Response(
                302,
                headers={"Location": "http://metadata.example/latest"},
            )

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            with self.assertRaises(OutboundPolicyError):
                await request_with_policy(
                    client,
                    OutboundPolicy("public", resolver=resolver),
                    "GET",
                    "https://public.example/start",
                )
        self.assertEqual(calls, 1)

    async def test_cancellation_reaches_the_active_transport(self) -> None:
        started = asyncio.Event()
        cancelled = asyncio.Event()

        async def handler(_request: httpx.Request) -> httpx.Response:
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()
            raise AssertionError("cancellation handler unexpectedly resumed")

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        try:
            task = asyncio.create_task(
                request_with_policy(
                    client,
                    OutboundPolicy("loopback"),
                    "POST",
                    "http://127.0.0.1:8080/generate",
                    json={"prompt": "cat"},
                )
            )
            await asyncio.wait_for(started.wait(), timeout=1)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            await asyncio.wait_for(cancelled.wait(), timeout=1)
        finally:
            await client.aclose()

    async def test_pool_reuses_and_closes_lifecycle_owned_clients(self) -> None:
        default = httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200)))
        long_running = httpx.AsyncClient(
            transport=httpx.MockTransport(lambda _: httpx.Response(200))
        )
        pool = HttpClientPool(
            default_client=default,
            long_running_client=long_running,
        )

        self.assertIs(pool.default, pool.default)
        self.assertIs(pool.long_running, pool.long_running)
        await pool.close()
        self.assertTrue(default.is_closed)
        self.assertTrue(long_running.is_closed)

    async def test_pool_dials_the_policy_approved_ip_without_resolving_again(self) -> None:
        request_received = asyncio.Event()

        async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            try:
                await reader.readuntil(b"\r\n\r\n")
                request_received.set()
                writer.write(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"
                )
                await writer.drain()
            finally:
                writer.close()
                await writer.wait_closed()

        server = await asyncio.start_server(handle, "127.0.0.1", 0)
        port = int(server.sockets[0].getsockname()[1])
        resolver = _Resolver({"approved.invalid": ["127.0.0.1"]})
        pool = HttpClientPool()
        try:
            response = await pool.request(
                OutboundPolicy("loopback", resolver=resolver),
                "GET",
                f"http://approved.invalid:{port}/health",
            )
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.text, "ok")
            await asyncio.wait_for(request_received.wait(), timeout=1)
            self.assertEqual(resolver.calls, [("approved.invalid", port)])
        finally:
            await pool.close()
            server.close()
            await server.wait_closed()

    async def test_pool_does_not_reuse_a_socket_across_dns_policy_approvals(self) -> None:
        request_count = 0

        async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            nonlocal request_count
            try:
                while True:
                    await reader.readuntil(b"\r\n\r\n")
                    request_count += 1
                    writer.write(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n"
                        b"Connection: keep-alive\r\n\r\nok"
                    )
                    await writer.drain()
            except (asyncio.IncompleteReadError, ConnectionError):
                pass
            finally:
                writer.close()
                await writer.wait_closed()

        server = await asyncio.start_server(handle, "127.0.0.1", 0)
        port = int(server.sockets[0].getsockname()[1])
        pool = HttpClientPool()
        try:
            first = await pool.request(
                OutboundPolicy(
                    "loopback",
                    resolver=_Resolver({"changing.invalid": ["127.0.0.1"]}),
                ),
                "GET",
                f"http://changing.invalid:{port}/first",
            )
            self.assertEqual(first.status_code, 200)

            # The same origin now validates to a different approved loopback
            # address. Reusing the previous socket would incorrectly return 200.
            with self.assertRaises(httpx.TransportError):
                await pool.request(
                    OutboundPolicy(
                        "loopback",
                        resolver=_Resolver({"changing.invalid": ["127.0.0.2"]}),
                    ),
                    "GET",
                    f"http://changing.invalid:{port}/second",
                    timeout=httpx.Timeout(0.1),
                )
            self.assertEqual(request_count, 1)
        finally:
            await pool.close()
            server.close()
            await server.wait_closed()


class StreamingRequestPolicyTests(unittest.IsolatedAsyncioTestCase):
    async def test_yields_unread_final_response_and_closes_on_exit(self) -> None:
        policy = OutboundPolicy("public", resolver=_Resolver({"one.example": ["93.184.216.34"]}))

        async def content():
            yield b"0123456789"

        async def handler(request: httpx.Request) -> httpx.Response:
            # Iterator-backed content keeps the response genuinely unread until
            # the caller consumes it; plain bytes are pre-buffered by httpx.
            return httpx.Response(200, content=content())

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        try:
            async with streaming_request_with_policy(
                client,
                policy,
                "GET",
                "https://one.example/live",
            ) as response:
                self.assertEqual(response.status_code, 200)
                # The whole point of the streaming helper: the body has not
                # been buffered yet.
                self.assertFalse(response.is_stream_consumed)
                first = await response.aread()
                self.assertEqual(first, b"0123456789")
            self.assertTrue(response.is_closed)
        finally:
            await client.aclose()

    async def test_abandoned_stream_is_closed_without_reading(self) -> None:
        policy = OutboundPolicy("public", resolver=_Resolver({"one.example": ["93.184.216.34"]}))

        async def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, content=b"unused-body")

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        try:
            async with streaming_request_with_policy(
                client,
                policy,
                "GET",
                "https://one.example/live",
            ) as response:
                pass  # consumer loses interest without reading
            # Leaving the context must not leak the unread stream.
            self.assertTrue(response.is_closed)
        finally:
            await client.aclose()

    async def test_streaming_redirects_revalidate_and_strip_cross_origin_credentials(self) -> None:
        resolver = _Resolver(
            {
                "first.example": ["93.184.216.34"],
                "second.example": ["93.184.216.35"],
            }
        )
        policy = OutboundPolicy("public", resolver=resolver)
        requests: list[httpx.Request] = []

        async def final_content():
            yield b"stream-bytes"

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            if request.url.host == "first.example":
                return httpx.Response(
                    307,
                    headers={"Location": "https://second.example/final"},
                )
            return httpx.Response(200, content=final_content())

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        try:
            async with streaming_request_with_policy(
                client,
                policy,
                "POST",
                "https://first.example/start",
                headers={
                    "Authorization": "Bearer top-secret",
                    "Content-Type": "application/json",
                },
                json={"prompt": "cat"},
            ) as response:
                self.assertEqual(response.status_code, 200)
                self.assertFalse(response.is_stream_consumed)
                self.assertEqual(await response.aread(), b"stream-bytes")
        finally:
            await client.aclose()

        self.assertEqual(len(requests), 2)
        self.assertEqual(requests[0].headers["authorization"], "Bearer top-secret")
        self.assertNotIn("authorization", requests[1].headers)
        self.assertEqual(requests[1].method, "POST")
        # The streaming redirect keeps the same content-forwarding contract as
        # the buffered helper (307 preserves method and body).
        self.assertEqual(requests[1].content, requests[0].content)


if __name__ == "__main__":
    unittest.main()
