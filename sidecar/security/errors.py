from __future__ import annotations

from collections.abc import Mapping
from typing import Any


class SecurityError(Exception):
    """Base class for security failures that can be translated at an API edge.

    Security helpers deliberately do not depend on FastAPI (or any other HTTP
    framework).  ``code``, ``status`` and ``retryable`` form the stable contract
    for an adapter that wants to turn a failure into an HTTP response.
    """

    default_code = "security_error"
    default_status = 400
    default_retryable = False

    def __init__(
        self,
        message: str,
        *,
        code: str | None = None,
        status: int | None = None,
        retryable: bool | None = None,
        details: Mapping[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.code = code if code is not None else self.default_code
        self.status = status if status is not None else self.default_status
        self.retryable = retryable if retryable is not None else self.default_retryable
        self.details = dict(details or {})

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "code": self.code,
            "message": self.message,
            "retryable": self.retryable,
        }
        if self.details:
            result["details"] = dict(self.details)
        return result


class AuthenticationError(SecurityError):
    default_code = "authentication_failed"
    default_status = 401


class AuthenticationUnavailableError(AuthenticationError):
    default_code = "authentication_unavailable"
    default_status = 503
    default_retryable = True


class PairingError(SecurityError):
    default_code = "pairing_failed"
    default_status = 401


class PairingUnavailableError(PairingError):
    default_code = "pairing_unavailable"
    default_status = 409


class PairingInvalidError(PairingError):
    default_code = "pairing_invalid"
    default_status = 401
    default_retryable = True


class PairingExpiredError(PairingError):
    default_code = "pairing_expired"
    default_status = 410
    default_retryable = True


class PairingAttemptsExceededError(PairingError):
    default_code = "pairing_attempts_exceeded"
    default_status = 429
    default_retryable = True


class PairingReplayError(PairingError):
    default_code = "pairing_replayed"
    default_status = 409


class RequestBodyError(SecurityError):
    default_code = "invalid_request_body"
    default_status = 400


class RequestBodyTooLargeError(RequestBodyError):
    default_code = "request_body_too_large"
    default_status = 413


class OutboundPolicyError(SecurityError):
    default_code = "outbound_url_rejected"
    default_status = 400


class OutboundResolutionError(OutboundPolicyError):
    default_code = "outbound_dns_failed"
    default_retryable = True


class UnsafePathError(SecurityError):
    default_code = "unsafe_path"
    default_status = 400


class PathNotFoundSecurityError(UnsafePathError):
    default_code = "safe_path_not_found"
    default_status = 404


__all__ = [
    "AuthenticationError",
    "AuthenticationUnavailableError",
    "OutboundPolicyError",
    "OutboundResolutionError",
    "PairingAttemptsExceededError",
    "PairingError",
    "PairingExpiredError",
    "PairingInvalidError",
    "PairingReplayError",
    "PairingUnavailableError",
    "PathNotFoundSecurityError",
    "RequestBodyError",
    "RequestBodyTooLargeError",
    "SecurityError",
    "UnsafePathError",
]
