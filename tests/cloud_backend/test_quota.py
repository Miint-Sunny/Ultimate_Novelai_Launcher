from __future__ import annotations

import asyncio
from datetime import datetime
from pathlib import Path
from typing import cast

import pytest

from cloud_backend.errors import (
    IdempotencyConflictError,
    InvalidRequestError,
    QuotaExceededError,
    ReservationStateError,
    ResourceNotFoundError,
)
from cloud_backend.identity import OwnerClaim, Principal, ResourceOwner
from cloud_backend.infrastructure import SQLiteQuotaRepository
from cloud_backend.quota import (
    QuotaReservationRequest,
    QuotaService,
    QuotaSettlementRequest,
    ReservationState,
    SettlementAction,
)


async def _ledger(tmp_path: Path, units: int = 10) -> tuple[SQLiteQuotaRepository, QuotaService]:
    repository = SQLiteQuotaRepository(tmp_path / "cloud.db")
    await repository.initialize()
    await repository.provision_account(ResourceOwner("tenant-a", "user-1"), available_units=units)
    return repository, QuotaService(repository)


@pytest.mark.asyncio
async def test_sqlite_uses_wal_and_account_provision_is_idempotent(tmp_path: Path) -> None:
    repository, _ = await _ledger(tmp_path)
    resource = ResourceOwner("tenant-a", "user-1")

    assert await repository.journal_mode() == "wal"
    assert (await repository.provision_account(resource, available_units=10)).available_units == 10
    with pytest.raises(IdempotencyConflictError):
        await repository.provision_account(resource, available_units=11)


@pytest.mark.asyncio
async def test_reserve_and_refund_are_idempotent_without_double_credit(tmp_path: Path) -> None:
    _, service = await _ledger(tmp_path)
    principal = Principal.user("user-1", "tenant-a")
    request = QuotaReservationRequest(3, "reserve-1", "generation")

    first = await service.reserve(principal, request)
    replay = await service.reserve(principal, request)
    assert first.created is True
    assert replay.created is False
    assert replay.reservation.id == first.reservation.id
    assert (await service.balance(principal, OwnerClaim())).available_units == 7

    refund = QuotaSettlementRequest(first.reservation.id, "refund-1")
    assert (await service.refund(principal, refund)).changed is True
    assert (await service.refund(principal, refund)).changed is False
    second_key = QuotaSettlementRequest(first.reservation.id, "refund-retry-new-key")
    assert (await service.refund(principal, second_key)).changed is False
    assert (await service.balance(principal, OwnerClaim())).available_units == 10


@pytest.mark.asyncio
async def test_idempotency_key_payload_mismatch_is_a_conflict(tmp_path: Path) -> None:
    _, service = await _ledger(tmp_path)
    principal = Principal.user("user-1", "tenant-a")
    await service.reserve(principal, QuotaReservationRequest(2, "same-key", "generation"))

    with pytest.raises(IdempotencyConflictError):
        await service.reserve(principal, QuotaReservationRequest(3, "same-key", "generation"))


@pytest.mark.asyncio
async def test_capture_is_idempotent_and_cannot_later_be_refunded(tmp_path: Path) -> None:
    _, service = await _ledger(tmp_path)
    principal = Principal.user("user-1", "tenant-a")
    reserved = await service.reserve(
        principal, QuotaReservationRequest(2, "reserve-capture", "generation")
    )
    capture = QuotaSettlementRequest(reserved.reservation.id, "capture-1")

    assert (await service.capture(principal, capture)).changed is True
    assert (await service.capture(principal, capture)).changed is False
    assert reserved.reservation.state is ReservationState.RESERVED
    with pytest.raises(ReservationStateError):
        await service.refund(
            principal,
            QuotaSettlementRequest(reserved.reservation.id, "late-refund"),
        )
    assert (await service.balance(principal, OwnerClaim())).available_units == 8


@pytest.mark.asyncio
async def test_wrong_owner_refund_is_not_found_and_does_not_mutate(tmp_path: Path) -> None:
    _, service = await _ledger(tmp_path)
    owner = Principal.user("user-1", "tenant-a")
    reserved = await service.reserve(
        owner, QuotaReservationRequest(4, "reserve-private", "generation")
    )

    with pytest.raises(ResourceNotFoundError):
        await service.refund(
            Principal.user("user-2", "tenant-a"),
            QuotaSettlementRequest(reserved.reservation.id, "stolen-refund"),
        )
    assert (await service.balance(owner, OwnerClaim())).available_units == 6


@pytest.mark.asyncio
async def test_concurrent_reservations_cannot_overdraw(tmp_path: Path) -> None:
    _, service = await _ledger(tmp_path, units=5)
    principal = Principal.user("user-1", "tenant-a")

    results = await asyncio.gather(
        service.reserve(principal, QuotaReservationRequest(4, "concurrent-1", "generation")),
        service.reserve(principal, QuotaReservationRequest(4, "concurrent-2", "generation")),
        return_exceptions=True,
    )
    assert sum(not isinstance(result, BaseException) for result in results) == 1
    assert sum(isinstance(result, QuotaExceededError) for result in results) == 1
    assert (await service.balance(principal, OwnerClaim())).available_units == 1


@pytest.mark.asyncio
async def test_repository_lifecycle_and_account_validation(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="positive"):
        SQLiteQuotaRepository(tmp_path / "bad.db", busy_timeout_ms=0)

    repository = SQLiteQuotaRepository(tmp_path / "quota.db")
    assert repository.ready is False
    with pytest.raises(RuntimeError, match="not been initialized"):
        await repository.get_balance(ResourceOwner("tenant", "owner"))
    await repository.initialize()
    await repository.initialize()
    assert repository.ready is True

    with pytest.raises(ResourceNotFoundError):
        await repository.get_balance(ResourceOwner("tenant", "missing"))
    with pytest.raises(InvalidRequestError, match="owner_id"):
        await repository.provision_account(ResourceOwner("tenant", None), available_units=1)
    for units in (-1, True, 2**63):
        with pytest.raises(InvalidRequestError, match="available_units"):
            await repository.provision_account(
                ResourceOwner("tenant", "owner"), available_units=units
            )


@pytest.mark.asyncio
async def test_direct_reserve_requires_account_and_valid_factory(tmp_path: Path) -> None:
    resource = ResourceOwner("tenant", "owner")
    principal = Principal.user("owner", "tenant")
    repository = SQLiteQuotaRepository(tmp_path / "quota.db")
    await repository.initialize()
    with pytest.raises(ResourceNotFoundError):
        await repository.reserve(
            resource,
            units=1,
            purpose="generation",
            idempotency_key="missing-account",
            actor=principal,
        )

    invalid_factory = SQLiteQuotaRepository(
        tmp_path / "invalid-factory.db",
        reservation_id_factory=lambda: "",
    )
    await invalid_factory.initialize()
    await invalid_factory.provision_account(resource, available_units=1)
    with pytest.raises(RuntimeError, match="factory"):
        await invalid_factory.reserve(
            resource,
            units=1,
            purpose="generation",
            idempotency_key="invalid-id",
            actor=principal,
        )
    assert (await invalid_factory.get_balance(resource)).available_units == 1


@pytest.mark.asyncio
async def test_direct_settlement_validation_not_found_and_replay_conflict(tmp_path: Path) -> None:
    repository, _ = await _ledger(tmp_path, units=2)
    resource = ResourceOwner("tenant-a", "user-1")
    principal = Principal.user("user-1", "tenant-a")
    with pytest.raises(InvalidRequestError, match="action"):
        await repository.settle(
            resource,
            reservation_id="missing",
            action=cast(SettlementAction, "refund"),
            idempotency_key="invalid-action",
            actor=principal,
        )
    with pytest.raises(ResourceNotFoundError):
        await repository.settle(
            resource,
            reservation_id="missing",
            action=SettlementAction.REFUND,
            idempotency_key="missing-reservation",
            actor=principal,
        )

    reserved = await repository.reserve(
        resource,
        units=1,
        purpose="generation",
        idempotency_key="reserve",
        actor=principal,
    )
    await repository.settle(
        resource,
        reservation_id=reserved.reservation.id,
        action=SettlementAction.REFUND,
        idempotency_key="same-settlement",
        actor=principal,
    )
    with pytest.raises(IdempotencyConflictError, match="different settlement"):
        await repository.settle(
            resource,
            reservation_id=reserved.reservation.id,
            action=SettlementAction.CAPTURE,
            idempotency_key="same-settlement",
            actor=principal,
        )


@pytest.mark.asyncio
async def test_interrupted_reservation_recovery_is_idempotent(tmp_path: Path) -> None:
    repository, _ = await _ledger(tmp_path, units=3)
    resource = ResourceOwner("tenant-a", "user-1")
    principal = Principal.user("user-1", "tenant-a")
    open_reservation = await repository.reserve(
        resource,
        units=2,
        purpose="generation",
        idempotency_key="interrupted",
        actor=principal,
    )

    assert (await repository.get_balance(resource)).available_units == 1
    assert await repository.refund_interrupted_reservations() == 1
    assert await repository.refund_interrupted_reservations() == 0
    assert (await repository.get_balance(resource)).available_units == 3
    replay = await repository.settle(
        resource,
        reservation_id=open_reservation.reservation.id,
        action=SettlementAction.REFUND,
        idempotency_key=f"recovery:{open_reservation.reservation.id}",
        actor=principal,
    )
    assert replay.changed is False


@pytest.mark.asyncio
async def test_repository_rejects_naive_clock(tmp_path: Path) -> None:
    repository = SQLiteQuotaRepository(
        tmp_path / "quota.db",
        clock=lambda: datetime(2026, 7, 13),
    )
    await repository.initialize()
    with pytest.raises(ValueError, match="aware"):
        await repository.provision_account(
            ResourceOwner("tenant", "owner"),
            available_units=1,
        )
