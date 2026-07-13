"""Strict adaptation from transport-neutral job records to v1 DTOs."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime
from typing import Any

from .models import (
    GenerationJobEventResponse,
    GenerationJobResponse,
)


def job_response(record: Any) -> GenerationJobResponse:
    data = record_data(record)
    _normalize_timestamps(
        data,
        ("created_at", "updated_at", "started_at", "finished_at"),
    )
    return GenerationJobResponse.model_validate(data)


def event_response(record: Any) -> GenerationJobEventResponse:
    data = record_data(record)
    _normalize_timestamps(data, ("created_at",))
    return GenerationJobEventResponse.model_validate(data)


def record_data(record: Any) -> dict[str, Any]:
    if isinstance(record, Mapping):
        return dict(record)
    serializer = getattr(record, "to_dict", None)
    if not callable(serializer):
        raise TypeError("job service returned a record without to_dict()")
    data = serializer()
    if not isinstance(data, Mapping):
        raise TypeError("record to_dict() must return a mapping")
    return dict(data)


def _normalize_timestamps(data: dict[str, Any], names: tuple[str, ...]) -> None:
    for name in names:
        value = data.get(name)
        if isinstance(value, str):
            data[name] = datetime.fromisoformat(value.replace("Z", "+00:00"))
