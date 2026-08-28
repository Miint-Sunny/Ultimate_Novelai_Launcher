from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Mapping
from contextlib import AbstractAsyncContextManager, asynccontextmanager, contextmanager
from contextvars import ContextVar
from ipaddress import IPv4Address, IPv6Address
from typing import Any, cast

import httpcore
import httpx

from sidecar.security import (
    SENSITIVE_REDIRECT_HEADERS,
    OutboundPolicy,
    same_origin,
    strip_sensitive_headers_on_cross_origin,
)

_REDIRECT_STATUS_CODES = frozenset({301, 302, 303, 307, 308})
_CONTENT_HEADERS = frozenset(
    {
        "content-encoding",
        "content-language",
        "content-length",
        "content-location",
        "content-type",
        "transfer-encoding",
    }
)

_ApprovedEndpoint = tuple[
    str,
    int,
    tuple[IPv4Address | IPv6Address, ...],
]
_approved_endpoint: ContextVar[_ApprovedEndpoint | None] = ContextVar(
    "sidecar_approved_outbound_endpoint",
    default=None,
)


def _normalize_connection_host(host: str) -> str:
    return host.rstrip(".").encode("idna").decode("ascii").lower()


@contextmanager
def _approve_endpoint(
    host: str,
    port: int,
    addresses: tuple[IPv4Address | IPv6Address, ...],
):
    token = _approved_endpoint.set((_normalize_connection_host(host), port, addresses))
    try:
        yield
    finally:
        _approved_endpoint.reset(token)


class _PinnedNetworkBackend(httpcore.AsyncNetworkBackend):
    """Connect only to the IP addresses approved for the active request hop.

    Validating a hostname and then letting the HTTP stack resolve it again leaves a
    DNS-rebinding race.  The request context therefore carries the exact addresses
    returned by ``OutboundPolicy`` and this backend dials one of those addresses
    directly.  TLS still receives the original hostname from httpcore, preserving
    SNI and certificate verification.
    """

    def __init__(self) -> None:
        self._backend = cast(httpcore.AsyncNetworkBackend, httpcore.AnyIOBackend())

    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Any = None,
    ) -> httpcore.AsyncNetworkStream:
        approved = _approved_endpoint.get()
        normalized_host = _normalize_connection_host(host)
        if approved is None or approved[0] != normalized_host or approved[1] != port:
            raise httpcore.ConnectError("outbound connection was not approved")

        last_error: Exception | None = None
        for address in approved[2]:
            try:
                return await self._backend.connect_tcp(
                    str(address),
                    port,
                    timeout=timeout,
                    local_address=local_address,
                    socket_options=socket_options,
                )
            except httpcore.ConnectError as exc:
                last_error = exc
        if last_error is not None:
            raise last_error
        raise httpcore.ConnectError("outbound endpoint has no approved address")

    async def connect_unix_socket(
        self,
        path: str,
        timeout: float | None = None,
        socket_options: Any = None,
    ) -> httpcore.AsyncNetworkStream:
        del path, timeout, socket_options
        raise httpcore.ConnectError("Unix sockets are forbidden for outbound HTTP")

    async def sleep(self, seconds: float) -> None:
        await self._backend.sleep(seconds)


class _PinnedAsyncHTTPTransport(httpx.AsyncHTTPTransport):
    """httpx transport whose every connection is pinned to the current DNS approval.

    Keepalive is intentionally disabled for policy-controlled endpoints.  httpcore
    only calls the network backend for a new socket; reusing an origin connection
    after DNS or policy changes would bypass the request's newly approved address
    set.  The lifecycle-owned clients still share TLS/configuration state, while
    each paid upstream request gets a freshly policy-checked socket.
    """

    def __init__(self, *, limits: httpx.Limits) -> None:
        super().__init__(trust_env=False, limits=limits)
        self._pool = httpcore.AsyncConnectionPool(  # pyright: ignore[reportPrivateUsage]
            ssl_context=httpx.create_ssl_context(verify=True, trust_env=False),
            max_connections=limits.max_connections,
            max_keepalive_connections=limits.max_keepalive_connections,
            keepalive_expiry=limits.keepalive_expiry,
            network_backend=_PinnedNetworkBackend(),
        )


def _redirect_method(method: str, status_code: int) -> tuple[str, bool]:
    """Match the redirect method semantics used by common HTTP clients."""

    normalized = method.upper()
    if status_code == 303 and normalized != "HEAD":
        return "GET", True
    if status_code in {301, 302} and normalized == "POST":
        return "GET", True
    return normalized, False


@asynccontextmanager
async def streaming_request_with_policy(
    client: httpx.AsyncClient,
    policy: OutboundPolicy,
    method: str,
    url: str,
    *,
    headers: Mapping[str, str] | None = None,
    json: Any = None,
    content: bytes | str | None = None,
    timeout: httpx.Timeout | float | None = None,
    max_redirects: int = 5,
) -> AsyncIterator[httpx.Response]:
    """Send one request and yield the final response with its body still streaming.

    Shares the redirect, DNS-approval, and credential-stripping rules of
    ``request_with_policy`` (which is implemented on top of this helper); the
    only difference is that the terminal response is handed over unread so the
    caller can consume it incrementally. Redirect bodies are small control
    responses and are closed eagerly. The context owns the final response's
    close, so an abandoned stream never leaks a connection. Cancellation is not
    shielded: cancelling the caller propagates into the transfer and cleanup.
    """

    if max_redirects < 0:
        raise ValueError("max_redirects cannot be negative")
    approved_hop = await asyncio.to_thread(policy.validate_url, url)
    current_url = str(approved_hop)
    current_method = method.upper()
    current_headers = dict(headers or {})
    current_json = json
    current_content = content
    credentials_stripped = False
    response: httpx.Response | None = None
    try:
        for redirects_followed in range(max_redirects + 1):
            request_kwargs: dict[str, Any] = {"headers": current_headers}
            if current_json is not None:
                request_kwargs["json"] = current_json
            elif current_content is not None:
                request_kwargs["content"] = current_content
            if timeout is not None:
                request_kwargs["timeout"] = timeout

            request = client.build_request(
                current_method,
                current_url,
                **request_kwargs,
            )
            if credentials_stripped:
                # ``build_request`` merges client defaults and the cookie jar after
                # our explicit headers. Strip those implicit credentials too.
                for header in SENSITIVE_REDIRECT_HEADERS - {"host"}:
                    request.headers.pop(header, None)
            with _approve_endpoint(
                approved_hop.host,
                approved_hop.port,
                approved_hop.addresses,
            ):
                response = await client.send(
                    request,
                    stream=True,
                    follow_redirects=False,
                )
            location = response.headers.get("location")
            if response.status_code not in _REDIRECT_STATUS_CODES or not location:
                yield response
                return

            if redirects_followed >= max_redirects:
                raise httpx.TooManyRedirects(
                    "maximum redirect count exceeded",
                    request=response.request,
                )

            try:
                approved_hop = await asyncio.to_thread(
                    policy.validate_redirect,
                    current_url,
                    location,
                )
                destination = str(approved_hop)
                if not same_origin(current_url, destination):
                    credentials_stripped = True
                redirected_headers = strip_sensitive_headers_on_cross_origin(
                    current_headers,
                    current_url,
                    destination,
                )
                current_headers = {
                    str(name): str(value)
                    for name, value in redirected_headers.items()
                }
                current_method, drop_content = _redirect_method(
                    current_method,
                    response.status_code,
                )
                if drop_content:
                    current_json = None
                    current_content = None
                    current_headers = {
                        name: value
                        for name, value in current_headers.items()
                        if name.casefold() not in _CONTENT_HEADERS
                    }
                current_url = destination
            finally:
                await response.aclose()
                response = None
        raise AssertionError("redirect loop terminated unexpectedly")
    finally:
        if response is not None and not response.is_closed:
            await response.aclose()


async def request_with_policy(
    client: httpx.AsyncClient,
    policy: OutboundPolicy,
    method: str,
    url: str,
    *,
    headers: Mapping[str, str] | None = None,
    json: Any = None,
    content: bytes | str | None = None,
    timeout: httpx.Timeout | float | None = None,
    max_redirects: int = 5,
) -> httpx.Response:
    """Send one request while validating the initial URL and every redirect.

    Redirect handling is deliberately kept outside httpx so each hop gets a
    fresh DNS policy check and credentials cannot be copied to another origin.
    Cancellation is not shielded: cancelling the caller immediately propagates
    into httpx and its transport.
    """

    async with streaming_request_with_policy(
        client,
        policy,
        method,
        url,
        headers=headers,
        json=json,
        content=content,
        timeout=timeout,
        max_redirects=max_redirects,
    ) as response:
        # Buffer eagerly so callers get the same fully-read response this
        # wrapper has always returned; the stream stays closed afterwards.
        await response.aread()
        return response


class HttpClientPool:
    """Lifecycle-owned outbound pools; credentials are supplied per request."""

    def __init__(
        self,
        *,
        default_client: httpx.AsyncClient | None = None,
        long_running_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._default = default_client
        self._long_running = long_running_client

    @property
    def default(self) -> httpx.AsyncClient:
        if self._default is None or self._default.is_closed:
            limits = httpx.Limits(max_connections=50, max_keepalive_connections=0)
            self._default = httpx.AsyncClient(
                follow_redirects=False,
                limits=limits,
                timeout=httpx.Timeout(30.0, connect=10.0),
                transport=_PinnedAsyncHTTPTransport(limits=limits),
                trust_env=False,
            )
        return self._default

    @property
    def long_running(self) -> httpx.AsyncClient:
        if self._long_running is None or self._long_running.is_closed:
            limits = httpx.Limits(max_connections=10, max_keepalive_connections=0)
            self._long_running = httpx.AsyncClient(
                follow_redirects=False,
                limits=limits,
                timeout=httpx.Timeout(180.0, connect=20.0),
                transport=_PinnedAsyncHTTPTransport(limits=limits),
                trust_env=False,
            )
        return self._long_running

    async def request(
        self,
        policy: OutboundPolicy,
        method: str,
        url: str,
        *,
        long_running: bool = False,
        headers: Mapping[str, str] | None = None,
        json: Any = None,
        content: bytes | str | None = None,
        timeout: httpx.Timeout | float | None = None,
        max_redirects: int = 5,
    ) -> httpx.Response:
        client = self.long_running if long_running else self.default
        return await request_with_policy(
            client,
            policy,
            method,
            url,
            headers=headers,
            json=json,
            content=content,
            timeout=timeout,
            max_redirects=max_redirects,
        )

    def streaming_request(
        self,
        policy: OutboundPolicy,
        method: str,
        url: str,
        *,
        long_running: bool = False,
        headers: Mapping[str, str] | None = None,
        json: Any = None,
        content: bytes | str | None = None,
        timeout: httpx.Timeout | float | None = None,
        max_redirects: int = 5,
    ) -> AbstractAsyncContextManager[httpx.Response]:
        """Streaming counterpart of ``request``: yields the unread final response.

        Use as an async context manager; the pool picks the same lifecycle
        client the buffered helper would (``long_running`` for paid upstreams)
        and applies the identical outbound policy and redirect rules.
        """
        client = self.long_running if long_running else self.default
        return streaming_request_with_policy(
            client,
            policy,
            method,
            url,
            headers=headers,
            json=json,
            content=content,
            timeout=timeout,
            max_redirects=max_redirects,
        )

    async def close(self) -> None:
        clients = [self._default, self._long_running]
        self._default = None
        self._long_running = None
        for client in clients:
            if client is not None and not client.is_closed:
                await client.aclose()

    stop = close


__all__ = ["HttpClientPool", "request_with_policy", "streaming_request_with_policy"]
