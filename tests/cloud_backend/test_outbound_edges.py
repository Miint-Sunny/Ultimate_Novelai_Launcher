from __future__ import annotations

import ipaddress
import socket
from collections.abc import Mapping
from typing import Any

import pytest

import cloud_backend.outbound as outbound
from cloud_backend.errors import InvalidRequestError
from cloud_backend.outbound import (
    AiohttpPinnedBytesTransport,
    AiohttpPinnedDownloadTransport,
    AiohttpPinnedTransport,
    ApprovedURL,
    HopResponse,
    PublicEndpointPolicy,
    SafeBinaryHttpClient,
    SafeBytesHttpClient,
    SafeJsonHttpClient,
    _PinnedResolver,
    _resolved_address,
)


class Resolver:
    def __init__(self, answers: dict[str, list[Any]]) -> None:
        self.answers = answers

    def __call__(self, host: str, port: int) -> list[Any]:
        answer = self.answers[host]
        if answer and isinstance(answer[0], BaseException):
            raise answer[0]
        return answer


class JsonTransport:
    def __init__(self, responses: list[HopResponse]) -> None:
        self.responses = responses
        self.headers: list[dict[str, str]] = []

    async def __call__(self, approved, *, headers, payload, timeout, max_bytes):
        self.headers.append(dict(headers))
        return self.responses.pop(0)


class DownloadTransport(JsonTransport):
    async def __call__(self, approved, *, headers, timeout, max_bytes):
        self.headers.append(dict(headers))
        return self.responses.pop(0)


class BytesTransport(JsonTransport):
    async def __call__(self, approved, *, headers, body, timeout, max_bytes):
        self.headers.append(dict(headers))
        return self.responses.pop(0)


@pytest.mark.parametrize(
    "url",
    [
        None,
        "",
        "x" * 8193,
        "https://example.com\\path",
        "https://example.com/\x00",
        "https://example.com:bad",
        "ftp://example.com/file",
        "https://user:password@example.com/file",
        "https://example.com:",
        "https://[fe80::1%25eth0]/",
        "https://metadata.google.internal/latest",
        "https://service.metadata.google.internal/latest",
        "https://\udcff/",
    ],
)
def test_policy_rejects_malformed_or_credentialed_urls(url) -> None:
    with pytest.raises(InvalidRequestError):
        PublicEndpointPolicy(lambda host, port: ["8.8.8.8"]).validate(url)


def test_policy_accepts_tuple_resolver_shapes_and_normalizes_mapped_ipv6() -> None:
    policy = PublicEndpointPolicy(
        Resolver(
            {
                "tuple.example": [
                    (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443)),
                    ("2001:4860:4860::8888", 443),
                ]
            }
        )
    )
    approved = policy.validate("https://tuple.example./v1")

    assert approved.host == "tuple.example"
    assert approved.port == 443
    assert {str(address) for address in approved.addresses} == {
        "8.8.8.8",
        "2001:4860:4860::8888",
    }
    mapped = PublicEndpointPolicy().validate("https://[::ffff:8.8.8.8]/")
    assert mapped.addresses == (ipaddress.ip_address("8.8.8.8"),)


@pytest.mark.parametrize(
    "answers",
    [
        [],
        [RuntimeError("DNS unavailable")],
        [object()],
    ],
)
def test_policy_rejects_empty_failing_or_invalid_resolver_answers(answers: list[Any]) -> None:
    policy = PublicEndpointPolicy(Resolver({"bad.example": answers}))
    with pytest.raises(InvalidRequestError, match="could not be resolved"):
        policy.validate("https://bad.example")


def test_system_resolver_uses_stream_sockets(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, Any] = {}

    def fake_getaddrinfo(host, port, *, type):
        captured.update(host=host, port=port, type=type)
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", port))]

    monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)
    result = list(PublicEndpointPolicy._system_resolver("example.com", 443))

    assert result
    assert captured == {"host": "example.com", "port": 443, "type": socket.SOCK_STREAM}


@pytest.mark.parametrize(
    ("item", "expected"),
    [
        ("8.8.8.8", "8.8.8.8"),
        (ipaddress.ip_address("2001:4860:4860::8888"), "2001:4860:4860::8888"),
        (("8.8.4.4", 443), "8.8.4.4"),
        (
            (socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("2001:4860:4860::8844%eth0", 443)),
            "2001:4860:4860::8844",
        ),
        ("::ffff:8.8.8.8", "8.8.8.8"),
    ],
)
def test_resolved_address_normalizes_supported_shapes(item, expected: str) -> None:
    assert str(_resolved_address(item)) == expected


def test_resolved_address_rejects_unknown_shape() -> None:
    with pytest.raises(ValueError, match="invalid address"):
        _resolved_address(object())


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [301, 302, 303])
async def test_json_post_forbids_method_changing_redirect(status: int) -> None:
    client = SafeJsonHttpClient(
        policy=PublicEndpointPolicy(lambda host, port: ["8.8.8.8"]),
        transport=JsonTransport([HopResponse(status, {"Location": "/other"}, b"")]),
    )
    with pytest.raises(InvalidRequestError, match="method-changing"):
        await client.post_json("https://api.example/v1", headers={}, payload={}, timeout=1)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("client", "call"),
    [
        (
            SafeJsonHttpClient(
                policy=PublicEndpointPolicy(lambda host, port: ["8.8.8.8"]),
                transport=JsonTransport([HopResponse(307, {}, b"")]),
            ),
            "json",
        ),
        (
            SafeBinaryHttpClient(
                policy=PublicEndpointPolicy(lambda host, port: ["8.8.8.8"]),
                transport=DownloadTransport([HopResponse(302, {}, b"")]),
            ),
            "download",
        ),
        (
            SafeBytesHttpClient(
                policy=PublicEndpointPolicy(lambda host, port: ["8.8.8.8"]),
                transport=BytesTransport([HopResponse(307, {}, b"")]),
            ),
            "bytes",
        ),
    ],
)
async def test_safe_clients_reject_redirect_without_location(client, call: str) -> None:
    with pytest.raises(InvalidRequestError, match="redirect"):
        if call == "json":
            await client.post_json("https://api.example", headers={}, payload={}, timeout=1)
        elif call == "download":
            await client.get("https://api.example", headers={}, timeout=1, max_bytes=1)
        else:
            await client.post("https://api.example", headers={}, body=b"x", timeout=1)


@pytest.mark.asyncio
async def test_safe_clients_enforce_redirect_and_download_limits() -> None:
    policy = PublicEndpointPolicy(lambda host, port: ["8.8.8.8"])
    binary = SafeBinaryHttpClient(policy=policy, transport=DownloadTransport([]))
    with pytest.raises(ValueError, match="positive"):
        await binary.get("https://api.example", headers={}, timeout=1, max_bytes=0)

    for client, call in [
        (
            SafeJsonHttpClient(
                policy=policy,
                transport=JsonTransport([HopResponse(307, {"Location": "/again"}, b"")]),
                max_redirects=0,
            ),
            "json",
        ),
        (
            SafeBinaryHttpClient(
                policy=policy,
                transport=DownloadTransport([HopResponse(307, {"Location": "/again"}, b"")]),
                max_redirects=0,
            ),
            "download",
        ),
        (
            SafeBytesHttpClient(
                policy=policy,
                transport=BytesTransport([HopResponse(307, {"Location": "/again"}, b"")]),
                max_redirects=0,
            ),
            "bytes",
        ),
    ]:
        with pytest.raises(InvalidRequestError, match="redirect"):
            if call == "json":
                await client.post_json("https://api.example", headers={}, payload={}, timeout=1)
            elif call == "download":
                await client.get("https://api.example", headers={}, timeout=1, max_bytes=1)
            else:
                await client.post("https://api.example", headers={}, body=b"x", timeout=1)


@pytest.mark.asyncio
async def test_same_origin_redirect_keeps_credentials() -> None:
    policy = PublicEndpointPolicy(lambda host, port: ["8.8.8.8"])
    transport = JsonTransport(
        [
            HopResponse(307, {"LOCATION": "/v2"}, b""),
            HopResponse(200, {}, b"{}"),
        ]
    )
    client = SafeJsonHttpClient(policy=policy, transport=transport)

    await client.post_json(
        "https://api.example/v1",
        headers={"Authorization": "secret"},
        payload={},
        timeout=1,
    )

    assert transport.headers == [
        {"Authorization": "secret"},
        {"Authorization": "secret"},
    ]


@pytest.mark.asyncio
async def test_bytes_post_forbids_method_changing_redirect() -> None:
    client = SafeBytesHttpClient(
        policy=PublicEndpointPolicy(lambda host, port: ["8.8.8.8"]),
        transport=BytesTransport([HopResponse(302, {"Location": "/other"}, b"")]),
    )
    with pytest.raises(InvalidRequestError, match="method-changing"):
        await client.post("https://api.example", headers={}, body=b"x", timeout=1)


@pytest.mark.asyncio
async def test_pinned_resolver_only_serves_approved_origin() -> None:
    approved = ApprovedURL(
        url="https://api.example:8443/v1",
        scheme="https",
        host="api.example",
        port=8443,
        addresses=(ipaddress.ip_address("8.8.8.8"), ipaddress.ip_address("2001:4860::8888")),
    )
    resolver = _PinnedResolver(approved)

    answers = await resolver.resolve("API.EXAMPLE.", 8443)
    assert [answer["family"] for answer in answers] == [socket.AF_INET, socket.AF_INET6]
    with pytest.raises(OSError, match="unapproved"):
        await resolver.resolve("other.example", 8443)
    with pytest.raises(OSError, match="unapproved"):
        await resolver.resolve("api.example", 443)
    await resolver.close()


class FakeContent:
    def __init__(self, chunks: list[bytes]) -> None:
        self.chunks = chunks

    async def iter_chunked(self, size: int):
        assert size == 64 * 1024
        for chunk in self.chunks:
            yield chunk


class FakeResponse:
    def __init__(self, chunks: list[bytes]) -> None:
        self.status = 201
        self.headers: Mapping[str, str] = {"X-Test": "yes"}
        self.content = FakeContent(chunks)

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, traceback) -> None:
        return None


class FakeSession:
    def __init__(self, response: FakeResponse, captured: dict[str, Any], **kwargs) -> None:
        self.response = response
        self.captured = captured
        self.captured["session"] = kwargs

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, traceback) -> None:
        return None

    def post(self, url: str, **kwargs):
        self.captured["method"] = "post"
        self.captured["url"] = url
        self.captured["request"] = kwargs
        return self.response

    def get(self, url: str, **kwargs):
        self.captured["method"] = "get"
        self.captured["url"] = url
        self.captured["request"] = kwargs
        return self.response


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("transport", "kind"),
    [
        (AiohttpPinnedTransport(), "json"),
        (AiohttpPinnedDownloadTransport(), "download"),
        (AiohttpPinnedBytesTransport(), "bytes"),
    ],
)
@pytest.mark.parametrize("oversized", [False, True])
async def test_aiohttp_transports_are_bounded_and_disable_ambient_routing(
    monkeypatch: pytest.MonkeyPatch,
    transport,
    kind: str,
    oversized: bool,
) -> None:
    approved = ApprovedURL(
        url="https://api.example/v1",
        scheme="https",
        host="api.example",
        port=443,
        addresses=(ipaddress.ip_address("8.8.8.8"),),
    )
    captured: dict[str, Any] = {}
    response = FakeResponse([b"abc", b"def"] if oversized else [b"ok"])

    def connector(**kwargs):
        captured["connector"] = kwargs
        return object()

    def session(**kwargs):
        return FakeSession(response, captured, **kwargs)

    monkeypatch.setattr(outbound.aiohttp, "TCPConnector", connector)
    monkeypatch.setattr(outbound.aiohttp, "ClientSession", session)

    kwargs = {"headers": {"Authorization": "secret"}, "timeout": 2, "max_bytes": 4}
    if kind == "json":
        call = transport(approved, payload={"hello": "world"}, **kwargs)
    elif kind == "download":
        call = transport(approved, **kwargs)
    else:
        call = transport(approved, body=b"request", **kwargs)

    if oversized:
        with pytest.raises(InvalidRequestError, match="too large"):
            await call
    else:
        result = await call
        assert result == HopResponse(201, {"X-Test": "yes"}, b"ok")
        assert captured["url"] == approved.url
        assert captured["request"]["allow_redirects"] is False
        assert captured["session"]["trust_env"] is False
        assert captured["connector"]["use_dns_cache"] is False
