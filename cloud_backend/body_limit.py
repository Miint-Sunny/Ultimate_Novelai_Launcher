"""ASGI request-size enforcement based on bytes actually received."""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable, Mapping
from typing import Any

ASGIMessage = dict[str, Any]
Receive = Callable[[], Awaitable[ASGIMessage]]
Send = Callable[[ASGIMessage], Awaitable[None]]
ASGIApp = Callable[[dict[str, Any], Receive, Send], Awaitable[None]]


class StreamingBodyLimitMiddleware:
    """Reject oversized chunked bodies even without a Content-Length header."""

    def __init__(
        self,
        app: ASGIApp,
        *,
        default_limit: int,
        path_limits: Mapping[str, int] | None = None,
    ) -> None:
        if default_limit < 0:
            raise ValueError("default body limit must be non-negative")
        self.app = app
        self.default_limit = default_limit
        self.path_limits = dict(path_limits or {})
        if any(not path.startswith("/") or limit < 0 for path, limit in self.path_limits.items()):
            raise ValueError("path limits must use absolute paths and non-negative sizes")

    def limit_for(self, path: str) -> int:
        matches = [
            (len(prefix), limit)
            for prefix, limit in self.path_limits.items()
            if path == prefix.rstrip("/") or path.startswith(prefix.rstrip("/") + "/")
        ]
        return max(matches, default=(0, self.default_limit), key=lambda item: item[0])[1]

    async def __call__(self, scope: dict[str, Any], receive: Receive, send: Send) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        limit = self.limit_for(str(scope.get("path", "/")))
        declared = self._content_length(scope)
        if declared is not None and declared > limit:
            await self._reject(send, limit)
            return

        # Starlette converts exceptions raised by ``receive`` while parsing a body
        # into a generic 400 response.  Buffering up to the configured hard limit
        # before entering the framework is the only reliable way for this outer
        # ASGI boundary to preserve a deterministic 413 for chunked requests.
        received = 0
        buffered: list[ASGIMessage] = []
        while True:
            message = await receive()
            buffered.append(message)
            if message.get("type") != "http.request":
                break
            body = message.get("body", b"")
            if not isinstance(body, (bytes, bytearray, memoryview)):
                await self._reject(send, limit)
                return
            received += len(body)
            if received > limit:
                await self._reject(send, limit)
                return
            if not message.get("more_body", False):
                break

        index = 0

        async def replay_receive() -> ASGIMessage:
            nonlocal index
            if index < len(buffered):
                message = buffered[index]
                index += 1
                return message
            return await receive()

        await self.app(scope, replay_receive, send)

    @staticmethod
    def _content_length(scope: Mapping[str, Any]) -> int | None:
        values: list[bytes] = []
        for name, value in scope.get("headers", []):
            if bytes(name).lower() == b"content-length":
                values.append(bytes(value))
        if not values:
            return None
        if len(values) != 1 or not values[0].isdigit():
            # Treat ambiguous framing as oversized so the application never reads it.
            return 2**63 - 1
        return int(values[0])

    @staticmethod
    async def _reject(send: Send, limit: int) -> None:
        body = json.dumps(
            {
                "detail": "request body is too large",
                "code": "request_body_too_large",
                "limit": limit,
            },
            separators=(",", ":"),
        ).encode("utf-8")
        await send(
            {
                "type": "http.response.start",
                "status": 413,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode("ascii")),
                    (b"cache-control", b"no-store"),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body, "more_body": False})
