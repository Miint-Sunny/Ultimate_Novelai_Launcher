"""Short human pairing codes bound to an unguessable browser polling secret."""

from __future__ import annotations

import hashlib
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass


class PairingCapacityError(RuntimeError):
    """The bounded in-memory challenge registry is full."""


@dataclass(frozen=True)
class PairingChallenge:
    code: str
    poll_token: str
    expires_in: int


@dataclass
class _PairingRecord:
    poll_token_hash: bytes
    expires_at: float
    session_id: str | None = None
    failed_attempts: int = 0


class PairingCodeRegistry:
    """Coordinate a Bot-confirmed code without exposing its resulting session.

    The six-character code is intended for a human to copy into a Bot message and
    is therefore not an authentication secret.  Only the browser that also holds
    the 256-bit poll token can consume the session produced by the Bot.
    """

    def __init__(
        self,
        *,
        ttl_seconds: int = 300,
        max_attempts: int = 5,
        max_active: int = 1000,
        clock: Callable[[], float] = time.monotonic,
        code_factory: Callable[[], str] | None = None,
        token_factory: Callable[[], str] | None = None,
    ) -> None:
        if ttl_seconds < 1 or max_attempts < 1 or max_active < 1:
            raise ValueError("invalid pairing registry limits")
        self.ttl_seconds = ttl_seconds
        self.max_attempts = max_attempts
        self.max_active = max_active
        self._clock = clock
        self._code_factory = code_factory or (lambda: secrets.token_hex(3).upper())
        self._token_factory = token_factory or (lambda: secrets.token_urlsafe(32))
        self._records: dict[str, _PairingRecord] = {}

    @property
    def active_count(self) -> int:
        self.prune()
        return len(self._records)

    def issue(self) -> PairingChallenge:
        self.prune()
        if len(self._records) >= self.max_active:
            raise PairingCapacityError("too many active pairing challenges")
        code = ""
        for _ in range(100):
            candidate = _normalize_code(self._code_factory())
            if candidate and candidate not in self._records:
                code = candidate
                break
        if not code:
            raise PairingCapacityError("could not allocate a unique pairing code")
        poll_token = self._token_factory()
        if not _valid_poll_token(poll_token):
            raise RuntimeError("pairing token factory returned an invalid token")
        self._records[code] = _PairingRecord(
            poll_token_hash=_token_hash(poll_token),
            expires_at=self._clock() + self.ttl_seconds,
        )
        return PairingChallenge(code, poll_token, self.ttl_seconds)

    def bind(self, code: str, session_id: str) -> bool:
        """Bind a Bot-created session exactly once to a live human code."""

        self.prune()
        normalized = _normalize_code(code)
        record = self._records.get(normalized)
        if record is None or record.session_id is not None:
            return False
        normalized_session = str(session_id).strip()
        if not normalized_session or any(char.isspace() for char in normalized_session):
            return False
        record.session_id = normalized_session
        return True

    def rollback_bind(self, code: str, session_id: str) -> bool:
        """Undo this exact binding when durable session creation fails."""

        self.prune()
        normalized = _normalize_code(code)
        record = self._records.get(normalized)
        normalized_session = str(session_id).strip()
        if record is None or record.session_id != normalized_session:
            return False
        record.session_id = None
        return True

    def consume(self, code: str, poll_token: str) -> str | None:
        """Return and remove the bound session only to the issuing browser."""

        self.prune()
        normalized = _normalize_code(code)
        record = self._records.get(normalized)
        if record is None:
            return None
        supplied_hash = _token_hash(poll_token) if _valid_poll_token(poll_token) else b""
        if not secrets.compare_digest(supplied_hash, record.poll_token_hash):
            record.failed_attempts += 1
            if record.failed_attempts >= self.max_attempts:
                self._records.pop(normalized, None)
            return None
        if record.session_id is None:
            return None
        session_id = record.session_id
        self._records.pop(normalized, None)
        return session_id

    def prune(self) -> int:
        now = self._clock()
        expired = [code for code, record in self._records.items() if now >= record.expires_at]
        for code in expired:
            self._records.pop(code, None)
        return len(expired)


def _normalize_code(value: object) -> str:
    code = str(value).strip().upper()
    if len(code) != 6 or any(char not in "0123456789ABCDEF" for char in code):
        return ""
    return code


def _valid_poll_token(value: object) -> bool:
    return (
        isinstance(value, str)
        and 32 <= len(value) <= 256
        and value == value.strip()
        and not any(char.isspace() for char in value)
    )


def _token_hash(value: str) -> bytes:
    return hashlib.sha256(value.encode("utf-8")).digest()


__all__ = [
    "PairingCapacityError",
    "PairingChallenge",
    "PairingCodeRegistry",
]
