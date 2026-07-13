from __future__ import annotations

import json
from typing import Any

import pytest

from sidecar.api.auth_middleware import SidecarAuthMiddleware
from sidecar.security import AuthManager


def _scope(path: str, *, method: str = "GET", authorization: str | None = None) -> dict[str, Any]:
    headers = []
    if authorization is not None:
        headers.append((b"authorization", authorization.encode()))
    return {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "headers": headers,
        "client": ("127.0.0.1", 1234),
        "server": ("127.0.0.1", 80),
        "state": {"request_id": "a" * 32},
    }


async def _invoke(scope: dict[str, Any]) -> tuple[bool, list[dict[str, Any]]]:
    called = False
    messages: list[dict[str, Any]] = []

    async def app(_scope, _receive, send):  # type: ignore[no-untyped-def]
        nonlocal called
        called = True
        await send({"type": "http.response.start", "status": 204, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    async def receive():  # type: ignore[no-untyped-def]
        raise AssertionError("authentication middleware consumed the request body")

    async def send(message):  # type: ignore[no-untyped-def]
        messages.append(dict(message))

    middleware = SidecarAuthMiddleware(app, manager=AuthManager("process-token"))
    await middleware(scope, receive, send)  # type: ignore[arg-type]
    return called, messages


@pytest.mark.asyncio
async def test_v1_rejects_legacy_header_and_returns_problem_details() -> None:
    called, messages = await _invoke(_scope("/api/v1/settings"))
    assert not called
    assert messages[0]["status"] == 401
    headers = dict(messages[0]["headers"])
    assert headers[b"content-type"].startswith(b"application/problem+json")
    payload = json.loads(messages[1]["body"])
    assert payload["code"] == "authentication_failed"
    assert payload["request_id"] == "a" * 32


@pytest.mark.asyncio
async def test_private_bearer_and_public_routes_pass_without_reading_body() -> None:
    called, messages = await _invoke(
        _scope("/api/v1/settings", authorization="Bearer process-token")
    )
    assert called and messages[0]["status"] == 204

    for scope in (
        _scope("/livez"),
        _scope("/api/v1/auth/pair/exchange", method="POST"),
        _scope("/api/v1/settings", method="OPTIONS"),
    ):
        called, messages = await _invoke(scope)
        assert called and messages[0]["status"] == 204


@pytest.mark.asyncio
async def test_compat_route_keeps_one_release_legacy_header_support() -> None:
    scope = _scope("/settings")
    scope["headers"] = [(b"x-sidecar-auth", b"process-token")]
    called, messages = await _invoke(scope)
    assert called and messages[0]["status"] == 204
