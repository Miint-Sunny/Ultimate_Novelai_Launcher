from __future__ import annotations

from typing import Any

import pytest

from cloud_backend.body_limit import StreamingBodyLimitMiddleware


async def _invoke(
    middleware: StreamingBodyLimitMiddleware,
    scope: dict[str, Any],
    messages: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    sent: list[dict[str, Any]] = []
    seen: list[dict[str, Any]] = []

    async def receive() -> dict[str, Any]:
        return messages.pop(0)

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    async def app(app_scope, app_receive, app_send) -> None:
        seen.append(await app_receive())
        if messages:
            seen.append(await app_receive())
        await app_send({"type": "http.response.start", "status": 204, "headers": []})

    middleware.app = app
    await middleware(scope, receive, send)
    return sent, seen


def test_body_limit_configuration_and_longest_path_prefix() -> None:
    async def app(scope, receive, send) -> None:
        return None

    with pytest.raises(ValueError, match="non-negative"):
        StreamingBodyLimitMiddleware(app, default_limit=-1)
    with pytest.raises(ValueError, match="absolute"):
        StreamingBodyLimitMiddleware(app, default_limit=1, path_limits={"relative": 1})
    with pytest.raises(ValueError, match="absolute"):
        StreamingBodyLimitMiddleware(app, default_limit=1, path_limits={"/api": -1})

    middleware = StreamingBodyLimitMiddleware(
        app,
        default_limit=100,
        path_limits={"/api": 50, "/api/settings/": 10},
    )
    assert middleware.limit_for("/other") == 100
    assert middleware.limit_for("/api") == 50
    assert middleware.limit_for("/api/settings/key") == 10


@pytest.mark.asyncio
async def test_non_http_scope_passes_through_unchanged() -> None:
    called = False

    async def app(scope, receive, send) -> None:
        nonlocal called
        called = True

    middleware = StreamingBodyLimitMiddleware(app, default_limit=1)

    async def receive() -> dict[str, Any]:
        return {"type": "websocket.receive"}

    async def send(message: dict[str, Any]) -> None:
        return None

    await middleware({"type": "websocket"}, receive, send)
    assert called is True


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "headers",
    [
        [(b"content-length", b"2")],
        [(b"content-length", b"1"), (b"Content-Length", b"1")],
        [(b"content-length", b"invalid")],
    ],
)
async def test_declared_oversize_or_ambiguous_length_is_rejected(headers) -> None:
    async def app(scope, receive, send) -> None:
        raise AssertionError("application must not run")

    sent: list[dict[str, Any]] = []

    async def receive() -> dict[str, Any]:
        raise AssertionError("body must not be read")

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    middleware = StreamingBodyLimitMiddleware(app, default_limit=1)
    await middleware({"type": "http", "path": "/", "headers": headers}, receive, send)
    assert sent[0]["status"] == 413


@pytest.mark.asyncio
async def test_stream_rejects_non_bytes_and_replays_buffered_messages() -> None:
    middleware = StreamingBodyLimitMiddleware(
        lambda scope, receive, send: None,  # replaced by helper
        default_limit=5,
    )
    sent, _ = await _invoke(
        middleware,
        {"type": "http", "path": "/", "headers": []},
        [{"type": "http.request", "body": "text", "more_body": False}],
    )
    assert sent[0]["status"] == 413

    sent, seen = await _invoke(
        middleware,
        {"type": "http", "path": "/", "headers": []},
        [
            {"type": "http.request", "body": memoryview(b"ok"), "more_body": False},
            {"type": "http.disconnect"},
        ],
    )
    assert sent[0]["status"] == 204
    assert [message["type"] for message in seen] == ["http.request", "http.disconnect"]


@pytest.mark.asyncio
async def test_non_request_message_is_buffered_and_forwarded() -> None:
    middleware = StreamingBodyLimitMiddleware(
        lambda scope, receive, send: None,
        default_limit=5,
    )
    sent, seen = await _invoke(
        middleware,
        {"type": "http", "path": "/", "headers": []},
        [{"type": "http.disconnect"}],
    )
    assert sent[0]["status"] == 204
    assert seen == [{"type": "http.disconnect"}]
