from __future__ import annotations

from typing import Any

import pytest

from cloud_backend.rate_limit import RateLimitMiddleware, RateLimitRule


class _Clock:
    """Manually advanced monotonic clock so window expiry is deterministic."""

    def __init__(self) -> None:
        self.now = 1_000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


async def _ok_app(scope, receive, send) -> None:
    await send({"type": "http.response.start", "status": 204, "headers": []})
    await send({"type": "http.response.body", "body": b"", "more_body": False})


def _scope(
    path: str = "/api/thing",
    *,
    method: str = "GET",
    headers: list[tuple[bytes, bytes]] | None = None,
    client: tuple[str, int] | None = ("203.0.113.7", 44444),
    query: bytes = b"",
) -> dict[str, Any]:
    return {
        "type": "http",
        "method": method,
        "path": path,
        "headers": list(headers or []),
        "client": client,
        "query_string": query,
    }


async def _call(middleware: RateLimitMiddleware, scope: dict[str, Any]) -> list[dict[str, Any]]:
    sent: list[dict[str, Any]] = []

    async def receive() -> dict[str, Any]:
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    await middleware(scope, receive, send)
    return sent


def _status(sent: list[dict[str, Any]]) -> int:
    return int(sent[0]["status"])


def _header(sent: list[dict[str, Any]], name: bytes) -> bytes | None:
    for key, value in sent[0]["headers"]:
        if key == name:
            return value
    return None


def _build(**kwargs: Any) -> RateLimitMiddleware:
    kwargs.setdefault("default_rule", RateLimitRule(limit=2, window_seconds=60))
    return RateLimitMiddleware(_ok_app, **kwargs)


def test_rule_validation_rejects_impossible_budgets() -> None:
    with pytest.raises(ValueError, match="at least one request"):
        RateLimitRule(limit=0, window_seconds=60)
    with pytest.raises(ValueError, match="window must be positive"):
        RateLimitRule(limit=1, window_seconds=0)


def test_middleware_configuration_is_validated() -> None:
    rule = RateLimitRule(limit=1, window_seconds=60)
    with pytest.raises(ValueError, match="absolute paths"):
        RateLimitMiddleware(_ok_app, default_rule=rule, path_rules={"api": rule})
    with pytest.raises(ValueError, match="exempt paths must be absolute"):
        RateLimitMiddleware(_ok_app, default_rule=rule, exempt_paths=("health",))
    with pytest.raises(ValueError, match="max_tracked_keys must be positive"):
        RateLimitMiddleware(_ok_app, default_rule=rule, max_tracked_keys=0)


def test_longest_path_prefix_wins() -> None:
    tight = RateLimitRule(limit=1, window_seconds=60)
    middleware = _build(path_rules={"/api": tight, "/api/vibes/upload/": tight})
    assert middleware.rule_for("/other") == ("*", middleware.default_rule)
    assert middleware.rule_for("/api")[0] == "/api"
    assert middleware.rule_for("/api/vibes/upload/one")[0] == "/api/vibes/upload"
    # A prefix must match on a path segment, never mid-word.
    assert middleware.rule_for("/apifoo") == ("*", middleware.default_rule)


@pytest.mark.asyncio
async def test_requests_beyond_the_budget_are_rejected_with_retry_after() -> None:
    clock = _Clock()
    middleware = _build(clock=clock)
    headers = [(b"x-bot-session", b"session-value")]

    assert _status(await _call(middleware, _scope(headers=headers))) == 204
    assert _status(await _call(middleware, _scope(headers=headers))) == 204

    blocked = await _call(middleware, _scope(headers=headers))
    assert _status(blocked) == 429
    assert _header(blocked, b"retry-after") == b"60"
    assert _header(blocked, b"cache-control") == b"no-store"

    # The window slides: once the oldest hit ages out the caller is served again.
    clock.advance(61)
    assert _status(await _call(middleware, _scope(headers=headers))) == 204


@pytest.mark.asyncio
async def test_path_classes_and_identities_hold_independent_budgets() -> None:
    middleware = _build(path_rules={"/api/generate": RateLimitRule(limit=1, window_seconds=60)})
    first = [(b"x-bot-session", b"session-one")]
    second = [(b"x-bot-session", b"session-two")]

    assert _status(await _call(middleware, _scope("/api/generate", headers=first))) == 204
    assert _status(await _call(middleware, _scope("/api/generate", headers=first))) == 429
    # Exhausting the generate budget must not touch the polling budget.
    assert _status(await _call(middleware, _scope("/api/tasks", headers=first))) == 204
    # A different caller keeps its own allowance.
    assert _status(await _call(middleware, _scope("/api/generate", headers=second))) == 204


@pytest.mark.asyncio
async def test_identity_precedence_and_credential_fingerprinting() -> None:
    middleware = _build()
    session_scope = _scope(headers=[(b"x-bot-session", b"abc")])
    bearer_scope = _scope(headers=[(b"authorization", b"Bearer abc")])
    compat_scope = _scope(query=b"session_id=abc")

    session_key = middleware.identity_for(session_scope)
    bearer_key = middleware.identity_for(bearer_scope)
    compat_key = middleware.identity_for(compat_scope)

    assert session_key is not None and session_key.startswith("session:")
    assert bearer_key is not None and bearer_key.startswith("bearer:")
    # The compat query credential lands in the same namespace as the header.
    assert compat_key == session_key
    # Raw credentials are never retained in a bucket key.
    assert "abc" not in session_key
    assert "abc" not in bearer_key

    # A header credential outranks both the bearer token and the compat query.
    mixed = _scope(
        headers=[(b"x-bot-session", b"abc"), (b"authorization", b"Bearer other")],
        query=b"session_id=other",
    )
    assert middleware.identity_for(mixed) == session_key

    # Ambiguous duplicate headers fall through to the address bucket.
    duplicated = _scope(headers=[(b"x-bot-session", b"one"), (b"x-bot-session", b"two")])
    assert middleware.identity_for(duplicated) == "ip:203.0.113.7"


@pytest.mark.asyncio
async def test_preflight_health_and_non_http_scopes_are_never_throttled() -> None:
    middleware = _build(
        default_rule=RateLimitRule(limit=1, window_seconds=60),
        exempt_paths=("/health",),
    )
    headers = [(b"x-bot-session", b"session-value")]

    for _ in range(5):
        preflight = await _call(middleware, _scope(method="OPTIONS", headers=headers))
        assert _status(preflight) == 204
    for _ in range(5):
        assert _status(await _call(middleware, _scope("/health", headers=headers))) == 204

    seen = False

    async def websocket_app(scope, receive, send) -> None:
        nonlocal seen
        seen = True

    async def receive() -> dict[str, Any]:
        return {"type": "websocket.receive"}

    async def send(message: dict[str, Any]) -> None:
        return None

    middleware.app = websocket_app
    await middleware({"type": "websocket"}, receive, send)
    assert seen is True


@pytest.mark.asyncio
async def test_forwarded_for_is_only_trusted_from_a_configured_proxy() -> None:
    spoofed = [(b"x-forwarded-for", b"198.51.100.9")]

    # A direct caller controls the header, so it must be ignored entirely.
    direct = _build()
    assert direct.client_address(_scope(headers=spoofed)) == "203.0.113.7"

    # Behind a declared proxy the right-most non-proxy entry is the caller.
    proxied = _build(trusted_proxies=("203.0.113.7/32", "10.0.0.0/8"))
    chained = _scope(headers=[(b"x-forwarded-for", b"198.51.100.9, 10.0.0.4")])
    assert proxied.client_address(chained) == "198.51.100.9"
    # An unparseable chain degrades to the peer rather than inventing an identity.
    assert proxied.client_address(_scope(headers=[(b"x-forwarded-for", b"junk")])) == "203.0.113.7"


@pytest.mark.asyncio
async def test_indistinguishable_anonymous_callers_are_not_bucketed_together() -> None:
    middleware = _build(default_rule=RateLimitRule(limit=1, window_seconds=60))

    # Every caller behind an unconfigured reverse proxy arrives from loopback.
    # Throttling them as one identity would take the deployment down, so the
    # address bucket is skipped until trusted proxies are configured.
    loopback = _scope(client=("127.0.0.1", 5000))
    assert middleware.identity_for(loopback) is None
    for _ in range(4):
        assert _status(await _call(middleware, loopback)) == 204

    # Missing or non-address peers are equally indistinguishable.
    assert middleware.identity_for(_scope(client=None)) is None
    assert middleware.identity_for(_scope(client=("testclient", 0))) is None

    # Once the proxy is declared, loopback is a real bucket again.
    configured = _build(
        default_rule=RateLimitRule(limit=1, window_seconds=60),
        trusted_proxies=("192.0.2.0/24",),
    )
    assert configured.identity_for(loopback) == "ip:127.0.0.1"

    # A routable anonymous caller is always bucketed.
    assert _status(await _call(middleware, _scope())) == 204
    assert _status(await _call(middleware, _scope())) == 429


@pytest.mark.asyncio
async def test_tracked_identities_stay_bounded() -> None:
    middleware = _build(max_tracked_keys=3)
    for index in range(10):
        scope = _scope(headers=[(b"x-bot-session", f"session-{index}".encode())])
        assert _status(await _call(middleware, scope)) == 204
    assert len(middleware._buckets) <= 3


@pytest.mark.asyncio
async def test_rotating_a_forged_session_cannot_escape_the_address_ceiling() -> None:
    """轮换未认证的 X-Bot-Session 曾经等于无限额度:每个随机值都是新桶。"""

    clock = _Clock()
    # 每身份 2 次/60s,地址上限 = 2 * 3 = 6 次/60s。
    middleware = _build(clock=clock, address_ceiling_multiplier=3)

    statuses = []
    for index in range(8):
        # 每个请求换一个全新的会话值 —— 身份桶永远是空的。
        forged = f"forged-session-{index}".encode()
        statuses.append(
            _status(await _call(middleware, _scope(headers=[(b"x-bot-session", forged)])))
        )

    # 前 6 次吃满地址上限,之后被拦下 —— 而不是 8 次全放行。
    assert statuses[:6] == [204] * 6
    assert statuses[6:] == [429, 429]


@pytest.mark.asyncio
async def test_address_ceiling_is_looser_than_one_identity_budget() -> None:
    """同一出口 IP 后的多个诚实用户不该被当成一个人限流。"""

    clock = _Clock()
    middleware = _build(clock=clock, address_ceiling_multiplier=3)

    # 三个不同身份、同一个 IP,各自用满自己的 2 次预算 = 6 次,都应放行。
    for user in range(3):
        session = f"honest-user-{user}".encode()
        for _ in range(2):
            sent = await _call(middleware, _scope(headers=[(b"x-bot-session", session)]))
            assert _status(sent) == 204

    # 第 4 个用户此时才撞上地址上限(而不是撞自己的预算)。
    sent = await _call(middleware, _scope(headers=[(b"x-bot-session", b"honest-user-3")]))
    assert _status(sent) == 429

    # 窗口过去后恢复。
    clock.advance(61)
    sent = await _call(middleware, _scope(headers=[(b"x-bot-session", b"honest-user-3")]))
    assert _status(sent) == 204


@pytest.mark.asyncio
async def test_anonymous_caller_is_not_charged_to_two_buckets() -> None:
    """无凭据时身份桶本身就是地址桶,不能重复扣两次额度。"""

    clock = _Clock()
    middleware = _build(clock=clock)

    assert _status(await _call(middleware, _scope())) == 204
    assert _status(await _call(middleware, _scope())) == 204
    # 预算是 2:第三次才该被拒(若重复扣费,第二次就会 429)。
    assert _status(await _call(middleware, _scope())) == 429


def test_address_ceiling_multiplier_is_validated() -> None:
    with pytest.raises(ValueError):
        _build(address_ceiling_multiplier=0)
