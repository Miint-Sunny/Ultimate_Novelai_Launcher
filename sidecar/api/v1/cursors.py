"""Opaque cursor helpers for v1 job pagination and SSE resumption."""

from __future__ import annotations

import base64

from backend_core.errors import InvalidArgumentError


def encode_cursor(offset: int) -> str:
    if offset < 0:
        raise ValueError("cursor offset must be non-negative")
    payload = f"v1:{offset}".encode("ascii")
    return base64.urlsafe_b64encode(payload).rstrip(b"=").decode("ascii")


def decode_cursor(cursor: str | None) -> int:
    if cursor is None:
        return 0
    try:
        padding = "=" * (-len(cursor) % 4)
        payload = base64.b64decode(
            cursor + padding,
            altchars=b"-_",
            validate=True,
        ).decode("ascii")
        version, raw_offset = payload.split(":", 1)
        offset = int(raw_offset)
    except (ValueError, UnicodeError) as exc:
        raise InvalidArgumentError(
            "generation job cursor is invalid",
            code="invalid_cursor",
        ) from exc
    if version != "v1" or offset < 0 or offset > 2**63 - 1:
        raise InvalidArgumentError("generation job cursor is invalid", code="invalid_cursor")
    return offset


def resolve_event_cursor(after_sequence: int, last_event_id: str | None) -> int:
    if last_event_id is None:
        return after_sequence
    try:
        header_sequence = int(last_event_id)
    except ValueError as exc:
        raise InvalidArgumentError("Last-Event-ID must be an event sequence") from exc
    if header_sequence < 0:
        raise InvalidArgumentError("Last-Event-ID must be non-negative")
    return max(after_sequence, header_sequence)
