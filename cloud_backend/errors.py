"""Stable application errors without HTTP or framework status codes."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any


class CloudBackendError(Exception):
    """An expected failure safe for an outer adapter to classify.

    Adapters should map ``code`` to their own status/close codes.  Messages never
    contain bearer tokens or identify a resource hidden by authorization policy.
    """

    code = "cloud_backend_error"

    def __init__(
        self,
        message: str,
        *,
        details: Mapping[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.details = dict(details or {})


class InvalidRequestError(CloudBackendError):
    code = "invalid_request"


class AuthenticationError(CloudBackendError):
    code = "authentication_required"


class InvalidCapabilityError(AuthenticationError):
    code = "invalid_capability"

    def __init__(self) -> None:
        # Keep every parsing/signature/expiry failure indistinguishable.
        super().__init__("capability is invalid or expired")


class ResourceNotFoundError(CloudBackendError):
    code = "not_found"

    def __init__(self) -> None:
        # Authorization failures deliberately use this exact error as missing rows.
        super().__init__("resource was not found")


class IdempotencyConflictError(CloudBackendError):
    code = "idempotency_conflict"


class QuotaExceededError(CloudBackendError):
    code = "quota_exceeded"


class ReservationStateError(CloudBackendError):
    code = "reservation_state_conflict"


class UsageRecordingError(CloudBackendError):
    """The paid operation succeeded but its durable usage record did not."""

    code = "usage_recording_unavailable"


class JobStateConflictError(CloudBackendError):
    code = "job_state_conflict"


class EventSourceViolationError(CloudBackendError):
    code = "event_source_violation"
