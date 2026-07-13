from __future__ import annotations

import json
import stat
from pathlib import Path
from typing import Any

import pytest

from cloud_backend.body_limit import StreamingBodyLimitMiddleware
from cloud_backend.errors import (
    IdempotencyConflictError,
    InvalidCapabilityError,
    InvalidRequestError,
    ResourceNotFoundError,
)
from cloud_backend.identity import Principal, ResourceOwner
from cloud_backend.legacy_adapter import (
    LegacyQuotaLedger,
    LegacyTaskAccess,
    bearer_token,
    capability_key,
    persistent_capability_key,
)
from cloud_backend.outbound import (
    HopResponse,
    PublicEndpointPolicy,
    SafeBinaryHttpClient,
    SafeBytesHttpClient,
    SafeJsonHttpClient,
)


def test_anonymous_capability_is_single_job_and_owner_bound() -> None:
    access = LegacyTaskAccess.from_secret(bytes(range(32)))
    first: dict[str, Any] = {}
    second: dict[str, Any] = {}
    grant = access.issue_anonymous(job_id="job-1", tenant_id="legacy-direct")
    access.bind_record(first, grant.resource)
    access.bind_record(second, ResourceOwner("legacy-direct", "someone-else"))

    assert (
        access.require_capability(first, job_id="job-1", token=grant.capability_token)
        == grant.resource
    )
    with pytest.raises(InvalidCapabilityError):
        access.require_capability(first, job_id="job-2", token=grant.capability_token)
    with pytest.raises(ResourceNotFoundError):
        access.require_capability(second, job_id="job-1", token=grant.capability_token)


def test_principal_cross_owner_and_cross_tenant_are_both_not_found() -> None:
    access = LegacyTaskAccess.from_secret(bytes(range(32)))
    task = {"tenant_id": "tenant-a", "owner_id": "user-1"}

    assert access.require_principal(task, Principal.user("user-1", "tenant-a"))
    with pytest.raises(ResourceNotFoundError):
        access.require_principal(task, Principal.user("user-2", "tenant-a"))
    with pytest.raises(ResourceNotFoundError):
        access.require_principal(task, Principal.user("user-1", "tenant-b"))
    with pytest.raises(ResourceNotFoundError):
        access.require_principal({"status": "legacy-unowned"}, Principal.user("user-1", "tenant-a"))
    with pytest.raises(ResourceNotFoundError):
        access.require_principal(None, Principal.user("user-1", "tenant-a"))
    with pytest.raises(ResourceNotFoundError):
        access.require_principal(
            {"tenant_id": "tenant-a", "owner_id": 123},
            Principal.user("user-1", "tenant-a"),
        )


def test_legacy_access_rejects_short_secret() -> None:
    with pytest.raises(ValueError, match="32 bytes"):
        LegacyTaskAccess.from_secret(b"short")


def test_bearer_parser_rejects_query_style_or_ambiguous_credentials() -> None:
    assert bearer_token("Bearer abc") == "abc"
    with pytest.raises(InvalidCapabilityError):
        bearer_token(None)
    with pytest.raises(InvalidCapabilityError):
        bearer_token("Basic abc")
    with pytest.raises(InvalidCapabilityError):
        bearer_token("Bearer a b")


def test_generated_capability_key_is_restart_stable_and_owner_only(tmp_path: Path) -> None:
    path = tmp_path / "secrets" / "job.key"

    first = persistent_capability_key("", path)
    second = persistent_capability_key(None, path)

    assert first == second
    assert len(first) == 32
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_persistent_capability_key_rejects_invalid_file(tmp_path: Path) -> None:
    path = tmp_path / "job.key"
    path.write_bytes(b"too-short")

    with pytest.raises(RuntimeError, match="invalid"):
        persistent_capability_key("", path)


def test_capability_key_supports_ephemeral_and_configured_material(tmp_path: Path) -> None:
    ephemeral = capability_key(None)
    configured_text = capability_key("deployment-secret")
    configured_bytes = capability_key(b"deployment-secret")

    assert len(ephemeral) == 32
    assert configured_text == configured_bytes
    assert (
        persistent_capability_key("deployment-secret", tmp_path / "unused.key") == configured_text
    )
    assert not (tmp_path / "unused.key").exists()


@pytest.mark.asyncio
async def test_legacy_quota_lifecycle_is_idempotent(tmp_path: Path) -> None:
    ledger = LegacyQuotaLedger(tmp_path / "quota.db", enabled=True)
    await ledger.initialize()
    principal = Principal.user("user-1", "tenant-a")
    resource = ResourceOwner("tenant-a", "user-1")
    await ledger.repository.provision_account(resource, available_units=5)
    task: dict[str, Any] = {"tenant_id": "tenant-a", "owner_id": "user-1"}

    await ledger.reserve(task, principal, units=2, idempotency_key="submit-1")
    await ledger.reserve(task, principal, units=2, idempotency_key="submit-1")
    await ledger.settle(task, principal, succeeded=False, job_id="job-1")
    await ledger.settle(task, principal, succeeded=False, job_id="job-1")

    assert (await ledger.service.balance(principal, resource)).available_units == 5
    with pytest.raises(IdempotencyConflictError):
        await ledger.reserve({}, principal, units=2, idempotency_key="submit-1")


@pytest.mark.asyncio
async def test_legacy_quota_startup_does_not_guess_interrupted_cost_state(tmp_path: Path) -> None:
    path = tmp_path / "quota.db"
    first = LegacyQuotaLedger(path, enabled=True)
    await first.initialize()
    principal = Principal.user("user-1", "tenant-a")
    resource = ResourceOwner("tenant-a", "user-1")
    await first.repository.provision_account(resource, available_units=5)
    task: dict[str, Any] = {"tenant_id": "tenant-a", "owner_id": "user-1"}
    await first.reserve(task, principal, units=3, idempotency_key="crashed-submit")
    assert (await first.service.balance(principal, resource)).available_units == 2

    restarted = LegacyQuotaLedger(path, enabled=True)
    await restarted.initialize()

    assert restarted.recovered_reservations == 0
    assert (await restarted.service.balance(principal, resource)).available_units == 2
    await restarted.settle(task, principal, succeeded=False, job_id="crashed-job")
    assert (await restarted.service.balance(principal, resource)).available_units == 5


@pytest.mark.asyncio
async def test_legacy_quota_disabled_and_missing_reservation_are_noops(tmp_path: Path) -> None:
    principal = Principal.user("user-1", "tenant-a")
    disabled = LegacyQuotaLedger(tmp_path / "disabled.db", enabled=False)
    record: dict[str, Any] = {}

    await disabled.initialize()
    await disabled.reserve(record, principal, units=1, idempotency_key="disabled")
    await disabled.settle(record, principal, succeeded=False, job_id="disabled")
    assert record == {}
    assert not (tmp_path / "disabled.db").exists()

    enabled = LegacyQuotaLedger(tmp_path / "enabled.db", enabled=True)
    await enabled.initialize()
    await enabled.settle(None, principal, succeeded=False, job_id="none")
    await enabled.settle({}, principal, succeeded=False, job_id="missing")


@pytest.mark.asyncio
async def test_legacy_quota_capture_commits_reserved_units(tmp_path: Path) -> None:
    ledger = LegacyQuotaLedger(tmp_path / "quota.db", enabled=True)
    await ledger.initialize()
    principal = Principal.user("user-1", "tenant-a")
    resource = ResourceOwner("tenant-a", "user-1")
    await ledger.repository.provision_account(resource, available_units=3)
    record: dict[str, Any] = {}

    await ledger.reserve(record, principal, units=2, idempotency_key="capture")
    await ledger.settle(record, principal, succeeded=True, job_id="captured-job")

    assert (await ledger.service.balance(principal, resource)).available_units == 1


async def _asgi_request(chunks: list[bytes]) -> list[dict[str, Any]]:
    messages = [
        {"type": "http.request", "body": chunk, "more_body": index < len(chunks) - 1}
        for index, chunk in enumerate(chunks)
    ]

    async def app(scope, receive, send):
        while True:
            message = await receive()
            if not message.get("more_body", False):
                break
        await send({"type": "http.response.start", "status": 204, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    async def receive():
        return messages.pop(0)

    sent: list[dict[str, Any]] = []

    async def send(message):
        sent.append(message)

    middleware = StreamingBodyLimitMiddleware(app, default_limit=5)
    await middleware(
        {"type": "http", "path": "/api/generate", "headers": [(b"content-length", b"1")]},
        receive,
        send,
    )
    return sent


@pytest.mark.asyncio
async def test_chunked_body_limit_counts_real_bytes_despite_lie() -> None:
    sent = await _asgi_request([b"abc", b"def"])
    assert sent[0]["status"] == 413
    assert json.loads(sent[1]["body"])["code"] == "request_body_too_large"


class Resolver:
    def __init__(self, answers: dict[str, list[str]]) -> None:
        self.answers = answers
        self.calls: list[str] = []

    def __call__(self, host: str, port: int) -> list[str]:
        self.calls.append(host)
        return self.answers[host]


class FakeTransport:
    def __init__(self, responses: list[HopResponse]) -> None:
        self.responses = responses
        self.headers: list[dict[str, str]] = []

    async def __call__(self, approved, *, headers, payload, timeout, max_bytes):
        self.headers.append(dict(headers))
        response = self.responses.pop(0)
        if len(response.body) > max_bytes:
            raise InvalidRequestError("outbound response is too large")
        return response


class FakeDownloadTransport(FakeTransport):
    async def __call__(self, approved, *, headers, timeout, max_bytes):
        self.headers.append(dict(headers))
        response = self.responses.pop(0)
        if len(response.body) > max_bytes:
            raise InvalidRequestError("outbound response is too large")
        return response


class FakeBytesTransport(FakeTransport):
    async def __call__(self, approved, *, headers, body, timeout, max_bytes):
        self.headers.append(dict(headers))
        response = self.responses.pop(0)
        if len(response.body) > max_bytes:
            raise InvalidRequestError("outbound response is too large")
        return response


@pytest.mark.asyncio
async def test_redirect_revalidates_dns_and_strips_cross_origin_secrets() -> None:
    resolver = Resolver({"first.example": ["93.184.216.34"], "second.example": ["8.8.8.8"]})
    transport = FakeTransport(
        [
            HopResponse(307, {"Location": "https://second.example/v1"}, b""),
            HopResponse(200, {}, b'{"ok":true}'),
        ]
    )
    client = SafeJsonHttpClient(
        policy=PublicEndpointPolicy(resolver),
        transport=transport,
    )

    response = await client.post_json(
        "https://first.example/v1",
        headers={"Authorization": "Bearer secret", "Content-Type": "application/json"},
        payload={"hello": "world"},
        timeout=1,
    )

    assert response.json() == {"ok": True}
    assert resolver.calls == ["first.example", "first.example", "second.example"]
    assert "Authorization" in transport.headers[0]
    assert "Authorization" not in transport.headers[1]


@pytest.mark.asyncio
async def test_dns_rebinding_and_metadata_redirect_are_rejected() -> None:
    resolver = Resolver(
        {
            "mixed.example": ["93.184.216.34", "127.0.0.1"],
            "first.example": ["93.184.216.34"],
            "metadata.example": ["169.254.169.254"],
        }
    )
    policy = PublicEndpointPolicy(resolver)
    with pytest.raises(InvalidRequestError):
        policy.validate("https://mixed.example")

    client = SafeJsonHttpClient(
        policy=policy,
        transport=FakeTransport(
            [HopResponse(307, {"Location": "http://metadata.example/latest"}, b"")]
        ),
    )
    with pytest.raises(InvalidRequestError):
        await client.post_json(
            "https://first.example/v1",
            headers={"Authorization": "Bearer secret"},
            payload={},
            timeout=1,
        )


@pytest.mark.asyncio
async def test_binary_download_drops_cookie_on_cdn_redirect() -> None:
    resolver = Resolver({"api.example": ["93.184.216.34"], "cdn.example": ["8.8.8.8"]})
    transport = FakeDownloadTransport(
        [
            HopResponse(302, {"Location": "https://cdn.example/image.png"}, b""),
            HopResponse(200, {"Content-Type": "image/png"}, b"png"),
        ]
    )
    client = SafeBinaryHttpClient(
        policy=PublicEndpointPolicy(resolver),
        transport=transport,
    )

    response = await client.get(
        "https://api.example/image",
        headers={"Cookie": "secret", "User-Agent": "test"},
        timeout=1,
        max_bytes=10,
    )

    assert response.body == b"png"
    assert transport.headers[0]["Cookie"] == "secret"
    assert "Cookie" not in transport.headers[1]


@pytest.mark.asyncio
async def test_multipart_post_revalidates_redirect_and_drops_authorization() -> None:
    resolver = Resolver({"api.example": ["93.184.216.34"], "cdn.example": ["8.8.8.8"]})
    transport = FakeBytesTransport(
        [
            HopResponse(307, {"Location": "https://cdn.example/upload"}, b""),
            HopResponse(200, {}, b'{"ok":true}'),
        ]
    )
    client = SafeBytesHttpClient(
        policy=PublicEndpointPolicy(resolver),
        transport=transport,
    )

    response = await client.post(
        "https://api.example/upload",
        headers={"Authorization": "Bearer secret", "Content-Type": "multipart/form-data"},
        body=b"multipart-body",
        timeout=1,
    )

    assert response.json() == {"ok": True}
    assert "Authorization" in transport.headers[0]
    assert "Authorization" not in transport.headers[1]


@pytest.mark.parametrize(
    ("factory", "kwargs"),
    [
        (SafeJsonHttpClient, {"max_redirects": -1}),
        (SafeBinaryHttpClient, {"max_redirects": -1}),
        (SafeBytesHttpClient, {"max_redirects": -1}),
        (SafeBytesHttpClient, {"max_response_bytes": 0}),
    ],
)
def test_safe_clients_reject_invalid_limits(factory, kwargs) -> None:
    with pytest.raises(ValueError):
        factory(**kwargs)
