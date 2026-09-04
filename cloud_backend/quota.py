"""Transport-neutral quota reservation domain and repository port."""

from __future__ import annotations

import unicodedata
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import Protocol, runtime_checkable

from .errors import InvalidRequestError
from .identity import (
    OwnerBoundRequest,
    Principal,
    RequestOwnerChecker,
    ResourceOwner,
    StrictRequestOwnerChecker,
)


class ReservationState(str, Enum):
    RESERVED = "reserved"
    CAPTURED = "captured"
    REFUNDED = "refunded"


class SettlementAction(str, Enum):
    CAPTURE = "capture"
    REFUND = "refund"


@dataclass(frozen=True)
class QuotaBalance:
    resource: ResourceOwner
    available_units: int
    updated_at: datetime


@dataclass(frozen=True)
class QuotaReservation:
    id: str
    resource: ResourceOwner
    units: int
    purpose: str
    idempotency_key: str
    state: ReservationState
    actor_kind: str
    actor_subject_id: str
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True)
class ReservationResult:
    reservation: QuotaReservation
    created: bool


@dataclass(frozen=True)
class SettlementResult:
    reservation: QuotaReservation
    changed: bool


@dataclass(frozen=True)
class QuotaReservationRequest:
    units: int
    idempotency_key: str
    purpose: str
    tenant_id: str | None = None
    owner_id: str | None = None

    def __post_init__(self) -> None:
        _positive_units(self.units)
        _request_key(self.idempotency_key)
        _purpose(self.purpose)


@dataclass(frozen=True)
class QuotaReservationIncreaseRequest:
    reservation_id: str
    target_units: int
    tenant_id: str | None = None
    owner_id: str | None = None

    def __post_init__(self) -> None:
        _record_id(self.reservation_id, "reservation_id")
        _positive_units(self.target_units)


@dataclass(frozen=True)
class QuotaSettlementRequest:
    reservation_id: str
    idempotency_key: str
    tenant_id: str | None = None
    owner_id: str | None = None

    def __post_init__(self) -> None:
        _record_id(self.reservation_id, "reservation_id")
        _request_key(self.idempotency_key)


@runtime_checkable
class QuotaRepository(Protocol):
    """Atomic persistence port; implementations own concurrency control."""

    async def get_balance(self, resource: ResourceOwner) -> QuotaBalance: ...

    async def reserve(
        self,
        resource: ResourceOwner,
        *,
        units: int,
        purpose: str,
        idempotency_key: str,
        actor: Principal,
    ) -> ReservationResult: ...

    async def increase_reservation(
        self,
        resource: ResourceOwner,
        *,
        reservation_id: str,
        target_units: int,
    ) -> QuotaReservation: ...

    async def settle(
        self,
        resource: ResourceOwner,
        *,
        reservation_id: str,
        action: SettlementAction,
        idempotency_key: str,
        actor: Principal,
    ) -> SettlementResult: ...


class QuotaService:
    """Reusable authorization + validation layer around an atomic quota ledger."""

    def __init__(
        self,
        repository: QuotaRepository,
        *,
        owner_checker: RequestOwnerChecker | None = None,
    ) -> None:
        self._repository = repository
        self._owner_checker = owner_checker or StrictRequestOwnerChecker()

    async def balance(
        self,
        principal: Principal,
        request: OwnerBoundRequest,
    ) -> QuotaBalance:
        resource = self._quota_resource(principal, request)
        return await self._repository.get_balance(resource)

    async def reserve(
        self,
        principal: Principal,
        request: QuotaReservationRequest,
    ) -> ReservationResult:
        resource = self._quota_resource(principal, request)
        return await self._repository.reserve(
            resource,
            units=request.units,
            purpose=request.purpose,
            idempotency_key=request.idempotency_key,
            actor=principal,
        )

    async def capture(
        self,
        principal: Principal,
        request: QuotaSettlementRequest,
    ) -> SettlementResult:
        return await self._settle(principal, request, SettlementAction.CAPTURE)

    async def increase_reservation(
        self,
        principal: Principal,
        request: QuotaReservationIncreaseRequest,
    ) -> QuotaReservation:
        resource = self._quota_resource(principal, request)
        return await self._repository.increase_reservation(
            resource,
            reservation_id=request.reservation_id,
            target_units=request.target_units,
        )

    async def refund(
        self,
        principal: Principal,
        request: QuotaSettlementRequest,
    ) -> SettlementResult:
        return await self._settle(principal, request, SettlementAction.REFUND)

    async def _settle(
        self,
        principal: Principal,
        request: QuotaSettlementRequest,
        action: SettlementAction,
    ) -> SettlementResult:
        resource = self._quota_resource(principal, request)
        return await self._repository.settle(
            resource,
            reservation_id=request.reservation_id,
            action=action,
            idempotency_key=request.idempotency_key,
            actor=principal,
        )

    def _quota_resource(
        self,
        principal: Principal,
        request: OwnerBoundRequest,
    ) -> ResourceOwner:
        resource = self._owner_checker.resolve(principal, request)
        if resource.owner_id is None:
            # Quota accounts are always concrete owner accounts, even when a tenant
            # or platform administrator operates them.
            raise InvalidRequestError("owner_id is required for a quota account")
        return resource


def _positive_units(value: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise InvalidRequestError("units must be a positive integer")
    if value > 2**63 - 1:
        raise InvalidRequestError("units is too large")
    return value


def _request_key(value: str) -> str:
    return _bounded_text(value, "idempotency_key", max_length=200)


def _purpose(value: str) -> str:
    return _bounded_text(value, "purpose", max_length=200)


def _record_id(value: str, field_name: str) -> str:
    return _bounded_text(value, field_name, max_length=200)


def _bounded_text(value: str, field_name: str, *, max_length: int) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise InvalidRequestError(f"{field_name} is invalid")
    if len(value) > max_length:
        raise InvalidRequestError(f"{field_name} is invalid")
    if any(unicodedata.category(char).startswith("C") for char in value):
        raise InvalidRequestError(f"{field_name} is invalid")
    return value
