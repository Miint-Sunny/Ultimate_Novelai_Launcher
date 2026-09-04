"""Decoded input budgets used after the raw ASGI body limit."""

from __future__ import annotations

import base64
import binascii
import re
from collections.abc import Iterable, Mapping, Sequence
from typing import Any

MAX_SINGLE_ASSET_BYTES = 32 * 1024 * 1024
MAX_GENERATION_DECODED_BYTES = 64 * 1024 * 1024
MAX_AGENT_IMAGE_BYTES = 20 * 1024 * 1024
MAX_TEXT_CONTEXT_BYTES = 4 * 1024 * 1024

_DATA_URL = re.compile(
    r"^data:(?P<mime>[-\w.]+/[-\w+.]+);base64,(?P<data>.*)$",
    re.DOTALL,
)
_BINARY_FIELD_PARTS = ("base64", "image", "thumbnail", "reference", "mask")
# NovelAI wire fields whose names merely LOOK binary. ``image_format`` carries
# the output container name ('png'); decoding it as base64 would reject every
# legitimate desktop generation request. Keep this an exact-name allowlist so
# the fail-closed default still covers unknown binary-looking fields.
_TEXT_METADATA_FIELDS = frozenset({"image_format", "image_model"})


class PayloadBudgetError(ValueError):
    pass


def utf8_size(value: str) -> int:
    return len(value.encode("utf-8", errors="strict"))


def enforce_text_budget(
    values: Iterable[str | None],
    *,
    maximum: int = MAX_TEXT_CONTEXT_BYTES,
) -> int:
    total = sum(utf8_size(value) for value in values if value is not None)
    if total > maximum:
        raise PayloadBudgetError(f"text context exceeds {maximum} decoded bytes")
    return total


def decode_base64_payload(
    value: str,
    *,
    maximum: int = MAX_SINGLE_ASSET_BYTES,
) -> tuple[bytes, str | None]:
    text = value.strip()
    match = _DATA_URL.match(text)
    mime: str | None = None
    if match:
        mime = match.group("mime").lower()
        text = match.group("data")
    compact = "".join(text.split())
    if not compact:
        raise PayloadBudgetError("base64 payload is empty")
    estimated = (len(compact) * 3) // 4
    if estimated > maximum + 2:
        raise PayloadBudgetError(f"decoded asset exceeds {maximum} bytes")
    try:
        payload = base64.b64decode(compact, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise PayloadBudgetError("invalid base64 payload") from exc
    if len(payload) > maximum:
        raise PayloadBudgetError(f"decoded asset exceeds {maximum} bytes")
    return payload, mime


def enforce_json_decoded_budget(
    value: Any,
    *,
    maximum: int = MAX_GENERATION_DECODED_BYTES,
    maximum_single_asset: int = MAX_SINGLE_ASSET_BYTES,
) -> int:
    """Count nested JSON text and decode image-like fields before upstream use."""

    total = 0

    def visit(item: Any, field_name: str = "") -> None:
        nonlocal total
        if item is None or isinstance(item, (bool, int, float)):
            return
        if isinstance(item, str):
            if _looks_binary_field(field_name) or item.lstrip().startswith("data:"):
                payload, _ = decode_base64_payload(item, maximum=maximum_single_asset)
                total += len(payload)
            else:
                total += utf8_size(item)
        elif isinstance(item, Mapping):
            for key, nested in item.items():
                key_text = str(key)
                total += utf8_size(key_text)
                visit(nested, key_text)
        elif isinstance(item, Sequence) and not isinstance(item, (bytes, bytearray)):
            for nested in item:
                visit(nested, field_name)
        else:
            raise PayloadBudgetError("payload contains a non-JSON value")
        if total > maximum:
            raise PayloadBudgetError(f"decoded payload exceeds {maximum} bytes")

    visit(value)
    return total


def _looks_binary_field(value: str) -> bool:
    normalized = value.casefold()
    if normalized in _TEXT_METADATA_FIELDS:
        return False
    return any(part in normalized for part in _BINARY_FIELD_PARTS)


__all__ = [
    "MAX_AGENT_IMAGE_BYTES",
    "MAX_GENERATION_DECODED_BYTES",
    "MAX_SINGLE_ASSET_BYTES",
    "MAX_TEXT_CONTEXT_BYTES",
    "PayloadBudgetError",
    "decode_base64_payload",
    "enforce_json_decoded_budget",
    "enforce_text_budget",
    "utf8_size",
]
