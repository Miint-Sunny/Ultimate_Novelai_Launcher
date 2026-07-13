"""Strict request contracts for the unversioned compatibility API."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from sidecar.nai.models import GenerationParams
from sidecar.security.payloads import (
    MAX_AGENT_IMAGE_BYTES,
    MAX_SINGLE_ASSET_BYTES,
    MAX_TEXT_CONTEXT_BYTES,
    decode_base64_payload,
    enforce_json_decoded_budget,
    enforce_text_budget,
)


class StrictRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


class TokenRequest(StrictRequest):
    token: str = Field(min_length=1, max_length=4096)


class LlmKeyRequest(StrictRequest):
    api_key: str = Field(min_length=1, max_length=16 * 1024)
    slot: Literal["primary", "backup"] = "primary"


class SettingsUpdateRequest(StrictRequest):
    nai_base_url: str | None = Field(default=None, max_length=2048)
    llm_provider: Literal["openai", "anthropic", "gemini"] | None = None
    llm_backup_provider: Literal["openai", "anthropic", "gemini"] | None = None
    llm_backup_base_url: str | None = Field(default=None, max_length=2048)
    llm_backup_model: str | None = Field(default=None, max_length=256)
    llm_base_url: str | None = Field(default=None, max_length=2048)
    llm_model: str | None = Field(default=None, max_length=256)
    llm_network_scope: Literal["public", "loopback", "trusted-lan"] | None = None
    llm_backup_network_scope: Literal["public", "loopback", "trusted-lan"] | None = None
    llm_trusted_networks: list[str] | None = Field(default=None, max_length=16)
    llm_backup_trusted_networks: list[str] | None = Field(default=None, max_length=16)


class VibeEncodeRequest(StrictRequest):
    image: str = Field(min_length=1, max_length=45 * 1024 * 1024)
    information_extracted: float = 0.5
    model: str = "nai-diffusion-4-5-full"

    @model_validator(mode="after")
    def validate_image_budget(self) -> VibeEncodeRequest:
        decode_base64_payload(self.image, maximum=MAX_SINGLE_ASSET_BYTES)
        return self


class UpscaleRequest(StrictRequest):
    image: str = Field(min_length=1, max_length=45 * 1024 * 1024)
    width: int
    height: int
    scale: int | float = 4

    @model_validator(mode="after")
    def validate_image_budget(self) -> UpscaleRequest:
        decode_base64_payload(self.image, maximum=MAX_SINGLE_ASSET_BYTES)
        return self


class AgentGeneratePromptRequest(StrictRequest):
    input: str = Field(min_length=1, max_length=4 * 1024 * 1024)
    params: GenerationParams = Field(default_factory=GenerationParams)
    negative: str = Field(default="", max_length=4 * 1024 * 1024)

    @model_validator(mode="after")
    def validate_text_budget(self) -> AgentGeneratePromptRequest:
        enforce_text_budget((self.input, self.negative))
        return self


class AgentHistoryMessage(StrictRequest):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=MAX_TEXT_CONTEXT_BYTES)


class AgentKnowledgeArtist(StrictRequest):
    id: str | int
    name: str = Field(min_length=1, max_length=512)
    prompt: str = Field(max_length=MAX_TEXT_CONTEXT_BYTES)


class AgentKnowledgeOc(StrictRequest):
    id: str | int
    name: str = Field(min_length=1, max_length=512)
    zh_name: str = Field(default="", max_length=512)
    positive: str = Field(default="", max_length=MAX_TEXT_CONTEXT_BYTES)
    negative: str = Field(default="", max_length=MAX_TEXT_CONTEXT_BYTES)


class AgentPromptCharacter(StrictRequest):
    name: str = Field(min_length=1, max_length=512)
    positive: str = Field(default="", max_length=MAX_TEXT_CONTEXT_BYTES)
    negative: str = Field(default="", max_length=MAX_TEXT_CONTEXT_BYTES)


class AgentCodexContext(StrictRequest):
    id: str | int
    category: str = Field(default="", max_length=512)
    title: str = Field(default="", max_length=1000)
    content: str = Field(default="", max_length=MAX_TEXT_CONTEXT_BYTES)
    is_r18: bool = False


class AgentWebGeneratePromptRequest(StrictRequest):
    """The complete desktop request shape, even though main has no Agent adapter."""

    user_request: str = Field(default="", max_length=MAX_TEXT_CONTEXT_BYTES)
    model: str = Field(default="", max_length=256)
    image_b64: str | None = Field(
        default=None,
        max_length=(MAX_AGENT_IMAGE_BYTES * 4 // 3) + 32,
    )
    image_mime_type: str = Field(default="image/png", max_length=100)
    history: list[AgentHistoryMessage] = Field(default_factory=list, max_length=200)
    use_codex: bool = False
    knowledge_sources: list[Literal["roleTags", "artists", "vibes", "ocs"]] = Field(
        default_factory=lambda: ["roleTags", "artists", "vibes", "ocs"],
        max_length=4,
    )
    web_artists: list[AgentKnowledgeArtist] = Field(default_factory=list, max_length=1000)
    web_ocs: list[AgentKnowledgeOc] = Field(default_factory=list, max_length=1000)
    web_codex: list[AgentCodexContext] = Field(default_factory=list, max_length=5000)
    current_positive: str = Field(default="", max_length=MAX_TEXT_CONTEXT_BYTES)
    current_negative: str = Field(default="", max_length=MAX_TEXT_CONTEXT_BYTES)
    current_characters: list[AgentPromptCharacter] = Field(
        default_factory=list,
        max_length=100,
    )

    @field_validator("image_mime_type")
    @classmethod
    def normalize_image_mime_type(cls, value: str) -> str:
        normalized = value.strip().lower() or "image/png"
        if normalized == "image/jpg":
            normalized = "image/jpeg"
        if normalized not in {"image/png", "image/jpeg", "image/webp", "image/gif"}:
            raise ValueError("image_mime_type must be PNG, JPEG, WebP, or GIF")
        return normalized

    @model_validator(mode="after")
    def validate_decoded_budgets(self) -> AgentWebGeneratePromptRequest:
        decoded: bytes | None = None
        embedded_mime: str | None = None
        if self.image_b64 is not None:
            decoded, embedded_mime = decode_base64_payload(
                self.image_b64,
                maximum=MAX_AGENT_IMAGE_BYTES,
            )
        if not self.user_request.strip() and decoded is None:
            raise ValueError("user_request or image_b64 is required")
        if decoded is not None:
            signatures = {
                "image/png": decoded.startswith(b"\x89PNG\r\n\x1a\n"),
                "image/jpeg": decoded.startswith(b"\xff\xd8\xff"),
                "image/webp": (
                    len(decoded) >= 12 and decoded.startswith(b"RIFF") and decoded[8:12] == b"WEBP"
                ),
                "image/gif": decoded.startswith((b"GIF87a", b"GIF89a")),
            }
            detected = next((mime for mime, matches in signatures.items() if matches), None)
            if detected is None:
                raise ValueError("image bytes are not a supported PNG, JPEG, WebP, or GIF")
            if embedded_mime is not None and embedded_mime != detected:
                raise ValueError("image bytes do not match the data URL MIME type")
            if "image_mime_type" not in self.model_fields_set:
                self.image_mime_type = detected
            elif self.image_mime_type != detected:
                raise ValueError("image bytes do not match image_mime_type")
        enforce_json_decoded_budget(
            self.model_dump(exclude={"image_b64", "image_mime_type"}, mode="json"),
            maximum=MAX_TEXT_CONTEXT_BYTES,
            maximum_single_asset=MAX_AGENT_IMAGE_BYTES,
        )
        return self


class ChatMessage(StrictRequest):
    role: Literal["system", "user", "assistant"]
    content: str = Field(min_length=1, max_length=4 * 1024 * 1024)


class ChatCompletionRequest(StrictRequest):
    messages: list[ChatMessage] = Field(min_length=1, max_length=100)
    temperature: float = 0.3
    max_tokens: int = 1000

    @model_validator(mode="after")
    def validate_text_budget(self) -> ChatCompletionRequest:
        enforce_text_budget(message.content for message in self.messages)
        return self


class TagTranslationLookupRequest(StrictRequest):
    tags: list[str] = Field(default_factory=list, max_length=1000)


class TagTranslationEntry(StrictRequest):
    tag: str = Field(min_length=1, max_length=512)
    zh: str = Field(min_length=1, max_length=512)
    source: str = Field(default="ai", max_length=64)


class TagTranslationSubmitRequest(StrictRequest):
    entries: list[TagTranslationEntry] = Field(default_factory=list, max_length=1000)


__all__ = [
    "AgentGeneratePromptRequest",
    "AgentCodexContext",
    "AgentHistoryMessage",
    "AgentKnowledgeArtist",
    "AgentKnowledgeOc",
    "AgentPromptCharacter",
    "AgentWebGeneratePromptRequest",
    "ChatCompletionRequest",
    "LlmKeyRequest",
    "SettingsUpdateRequest",
    "TagTranslationLookupRequest",
    "TagTranslationSubmitRequest",
    "TokenRequest",
    "UpscaleRequest",
    "VibeEncodeRequest",
]
