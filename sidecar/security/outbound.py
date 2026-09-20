from __future__ import annotations

import ipaddress
import os
import re
import socket
from collections.abc import Callable, Iterable, Mapping
from enum import Enum
from typing import Any, cast, overload
from urllib.parse import urljoin, urlsplit

from .errors import OutboundPolicyError, OutboundResolutionError


class OutboundMode(str, Enum):
    PUBLIC = "public"
    LOOPBACK = "loopback"
    TRUSTED_LAN = "trusted-lan"


class ValidatedURL(str):
    """Validated URL string plus the addresses approved for this request hop."""

    url: str
    scheme: str
    host: str
    port: int
    addresses: tuple[ipaddress.IPv4Address | ipaddress.IPv6Address, ...]

    def __new__(
        cls,
        url: str,
        *,
        scheme: str,
        host: str,
        port: int,
        addresses: tuple[ipaddress.IPv4Address | ipaddress.IPv6Address, ...],
    ) -> ValidatedURL:
        instance = str.__new__(cls, url)
        instance.url = url
        instance.scheme = scheme
        instance.host = host
        instance.port = port
        instance.addresses = addresses
        return instance


Resolver = Callable[[str, int], Iterable[Any]]
IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address
IPNetwork = ipaddress.IPv4Network | ipaddress.IPv6Network


_METADATA_HOSTS = frozenset(
    {
        "instance-data",
        "instance-data.ec2.internal",
        "metadata",
        "metadata.aws.internal",
        "metadata.azure.internal",
        "metadata.google.internal",
        "metadata.internal",
        "metadata.oraclecloud.com",
    }
)
_LEGACY_NUMERIC_HOST = re.compile(
    r"(?:0x[0-9a-f]+|[0-9]+)(?:\.(?:0x[0-9a-f]+|[0-9]+)){0,3}\Z",
    flags=re.IGNORECASE,
)
_METADATA_ADDRESSES = frozenset(
    {
        ipaddress.ip_address("100.100.100.200"),  # Alibaba Cloud
        ipaddress.ip_address("169.254.169.254"),  # AWS/Azure/GCP/Oracle
        ipaddress.ip_address("169.254.170.2"),  # AWS ECS task metadata
        ipaddress.ip_address("fd00:ec2::254"),  # AWS IMDS IPv6
    }
)
_TRUSTABLE_LAN_RANGES = tuple(
    ipaddress.ip_network(value)
    for value in (
        "10.0.0.0/8",
        "100.64.0.0/10",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "fc00::/7",
    )
)

FAKE_IP_RANGES_ENV = "ULTIMATE_NOVELAI_LAUNCHER_FAKE_IP_RANGES"
# RFC 2544 benchmarking block.  It is never routed on the public Internet or on
# any sane LAN, so a resolver answer inside it can only come from a local
# fake-ip proxy (Clash / Mihomo / sing-box / Surge hand out 198.18.0.0/15 by
# default): the TUN maps the placeholder back to the hostname and the proxy
# resolves it upstream.  Public mode therefore accepts it in place of a global
# address.  Other placeholder ranges go in FAKE_IP_RANGES_ENV.
_BUILTIN_FAKE_IP_RANGES: tuple[IPNetwork, ...] = (ipaddress.ip_network("198.18.0.0/15"),)

SENSITIVE_REDIRECT_HEADERS = frozenset(
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
        "x-forwarded-authorization",
        "x-goog-api-key",
        "x-sidecar-auth",
    }
)


def _default_resolver(host: str, port: int) -> Iterable[Any]:
    # A new resolver call is made for every URL and every redirect hop.  No DNS
    # result is cached in this module.
    return socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)


def _normalized_ip(value: str | IPAddress) -> IPAddress:
    address = (
        value
        if isinstance(value, (ipaddress.IPv4Address, ipaddress.IPv6Address))
        else ipaddress.ip_address(value)
    )
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        return address.ipv4_mapped
    return address


def _extract_resolved_ip(item: Any) -> ipaddress.IPv4Address | ipaddress.IPv6Address:
    if isinstance(item, (str, ipaddress.IPv4Address, ipaddress.IPv6Address)):
        return _normalized_ip(item)
    # socket.getaddrinfo -> (family, type, proto, canonname, sockaddr)
    if isinstance(item, tuple) and len(item) >= 5:
        sockaddr = item[4]
        if isinstance(sockaddr, tuple) and sockaddr:
            return _normalized_ip(str(sockaddr[0]).split("%", 1)[0])
    # Small injected resolvers often return (address, port).
    if isinstance(item, tuple) and item:
        return _normalized_ip(str(item[0]).split("%", 1)[0])
    raise ValueError("resolver returned an invalid address")


def _normalize_mode(value: str | OutboundMode) -> OutboundMode:
    if isinstance(value, OutboundMode):
        return value
    normalized = str(value).strip().lower().replace("_", "-")
    try:
        return OutboundMode(normalized)
    except ValueError as exc:
        raise ValueError("outbound mode must be public, loopback, or trusted-lan") from exc


def _network_is_trustable(network: IPNetwork) -> bool:
    if isinstance(network, ipaddress.IPv4Network):
        return any(
            isinstance(allowed, ipaddress.IPv4Network) and network.subnet_of(allowed)
            for allowed in _TRUSTABLE_LAN_RANGES
        )
    return any(
        isinstance(allowed, ipaddress.IPv6Network) and network.subnet_of(allowed)
        for allowed in _TRUSTABLE_LAN_RANGES
    )


def _network_may_be_fake_ip(network: IPNetwork) -> bool:
    """A fake-ip range must not alias anything the always-reject rules protect."""
    if (
        network.is_loopback
        or network.is_link_local
        or network.is_multicast
        or network.is_unspecified
    ):
        return False
    return not any(
        address.version == network.version and address in network for address in _METADATA_ADDRESSES
    )


def parse_fake_ip_ranges(values: Iterable[str | IPNetwork]) -> tuple[IPNetwork, ...]:
    """Parse placeholder ranges handed out by a local fake-ip proxy."""
    networks: list[IPNetwork] = []
    for value in values:
        try:
            network = (
                value
                if isinstance(value, (ipaddress.IPv4Network, ipaddress.IPv6Network))
                else ipaddress.ip_network(str(value).strip(), strict=False)
            )
        except ValueError as exc:
            raise ValueError(f"invalid fake-ip range: {value}") from exc
        if not _network_may_be_fake_ip(network):
            raise ValueError(f"fake-ip range overlaps a protected address block: {network}")
        networks.append(network)
    return tuple(dict.fromkeys(networks))


def default_fake_ip_ranges() -> tuple[IPNetwork, ...]:
    """Built-in fake-ip ranges plus the comma-separated FAKE_IP_RANGES_ENV extras."""
    raw = os.environ.get(FAKE_IP_RANGES_ENV, "")
    try:
        configured = parse_fake_ip_ranges(item for item in raw.split(",") if item.strip())
    except ValueError as exc:
        raise ValueError(f"{FAKE_IP_RANGES_ENV} is invalid: {exc}") from exc
    return tuple(dict.fromkeys((*_BUILTIN_FAKE_IP_RANGES, *configured)))


class OutboundPolicy:
    """DNS-aware SSRF policy for public, loopback, or explicitly trusted LANs.

    Every resolved address must satisfy the selected mode.  Rejecting a hostname
    with mixed public/private answers closes the common DNS-rebinding bypass where
    a client chooses an address that the validator did not approve.

    Public mode also accepts the placeholder addresses of a local fake-ip proxy
    (``fake_ip_ranges``): the machine's resolver answers 198.18.x.x for every
    name while the proxy TUN is up, and the real destination is still the public
    hostname.  Those ranges cannot address LAN services, and the always-reject
    rules (metadata, link-local, multicast) keep running in front of them.
    """

    def __init__(
        self,
        mode: str | OutboundMode = OutboundMode.PUBLIC,
        *,
        trusted_networks: Iterable[str | ipaddress.IPv4Network | ipaddress.IPv6Network] = (),
        fake_ip_ranges: Iterable[str | IPNetwork] | None = None,
        resolver: Resolver | None = None,
    ) -> None:
        self.mode = _normalize_mode(mode)
        self.fake_ip_ranges = (
            parse_fake_ip_ranges(fake_ip_ranges)
            if fake_ip_ranges is not None
            else default_fake_ip_ranges()
        )
        networks: list[IPNetwork] = []
        for value in trusted_networks:
            try:
                network = (
                    value
                    if isinstance(value, (ipaddress.IPv4Network, ipaddress.IPv6Network))
                    else ipaddress.ip_network(value, strict=False)
                )
            except ValueError as exc:
                raise ValueError(f"invalid trusted LAN network: {value}") from exc
            if not _network_is_trustable(network):
                raise ValueError(f"trusted LAN network is not private LAN space: {network}")
            networks.append(network)
        self.trusted_networks = tuple(networks)
        self._resolver = resolver or _default_resolver

    @staticmethod
    def _parse(url: str) -> tuple[str, str, int]:
        if not isinstance(url, str) or not url or len(url) > 8192:
            raise OutboundPolicyError("outbound URL is invalid")
        if "\\" in url or any(ord(character) < 0x20 or ord(character) == 0x7F for character in url):
            raise OutboundPolicyError("outbound URL contains forbidden characters")
        try:
            parsed = urlsplit(url)
        except ValueError as exc:
            raise OutboundPolicyError("outbound URL is invalid") from exc
        scheme = parsed.scheme.lower()
        if scheme not in {"http", "https"}:
            raise OutboundPolicyError(
                "outbound URL must use HTTP or HTTPS",
                code="outbound_scheme_forbidden",
            )
        if parsed.username is not None or parsed.password is not None:
            raise OutboundPolicyError(
                "userinfo is forbidden in outbound URLs",
                code="outbound_userinfo_forbidden",
            )
        try:
            host_value = parsed.hostname
            port = parsed.port
        except ValueError as exc:
            raise OutboundPolicyError("outbound URL has an invalid host or port") from exc
        if not parsed.netloc or not host_value:
            raise OutboundPolicyError("outbound URL must include a host")
        if parsed.netloc.endswith(":"):
            raise OutboundPolicyError("outbound URL has an invalid port")
        if port is not None and port < 1:
            raise OutboundPolicyError("outbound URL has an invalid port")
        if "%" in host_value:
            raise OutboundPolicyError("scoped IPv6 hosts are forbidden")
        host = host_value.rstrip(".").lower()
        try:
            host = host.encode("idna").decode("ascii")
        except UnicodeError as exc:
            raise OutboundPolicyError("outbound URL host is invalid") from exc
        if not host or len(host) > 253:
            raise OutboundPolicyError("outbound URL host is invalid")
        try:
            ipaddress.ip_address(host)
        except ValueError:
            if _LEGACY_NUMERIC_HOST.fullmatch(host):
                raise OutboundPolicyError(
                    "ambiguous numeric IP encodings are forbidden",
                    code="outbound_ambiguous_host_forbidden",
                ) from None
        if host in _METADATA_HOSTS or host.endswith(".metadata.google.internal"):
            raise OutboundPolicyError(
                "cloud metadata hosts are forbidden",
                code="outbound_metadata_forbidden",
            )
        return scheme, host, port if port is not None else (443 if scheme == "https" else 80)

    def _resolve(self, host: str, port: int) -> tuple[IPAddress, ...]:
        literal_host = host[1:-1] if host.startswith("[") and host.endswith("]") else host
        try:
            literal = _normalized_ip(literal_host)
        except ValueError:
            literal = None
        if literal is not None:
            return (literal,)

        try:
            raw_results = self._resolver(host, port)
            addresses = {_extract_resolved_ip(item) for item in raw_results}
        except Exception as exc:
            raise OutboundResolutionError("outbound host could not be resolved") from exc
        if not addresses:
            raise OutboundResolutionError("outbound host did not resolve to an address")
        return tuple(sorted(addresses, key=lambda item: (item.version, int(item))))

    @staticmethod
    def _reject_always(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> None:
        if address in _METADATA_ADDRESSES:
            raise OutboundPolicyError(
                "cloud metadata addresses are forbidden",
                code="outbound_metadata_forbidden",
            )
        if address.is_link_local:
            raise OutboundPolicyError(
                "link-local addresses are forbidden",
                code="outbound_link_local_forbidden",
            )
        if address.is_multicast:
            raise OutboundPolicyError(
                "multicast addresses are forbidden",
                code="outbound_multicast_forbidden",
            )
        if address.is_unspecified:
            raise OutboundPolicyError(
                "unspecified addresses are forbidden",
                code="outbound_address_forbidden",
            )

    def _is_fake_ip(self, address: IPAddress) -> bool:
        return any(
            address.version == network.version and address in network
            for network in self.fake_ip_ranges
        )

    def _address_allowed(self, address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
        if self.mode is OutboundMode.PUBLIC:
            return address.is_global or self._is_fake_ip(address)
        if self.mode is OutboundMode.LOOPBACK:
            return address.is_loopback
        return any(
            address.version == network.version and address in network
            for network in self.trusted_networks
        )

    def validate_url(self, url: str) -> ValidatedURL:
        scheme, host, port = self._parse(url)
        if self.mode is OutboundMode.PUBLIC and scheme != "https":
            raise OutboundPolicyError(
                "public outbound endpoints must use HTTPS",
                code="outbound_insecure_transport_forbidden",
            )
        if self.mode is OutboundMode.TRUSTED_LAN and not self.trusted_networks:
            raise OutboundPolicyError(
                "trusted-lan mode requires an explicit trusted network",
                code="outbound_trusted_network_required",
            )
        addresses = self._resolve(host, port)
        for address in addresses:
            self._reject_always(address)
            if not self._address_allowed(address):
                raise OutboundPolicyError(
                    "outbound host resolves outside the selected network policy",
                    code="outbound_address_forbidden",
                )
        return ValidatedURL(
            url,
            scheme=scheme,
            host=host,
            port=port,
            addresses=addresses,
        )

    validate = validate_url

    def validate_redirect(self, from_url: str, to_url: str) -> ValidatedURL:
        """Revalidate both the current hop and a relative or absolute redirect."""

        current = self.validate_url(from_url)
        destination = urljoin(str(current), to_url)
        return self.validate_url(destination)

    def validate_redirect_chain(self, urls: Iterable[str]) -> tuple[ValidatedURL, ...]:
        iterator = iter(urls)
        try:
            first = next(iterator)
        except StopIteration:
            return ()
        approved = [self.validate_url(first)]
        for target in iterator:
            approved.append(self.validate_redirect(str(approved[-1]), target))
        return tuple(approved)


def validate_trusted_network_allowlist(
    values: Iterable[str | ipaddress.IPv4Network | ipaddress.IPv6Network],
) -> tuple[IPNetwork, ...]:
    """Validate the narrower allowlist accepted from canonical settings APIs.

    Legacy/env configuration remains readable, while new API writes cannot grant
    access to an entire private address family or a range containing cloud metadata.
    """

    networks = OutboundPolicy(OutboundMode.TRUSTED_LAN, trusted_networks=values).trusted_networks
    for network in networks:
        minimum_prefix = 16 if network.version == 4 else 48
        if network.prefixlen < minimum_prefix:
            raise ValueError(
                f"trusted LAN network is too broad; use /{minimum_prefix} or narrower: {network}"
            )
        if any(
            address.version == network.version and address in network
            for address in _METADATA_ADDRESSES
        ):
            raise ValueError(f"trusted LAN network contains a metadata address: {network}")
    return networks


def _origin(url: str) -> tuple[str, str, int] | None:
    try:
        if not isinstance(url, str) or "\\" in url:
            return None
        if any(ord(character) < 0x20 or ord(character) == 0x7F for character in url):
            return None
        parsed = urlsplit(url)
        scheme = parsed.scheme.lower()
        host_value = parsed.hostname
        if scheme not in {"http", "https"} or not host_value:
            return None
        if parsed.username is not None or parsed.password is not None:
            return None
        if parsed.netloc.endswith(":"):
            return None
        host = host_value.rstrip(".").encode("idna").decode("ascii").lower()
        parsed_port = parsed.port
        if parsed_port is not None and parsed_port < 1:
            return None
        port = parsed_port if parsed_port is not None else (443 if scheme == "https" else 80)
        return scheme, host, port
    except (UnicodeError, ValueError):
        return None


def same_origin(source_url: str, destination_url: str) -> bool:
    source = _origin(source_url)
    destination = _origin(destination_url)
    return source is not None and source == destination


def _header_name(value: Any) -> str:
    if isinstance(value, bytes):
        return value.decode("latin-1").casefold()
    return str(value).casefold()


@overload
def strip_sensitive_headers_on_cross_origin(
    headers: Mapping[str, Any],
    source_url: str,
    destination_url: str,
    *,
    sensitive_headers: Iterable[str] = (),
) -> dict[str, Any]: ...


@overload
def strip_sensitive_headers_on_cross_origin(
    headers: Iterable[tuple[str, Any]],
    source_url: str,
    destination_url: str,
    *,
    sensitive_headers: Iterable[str] = (),
) -> list[tuple[str, Any]]: ...


def strip_sensitive_headers_on_cross_origin(
    headers: Mapping[str, Any] | Iterable[tuple[str, Any]],
    source_url: str,
    destination_url: str,
    *,
    sensitive_headers: Iterable[str] = (),
) -> dict[str, Any] | list[tuple[str, Any]]:
    """Drop credentials (and stale Host) whenever a redirect changes origin.

    Invalid URL origins fail closed and are treated as cross-origin.
    """

    blocked = set(SENSITIVE_REDIRECT_HEADERS)
    blocked.update(str(name).casefold() for name in sensitive_headers)
    if isinstance(headers, Mapping):
        mapping = cast(Mapping[str, Any], headers)
        if same_origin(source_url, destination_url):
            return {key: value for key, value in mapping.items()}
        return {key: value for key, value in mapping.items() if _header_name(key) not in blocked}
    if same_origin(source_url, destination_url):
        return list(headers)
    return [(key, value) for key, value in headers if _header_name(key) not in blocked]


__all__ = [
    "OutboundMode",
    "OutboundPolicy",
    "SENSITIVE_REDIRECT_HEADERS",
    "ValidatedURL",
    "same_origin",
    "strip_sensitive_headers_on_cross_origin",
    "validate_trusted_network_allowlist",
]
