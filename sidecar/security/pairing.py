from __future__ import annotations

import hmac
import math
import secrets
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass

from .errors import (
    PairingAttemptsExceededError,
    PairingExpiredError,
    PairingInvalidError,
    PairingReplayError,
    PairingUnavailableError,
)
from .tokens import get_process_session_token

DEFAULT_PAIRING_TTL_SECONDS = 120.0
DEFAULT_PAIRING_MAX_ATTEMPTS = 5
DEFAULT_PAIRING_CODE_DIGITS = 6


class PairingChallenge(str):
    """A string pairing code carrying display-safe expiry metadata.

    Being a ``str`` keeps ``manager.exchange(manager.issue())`` and JSON
    serialization convenient, while ``.code``/``.expires_at`` are available to an
    API adapter that wants an explicit challenge payload.
    """

    code: str
    expires_at: float
    expires_in: float
    max_attempts: int

    def __new__(
        cls,
        code: str,
        *,
        expires_at: float,
        expires_in: float,
        max_attempts: int,
    ) -> PairingChallenge:
        instance = str.__new__(cls, code)
        instance.code = code
        instance.expires_at = expires_at
        instance.expires_in = expires_in
        instance.max_attempts = max_attempts
        return instance

    def to_dict(self) -> dict[str, float | int | str]:
        return {
            "code": self.code,
            "expires_at": self.expires_at,
            "expires_in": self.expires_in,
            "max_attempts": self.max_attempts,
        }


@dataclass
class _PairingState:
    digest: bytes
    expires_at_monotonic: float
    attempts: int = 0


class PairingManager:
    """Issue short-lived, one-use codes that exchange for the process token."""

    def __init__(
        self,
        *,
        session_token: str | None = None,
        ttl_seconds: float = DEFAULT_PAIRING_TTL_SECONDS,
        max_attempts: int = DEFAULT_PAIRING_MAX_ATTEMPTS,
        code_digits: int = DEFAULT_PAIRING_CODE_DIGITS,
        clock: Callable[[], float] = time.monotonic,
        wall_clock: Callable[[], float] = time.time,
        code_factory: Callable[[], str] | None = None,
    ) -> None:
        if isinstance(ttl_seconds, bool) or not math.isfinite(ttl_seconds) or ttl_seconds <= 0:
            raise ValueError("pairing ttl_seconds must be positive")
        if isinstance(max_attempts, bool) or max_attempts <= 0:
            raise ValueError("pairing max_attempts must be positive")
        if isinstance(code_digits, bool) or code_digits < 6:
            raise ValueError("pairing codes must contain at least six digits")
        self._session_token = (
            get_process_session_token() if session_token is None else session_token
        )
        if not isinstance(self._session_token, str) or not self._session_token:
            raise ValueError("pairing session token must not be empty")
        self.ttl_seconds = float(ttl_seconds)
        self.max_attempts = int(max_attempts)
        self.code_digits = int(code_digits)
        self._clock = clock
        self._wall_clock = wall_clock
        self._code_factory = code_factory
        self._digest_key = secrets.token_bytes(32)
        self._state: _PairingState | None = None
        self._consumed_digest: bytes | None = None
        self._expired_digest: bytes | None = None
        self._locked_digest: bytes | None = None
        self._issued_digests: set[bytes] = set()
        self._lock = threading.RLock()

    @property
    def session_token(self) -> str:
        return self._session_token

    def _digest(self, code: str) -> bytes:
        return hmac.digest(
            self._digest_key,
            code.encode("utf-8", errors="surrogatepass"),
            "sha256",
        )

    def _new_code(self) -> str:
        if self._code_factory is not None:
            code = self._code_factory()
        else:
            code = f"{secrets.randbelow(10**self.code_digits):0{self.code_digits}d}"
        valid = (
            isinstance(code, str)
            and len(code) == self.code_digits
            and code.isascii()
            and code.isdigit()
        )
        if not valid:
            raise ValueError(
                f"pairing code factory must return exactly {self.code_digits} ASCII digits"
            )
        return code

    def issue(self) -> PairingChallenge:
        """Rotate the active code and return a fresh 120-second challenge."""

        max_generation_attempts = 1 if self._code_factory is not None else 32
        for _ in range(max_generation_attempts):
            code = self._new_code()
            digest = self._digest(code)
            now_monotonic = self._clock()
            now_wall = self._wall_clock()
            with self._lock:
                if digest in self._issued_digests:
                    continue
                self._issued_digests.add(digest)
                self._state = _PairingState(
                    digest=digest,
                    expires_at_monotonic=now_monotonic + self.ttl_seconds,
                )
                self._consumed_digest = None
                self._expired_digest = None
                self._locked_digest = None
            break
        else:
            raise PairingUnavailableError(
                "pairing code generator repeated a retired code",
                code="pairing_code_reused",
                status=503,
                retryable=True,
            )
        return PairingChallenge(
            code,
            expires_at=now_wall + self.ttl_seconds,
            expires_in=self.ttl_seconds,
            max_attempts=self.max_attempts,
        )

    issue_code = issue

    def exchange(self, code: str) -> str:
        """Consume a valid challenge and return the process session token.

        Every submitted value counts as an attempt.  A fifth bad attempt burns the
        challenge.  Successful codes can never be replayed.
        """

        valid_format = (
            isinstance(code, str)
            and len(code) == self.code_digits
            and code.isascii()
            and code.isdigit()
        )
        # Never hash an attacker-controlled unbounded string.  The non-numeric
        # fixed-size sentinel cannot collide with any code produced by issue().
        submitted = code if valid_format else "!" * self.code_digits
        submitted_digest = self._digest(submitted)
        with self._lock:
            state = self._state
            if state is None:
                if self._consumed_digest is not None and hmac.compare_digest(
                    submitted_digest, self._consumed_digest
                ):
                    raise PairingReplayError("pairing code has already been used")
                if self._expired_digest is not None and hmac.compare_digest(
                    submitted_digest, self._expired_digest
                ):
                    raise PairingExpiredError("pairing code has expired")
                if self._locked_digest is not None and hmac.compare_digest(
                    submitted_digest, self._locked_digest
                ):
                    raise PairingAttemptsExceededError("pairing attempt limit was exceeded")
                raise PairingUnavailableError("no active pairing challenge")

            if self._clock() >= state.expires_at_monotonic:
                self._expired_digest = state.digest
                self._state = None
                raise PairingExpiredError("pairing code has expired")

            matched = hmac.compare_digest(submitted_digest, state.digest)
            if not matched:
                state.attempts += 1
                attempts_remaining = self.max_attempts - state.attempts
                details = {"attempts_remaining": max(attempts_remaining, 0)}
                if state.attempts >= self.max_attempts:
                    self._locked_digest = state.digest
                    self._state = None
                    raise PairingAttemptsExceededError(
                        "pairing attempt limit was exceeded",
                        details=details,
                    )
                raise PairingInvalidError("invalid pairing code", details=details)

            self._consumed_digest = state.digest
            self._state = None
            return self._session_token

    def try_exchange(self, code: str) -> str | None:
        try:
            return self.exchange(code)
        except (
            PairingAttemptsExceededError,
            PairingExpiredError,
            PairingInvalidError,
            PairingReplayError,
            PairingUnavailableError,
        ):
            return None

    def invalidate(self) -> None:
        with self._lock:
            self._state = None
            self._consumed_digest = None
            self._expired_digest = None
            self._locked_digest = None

    @property
    def attempts_remaining(self) -> int:
        with self._lock:
            if self._state is None:
                return 0
            return max(self.max_attempts - self._state.attempts, 0)

    @property
    def active(self) -> bool:
        with self._lock:
            state = self._state
            return state is not None and self._clock() < state.expires_at_monotonic


__all__ = [
    "DEFAULT_PAIRING_CODE_DIGITS",
    "DEFAULT_PAIRING_MAX_ATTEMPTS",
    "DEFAULT_PAIRING_TTL_SECONDS",
    "PairingChallenge",
    "PairingManager",
]
