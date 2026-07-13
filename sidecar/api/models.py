"""Strict models shared by versioned HTTP adapters."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from backend_core.types import JsonValue


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


class ProblemFieldError(StrictModel):
    location: str
    message: str
    code: str


class ProblemDetails(StrictModel):
    """RFC 9457 response with stable application extensions."""

    type: str = "about:blank"
    title: str
    status: int = Field(ge=400, le=599)
    detail: str | None = None
    request_id: str = Field(min_length=16, max_length=64)
    instance: str | None = None
    code: str | None = None
    retryable: bool = False
    errors: list[ProblemFieldError] = Field(default_factory=list)
    context: dict[str, JsonValue] = Field(default_factory=dict)
