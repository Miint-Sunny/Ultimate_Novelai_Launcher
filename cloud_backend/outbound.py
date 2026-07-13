"""DNS-pinned, redirect-aware HTTP for user-configured legacy endpoints."""

from __future__ import annotations

import ipaddress
import json
import socket
from collections.abc import Awaitable, Callable, Iterable, Mapping
from dataclasses import dataclass
from typing import Any, Protocol, cast
from urllib.parse import urljoin, urlsplit

import aiohttp
from aiohttp.abc import AbstractResolver, ResolveResult

from .errors import InvalidRequestError

IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address
Resolver = Callable[[str, int], Iterable[Any]]

SENSITIVE_HEADERS = frozenset(
    {
        "api-key",
        "authorization",
        "cookie",
        "cookie2",
        "host",
        "proxy-authorization",
        "token",
        "x-api-key",
        "x-auth-token",
        "x-bot-secret",
    }
)
_METADATA_HOSTS = frozenset(
    {
        "instance-data",
        "instance-data.ec2.internal",
        "metadata",
        "metadata.google.internal",
        "metadata.internal",
        "metadata.oraclecloud.com",
    }
)
_METADATA_ADDRESSES = frozenset(
    {
        ipaddress.ip_address("100.100.100.200"),
        ipaddress.ip_address("169.254.169.254"),
        ipaddress.ip_address("169.254.170.2"),
        ipaddress.ip_address("fd00:ec2::254"),
    }
)


@dataclass(frozen=True)
class ApprovedURL:
    url: str
    scheme: str
    host: str
    port: int
    addresses: tuple[IPAddress, ...]


@dataclass(frozen=True)
class HopResponse:
    status: int
    headers: Mapping[str, str]
    body: bytes

    def json(self) -> Any:
        return json.loads(self.body.decode("utf-8"))


class HopTransport(Protocol):
    def __call__(
        self,
        approved: ApprovedURL,
        *,
        headers: Mapping[str, str],
        payload: Mapping[str, Any],
        timeout: float,
        max_bytes: int,
    ) -> Awaitable[HopResponse]: ...


class DownloadHopTransport(Protocol):
    def __call__(
        self,
        approved: ApprovedURL,
        *,
        headers: Mapping[str, str],
        timeout: float,
        max_bytes: int,
    ) -> Awaitable[HopResponse]: ...


class BytesHopTransport(Protocol):
    def __call__(
        self,
        approved: ApprovedURL,
        *,
        headers: Mapping[str, str],
        body: bytes,
        timeout: float,
        max_bytes: int,
    ) -> Awaitable[HopResponse]: ...


class PublicEndpointPolicy:
    """Resolve every hop and allow only globally-routable public addresses."""

    def __init__(self, resolver: Resolver | None = None) -> None:
        self._resolver = resolver or self._system_resolver

    @staticmethod
    def _system_resolver(host: str, port: int) -> Iterable[Any]:
        return socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)

    def validate(self, url: str) -> ApprovedURL:
        if not isinstance(url, str) or not url or len(url) > 8192:
            raise InvalidRequestError("outbound URL is invalid")
        if "\\" in url or any(ord(char) < 0x20 or ord(char) == 0x7F for char in url):
            raise InvalidRequestError("outbound URL is invalid")
        try:
            parsed = urlsplit(url)
            scheme = parsed.scheme.lower()
            host_value = parsed.hostname
            port = parsed.port
        except ValueError as exc:
            raise InvalidRequestError("outbound URL is invalid") from exc
        if scheme not in {"http", "https"} or not parsed.netloc or not host_value:
            raise InvalidRequestError("outbound URL must use HTTP or HTTPS")
        if parsed.username is not None or parsed.password is not None:
            raise InvalidRequestError("userinfo is forbidden in outbound URLs")
        if parsed.netloc.endswith(":") or (port is not None and port < 1):
            raise InvalidRequestError("outbound URL has an invalid port")
        if "%" in host_value:
            raise InvalidRequestError("scoped IPv6 hosts are forbidden")
        try:
            host = host_value.rstrip(".").encode("idna").decode("ascii").lower()
        except UnicodeError as exc:
            raise InvalidRequestError("outbound URL host is invalid") from exc
        if not host or host in _METADATA_HOSTS or host.endswith(".metadata.google.internal"):
            raise InvalidRequestError("outbound host is forbidden")
        port = port or (443 if scheme == "https" else 80)
        addresses = self._resolve(host, port)
        for address in addresses:
            normalized = address.ipv4_mapped if isinstance(address, ipaddress.IPv6Address) else None
            checked = normalized or address
            if checked in _METADATA_ADDRESSES or not checked.is_global:
                raise InvalidRequestError("outbound host resolves to a forbidden address")
        return ApprovedURL(url=url, scheme=scheme, host=host, port=port, addresses=addresses)

    def validate_redirect(self, current_url: str, location: str) -> ApprovedURL:
        # Revalidating the current URL forces a fresh DNS resolution before every
        # redirect as well as validating the destination hop.
        current = self.validate(current_url)
        return self.validate(urljoin(current.url, location))

    def _resolve(self, host: str, port: int) -> tuple[IPAddress, ...]:
        try:
            literal = ipaddress.ip_address(host)
            if isinstance(literal, ipaddress.IPv6Address) and literal.ipv4_mapped:
                literal = literal.ipv4_mapped
            return (literal,)
        except ValueError:
            pass
        try:
            results = self._resolver(host, port)
            addresses = {_resolved_address(item) for item in results}
        except Exception as exc:
            raise InvalidRequestError("outbound host could not be resolved") from exc
        if not addresses:
            raise InvalidRequestError("outbound host could not be resolved")
        return tuple(sorted(addresses, key=lambda value: (value.version, int(value))))


class SafeJsonHttpClient:
    """POST JSON with DNS pinning and explicit per-hop redirect handling."""

    def __init__(
        self,
        *,
        policy: PublicEndpointPolicy | None = None,
        transport: HopTransport | None = None,
        max_redirects: int = 3,
        max_response_bytes: int = 4 * 1024 * 1024,
    ) -> None:
        if (
            not isinstance(max_redirects, int)
            or isinstance(max_redirects, bool)
            or max_redirects < 0
        ):
            raise ValueError("max_redirects must be a non-negative integer")
        if max_response_bytes <= 0:
            raise ValueError("max_response_bytes must be positive")
        self.policy = policy or PublicEndpointPolicy()
        self.transport = transport or AiohttpPinnedTransport()
        self.max_redirects = max_redirects
        self.max_response_bytes = max_response_bytes

    async def post_json(
        self,
        url: str,
        *,
        headers: Mapping[str, str],
        payload: Mapping[str, Any],
        timeout: float,
    ) -> HopResponse:
        current = self.policy.validate(url)
        request_headers = dict(headers)
        for redirect_count in range(self.max_redirects + 1):
            response = await self.transport(
                current,
                headers=request_headers,
                payload=payload,
                timeout=timeout,
                max_bytes=self.max_response_bytes,
            )
            if response.status not in {301, 302, 303, 307, 308}:
                return response
            location = _header(response.headers, "location")
            if not location or redirect_count >= self.max_redirects:
                raise InvalidRequestError("outbound redirect is invalid")
            if response.status in {301, 302, 303}:
                # Never silently turn a credentialed POST into a GET or replay it
                # under ambiguous legacy redirect semantics.
                raise InvalidRequestError("method-changing redirects are forbidden")
            next_url = self.policy.validate_redirect(current.url, location)
            if _origin(current.url) != _origin(next_url.url):
                request_headers = {
                    name: value
                    for name, value in request_headers.items()
                    if name.lower() not in SENSITIVE_HEADERS
                }
            current = next_url
        raise InvalidRequestError("too many outbound redirects")


class SafeBinaryHttpClient:
    """GET bounded bytes with pinned DNS and per-hop redirect validation."""

    def __init__(
        self,
        *,
        policy: PublicEndpointPolicy | None = None,
        transport: DownloadHopTransport | None = None,
        max_redirects: int = 3,
    ) -> None:
        if (
            not isinstance(max_redirects, int)
            or isinstance(max_redirects, bool)
            or max_redirects < 0
        ):
            raise ValueError("max_redirects must be a non-negative integer")
        self.policy = policy or PublicEndpointPolicy()
        self.transport = transport or AiohttpPinnedDownloadTransport()
        self.max_redirects = max_redirects

    async def get(
        self,
        url: str,
        *,
        headers: Mapping[str, str],
        timeout: float,
        max_bytes: int,
    ) -> HopResponse:
        if max_bytes <= 0:
            raise ValueError("max_bytes must be positive")
        current = self.policy.validate(url)
        request_headers = dict(headers)
        for redirect_count in range(self.max_redirects + 1):
            response = await self.transport(
                current,
                headers=request_headers,
                timeout=timeout,
                max_bytes=max_bytes,
            )
            if response.status not in {301, 302, 303, 307, 308}:
                return response
            location = _header(response.headers, "location")
            if not location or redirect_count >= self.max_redirects:
                raise InvalidRequestError("outbound redirect is invalid")
            next_url = self.policy.validate_redirect(current.url, location)
            if _origin(current.url) != _origin(next_url.url):
                request_headers = {
                    name: value
                    for name, value in request_headers.items()
                    if name.lower() not in SENSITIVE_HEADERS
                }
            current = next_url
        raise InvalidRequestError("too many outbound redirects")


class SafeBytesHttpClient:
    """POST an already-encoded bounded body with the same pinned-hop policy."""

    def __init__(
        self,
        *,
        policy: PublicEndpointPolicy | None = None,
        transport: BytesHopTransport | None = None,
        max_redirects: int = 3,
        max_response_bytes: int = 48 * 1024 * 1024,
    ) -> None:
        if (
            not isinstance(max_redirects, int)
            or isinstance(max_redirects, bool)
            or max_redirects < 0
        ):
            raise ValueError("max_redirects must be a non-negative integer")
        if max_response_bytes <= 0:
            raise ValueError("max_response_bytes must be positive")
        self.policy = policy or PublicEndpointPolicy()
        self.transport = transport or AiohttpPinnedBytesTransport()
        self.max_redirects = max_redirects
        self.max_response_bytes = max_response_bytes

    async def post(
        self,
        url: str,
        *,
        headers: Mapping[str, str],
        body: bytes,
        timeout: float,
    ) -> HopResponse:
        current = self.policy.validate(url)
        request_headers = dict(headers)
        for redirect_count in range(self.max_redirects + 1):
            response = await self.transport(
                current,
                headers=request_headers,
                body=body,
                timeout=timeout,
                max_bytes=self.max_response_bytes,
            )
            if response.status not in {301, 302, 303, 307, 308}:
                return response
            location = _header(response.headers, "location")
            if not location or redirect_count >= self.max_redirects:
                raise InvalidRequestError("outbound redirect is invalid")
            if response.status in {301, 302, 303}:
                raise InvalidRequestError("method-changing redirects are forbidden")
            next_url = self.policy.validate_redirect(current.url, location)
            if _origin(current.url) != _origin(next_url.url):
                request_headers = {
                    name: value
                    for name, value in request_headers.items()
                    if name.lower() not in SENSITIVE_HEADERS
                }
            current = next_url
        raise InvalidRequestError("too many outbound redirects")


class _PinnedResolver(AbstractResolver):
    def __init__(self, approved: ApprovedURL) -> None:
        self.approved = approved

    async def resolve(
        self,
        host: str,
        port: int = 0,
        family: int = socket.AF_INET,
    ) -> list[ResolveResult]:
        if host.rstrip(".").lower() != self.approved.host or port != self.approved.port:
            raise OSError("resolver was asked for an unapproved origin")
        return cast(
            list[ResolveResult],
            [
                {
                    "hostname": host,
                    "host": str(address),
                    "port": port,
                    "family": socket.AF_INET6 if address.version == 6 else socket.AF_INET,
                    "proto": 0,
                    "flags": 0,
                }
                for address in self.approved.addresses
            ],
        )

    async def close(self) -> None:
        return None


class AiohttpPinnedTransport:
    async def __call__(
        self,
        approved: ApprovedURL,
        *,
        headers: Mapping[str, str],
        payload: Mapping[str, Any],
        timeout: float,
        max_bytes: int,
    ) -> HopResponse:
        connector = aiohttp.TCPConnector(
            resolver=_PinnedResolver(approved),
            use_dns_cache=False,
            ttl_dns_cache=0,
        )
        client_timeout = aiohttp.ClientTimeout(total=timeout)
        async with aiohttp.ClientSession(
            connector=connector,
            timeout=client_timeout,
            trust_env=False,
        ) as session:
            async with session.post(
                approved.url,
                headers=dict(headers),
                json=dict(payload),
                allow_redirects=False,
            ) as response:
                body = bytearray()
                async for chunk in response.content.iter_chunked(64 * 1024):
                    body.extend(chunk)
                    if len(body) > max_bytes:
                        raise InvalidRequestError("outbound response is too large")
                return HopResponse(
                    status=response.status,
                    headers=dict(response.headers),
                    body=bytes(body),
                )


class AiohttpPinnedDownloadTransport:
    async def __call__(
        self,
        approved: ApprovedURL,
        *,
        headers: Mapping[str, str],
        timeout: float,
        max_bytes: int,
    ) -> HopResponse:
        connector = aiohttp.TCPConnector(
            resolver=_PinnedResolver(approved),
            use_dns_cache=False,
            ttl_dns_cache=0,
        )
        client_timeout = aiohttp.ClientTimeout(total=timeout)
        async with aiohttp.ClientSession(
            connector=connector,
            timeout=client_timeout,
            trust_env=False,
        ) as session:
            async with session.get(
                approved.url,
                headers=dict(headers),
                allow_redirects=False,
            ) as response:
                body = bytearray()
                async for chunk in response.content.iter_chunked(64 * 1024):
                    body.extend(chunk)
                    if len(body) > max_bytes:
                        raise InvalidRequestError("outbound response is too large")
                return HopResponse(
                    status=response.status,
                    headers=dict(response.headers),
                    body=bytes(body),
                )


class AiohttpPinnedBytesTransport:
    async def __call__(
        self,
        approved: ApprovedURL,
        *,
        headers: Mapping[str, str],
        body: bytes,
        timeout: float,
        max_bytes: int,
    ) -> HopResponse:
        connector = aiohttp.TCPConnector(
            resolver=_PinnedResolver(approved),
            use_dns_cache=False,
            ttl_dns_cache=0,
        )
        client_timeout = aiohttp.ClientTimeout(total=timeout)
        async with aiohttp.ClientSession(
            connector=connector,
            timeout=client_timeout,
            trust_env=False,
        ) as session:
            async with session.post(
                approved.url,
                headers=dict(headers),
                data=body,
                allow_redirects=False,
            ) as response:
                response_body = bytearray()
                async for chunk in response.content.iter_chunked(64 * 1024):
                    response_body.extend(chunk)
                    if len(response_body) > max_bytes:
                        raise InvalidRequestError("outbound response is too large")
                return HopResponse(
                    status=response.status,
                    headers=dict(response.headers),
                    body=bytes(response_body),
                )


def _resolved_address(item: Any) -> IPAddress:
    if isinstance(item, (str, ipaddress.IPv4Address, ipaddress.IPv6Address)):
        address = ipaddress.ip_address(item)
    elif isinstance(item, tuple) and len(item) >= 5 and isinstance(item[4], tuple):
        address = ipaddress.ip_address(str(item[4][0]).split("%", 1)[0])
    elif isinstance(item, tuple) and item:
        address = ipaddress.ip_address(str(item[0]).split("%", 1)[0])
    else:
        raise ValueError("resolver returned an invalid address")
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        return address.ipv4_mapped
    return address


def _origin(url: str) -> tuple[str, str, int]:
    parsed = urlsplit(url)
    scheme = parsed.scheme.lower()
    host = (parsed.hostname or "").rstrip(".").encode("idna").decode("ascii").lower()
    return scheme, host, parsed.port or (443 if scheme == "https" else 80)


def _header(headers: Mapping[str, str], name: str) -> str | None:
    lowered = name.lower()
    return next((value for key, value in headers.items() if key.lower() == lowered), None)
