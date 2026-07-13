"""Errors that describe application failures without choosing a transport."""

from __future__ import annotations

from collections.abc import Mapping
from enum import Enum

from .types import JsonValue


class ErrorCode(str, Enum):
    INVALID_ARGUMENT = "invalid_argument"
    AUTHENTICATION_REQUIRED = "authentication_required"
    PERMISSION_DENIED = "permission_denied"
    NOT_FOUND = "not_found"
    CONFLICT = "conflict"
    EXPIRED = "expired"
    CAPACITY_EXCEEDED = "capacity_exceeded"
    DEPENDENCY_UNAVAILABLE = "dependency_unavailable"
    NOT_READY = "not_ready"
    INTERNAL = "internal_error"


class AppError(Exception):
    """Base class for expected application failures.

    ``code`` and ``details`` are stable domain data.  HTTP status codes, response
    bodies, CLI exit codes, and log levels belong to the outer adapter.
    """

    default_code = ErrorCode.INTERNAL

    def __init__(
        self,
        message: str,
        *,
        code: ErrorCode | str | None = None,
        details: Mapping[str, JsonValue] | None = None,
        retryable: bool | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.code = code or self.default_code
        self.details = dict(details or {})
        self.retryable = (
            bool(getattr(type(self), "retryable", False)) if retryable is None else retryable
        )

    @property
    def code_value(self) -> str:
        code = self.code
        return code.value if isinstance(code, ErrorCode) else str(code)


class InvalidArgumentError(AppError):
    default_code = ErrorCode.INVALID_ARGUMENT


class AuthenticationRequiredError(AppError):
    default_code = ErrorCode.AUTHENTICATION_REQUIRED


class PermissionDeniedError(AppError):
    default_code = ErrorCode.PERMISSION_DENIED


class ResourceNotFoundError(AppError):
    default_code = ErrorCode.NOT_FOUND


class ConflictError(AppError):
    default_code = ErrorCode.CONFLICT


class ResourceExpiredError(AppError):
    default_code = ErrorCode.EXPIRED


class CapacityExceededError(AppError):
    default_code = ErrorCode.CAPACITY_EXCEEDED


class DependencyUnavailableError(AppError):
    default_code = ErrorCode.DEPENDENCY_UNAVAILABLE


class RuntimeNotReadyError(AppError):
    default_code = ErrorCode.NOT_READY


# A more explicit name for consumers that prefer architecture terminology.
ApplicationError = AppError
