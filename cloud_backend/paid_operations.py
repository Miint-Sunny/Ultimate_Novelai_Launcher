"""Transport-neutral validation and success-only accounting for paid operations."""

from __future__ import annotations

import asyncio
import base64
import binascii
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Protocol, TypeVar

from .errors import AuthenticationError, InvalidRequestError, UsageRecordingError
from .identity import Principal

MAX_PAID_IMAGE_BYTES = 20 * 1024 * 1024
MAX_PAID_RESULT_BYTES = 32 * 1024 * 1024
MAX_TRANSLATE_CONTEXT_BYTES = 4 * 1024 * 1024

_T = TypeVar("_T")
_ALLOWED_IMAGE_MIME_TYPES = frozenset(
    {"image/gif", "image/jpeg", "image/png", "image/webp"}
)


class UsageRecorder(Protocol):
    async def __call__(self, owner_id: str, points: int, reason: str) -> None: ...


@dataclass(frozen=True)
class UsageCharge:
    points: int
    reason: str

    def __post_init__(self) -> None:
        if not isinstance(self.points, int) or isinstance(self.points, bool) or self.points <= 0:
            raise InvalidRequestError("usage points must be a positive integer")
        if (
            not isinstance(self.reason, str)
            or not self.reason
            or self.reason != self.reason.strip()
            or len(self.reason) > 200
        ):
            raise InvalidRequestError("usage reason is invalid")


class PaidOperationService:
    """Run provider work for an authenticated owner and account only success.

    The legacy points table is usage reporting, not a reservable quota ledger.
    Consequently this service deliberately does not invent reservation semantics:
    provider errors and cancellation record nothing, while successful operations
    use the existing per-owner recorder exactly once.
    """

    def __init__(self, recorder: UsageRecorder) -> None:
        self._recorder = recorder

    async def execute(
        self,
        principal: Principal,
        operation: Callable[[], Awaitable[_T]],
        *,
        charge: UsageCharge | None = None,
        account_when: Callable[[_T], bool] | None = None,
    ) -> _T:
        owner_id = require_paid_owner(principal)
        try:
            result = await operation()
        except asyncio.CancelledError:
            raise
        if charge is not None and (account_when is None or account_when(result)):
            try:
                await self._recorder(owner_id, charge.points, charge.reason)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                # Keep the already-completed provider call distinct from an
                # upstream failure.  This outage is deliberately *not* described
                # as retry-safe: without request idempotency, a client retry could
                # repeat paid provider work.
                raise UsageRecordingError(
                    "paid operation succeeded but usage recording is unavailable"
                ) from exc
        return result


def require_paid_owner(principal: Principal) -> str:
    owner_id = principal.effective_owner_id
    if owner_id is None or principal.tenant_id is None:
        raise AuthenticationError("an authenticated owner is required")
    return owner_id


def normalize_image_base64(
    value: str,
    *,
    max_decoded_bytes: int = MAX_PAID_IMAGE_BYTES,
) -> str:
    """Validate a bounded PNG/JPEG/WebP/GIF and return canonical raw base64."""

    if not isinstance(value, str) or not value:
        raise InvalidRequestError("image is required")
    if max_decoded_bytes <= 0:
        raise ValueError("max_decoded_bytes must be positive")

    encoded = value
    declared_mime: str | None = None
    if value.startswith("data:"):
        header, separator, encoded = value.partition(",")
        if not separator or not header.endswith(";base64"):
            raise InvalidRequestError("image data URL is invalid")
        declared_mime = header[5:-7].lower()
        if declared_mime not in _ALLOWED_IMAGE_MIME_TYPES:
            raise InvalidRequestError("image MIME type is unsupported")

    max_encoded_length = 4 * ((max_decoded_bytes + 2) // 3)
    if not encoded or len(encoded) > max_encoded_length:
        raise InvalidRequestError("image exceeds the decoded size limit")
    try:
        decoded = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise InvalidRequestError("image base64 is invalid") from exc
    if not decoded or len(decoded) > max_decoded_bytes:
        raise InvalidRequestError("image exceeds the decoded size limit")

    detected_mime = _detect_image_mime(decoded)
    if detected_mime is None:
        raise InvalidRequestError("image format is unsupported")
    if declared_mime is not None and declared_mime != detected_mime:
        raise InvalidRequestError("image MIME type does not match its bytes")
    return base64.b64encode(decoded).decode("ascii")


def validate_translate_context(
    messages: Sequence[Mapping[str, str]],
    *,
    max_bytes: int = MAX_TRANSLATE_CONTEXT_BYTES,
) -> None:
    if max_bytes <= 0:
        raise ValueError("max_bytes must be positive")
    total = 0
    for message in messages:
        total += len(message.get("role", "").encode("utf-8"))
        total += len(message.get("content", "").encode("utf-8"))
        if total > max_bytes:
            raise InvalidRequestError("translation context exceeds the text budget")


def _detect_image_mime(payload: bytes) -> str | None:
    if payload.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if payload.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if payload.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if len(payload) >= 12 and payload.startswith(b"RIFF") and payload[8:12] == b"WEBP":
        return "image/webp"
    return None


__all__ = [
    "MAX_PAID_IMAGE_BYTES",
    "MAX_PAID_RESULT_BYTES",
    "MAX_TRANSLATE_CONTEXT_BYTES",
    "PaidOperationService",
    "UsageCharge",
    "normalize_image_base64",
    "require_paid_owner",
    "validate_translate_context",
]
