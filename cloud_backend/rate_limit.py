"""Per-identity request rate limiting for the legacy cloud host.

The limiter runs as the outermost ASGI layer so an abusive caller is rejected
before any body is buffered.  Budgets are sliding windows keyed by the strongest
caller identity available -- an authenticated session, then a capability bearer
token, then the client address -- and each path class gets its own budget so
routine polling can never exhaust the allowance for expensive routes.

Credentials are only ever kept as short digests: the limiter never stores or
emits a raw session id or token.
"""

from __future__ import annotations

import hashlib
import json
import math
import time
from collections import OrderedDict, deque
from collections.abc import Awaitable, Callable, Iterable, Mapping
from dataclasses import dataclass
from ipaddress import ip_address, ip_network
from typing import Any
from urllib.parse import parse_qs

ASGIMessage = dict[str, Any]
Receive = Callable[[], Awaitable[ASGIMessage]]
Send = Callable[[ASGIMessage], Awaitable[None]]
ASGIApp = Callable[[dict[str, Any], Receive, Send], Awaitable[None]]

_SESSION_HEADER = b"x-bot-session"
_AUTHORIZATION_HEADER = b"authorization"
_FORWARDED_FOR_HEADER = b"x-forwarded-for"
_BEARER_PREFIX = b"bearer "

# Bounds the limiter's own memory so a flood of distinct identities cannot grow
# the process without limit.  Least recently seen identities are dropped first.
_DEFAULT_MAX_TRACKED_KEYS = 20_000


@dataclass(frozen=True)
class RateLimitRule:
    """One sliding-window budget: ``limit`` requests per ``window_seconds``."""

    limit: int
    window_seconds: float

    def __post_init__(self) -> None:
        if self.limit < 1:
            raise ValueError("rate limit must allow at least one request")
        if self.window_seconds <= 0:
            raise ValueError("rate limit window must be positive")


def _fingerprint(value: bytes) -> str:
    """Short, non-reversible label for a credential used only as a bucket key."""

    return hashlib.blake2b(value, digest_size=16).hexdigest()


def _header_values(scope: Mapping[str, Any], name: bytes) -> list[bytes]:
    return [
        bytes(value) for key, value in scope.get("headers", []) if bytes(key).lower() == name
    ]


def _normalized_prefix(path: str) -> str:
    return path.rstrip("/") or "/"


def _matches_prefix(path: str, prefix: str) -> bool:
    normalized = _normalized_prefix(prefix)
    if normalized == "/":
        return True
    return path == normalized or path.startswith(normalized + "/")


class RateLimitMiddleware:
    """Reject callers that exceed their per-path-class sliding-window budget."""

    def __init__(
        self,
        app: ASGIApp,
        *,
        default_rule: RateLimitRule,
        path_rules: Mapping[str, RateLimitRule] | None = None,
        exempt_paths: Iterable[str] = (),
        trusted_proxies: Iterable[str] = (),
        max_tracked_keys: int = _DEFAULT_MAX_TRACKED_KEYS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.app = app
        self.default_rule = default_rule
        self.path_rules = dict(path_rules or {})
        if any(not path.startswith("/") for path in self.path_rules):
            raise ValueError("path rules must use absolute paths")
        self.exempt_paths = tuple(exempt_paths)
        if any(not path.startswith("/") for path in self.exempt_paths):
            raise ValueError("exempt paths must be absolute")
        if max_tracked_keys < 1:
            raise ValueError("max_tracked_keys must be positive")
        self.max_tracked_keys = max_tracked_keys
        self._clock = clock
        self._trusted_proxies = tuple(ip_network(entry, strict=False) for entry in trusted_proxies)
        self._buckets: OrderedDict[str, deque[float]] = OrderedDict()

    def rule_for(self, path: str) -> tuple[str, RateLimitRule]:
        """Resolve the longest matching path class and its budget."""

        matches = [
            (len(_normalized_prefix(prefix)), _normalized_prefix(prefix), rule)
            for prefix, rule in self.path_rules.items()
            if _matches_prefix(path, prefix)
        ]
        if not matches:
            return "*", self.default_rule
        _, prefix, rule = max(matches, key=lambda item: item[0])
        return prefix, rule

    def is_exempt(self, path: str) -> bool:
        return any(_matches_prefix(path, prefix) for prefix in self.exempt_paths)

    def _is_trusted_proxy(self, address: str) -> bool:
        if not address:
            return False
        try:
            parsed = ip_address(address)
        except ValueError:
            return False
        return any(parsed in network for network in self._trusted_proxies)

    def client_address(self, scope: Mapping[str, Any]) -> str:
        """Resolve the caller address, honouring forwarded headers only from proxies.

        ``X-Forwarded-For`` is attacker-controlled on a direct connection, so it is
        consulted only when the peer itself is a configured trusted proxy.  The
        right-most entry that is not itself a trusted proxy is the caller.
        """

        client = scope.get("client")
        peer = str(client[0]) if client else ""
        if not self._is_trusted_proxy(peer):
            return peer
        for raw in reversed(self._forwarded_candidates(scope)):
            try:
                ip_address(raw)
            except ValueError:
                continue
            if not self._is_trusted_proxy(raw):
                return raw
        return peer

    @staticmethod
    def _forwarded_candidates(scope: Mapping[str, Any]) -> list[str]:
        candidates: list[str] = []
        for header in _header_values(scope, _FORWARDED_FOR_HEADER):
            for entry in header.decode("latin-1").split(","):
                cleaned = entry.strip().strip("[]")
                if cleaned:
                    candidates.append(cleaned)
        return candidates

    def identity_for(self, scope: Mapping[str, Any]) -> str | None:
        """Bucket key for one caller, or ``None`` when callers are indistinguishable."""

        sessions = _header_values(scope, _SESSION_HEADER)
        if len(sessions) == 1 and sessions[0].strip():
            return "session:" + _fingerprint(sessions[0].strip())

        authorizations = _header_values(scope, _AUTHORIZATION_HEADER)
        if len(authorizations) == 1:
            raw = authorizations[0].strip()
            if raw[: len(_BEARER_PREFIX)].lower() == _BEARER_PREFIX:
                token = raw[len(_BEARER_PREFIX) :].strip()
                if token:
                    return "bearer:" + _fingerprint(token)

        compat = self._compat_session_id(scope)
        if compat:
            return "session:" + _fingerprint(compat)

        address = self.client_address(scope)
        if not address:
            return None
        try:
            parsed = ip_address(address)
        except ValueError:
            return None
        if parsed.is_loopback and not self._trusted_proxies:
            # Every caller behind an unconfigured reverse proxy arrives from
            # loopback, so an address bucket here would throttle all anonymous
            # users as one.  Configure trusted proxies to restore this budget.
            return None
        return "ip:" + address

    @staticmethod
    def _compat_session_id(scope: Mapping[str, Any]) -> bytes | None:
        raw_query = scope.get("query_string") or b""
        if not raw_query:
            return None
        values = parse_qs(bytes(raw_query).decode("latin-1")).get("session_id") or []
        if len(values) != 1:
            return None
        candidate = values[0].strip()
        return candidate.encode("utf-8") if candidate else None

    def _consume(self, key: str, rule: RateLimitRule) -> float | None:
        """Record one request. Returns ``None`` when allowed, else seconds to wait.

        The whole body runs without awaiting, so the single-threaded event loop
        cannot interleave another request between the read and the write.
        """

        now = self._clock()
        events = self._buckets.get(key)
        if events is None:
            events = deque()
            self._buckets[key] = events
        else:
            self._buckets.move_to_end(key)

        horizon = now - rule.window_seconds
        while events and events[0] <= horizon:
            events.popleft()

        if len(events) >= rule.limit:
            return max(events[0] + rule.window_seconds - now, 0.0)

        events.append(now)
        while len(self._buckets) > self.max_tracked_keys:
            self._buckets.popitem(last=False)
        return None

    async def __call__(self, scope: dict[str, Any], receive: Receive, send: Send) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        # CORS preflight carries no credentials and must never be throttled, or
        # the browser reports an opaque failure instead of the real response.
        if str(scope.get("method", "")).upper() == "OPTIONS":
            await self.app(scope, receive, send)
            return

        path = str(scope.get("path", "/"))
        if self.is_exempt(path):
            await self.app(scope, receive, send)
            return

        identity = self.identity_for(scope)
        if identity is None:
            await self.app(scope, receive, send)
            return

        scope_prefix, rule = self.rule_for(path)
        retry_after = self._consume(f"{scope_prefix}|{identity}", rule)
        if retry_after is None:
            await self.app(scope, receive, send)
            return
        await self._reject(send, rule, retry_after)

    @staticmethod
    async def _reject(send: Send, rule: RateLimitRule, retry_after: float) -> None:
        body = json.dumps(
            {
                "detail": "too many requests",
                "code": "rate_limited",
                "limit": rule.limit,
                "window_seconds": rule.window_seconds,
            },
            separators=(",", ":"),
        ).encode("utf-8")
        await send(
            {
                "type": "http.response.start",
                "status": 429,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode("ascii")),
                    (b"cache-control", b"no-store"),
                    (b"retry-after", str(max(1, math.ceil(retry_after))).encode("ascii")),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body, "more_body": False})


__all__ = ["RateLimitMiddleware", "RateLimitRule"]
