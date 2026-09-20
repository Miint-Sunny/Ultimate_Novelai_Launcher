"""Wire model of one harness turn, shared by every host of the LLM relay.

The client-side Agent harness sends OpenAI-shaped messages and tools; the host
adds the model and the stream switches (see ``stream.build_chat_body``).  The
strict shape and the decoded budgets are the contract (§2.1), so both the
sidecar's ``/api/v1/agent/llm/chat`` and the cloud host's ``/api/agent/llm/chat``
validate with these exact classes.  Class names are part of the sidecar's
OpenAPI snapshot; keep them stable.
"""

from __future__ import annotations

import base64
import binascii
import json
import re
from collections.abc import Iterable
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from backend_core.types import JsonValue

AgentChatRoleValue = Literal["system", "user", "assistant", "tool"]
AgentChatToolChoiceValue = Literal["auto", "none", "required"]
AgentChatReasoningEffortValue = Literal["none", "minimal", "low", "medium", "high", "xhigh"]
AgentChatSlotValue = Literal["auto", "primary", "backup"]

AGENT_CHAT_MAX_IMAGES = 8
AGENT_CHAT_MAX_IMAGE_BYTES = 20 * 1024 * 1024
AGENT_CHAT_MAX_TEXT_BYTES = 4 * 1024 * 1024
AGENT_CHAT_MAX_EXTRA_BODY_KEYS = 32
AGENT_CHAT_MAX_EXTRA_BODY_BYTES = 64 * 1024
AGENT_CHAT_RESERVED_KEYS = frozenset(
    {"model", "messages", "tools", "tool_choice", "stream", "stream_options"}
)

_DATA_URL = re.compile(
    r"^data:(?P<mime>[-\w.]+/[-\w+.]+);base64,(?P<data>.*)$",
    re.DOTALL,
)


class _StrictModel(BaseModel):
    # Same configuration as the sidecar's StrictModel so the wire behaviour and
    # the generated JSON schema are identical on both hosts.
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


def enforce_text_budget(
    values: Iterable[str | None],
    *,
    maximum: int = AGENT_CHAT_MAX_TEXT_BYTES,
) -> int:
    """Sum the UTF-8 size of the text pieces and reject a turn over budget."""

    total = sum(len(value.encode("utf-8")) for value in values if value is not None)
    if total > maximum:
        raise ValueError(f"text context exceeds {maximum} decoded bytes")
    return total


def split_data_url(value: str) -> tuple[str, str]:
    """``data:<mime>;base64,<payload>`` -> (mime, compact base64 payload)."""

    match = _DATA_URL.match(value.strip())
    if match is None:
        raise ValueError("image_url.url must be a base64 data: URL")
    return match.group("mime").lower(), "".join(match.group("data").split())


def decoded_data_url_size(value: str, *, maximum: int = AGENT_CHAT_MAX_IMAGE_BYTES) -> int:
    """Validate one ``data:`` image URL and return its decoded size.

    Only ``data:`` URLs are accepted: the provider must never be asked to fetch
    a URL on the user's behalf.  The base64 payload is decoded strictly so a
    corrupt image is rejected here rather than by the upstream model.
    """

    _, compact = split_data_url(value)
    if not compact:
        raise ValueError("base64 payload is empty")
    estimated = (len(compact) * 3) // 4
    if estimated > maximum + 2:
        raise ValueError(f"decoded asset exceeds {maximum} bytes")
    try:
        payload = base64.b64decode(compact, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("invalid base64 payload") from exc
    if len(payload) > maximum:
        raise ValueError(f"decoded asset exceeds {maximum} bytes")
    return len(payload)


class AgentChatImageUrl(_StrictModel):
    """Only ``data:`` URLs are accepted: the provider must never fetch a URL for us."""

    url: str = Field(min_length=1)
    detail: Literal["auto", "low", "high"] | None = None

    @model_validator(mode="after")
    def validate_data_url(self) -> AgentChatImageUrl:
        if not self.url.startswith("data:"):
            raise ValueError("image_url.url must be a data: URL")
        decoded_data_url_size(self.url)
        return self


class AgentChatContentPart(_StrictModel):
    type: Literal["text", "image_url"]
    text: str | None = None
    image_url: AgentChatImageUrl | None = None

    @model_validator(mode="after")
    def validate_part(self) -> AgentChatContentPart:
        if self.type == "text" and self.text is None:
            raise ValueError("text parts require text")
        if self.type == "image_url" and self.image_url is None:
            raise ValueError("image_url parts require image_url")
        return self


class AgentChatToolCallFunction(_StrictModel):
    name: str = Field(min_length=1, max_length=128)
    arguments: str = Field(default="", max_length=1024 * 1024)


class AgentChatToolCall(_StrictModel):
    id: str = Field(min_length=1, max_length=256)
    type: Literal["function"] = "function"
    function: AgentChatToolCallFunction


class AgentChatMessage(_StrictModel):
    role: AgentChatRoleValue
    content: str | list[AgentChatContentPart] | None = None
    name: str | None = Field(default=None, max_length=128)
    tool_calls: list[AgentChatToolCall] | None = Field(default=None, max_length=32)
    tool_call_id: str | None = Field(default=None, max_length=256)
    # A thinking model's own reasoning, replayed on the assistant turn that
    # carried it.  DeepSeek rejects a tool-call continuation without it; the
    # relay forwards it untouched and the text budget counts it like content.
    reasoning_content: str | None = None

    @model_validator(mode="after")
    def validate_shape(self) -> AgentChatMessage:
        if self.role == "tool" and not self.tool_call_id:
            raise ValueError("tool messages require tool_call_id")
        if self.role != "tool" and self.tool_call_id:
            raise ValueError("tool_call_id is only valid on tool messages")
        if self.tool_calls and self.role != "assistant":
            raise ValueError("tool_calls are only valid on assistant messages")
        if self.reasoning_content is not None and self.role != "assistant":
            raise ValueError("reasoning_content is only valid on assistant messages")
        if self.content is None and not self.tool_calls:
            raise ValueError("messages require content unless they carry tool_calls")
        if self.role != "user" and isinstance(self.content, list):
            if any(part.type == "image_url" for part in self.content):
                if self.role != "tool":
                    raise ValueError("only user and tool messages may carry images")
        return self

    def text_pieces(self) -> list[str]:
        pieces: list[str] = []
        if isinstance(self.content, str):
            pieces.append(self.content)
        elif isinstance(self.content, list):
            pieces.extend(part.text for part in self.content if part.text is not None)
        for call in self.tool_calls or []:
            pieces.append(call.function.arguments)
        if self.reasoning_content is not None:
            pieces.append(self.reasoning_content)
        return pieces

    def image_count(self) -> int:
        if not isinstance(self.content, list):
            return 0
        return sum(1 for part in self.content if part.type == "image_url")


class AgentChatToolFunction(_StrictModel):
    name: str = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")
    description: str = Field(default="", max_length=4096)
    parameters: dict[str, JsonValue] = Field(
        default_factory=lambda: {"type": "object", "properties": {}}
    )
    strict: bool | None = None


class AgentChatTool(_StrictModel):
    type: Literal["function"] = "function"
    function: AgentChatToolFunction


class AgentChatRequest(_StrictModel):
    """One harness turn: OpenAI-shaped messages and tools; the model is the host's."""

    messages: list[AgentChatMessage] = Field(min_length=1, max_length=400)
    tools: list[AgentChatTool] = Field(default_factory=list, max_length=64)
    tool_choice: AgentChatToolChoiceValue | None = None
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    max_tokens: int | None = Field(default=None, ge=1, le=131072)
    prompt_cache_key: str | None = Field(default=None, min_length=1, max_length=64)
    reasoning_effort: AgentChatReasoningEffortValue | None = None
    # Vendor-specific switches (thinking modes and the like). Relay-owned keys
    # cannot be overridden from here.
    extra_body: dict[str, JsonValue] = Field(default_factory=dict)
    slot: AgentChatSlotValue = "auto"

    @model_validator(mode="after")
    def validate_budgets(self) -> AgentChatRequest:
        pieces: list[str] = []
        for message in self.messages:
            pieces.extend(message.text_pieces())
        for tool in self.tools:
            pieces.append(tool.function.description)
            pieces.append(json.dumps(tool.function.parameters, ensure_ascii=False))
        enforce_text_budget(pieces)
        images = sum(message.image_count() for message in self.messages)
        if images > AGENT_CHAT_MAX_IMAGES:
            raise ValueError(f"at most {AGENT_CHAT_MAX_IMAGES} images per request")
        reserved = AGENT_CHAT_RESERVED_KEYS.intersection(self.extra_body)
        if reserved:
            raise ValueError(f"extra_body may not set {sorted(reserved)}")
        if len(self.extra_body) > AGENT_CHAT_MAX_EXTRA_BODY_KEYS:
            raise ValueError(f"extra_body may hold at most {AGENT_CHAT_MAX_EXTRA_BODY_KEYS} keys")
        encoded = json.dumps(self.extra_body, ensure_ascii=False).encode("utf-8")
        if len(encoded) > AGENT_CHAT_MAX_EXTRA_BODY_BYTES:
            raise ValueError("extra_body is too large")
        return self

    def upstream_fields(self) -> dict[str, JsonValue]:
        """The validated request as JSON-ready fields for the relay."""

        data = self.model_dump(mode="json", exclude_none=True)
        data.pop("slot", None)
        return data


__all__ = [
    "AGENT_CHAT_MAX_EXTRA_BODY_BYTES",
    "AGENT_CHAT_MAX_EXTRA_BODY_KEYS",
    "AGENT_CHAT_MAX_IMAGES",
    "AGENT_CHAT_MAX_IMAGE_BYTES",
    "AGENT_CHAT_MAX_TEXT_BYTES",
    "AGENT_CHAT_RESERVED_KEYS",
    "AgentChatContentPart",
    "AgentChatImageUrl",
    "AgentChatMessage",
    "AgentChatReasoningEffortValue",
    "AgentChatRequest",
    "AgentChatRoleValue",
    "AgentChatSlotValue",
    "AgentChatTool",
    "AgentChatToolCall",
    "AgentChatToolCallFunction",
    "AgentChatToolChoiceValue",
    "AgentChatToolFunction",
    "decoded_data_url_size",
    "enforce_text_budget",
    "split_data_url",
]
