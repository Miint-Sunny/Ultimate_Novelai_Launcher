from __future__ import annotations

import base64
import hashlib
import hmac
import json
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest

import cloud_backend.capabilities as capability_module
from cloud_backend.capabilities import HmacJobCapabilityTokens
from cloud_backend.errors import InvalidCapabilityError, InvalidRequestError, ResourceNotFoundError
from cloud_backend.identity import Principal, ResourceOwner

KEY_MATERIAL = bytes(range(32))


class AdjustableClock:
    def __init__(self) -> None:
        self.now = datetime(2026, 7, 13, 12, 0, tzinfo=timezone.utc)

    def __call__(self) -> datetime:
        return self.now


def _claims(token: str) -> dict[str, Any]:
    payload = token.split(".")[2]
    return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))


def _signed_payload(token: str, value: object, *, key: bytes = KEY_MATERIAL) -> str:
    version, key_id, _, _ = token.split(".")
    payload = json.dumps(value, separators=(",", ":"), sort_keys=True).encode("utf-8")
    payload_segment = base64.urlsafe_b64encode(payload).rstrip(b"=").decode("ascii")
    signing_input = f"{version}.{key_id}.{payload_segment}".encode("ascii")
    signature = hmac.new(key, signing_input, hashlib.sha256).digest()
    signature_segment = base64.urlsafe_b64encode(signature).rstrip(b"=").decode("ascii")
    return f"{signing_input.decode('ascii')}.{signature_segment}"


def test_capability_is_bound_to_one_job_and_exact_owner() -> None:
    clock = AdjustableClock()
    capabilities = HmacJobCapabilityTokens(
        {"primary": KEY_MATERIAL}, active_key_id="primary", clock=clock
    )
    principal = Principal.user("user-1", "tenant-a")
    resource = ResourceOwner("tenant-a", "user-1")
    bearer = capabilities.issue(principal, job_id="job-1", resource=resource)

    claim = capabilities.verify(bearer, expected_job_id="job-1")
    assert claim.job_id == "job-1"
    assert claim.actor == principal
    assert claim.resource == resource
    with pytest.raises(InvalidCapabilityError):
        capabilities.verify(bearer, expected_job_id="job-2")


def test_tamper_and_expiry_fail_with_same_safe_error() -> None:
    clock = AdjustableClock()
    capabilities = HmacJobCapabilityTokens(
        {"primary": KEY_MATERIAL}, active_key_id="primary", clock=clock
    )
    bearer = capabilities.issue(
        Principal.user("user-1", "tenant-a"),
        job_id="job-1",
        resource=ResourceOwner("tenant-a", "user-1"),
        ttl=timedelta(seconds=10),
    )
    parts = bearer.split(".")
    parts[2] = ("A" if parts[2][0] != "A" else "B") + parts[2][1:]

    with pytest.raises(InvalidCapabilityError) as tampered:
        capabilities.verify(".".join(parts), expected_job_id="job-1")
    clock.now += timedelta(seconds=10)
    with pytest.raises(InvalidCapabilityError) as expired:
        capabilities.verify(bearer, expected_job_id="job-1")
    assert str(tampered.value) == str(expired.value)
    assert "job-1" not in str(expired.value)


def test_capability_cannot_be_issued_for_an_unauthorized_owner() -> None:
    capabilities = HmacJobCapabilityTokens({"primary": KEY_MATERIAL}, active_key_id="primary")
    with pytest.raises(ResourceNotFoundError):
        capabilities.issue(
            Principal.user("user-2", "tenant-a"),
            job_id="job-1",
            resource=ResourceOwner("tenant-a", "user-1"),
        )


def test_verifier_accepts_old_configured_key_during_rotation() -> None:
    clock = AdjustableClock()
    old = HmacJobCapabilityTokens({"old": KEY_MATERIAL}, active_key_id="old", clock=clock)
    bearer = old.issue(
        Principal.user("user-1", "tenant-a"),
        job_id="job-1",
        resource=ResourceOwner("tenant-a", "user-1"),
    )
    rotated = HmacJobCapabilityTokens(
        {"old": KEY_MATERIAL, "new": bytes(reversed(range(32)))},
        active_key_id="new",
        clock=clock,
    )

    assert rotated.verify(bearer, expected_job_id="job-1").job_id == "job-1"


@pytest.mark.parametrize(
    "kwargs",
    [
        {"keys": {}, "active_key_id": "primary"},
        {"keys": {"other": KEY_MATERIAL}, "active_key_id": "primary"},
        {"keys": {"bad key": KEY_MATERIAL}, "active_key_id": "bad key"},
        {"keys": {"primary": b"short"}, "active_key_id": "primary"},
        {"keys": {"primary": KEY_MATERIAL}, "active_key_id": "primary", "issuer": ""},
        {
            "keys": {"primary": KEY_MATERIAL},
            "active_key_id": "primary",
            "default_ttl": timedelta(0),
        },
        {
            "keys": {"primary": KEY_MATERIAL},
            "active_key_id": "primary",
            "default_ttl": timedelta(minutes=20),
        },
        {
            "keys": {"primary": KEY_MATERIAL},
            "active_key_id": "primary",
            "clock_skew": timedelta(seconds=-1),
        },
        {
            "keys": {"primary": KEY_MATERIAL},
            "active_key_id": "primary",
            "clock_skew": timedelta(minutes=2),
        },
    ],
)
def test_capability_configuration_is_fail_closed(kwargs: dict[str, Any]) -> None:
    with pytest.raises(ValueError):
        HmacJobCapabilityTokens(**kwargs)


def test_issue_rejects_invalid_job_ttl_clock_and_oversized_claims(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = AdjustableClock()
    capabilities = HmacJobCapabilityTokens(
        {"primary": KEY_MATERIAL}, active_key_id="primary", clock=clock
    )
    principal = Principal.user("user-1", "tenant-a")
    resource = ResourceOwner("tenant-a", "user-1")
    for job_id in ("", " bad", "bad\x00id"):
        with pytest.raises(InvalidRequestError, match="job_id"):
            capabilities.issue(principal, job_id=job_id, resource=resource)
    for ttl in (timedelta(0), timedelta(minutes=16), timedelta(milliseconds=100)):
        with pytest.raises(InvalidRequestError, match="TTL"):
            capabilities.issue(principal, job_id="job", resource=resource, ttl=ttl)

    naive = HmacJobCapabilityTokens(
        {"primary": KEY_MATERIAL},
        active_key_id="primary",
        clock=lambda: datetime(2026, 7, 13),
    )
    with pytest.raises(ValueError, match="aware"):
        naive.issue(principal, job_id="job", resource=resource)

    monkeypatch.setattr(capability_module.secrets, "token_urlsafe", lambda size: "x" * 3000)
    with pytest.raises(InvalidRequestError, match="too large"):
        capabilities.issue(principal, job_id="job", resource=resource)


@pytest.mark.parametrize(
    "token",
    [
        "",
        "too.few.parts",
        "v2.primary.payload.signature",
        "v1.unknown.payload.signature",
        "v1.bad key.payload.signature",
        "v1.primary.payload.",
        "v1.primary.payload." + "A" * 100,
    ],
)
def test_verify_rejects_malformed_envelope(token: str) -> None:
    capabilities = HmacJobCapabilityTokens({"primary": KEY_MATERIAL}, active_key_id="primary")
    with pytest.raises(InvalidCapabilityError):
        capabilities.verify(token, expected_job_id="job")


@pytest.mark.parametrize(
    "mutate",
    [
        lambda claims: [],
        lambda claims: {key: value for key, value in claims.items() if key != "aud"},
        lambda claims: {**claims, "v": 2},
        lambda claims: {**claims, "iss": "other"},
        lambda claims: {**claims, "aud": "other"},
        lambda claims: {**claims, "iat": True},
        lambda claims: {**claims, "exp": claims["iat"]},
        lambda claims: {**claims, "exp": claims["iat"] + 3600},
        lambda claims: {**claims, "iat": claims["iat"] + 60, "exp": claims["exp"] + 60},
        lambda claims: {**claims, "kind": "unknown"},
        lambda claims: {**claims, "sub": ""},
        lambda claims: {**claims, "owner": 123},
        lambda claims: {**claims, "job": "bad\x00id"},
    ],
)
def test_verify_rejects_invalid_signed_claims(mutate) -> None:
    clock = AdjustableClock()
    capabilities = HmacJobCapabilityTokens(
        {"primary": KEY_MATERIAL}, active_key_id="primary", clock=clock
    )
    bearer = capabilities.issue(
        Principal.user("user-1", "tenant-a"),
        job_id="job-1",
        resource=ResourceOwner("tenant-a", "user-1"),
    )
    invalid = mutate(_claims(bearer))
    signed = _signed_payload(bearer, invalid)

    with pytest.raises(InvalidCapabilityError):
        capabilities.verify(signed, expected_job_id="job-1")
