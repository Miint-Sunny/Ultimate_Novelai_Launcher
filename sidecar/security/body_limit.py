from __future__ import annotations

import json
from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from .errors import RequestBodyError, RequestBodyTooLargeError, SecurityError

Receive = Callable[[], Awaitable[dict[str, Any]]]
Send = Callable[[dict[str, Any]], Awaitable[None]]
ASGIApp = Callable[[dict[str, Any], Receive, Send], Awaitable[None]]

# FastAPI converts exceptions raised while it consumes ``receive`` into a generic
# Starlette HTTP 400 before outer ASGI middleware can observe the original error.
# Preserve only our authoritative size-limit failure in request state so the v1
# adapter can restore its precise 413 contract without guessing from an arbitrary
# body-parsing error.
BODY_LIMIT_ERROR_STATE_KEY = "_sidecar_body_limit_error"


def _validate_limit(value: int | None, label: str) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{label} must be a non-negative integer or None")
    return value


class BodySizeLimitMiddleware:
    """Enforce request limits by counting actual ASGI body chunks.

    ``default_limit`` is the global fallback.  A longest matching path rule can
    select a tighter or larger route tier, and ``hard_limit`` can optionally cap
    every tier.  ``Content-Length`` is only an early rejection optimization; the
    wrapped ``receive`` remains authoritative for missing or dishonest headers.
    """

    def __init__(
        self,
        app: ASGIApp,
        default_limit: int | None = 8 * 1024 * 1024,
        path_limits: Mapping[str, int | None] | None = None,
        *,
        global_limit: int | None = None,
        hard_limit: int | None = None,
    ) -> None:
        self.app = app
        # ``global_limit`` is an explicit alias used by API composition code.
        if global_limit is not None:
            default_limit = global_limit
        self.default_limit = _validate_limit(default_limit, "default_limit")
        self.global_limit = self.default_limit
        self.hard_limit = _validate_limit(hard_limit, "hard_limit")
        self.path_limits: dict[str, int | None] = {}
        for raw_path, raw_limit in (path_limits or {}).items():
            if not isinstance(raw_path, str) or not raw_path.startswith("/"):
                raise ValueError("body-size path rules must start with '/'")
            path = raw_path[:-1] if raw_path.endswith("*") else raw_path
            if not path:
                path = "/"
            self.path_limits[path] = _validate_limit(raw_limit, f"path limit for {raw_path}")

    @staticmethod
    def _path_matches(rule: str, path: str) -> bool:
        if rule == "/":
            return True
        normalized = rule.rstrip("/")
        return path == normalized or path.startswith(normalized + "/")

    def limit_for(self, path: str) -> int | None:
        matches = [
            (len(rule), limit)
            for rule, limit in self.path_limits.items()
            if self._path_matches(rule, path)
        ]
        selected = max(matches, key=lambda item: item[0])[1] if matches else self.default_limit
        if self.hard_limit is None:
            return selected
        if selected is None:
            return self.hard_limit
        return min(selected, self.hard_limit)

    @staticmethod
    def _declared_content_length(scope: dict[str, Any]) -> int | None:
        def header_bytes(value: Any) -> bytes:
            if isinstance(value, bytes):
                return value
            if isinstance(value, bytearray):
                return bytes(value)
            if isinstance(value, str):
                try:
                    return value.encode("latin-1")
                except UnicodeEncodeError as exc:
                    raise RequestBodyError("ASGI request headers are invalid") from exc
            raise RequestBodyError("ASGI request headers must contain bytes")

        values: list[bytes] = []
        try:
            raw_headers = iter(scope.get("headers", []))
        except TypeError as exc:
            raise RequestBodyError("ASGI request headers are invalid") from exc
        for item in raw_headers:
            try:
                name, value = item
            except (TypeError, ValueError) as exc:
                raise RequestBodyError("ASGI request headers are invalid") from exc
            if header_bytes(name).lower() == b"content-length":
                values.append(header_bytes(value))
        if not values:
            return None
        if len(values) != 1:
            raise RequestBodyError("duplicate Content-Length headers are not allowed")
        raw = values[0]
        if not raw or not raw.isdigit():
            raise RequestBodyError("invalid Content-Length header")
        try:
            return int(raw)
        except (ValueError, OverflowError) as exc:  # pragma: no cover - int is generous
            raise RequestBodyError("invalid Content-Length header") from exc

    async def __call__(
        self,
        scope: dict[str, Any],
        receive: Callable[[], Awaitable[dict[str, Any]]],
        send: Callable[[dict[str, Any]], Awaitable[None]],
    ) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        limit = self.limit_for(str(scope.get("path", "/")))
        if limit is None:
            await self.app(scope, receive, send)
            return

        response_started = False

        async def tracked_send(message: dict[str, Any]) -> None:
            nonlocal response_started
            if message.get("type") == "http.response.start":
                response_started = True
            await send(message)

        try:
            declared = self._declared_content_length(scope)
            if declared is not None and declared > limit:
                error = RequestBodyTooLargeError(
                    "request body exceeds the configured limit",
                    details={"limit": limit, "declared": declared},
                )
                _remember_body_limit_error(scope, error)
                raise error

            received = 0

            async def limited_receive() -> dict[str, Any]:
                nonlocal received
                message = await receive()
                if message.get("type") == "http.request":
                    body = message.get("body", b"")
                    if not isinstance(body, (bytes, bytearray, memoryview)):
                        raise RequestBodyError("ASGI request body must contain bytes")
                    received += len(body)
                    if received > limit:
                        error = RequestBodyTooLargeError(
                            "request body exceeds the configured limit",
                            details={"limit": limit, "received": received},
                        )
                        _remember_body_limit_error(scope, error)
                        raise error
                return message

            state = scope.setdefault("state", {})
            if isinstance(state, dict):
                state["body_size_limit"] = limit
            await self.app(scope, limited_receive, tracked_send)
        except (RequestBodyError, RequestBodyTooLargeError) as exc:
            if response_started:
                raise
            await _send_error(send, exc, scope)


def _remember_body_limit_error(
    scope: dict[str, Any],
    error: RequestBodyTooLargeError,
) -> None:
    state = scope.setdefault("state", {})
    if isinstance(state, dict):
        state[BODY_LIMIT_ERROR_STATE_KEY] = error


async def _send_error(
    send: Callable[[dict[str, Any]], Awaitable[None]],
    error: SecurityError,
    scope: dict[str, Any],
) -> None:
    path = str(scope.get("path", "/"))
    if path == "/api/v1" or path.startswith("/api/v1/"):
        state = scope.get("state", {})
        request_id = state.get("request_id") if isinstance(state, dict) else None
        payload: dict[str, Any] = {
            "type": f"urn:ultimate-novelai:problem:{error.code}",
            "title": "Request body too large" if error.status == 413 else "Invalid request body",
            "status": error.status,
            "detail": error.message,
            "request_id": request_id if isinstance(request_id, str) else None,
            "instance": path,
            "code": error.code,
            "retryable": error.retryable,
            "errors": [],
            "context": error.details,
        }
        content_type = b"application/problem+json"
    else:
        payload = {"error": error.to_dict()}
        content_type = b"application/json"
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    await send(
        {
            "type": "http.response.start",
            "status": error.status,
            "headers": [
                (b"content-type", content_type),
                (b"content-length", str(len(body)).encode("ascii")),
                (b"cache-control", b"no-store"),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body, "more_body": False})


# Compatibility alias for callers that prefer the shorter name.
BodyLimitMiddleware = BodySizeLimitMiddleware


__all__ = [
    "BODY_LIMIT_ERROR_STATE_KEY",
    "BodyLimitMiddleware",
    "BodySizeLimitMiddleware",
]
