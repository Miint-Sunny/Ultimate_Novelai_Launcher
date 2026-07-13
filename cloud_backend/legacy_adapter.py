"""Security and quota adapters for the quarantined legacy FastAPI service."""

from __future__ import annotations

import hashlib
import os
import secrets
import stat
from collections.abc import Mapping, MutableMapping
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from typing import Any

from .capabilities import HmacJobCapabilityTokens
from .errors import IdempotencyConflictError, InvalidCapabilityError, ResourceNotFoundError
from .identity import Principal, ResourceAccessPolicy, ResourceOwner
from .infrastructure.sqlite_quota import SQLiteQuotaRepository
from .quota import (
    QuotaReservationRequest,
    QuotaService,
    QuotaSettlementRequest,
    ReservationState,
)

TASK_TENANT_FIELD = "tenant_id"
TASK_OWNER_FIELD = "owner_id"
TASK_RESERVATION_FIELD = "quota_reservation_id"


@dataclass(frozen=True)
class AnonymousTaskGrant:
    """A newly-created anonymous task owner and its single-job bearer token."""

    principal: Principal
    resource: ResourceOwner
    capability_token: str


class LegacyTaskAccess:
    """Fail-closed ownership checks for legacy in-memory task dictionaries."""

    def __init__(
        self,
        capabilities: HmacJobCapabilityTokens,
        *,
        policy: ResourceAccessPolicy | None = None,
    ) -> None:
        self.capabilities = capabilities
        self.policy = policy or ResourceAccessPolicy()

    @classmethod
    def from_secret(cls, secret: bytes) -> LegacyTaskAccess:
        if not isinstance(secret, bytes) or len(secret) < 32:
            raise ValueError("legacy task capability secret must contain at least 32 bytes")
        return cls(
            HmacJobCapabilityTokens(
                {"runtime": secret},
                active_key_id="runtime",
                # Direct generation can legitimately spend hours waiting for a
                # shared queue.  Keep the opaque single-job grant valid through
                # the server's one-day result retention window.
                default_ttl=timedelta(hours=24),
                max_ttl=timedelta(hours=24),
            )
        )

    def issue_anonymous(self, *, job_id: str, tenant_id: str) -> AnonymousTaskGrant:
        owner_id = f"anonymous-{secrets.token_urlsafe(18)}"
        principal = Principal.user(owner_id, tenant_id)
        resource = ResourceOwner(tenant_id, owner_id)
        token = self.capabilities.issue(principal, job_id=job_id, resource=resource)
        return AnonymousTaskGrant(principal, resource, token)

    @staticmethod
    def bind_record(record: MutableMapping[str, Any], resource: ResourceOwner) -> None:
        record[TASK_TENANT_FIELD] = resource.tenant_id
        record[TASK_OWNER_FIELD] = resource.owner_id

    @staticmethod
    def owner_of(record: Mapping[str, Any] | None) -> ResourceOwner:
        if record is None:
            raise ResourceNotFoundError()
        tenant_id = record.get(TASK_TENANT_FIELD)
        owner_id = record.get(TASK_OWNER_FIELD)
        if not isinstance(tenant_id, str) or not tenant_id:
            # Pre-upgrade rows have no trustworthy owner and must not become public.
            raise ResourceNotFoundError()
        if owner_id is not None and (not isinstance(owner_id, str) or not owner_id):
            raise ResourceNotFoundError()
        return ResourceOwner(tenant_id, owner_id)

    def require_principal(
        self,
        record: Mapping[str, Any] | None,
        principal: Principal,
    ) -> ResourceOwner:
        resource = self.owner_of(record)
        return self.policy.require_access(principal, resource)

    def require_capability(
        self,
        record: Mapping[str, Any] | None,
        *,
        job_id: str,
        token: str,
    ) -> ResourceOwner:
        resource = self.owner_of(record)
        capability = self.capabilities.verify(token, expected_job_id=job_id)
        if capability.resource != resource:
            # Ownership changes and token/job mismatches are deliberately identical
            # to a missing task at the HTTP boundary.
            raise ResourceNotFoundError()
        return self.policy.require_access(capability.actor, resource)


def capability_key(configured_secret: str | bytes | None) -> bytes:
    """Derive fixed-size material or create an explicitly process-only key.

    Durable deployments should call :func:`persistent_capability_key` so capability
    tokens remain verifiable after a restart.  A configured value makes key rotation
    explicit without reusing an administrator or Bot shared secret directly.
    """

    if configured_secret in (None, "", b""):
        return secrets.token_bytes(32)
    raw = (
        configured_secret
        if isinstance(configured_secret, bytes)
        else configured_secret.encode("utf-8")
    )
    return hashlib.sha256(raw).digest()


def persistent_capability_key(
    configured_secret: str | bytes | None,
    path: Path,
) -> bytes:
    """Use configured material or create one restart-stable, owner-only key file."""

    if configured_secret not in (None, "", b""):
        return capability_key(configured_secret)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        existing = _read_capability_key(path)
    except FileNotFoundError:
        material = secrets.token_bytes(32)
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        try:
            descriptor = os.open(path, flags, 0o600)
        except FileExistsError:
            existing = _read_capability_key(path)
        else:
            try:
                view = memoryview(material)
                while view:
                    written = os.write(descriptor, view)
                    if written <= 0:  # pragma: no cover - regular-file invariant
                        raise OSError("capability key write made no progress")
                    view = view[written:]
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
            os.chmod(path, 0o600)
            directory = os.open(
                path.parent,
                os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
            )
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
            return material
    if len(existing) != 32:
        raise RuntimeError("capability key file is invalid")
    os.chmod(path, 0o600)
    return existing


def _read_capability_key(path: Path) -> bytes:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size != 32:
            raise RuntimeError("capability key file is invalid")
        chunks: list[bytes] = []
        remaining = 32
        while remaining:
            chunk = os.read(descriptor, remaining)
            if not chunk:
                raise RuntimeError("capability key file is invalid")
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)
    finally:
        os.close(descriptor)


class LegacyQuotaLedger:
    """Optional idempotent quota lifecycle used by the legacy generation path."""

    def __init__(self, path: Path, *, enabled: bool) -> None:
        self.enabled = enabled
        self.repository = SQLiteQuotaRepository(path)
        self.service = QuotaService(self.repository)
        self.recovered_reservations = 0

    async def initialize(self) -> None:
        if self.enabled:
            await self.repository.initialize()
            # Job recovery owns settlement.  A reservation alone cannot reveal
            # whether a paid upstream request had already crossed its billable
            # boundary when the previous process stopped.
            self.recovered_reservations = 0

    async def reserve(
        self,
        record: MutableMapping[str, Any],
        principal: Principal,
        *,
        units: int,
        idempotency_key: str,
    ) -> None:
        if not self.enabled:
            return
        result = await self.service.reserve(
            principal,
            QuotaReservationRequest(
                units=max(1, units),
                idempotency_key=idempotency_key,
                purpose="generation",
            ),
        )
        if not result.created and result.reservation.state is not ReservationState.RESERVED:
            raise IdempotencyConflictError(
                "generation idempotency key belongs to a settled request"
            )
        record[TASK_RESERVATION_FIELD] = result.reservation.id

    async def settle(
        self,
        record: Mapping[str, Any] | None,
        principal: Principal,
        *,
        succeeded: bool,
        job_id: str,
    ) -> None:
        if not self.enabled or record is None:
            return
        reservation_id = record.get(TASK_RESERVATION_FIELD)
        if not isinstance(reservation_id, str) or not reservation_id:
            return
        request = QuotaSettlementRequest(
            reservation_id=reservation_id,
            idempotency_key=f"job:{job_id}:{'capture' if succeeded else 'refund'}",
        )
        if succeeded:
            await self.service.capture(principal, request)
        else:
            await self.service.refund(principal, request)


def bearer_token(authorization: str | None) -> str:
    """Parse one canonical bearer credential without accepting query secrets."""

    if not isinstance(authorization, str):
        raise InvalidCapabilityError()
    scheme, separator, value = authorization.partition(" ")
    if separator != " " or scheme.lower() != "bearer" or not value or value != value.strip():
        raise InvalidCapabilityError()
    if any(character.isspace() for character in value):
        raise InvalidCapabilityError()
    return value
