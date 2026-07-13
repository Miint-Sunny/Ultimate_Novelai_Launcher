from __future__ import annotations

import secrets
import threading

_TOKEN_BYTES = 32
_lock = threading.Lock()
_process_session_token = secrets.token_urlsafe(_TOKEN_BYTES)


def generate_session_token() -> str:
    """Return a cryptographically random token suitable for a Bearer header."""

    return secrets.token_urlsafe(_TOKEN_BYTES)


def get_process_session_token() -> str:
    """Return the token scoped to this Python process.

    It is intentionally created in memory at import time and is never persisted.
    """

    with _lock:
        return _process_session_token


def rotate_process_session_token() -> str:
    """Rotate and return the in-memory process token.

    Rotation is explicit because callers holding an :class:`AuthManager` need to
    update their own snapshot.  Normal application startup does not call this.
    """

    global _process_session_token
    with _lock:
        _process_session_token = generate_session_token()
        return _process_session_token


__all__ = [
    "generate_session_token",
    "get_process_session_token",
    "rotate_process_session_token",
]
