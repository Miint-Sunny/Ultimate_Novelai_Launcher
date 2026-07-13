"""Short-lived, single-job capabilities for authenticated event streams."""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import re
import secrets
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Protocol, runtime_checkable

from .errors import InvalidCapabilityError, InvalidRequestError
from .identity import Principal, PrincipalKind, ResourceAccessPolicy, ResourceOwner

JOB_EVENTS_AUDIENCE = "job-events"
FORMAT_VERSION = "v1"
MAX_TOKEN_LENGTH = 4096
MAX_PAYLOAD_BYTES = 2048
_KEY_ID = re.compile(r"^[A-Za-z0-9_-]{1,40}$")


@dataclass(frozen=True)
class JobCapability:
    """Authenticated claims extracted from a single-task bearer capability."""

    token_id: str
    job_id: str
    actor: Principal
    resource: ResourceOwner
    issued_at: datetime
    expires_at: datetime


@runtime_checkable
class JobCapabilityVerifier(Protocol):
    def verify(self, token: str, *, expected_job_id: str) -> JobCapability: ...


class HmacJobCapabilityTokens:
    """Issue and verify compact HMAC capabilities with explicit key rotation.

    Capabilities are bearer credentials.  They are deliberately short-lived and
    only authorize ``job-events`` for one job and its exact tenant/owner tuple.
    Callers must never put them in logs.  Key material must be at least 256 bits.
    """

    def __init__(
        self,
        keys: Mapping[str, bytes],
        *,
        active_key_id: str,
        issuer: str = "ultimate-novelai-cloud",
        default_ttl: timedelta = timedelta(minutes=5),
        max_ttl: timedelta = timedelta(minutes=15),
        clock_skew: timedelta = timedelta(seconds=5),
        clock: Callable[[], datetime] | None = None,
        policy: ResourceAccessPolicy | None = None,
    ) -> None:
        if not keys or active_key_id not in keys:
            raise ValueError("active capability key is missing")
        copied: dict[str, bytes] = {}
        for key_id, secret in keys.items():
            if _KEY_ID.fullmatch(key_id) is None:
                raise ValueError("capability key id is invalid")
            if not isinstance(secret, bytes) or len(secret) < 32:
                raise ValueError("capability keys must contain at least 32 bytes")
            copied[key_id] = bytes(secret)
        if not issuer or len(issuer) > 120:
            raise ValueError("capability issuer is invalid")
        if default_ttl <= timedelta(0) or max_ttl <= timedelta(0) or default_ttl > max_ttl:
            raise ValueError("capability TTL configuration is invalid")
        if clock_skew < timedelta(0) or clock_skew > timedelta(minutes=1):
            raise ValueError("capability clock skew is invalid")

        self._keys = copied
        self._active_key_id = active_key_id
        self._issuer = issuer
        self._default_ttl = default_ttl
        self._max_ttl = max_ttl
        self._clock_skew = clock_skew
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._policy = policy or ResourceAccessPolicy()

    def issue(
        self,
        principal: Principal,
        *,
        job_id: str,
        resource: ResourceOwner,
        ttl: timedelta | None = None,
    ) -> str:
        """Authorize access first, then mint a capability for exactly one job."""

        try:
            job_id = _opaque_job_id(job_id)
        except ValueError as exc:
            raise InvalidRequestError("job_id is invalid") from exc
        self._policy.require_access(principal, resource)
        lifetime = self._default_ttl if ttl is None else ttl
        if lifetime <= timedelta(0) or lifetime > self._max_ttl:
            raise InvalidRequestError("capability TTL is outside the allowed range")

        now = _aware_utc(self._clock())
        issued_at = int(now.timestamp())
        expires_at = int((now + lifetime).timestamp())
        if expires_at <= issued_at:
            raise InvalidRequestError("capability TTL must be at least one second")

        claims: dict[str, Any] = {
            "v": 1,
            "iss": self._issuer,
            "aud": JOB_EVENTS_AUDIENCE,
            "jti": secrets.token_urlsafe(18),
            "job": job_id,
            "sub": principal.subject_id,
            "kind": principal.kind.value,
            "actor_tenant": principal.tenant_id,
            "delegated_owner": principal.delegated_owner_id,
            "tenant": resource.tenant_id,
            "owner": resource.owner_id,
            "iat": issued_at,
            "exp": expires_at,
        }
        payload = json.dumps(
            claims,
            ensure_ascii=True,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        if len(payload) > MAX_PAYLOAD_BYTES:
            raise InvalidRequestError("capability claims are too large")

        key_id = self._active_key_id
        payload_segment = _b64encode(payload)
        signing_input = f"{FORMAT_VERSION}.{key_id}.{payload_segment}".encode("ascii")
        signature = hmac.new(self._keys[key_id], signing_input, hashlib.sha256).digest()
        return f"{signing_input.decode('ascii')}.{_b64encode(signature)}"

    def verify(self, token: str, *, expected_job_id: str) -> JobCapability:
        """Verify signature and strict claims, returning only authenticated data."""

        try:
            expected_job_id = _opaque_job_id(expected_job_id)
            if not isinstance(token, str) or not token or len(token) > MAX_TOKEN_LENGTH:
                raise ValueError
            version, key_id, payload_segment, signature_segment = token.split(".")
            if version != FORMAT_VERSION or _KEY_ID.fullmatch(key_id) is None:
                raise ValueError
            key = self._keys.get(key_id)
            if key is None:
                raise ValueError

            supplied_signature = _b64decode(signature_segment, max_bytes=64)
            signing_input = f"{version}.{key_id}.{payload_segment}".encode("ascii")
            expected_signature = hmac.new(key, signing_input, hashlib.sha256).digest()
            if len(supplied_signature) != len(expected_signature) or not hmac.compare_digest(
                supplied_signature, expected_signature
            ):
                raise ValueError

            payload_bytes = _b64decode(payload_segment, max_bytes=MAX_PAYLOAD_BYTES)
            claims = json.loads(payload_bytes.decode("utf-8"))
            capability = self._parse_claims(claims)
            if capability.job_id != expected_job_id:
                raise ValueError
            return capability
        except (
            AttributeError,
            binascii.Error,
            json.JSONDecodeError,
            InvalidRequestError,
            KeyError,
            TypeError,
            UnicodeDecodeError,
            ValueError,
        ) as exc:
            raise InvalidCapabilityError() from exc

    def _parse_claims(self, value: object) -> JobCapability:
        if not isinstance(value, dict):
            raise ValueError
        required = {
            "v",
            "iss",
            "aud",
            "jti",
            "job",
            "sub",
            "kind",
            "actor_tenant",
            "delegated_owner",
            "tenant",
            "owner",
            "iat",
            "exp",
        }
        if set(value) != required:
            raise ValueError
        if value["v"] != 1 or value["iss"] != self._issuer:
            raise ValueError
        if value["aud"] != JOB_EVENTS_AUDIENCE:
            raise ValueError
        issued_at_raw = value["iat"]
        expires_at_raw = value["exp"]
        if (
            not isinstance(issued_at_raw, int)
            or isinstance(issued_at_raw, bool)
            or not isinstance(expires_at_raw, int)
            or isinstance(expires_at_raw, bool)
        ):
            raise ValueError
        if expires_at_raw <= issued_at_raw:
            raise ValueError
        if expires_at_raw - issued_at_raw > int(self._max_ttl.total_seconds()):
            raise ValueError

        now = _aware_utc(self._clock())
        issued_at = datetime.fromtimestamp(issued_at_raw, timezone.utc)
        expires_at = datetime.fromtimestamp(expires_at_raw, timezone.utc)
        if issued_at > now + self._clock_skew or now >= expires_at:
            raise ValueError

        actor_tenant = _optional_string(value["actor_tenant"])
        delegated_owner = _optional_string(value["delegated_owner"])
        owner = _optional_string(value["owner"])
        actor = Principal(
            PrincipalKind(_required_string(value["kind"])),
            _required_string(value["sub"]),
            actor_tenant,
            delegated_owner,
        )
        resource = ResourceOwner(
            tenant_id=_required_string(value["tenant"]),
            owner_id=owner,
        )
        return JobCapability(
            token_id=_required_string(value["jti"]),
            job_id=_opaque_job_id(_required_string(value["job"])),
            actor=actor,
            resource=resource,
            issued_at=issued_at,
            expires_at=expires_at,
        )


def _b64encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _b64decode(value: str, *, max_bytes: int) -> bytes:
    if not value or len(value) > ((max_bytes + 2) // 3) * 4 + 4:
        raise ValueError
    padding = "=" * (-len(value) % 4)
    decoded = base64.b64decode(value + padding, altchars=b"-_", validate=True)
    if len(decoded) > max_bytes:
        raise ValueError
    return decoded


def _required_string(value: object) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError
    return value


def _optional_string(value: object) -> str | None:
    if value is None:
        return None
    return _required_string(value)


def _opaque_job_id(value: str) -> str:
    if not isinstance(value, str) or not value or value != value.strip() or len(value) > 200:
        raise ValueError("job id is invalid")
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise ValueError("job id is invalid")
    return value


def _aware_utc(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("clock must return an aware timestamp")
    return value.astimezone(timezone.utc)
