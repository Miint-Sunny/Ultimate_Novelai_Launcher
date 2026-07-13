from __future__ import annotations

from collections.abc import Iterator

import pytest

from cloud_backend.pairing import PairingCapacityError, PairingCodeRegistry


class MutableClock:
    def __init__(self, value: float = 100.0) -> None:
        self.value = value

    def __call__(self) -> float:
        return self.value


def _values(*values: str) -> Iterator[str]:
    yield from values


def test_pairing_session_is_only_returned_to_issuing_browser_once() -> None:
    registry = PairingCodeRegistry(
        code_factory=lambda: "a1b2c3",
        token_factory=lambda: "p" * 43,
    )

    challenge = registry.issue()

    assert challenge.code == "A1B2C3"
    assert challenge.expires_in == 300
    assert registry.consume(challenge.code, challenge.poll_token) is None
    assert registry.bind(challenge.code.lower(), "session-id") is True
    assert registry.bind(challenge.code, "replacement") is False
    assert registry.consume(challenge.code, challenge.poll_token) == "session-id"
    assert registry.consume(challenge.code, challenge.poll_token) is None
    assert registry.active_count == 0


def test_wrong_poll_token_never_reveals_session_and_exhausts_challenge() -> None:
    registry = PairingCodeRegistry(
        max_attempts=2,
        code_factory=lambda: "ABCDEF",
        token_factory=lambda: "s" * 43,
    )
    challenge = registry.issue()
    assert registry.bind(challenge.code, "private-session") is True

    assert registry.consume(challenge.code, "x" * 43) is None
    assert registry.consume(challenge.code, "y" * 43) is None
    assert registry.consume(challenge.code, challenge.poll_token) is None
    assert registry.active_count == 0


def test_exact_binding_can_be_rolled_back_after_persistence_failure() -> None:
    registry = PairingCodeRegistry(
        code_factory=lambda: "C0FFEE",
        token_factory=lambda: "r" * 43,
    )
    challenge = registry.issue()
    assert registry.bind(challenge.code, "first-session") is True

    assert registry.rollback_bind(challenge.code, "different-session") is False
    assert registry.rollback_bind(challenge.code, "first-session") is True
    assert registry.bind(challenge.code, "retry-session") is True
    assert registry.consume(challenge.code, challenge.poll_token) == "retry-session"


def test_expired_challenge_cannot_be_bound_or_consumed() -> None:
    clock = MutableClock()
    registry = PairingCodeRegistry(
        ttl_seconds=10,
        clock=clock,
        code_factory=lambda: "123ABC",
        token_factory=lambda: "t" * 43,
    )
    challenge = registry.issue()

    clock.value += 10

    assert registry.bind(challenge.code, "late-session") is False
    assert registry.consume(challenge.code, challenge.poll_token) is None
    assert registry.active_count == 0


def test_registry_is_bounded_and_reuses_capacity_after_expiry() -> None:
    clock = MutableClock()
    codes = _values("000001", "000002")
    registry = PairingCodeRegistry(
        ttl_seconds=1,
        max_active=1,
        clock=clock,
        code_factory=lambda: next(codes),
        token_factory=lambda: "u" * 43,
    )
    registry.issue()
    with pytest.raises(PairingCapacityError):
        registry.issue()

    clock.value += 1

    assert registry.issue().code == "000002"


def test_invalid_factories_and_bind_values_fail_closed() -> None:
    duplicate_codes = _values(*(["AAAAAA"] * 101))
    registry = PairingCodeRegistry(
        code_factory=lambda: next(duplicate_codes),
        token_factory=lambda: "v" * 43,
    )
    challenge = registry.issue()
    assert registry.bind(challenge.code, "contains whitespace") is False

    with pytest.raises(PairingCapacityError):
        registry.issue()

    invalid_token_registry = PairingCodeRegistry(
        code_factory=lambda: "BBBBBB",
        token_factory=lambda: "short",
    )
    with pytest.raises(RuntimeError, match="invalid token"):
        invalid_token_registry.issue()


@pytest.mark.parametrize(
    ("ttl_seconds", "max_attempts", "max_active"),
    [(0, 1, 1), (1, 0, 1), (1, 1, 0)],
)
def test_registry_rejects_non_positive_limits(
    ttl_seconds: int,
    max_attempts: int,
    max_active: int,
) -> None:
    with pytest.raises(ValueError, match="invalid pairing registry limits"):
        PairingCodeRegistry(
            ttl_seconds=ttl_seconds,
            max_attempts=max_attempts,
            max_active=max_active,
        )
