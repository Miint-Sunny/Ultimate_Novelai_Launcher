from __future__ import annotations

import hashlib
import hmac
import re
import threading
from collections.abc import Iterable, Mapping
from typing import Any, cast

from .errors import AuthenticationError, AuthenticationUnavailableError
from .tokens import get_process_session_token

AUTHORIZATION_HEADER = "Authorization"
LEGACY_AUTH_HEADER = "X-Sidecar-Auth"
_MAX_TOKEN_LENGTH = 4096
_BEARER_TOKEN = re.compile(r"[A-Za-z0-9\-._~+/]+=*\Z")


def _fixed_digest(value: str) -> bytes:
    """Hash before compare so the secret's length is not a timing signal."""

    return hashlib.sha256(value.encode("utf-8", errors="surrogatepass")).digest()


def constant_time_token_equal(candidate: str, expected: str) -> bool:
    """Compare two tokens through fixed-size digests using ``compare_digest``."""

    if not isinstance(candidate, str) or not isinstance(expected, str):
        return False
    # Bound attacker-controlled hashing work.  Still perform one fixed-size
    # comparison on invalid input so the rejection path is uniform.
    candidate_valid = 0 < len(candidate) <= _MAX_TOKEN_LENGTH
    candidate_value = candidate if candidate_valid else ""
    equal = hmac.compare_digest(_fixed_digest(candidate_value), _fixed_digest(expected))
    return candidate_valid and equal


def parse_bearer_token(value: str) -> str:
    """Parse one RFC 6750 Bearer credential or raise ``AuthenticationError``."""

    if not isinstance(value, str) or len(value) > _MAX_TOKEN_LENGTH + 32:
        raise AuthenticationError("invalid Authorization header")
    stripped = value.strip(" \t")
    if any(ord(character) < 0x20 or ord(character) == 0x7F for character in stripped):
        raise AuthenticationError("invalid Authorization header")
    parts = stripped.split()
    if len(parts) != 2 or parts[0].casefold() != "bearer":
        raise AuthenticationError("Bearer authorization is required")
    token = parts[1]
    if len(token) > _MAX_TOKEN_LENGTH or not _BEARER_TOKEN.fullmatch(token):
        raise AuthenticationError("invalid Bearer credential")
    return token


def _text(value: Any) -> str:
    if isinstance(value, bytes):
        return value.decode("latin-1")
    if isinstance(value, str):
        return value
    return str(value)


def _header_values(headers: Any, name: str) -> list[str]:
    """Read a header without hiding duplicate values.

    Works with normal mappings, Starlette-style multidicts, and raw ASGI header
    iterables.  Duplicate credential headers are rejected by ``AuthManager``.
    """

    if headers is None:
        return []
    lower_name = name.casefold()

    getlist = getattr(headers, "getlist", None)
    if callable(getlist):
        values = list(cast(Iterable[Any], getlist(name)))
        if not values:
            values = list(cast(Iterable[Any], getlist(name.lower())))
        return [_text(value) for value in values]

    if isinstance(headers, Mapping):
        result: list[str] = []
        for key, value in headers.items():
            if _text(key).casefold() != lower_name:
                continue
            if isinstance(value, (list, tuple)):
                result.extend(_text(item) for item in value)
            else:
                result.append(_text(value))
        return result

    if isinstance(headers, Iterable) and not isinstance(headers, (str, bytes)):
        result: list[str] = []
        for item in headers:
            try:
                key, value = item
            except (TypeError, ValueError):
                continue
            if _text(key).casefold() == lower_name:
                result.append(_text(value))
        return result
    return []


def _validate_legacy_token(value: str) -> str:
    if not isinstance(value, str):
        raise AuthenticationError("invalid sidecar credential")
    if not value or len(value) > _MAX_TOKEN_LENGTH:
        raise AuthenticationError("invalid sidecar credential")
    if any(ord(character) < 0x21 or ord(character) == 0x7F for character in value):
        raise AuthenticationError("invalid sidecar credential")
    return value


class AuthManager:
    """Validate the process credential from canonical or compatibility headers.

    ``Authorization: Bearer ...`` is canonical.  ``X-Sidecar-Auth`` is accepted
    only when no Authorization header is supplied, unless both headers carry the
    same token.  This prevents an ambiguous request from being interpreted
    differently by two layers of the stack.
    """

    def __init__(
        self,
        session_token: str | None = None,
        *,
        allow_legacy_header: bool = True,
        required: bool = True,
    ) -> None:
        self._lock = threading.RLock()
        self._session_token = (
            get_process_session_token() if session_token is None else session_token
        )
        if not isinstance(self._session_token, str):
            raise TypeError("session token must be a string")
        self.allow_legacy_header = allow_legacy_header
        self.required = required

    @property
    def enabled(self) -> bool:
        with self._lock:
            return bool(self._session_token)

    @property
    def session_token(self) -> str:
        with self._lock:
            return self._session_token

    def set_session_token(self, value: str) -> None:
        if not isinstance(value, str):
            raise TypeError("session token must be a string")
        with self._lock:
            self._session_token = value

    def authorization_header(self) -> dict[str, str]:
        with self._lock:
            token = self._session_token
        if not token:
            raise AuthenticationUnavailableError("sidecar authentication is not configured")
        return {AUTHORIZATION_HEADER: f"Bearer {token}"}

    def extract(
        self,
        headers: Any = None,
        *,
        authorization: str | None = None,
        x_sidecar_auth: str | None = None,
    ) -> str:
        authorization_values = _header_values(headers, AUTHORIZATION_HEADER)
        legacy_values = _header_values(headers, LEGACY_AUTH_HEADER)
        if authorization is not None:
            authorization_values.append(authorization)
        if x_sidecar_auth is not None:
            legacy_values.append(x_sidecar_auth)

        if len(authorization_values) > 1 or len(legacy_values) > 1:
            raise AuthenticationError("duplicate authentication headers are not allowed")

        if authorization_values:
            candidate = parse_bearer_token(authorization_values[0])
            if legacy_values:
                if not self.allow_legacy_header:
                    raise AuthenticationError("legacy authentication header is not accepted")
                legacy = _validate_legacy_token(legacy_values[0])
                if not constant_time_token_equal(legacy, candidate):
                    raise AuthenticationError("conflicting authentication headers")
            return candidate

        if legacy_values and self.allow_legacy_header:
            return _validate_legacy_token(legacy_values[0])

        raise AuthenticationError("Bearer authorization is required")

    def require(
        self,
        headers: Any = None,
        *,
        authorization: str | None = None,
        x_sidecar_auth: str | None = None,
    ) -> str:
        with self._lock:
            expected = self._session_token
        if not expected:
            if self.required:
                raise AuthenticationUnavailableError("sidecar authentication is not configured")
            return ""

        candidate = self.extract(
            headers,
            authorization=authorization,
            x_sidecar_auth=x_sidecar_auth,
        )
        if not constant_time_token_equal(candidate, expected):
            raise AuthenticationError("invalid sidecar credential")
        return candidate

    def require_bearer(self, headers: Any = None) -> str:
        """Require the canonical credential and reject the legacy header entirely.

        Versioned APIs use this path so ``X-Sidecar-Auth`` remains confined to the
        one-release compatibility router, even when both headers contain the same
        token.
        """

        with self._lock:
            expected = self._session_token
        if not expected:
            if self.required:
                raise AuthenticationUnavailableError("sidecar authentication is not configured")
            return ""

        authorization_values = _header_values(headers, AUTHORIZATION_HEADER)
        legacy_values = _header_values(headers, LEGACY_AUTH_HEADER)
        if len(authorization_values) > 1 or len(legacy_values) > 1:
            raise AuthenticationError("duplicate authentication headers are not allowed")
        if legacy_values:
            raise AuthenticationError(
                "legacy authentication is only accepted by compatibility APIs"
            )
        if not authorization_values:
            raise AuthenticationError("Bearer authorization is required")
        candidate = parse_bearer_token(authorization_values[0])
        if not constant_time_token_equal(candidate, expected):
            raise AuthenticationError("invalid sidecar credential")
        return candidate

    authenticate = require

    def verify(
        self,
        headers: Any = None,
        *,
        authorization: str | None = None,
        x_sidecar_auth: str | None = None,
    ) -> bool:
        try:
            self.require(
                headers,
                authorization=authorization,
                x_sidecar_auth=x_sidecar_auth,
            )
        except AuthenticationError:
            return False
        return True


__all__ = [
    "AUTHORIZATION_HEADER",
    "AuthManager",
    "LEGACY_AUTH_HEADER",
    "constant_time_token_equal",
    "parse_bearer_token",
]
