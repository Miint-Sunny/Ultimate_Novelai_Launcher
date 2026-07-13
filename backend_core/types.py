"""Small, transport-neutral types shared by backend adapters.

This package deliberately does not import FastAPI, Pydantic, or the sidecar.  It is
safe for workers, command-line tools, and HTTP adapters to depend on it.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from datetime import datetime, timezone
from enum import Enum
from typing import Any, NewType, TypeVar

JsonPrimitive = str | int | float | bool | None
# Recursive aliases are awkward for runtime consumers on Python 3.10.  Keep the
# public boundary honest while using ``Any`` for the recursive leaves.
JsonValue = JsonPrimitive | list[Any] | dict[str, Any]
JsonObject = Mapping[str, JsonValue]

JobId = NewType("JobId", str)

T = TypeVar("T")
MaybeAwaitable = T | Awaitable[T]
Clock = Callable[[], datetime]


class RuntimeState(str, Enum):
    """Lifecycle state for a process-local application runtime."""

    NEW = "new"
    STARTING = "starting"
    READY = "ready"
    STOPPING = "stopping"
    STOPPED = "stopped"
    FAILED = "failed"


def utc_now() -> datetime:
    """Return an aware UTC timestamp.

    Kept here so domain code can inject a clock without importing a transport or
    persistence layer.
    """

    return datetime.now(timezone.utc)


def as_utc(value: datetime) -> datetime:
    """Normalize an aware timestamp to UTC and reject ambiguous naive values."""

    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("timestamp must include a timezone")
    return value.astimezone(timezone.utc)
