"""Strict wire models for the stable v1 API."""

from __future__ import annotations

import json
from datetime import datetime
from typing import Annotated, Literal

from pydantic import Field, model_validator

from backend_core.types import JsonValue
from sidecar.nai.models import GenerateRequest
from sidecar.security.payloads import (
    MAX_AGENT_IMAGE_BYTES,
    decode_base64_payload,
    enforce_text_budget,
)

from ..models import ProblemDetails as ProblemDetails
from ..models import StrictModel

RuntimeStateValue = Literal["new", "starting", "ready", "stopping", "stopped", "failed"]
JobStatusValue = Literal[
    "queued",
    "running",
    "cancelling",
    "succeeded",
    "failed",
    "cancelled",
    "interrupted",
]
AssetStatusValue = Literal["available", "missing", "orphaned"]
LibraryKindValue = Literal["oc", "artist", "cr", "vibe"]


class ComponentReady(StrictModel):
    ready: bool
    required: bool
    detail: str | None = None


class ReadyResponse(StrictModel):
    ready: bool
    draining: bool = False
    state: RuntimeStateValue
    version: str
    started_at: datetime | None = None
    components: dict[str, ComponentReady] = Field(default_factory=dict)
    capabilities: dict[str, JsonValue] = Field(default_factory=dict)


V5UpscaleModelValue = Literal["nai-diffusion-5-full", "nai-diffusion-5-curated"]


class V5UpscaleRequest(StrictModel):
    """V5 扩散超分请求。源图 PNG 的 base64;结果固定 2×(服务端行为,无倍率参数)。"""

    image: str = Field(min_length=8)
    model: V5UpscaleModelValue = "nai-diffusion-5-curated"
    # 官方默认 0(源图越糊值越大,服务端据此调去模糊力度);上限未见文档,
    # 这里只给工程边界,真正的校验在服务端。
    declared_blur_sigma: float = Field(default=0.0, ge=0.0, le=100.0)


class V5UpscaleResponse(StrictModel):
    """结果 PNG 的 base64 与服务端实际返回的尺寸(前端按它对账,不信本地推算)。"""

    image: str
    width: int = Field(ge=1)
    height: int = Field(ge=1)
    model: str
    declared_blur_sigma: float


class PairingChallengeResponse(StrictModel):
    code: str = Field(pattern=r"^[0-9]{6}$")
    expires_at: datetime
    expires_in: float = Field(gt=0)
    max_attempts: int = Field(ge=1, le=5)


class PairingExchangeRequest(StrictModel):
    code: str = Field(pattern=r"^[0-9]{6}$")


class PairingExchangeResponse(StrictModel):
    access_token: str = Field(min_length=1)
    token_type: Literal["bearer"] = "bearer"  # noqa: S105 -- OAuth token type, not a secret
    instance_id: str
    protocol: int = Field(ge=1)


class DrainResponse(StrictModel):
    draining: bool
    active_tasks: int = Field(ge=0)
    shutdown_requested: bool


ProviderValue = Literal["openai", "anthropic", "gemini"]
NetworkScopeValue = Literal["public", "loopback", "trusted-lan"]
# ComfyUI is a local/LAN service; its endpoint may never be public internet.
ComfyNetworkScopeValue = Literal["loopback", "trusted-lan"]
TrustedNetworkValue = Annotated[str, Field(min_length=3, max_length=64)]


class SettingsUpdateRequest(StrictModel):
    nai_base_url: str | None = Field(default=None, max_length=2048)
    llm_provider: ProviderValue | None = None
    llm_base_url: str | None = Field(default=None, max_length=2048)
    llm_model: str | None = Field(default=None, max_length=256)
    llm_network_scope: NetworkScopeValue | None = None
    llm_trusted_networks: list[TrustedNetworkValue] | None = Field(
        default=None,
        max_length=16,
    )
    llm_backup_provider: ProviderValue | None = None
    llm_backup_base_url: str | None = Field(default=None, max_length=2048)
    llm_backup_model: str | None = Field(default=None, max_length=256)
    llm_backup_network_scope: NetworkScopeValue | None = None
    llm_backup_trusted_networks: list[TrustedNetworkValue] | None = Field(
        default=None,
        max_length=16,
    )
    comfy_base_url: str | None = Field(default=None, max_length=2048)
    comfy_network_scope: ComfyNetworkScopeValue | None = None
    comfy_trusted_networks: list[TrustedNetworkValue] | None = Field(
        default=None,
        max_length=16,
    )

    @model_validator(mode="after")
    def require_update(self) -> SettingsUpdateRequest:
        if not self.model_fields_set:
            raise ValueError("at least one setting is required")
        null_fields = sorted(name for name in self.model_fields_set if getattr(self, name) is None)
        if null_fields:
            raise ValueError(
                f"settings cannot be null; omit or explicitly clear: {', '.join(null_fields)}"
            )
        return self


class SettingsResponse(StrictModel):
    version: str
    data_dir: str
    nai_base_url: str
    nai_configured: bool
    nai_token_configured: bool
    llm_provider: ProviderValue
    llm_base_url: str
    llm_model: str
    llm_key_configured: bool
    llm_network_scope: NetworkScopeValue
    llm_trusted_networks: list[str]
    llm_backup_provider: ProviderValue
    llm_backup_base_url: str
    llm_backup_model: str
    llm_backup_key_configured: bool
    llm_backup_network_scope: NetworkScopeValue
    llm_backup_trusted_networks: list[str]
    llm_configured: bool
    comfy_base_url: str
    comfy_network_scope: ComfyNetworkScopeValue
    comfy_trusted_networks: list[str]
    comfy_configured: bool


class StorageStatusResponse(StrictModel):
    requested_bytes: int = Field(ge=0)
    catalog_bytes: int = Field(ge=0)
    quota_bytes: int = Field(ge=1)
    quota_remaining_bytes: int = Field(ge=0)
    disk_free_bytes: int = Field(ge=0)
    reserve_bytes: int = Field(ge=0)
    disk_usable_bytes: int = Field(ge=0)
    can_allocate: bool


class AssetResponse(StrictModel):
    id: str = Field(min_length=1)
    kind: str = Field(min_length=1)
    relative_path: str = Field(min_length=1)
    media_type: str | None = None
    byte_size: int = Field(ge=0)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    source_job_id: str | None = None
    status: AssetStatusValue
    metadata: dict[str, JsonValue] = Field(default_factory=dict)
    created_at: str
    updated_at: str


class AssetListResponse(StrictModel):
    items: list[AssetResponse]
    limit: int = Field(ge=1, le=100)
    offset: int = Field(ge=0)
    count: int = Field(ge=0)


class StoragePruneRequest(StrictModel):
    asset_ids: list[str] = Field(min_length=1, max_length=1000)


class StoragePruneResponse(StrictModel):
    removed_asset_ids: list[str]
    missing_asset_ids: list[str]


class OcLibraryData(StrictModel):
    en_name: str = Field(min_length=1, max_length=256)
    zh_name: str | None = Field(default=None, max_length=256)
    zh_aliases: list[str] = Field(default_factory=list, max_length=100)
    tag_group: str = Field(min_length=1, max_length=64 * 1024)
    negative_prompt: str = Field(default="", max_length=64 * 1024)
    created_by: str = Field(default="local", min_length=1, max_length=256)
    created_at: int = Field(default=0, ge=0)


class ArtistLibraryData(StrictModel):
    name: str = Field(min_length=1, max_length=256)
    artist_string: str = Field(min_length=1, max_length=64 * 1024)
    negative: str = Field(default="", max_length=64 * 1024)
    usage_count: int = Field(default=0, ge=0)
    added_by: str = Field(default="local", min_length=1, max_length=256)
    created_time: int = Field(default=0, ge=0)


class CrLibraryData(StrictModel):
    name: str = Field(min_length=1, max_length=256)
    zh_names: list[str] = Field(default_factory=list, max_length=100)
    created_time: int = Field(default=0, ge=0)


class VibeLibraryData(StrictModel):
    name: str = Field(min_length=1, max_length=256)
    filename: str = Field(min_length=1, max_length=256)
    supported_models: list[str] = Field(default_factory=list, max_length=100)
    default_strength: float | None = None
    default_info_extracted: float | None = None
    created_at: int = Field(default=0, ge=0)
    has_image: bool = False
    uploader_id: str = Field(default="local", min_length=1, max_length=256)
    uploaded_at: int = Field(default=0, ge=0)
    # NovelAI's versioned vibe document is retained as an explicitly named
    # vendor payload.  Core library fields stay typed and stable.
    payload: dict[str, JsonValue] = Field(default_factory=dict)


LibraryData = OcLibraryData | ArtistLibraryData | CrLibraryData | VibeLibraryData


class LibraryItemCreate(StrictModel):
    kind: LibraryKindValue
    key: str = Field(min_length=1, max_length=256)
    data: LibraryData
    primary_asset_base64: str | None = Field(default=None, max_length=45 * 1024 * 1024)
    thumbnail_asset_base64: str | None = Field(default=None, max_length=45 * 1024 * 1024)

    @model_validator(mode="after")
    def match_kind_and_data(self) -> LibraryItemCreate:
        expected = {
            "oc": OcLibraryData,
            "artist": ArtistLibraryData,
            "cr": CrLibraryData,
            "vibe": VibeLibraryData,
        }[self.kind]
        if type(self.data) is not expected:
            raise ValueError(f"{self.kind} library items require {expected.__name__}")
        return self


class LibraryItemReplace(StrictModel):
    key: str = Field(min_length=1, max_length=256)
    data: LibraryData
    primary_asset_base64: str | None = Field(default=None, max_length=45 * 1024 * 1024)
    thumbnail_asset_base64: str | None = Field(default=None, max_length=45 * 1024 * 1024)


class LibraryItemResponse(StrictModel):
    id: str = Field(min_length=1, max_length=256)
    owner: str = Field(min_length=1, max_length=256)
    kind: LibraryKindValue
    key: str = Field(min_length=1, max_length=256)
    data: LibraryData
    primary_asset_id: str | None = None
    thumbnail_asset_id: str | None = None
    created_at: datetime
    updated_at: datetime

    @model_validator(mode="after")
    def match_kind_and_data(self) -> LibraryItemResponse:
        expected = {
            "oc": OcLibraryData,
            "artist": ArtistLibraryData,
            "cr": CrLibraryData,
            "vibe": VibeLibraryData,
        }[self.kind]
        if type(self.data) is not expected:
            raise ValueError(f"{self.kind} library items require {expected.__name__}")
        return self


class LibraryItemListResponse(StrictModel):
    items: list[LibraryItemResponse]
    limit: int = Field(ge=1, le=100)
    offset: int = Field(ge=0)
    count: int = Field(ge=0)


class LibraryItemDeleteResponse(StrictModel):
    deleted: Literal[True] = True
    id: str = Field(min_length=1, max_length=256)


class BackupFileResponse(StrictModel):
    path: str = Field(min_length=1, max_length=1024)
    byte_size: int = Field(ge=0)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    kind: Literal["database", "settings", "asset"]


class BackupResponse(StrictModel):
    backup_id: str = Field(
        pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
    )
    filename: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$", max_length=200)
    created_at: datetime
    schema_version: int = Field(ge=0)
    includes_assets: bool
    includes_settings: bool
    archive_bytes: int = Field(ge=0)
    files: list[BackupFileResponse]


class BackupCreateRequest(StrictModel):
    include_assets: bool = True


class BackupListResponse(StrictModel):
    items: list[BackupResponse]
    count: int = Field(ge=0)


class BackupValidationResponse(StrictModel):
    valid: Literal[True] = True
    backup: BackupResponse


class BackupRestoreResponse(StrictModel):
    backup: BackupResponse
    safety_backup_filename: str = Field(
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$",
        max_length=200,
    )
    draining: Literal[True] = True
    restart_required: Literal[True] = True


class BackupDeleteResponse(StrictModel):
    deleted: Literal[True] = True
    filename: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$", max_length=200)
    reclaimed_bytes: int = Field(ge=0)


class GenerationJobCreate(StrictModel):
    """Transport envelope for an immutable generation request snapshot."""

    payload: GenerateRequest


class GenerationJobResponse(StrictModel):
    id: str = Field(min_length=1)
    owner: str | None = None
    idempotency_key: str | None = None
    request_hash: str = Field(min_length=1)
    payload: dict[str, JsonValue]
    status: JobStatusValue
    progress: float = Field(ge=0.0, le=1.0)
    result: dict[str, JsonValue] | None = None
    error_code: str | None = None
    error_message: str | None = None
    queue_sequence: int = Field(ge=1)
    created_at: datetime
    updated_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None


class GenerationJobListResponse(StrictModel):
    items: list[GenerationJobResponse]
    limit: int = Field(ge=1)
    cursor: str | None = None
    next_cursor: str | None = None
    count: int = Field(ge=0)


class GenerationJobCancel(StrictModel):
    reason: str | None = Field(default=None, max_length=500)


class GenerationJobEventResponse(StrictModel):
    sequence: int = Field(ge=1)
    job_id: str = Field(min_length=1)
    kind: str = Field(min_length=1)
    status: JobStatusValue
    created_at: datetime
    data: dict[str, JsonValue] = Field(default_factory=dict)


class GenerationJobEventListResponse(StrictModel):
    items: list[GenerationJobEventResponse]
    after_sequence: int = Field(ge=0)
    count: int = Field(ge=0)


# ---------------------------------------------------------------------------
# Agent: streaming LLM relay for the client-side harness
# ---------------------------------------------------------------------------

AgentChatRoleValue = Literal["system", "user", "assistant", "tool"]
AgentChatToolChoiceValue = Literal["auto", "none", "required"]
AgentChatReasoningEffortValue = Literal["none", "minimal", "low", "medium", "high", "xhigh"]
AgentChatSlotValue = Literal["auto", "primary", "backup"]
AGENT_CHAT_MAX_IMAGES = 8
AGENT_CHAT_MAX_EXTRA_BODY_KEYS = 32
AGENT_CHAT_MAX_EXTRA_BODY_BYTES = 64 * 1024
_AGENT_CHAT_RESERVED_KEYS = frozenset(
    {"model", "messages", "tools", "tool_choice", "stream", "stream_options"}
)


class AgentChatImageUrl(StrictModel):
    """Only ``data:`` URLs are accepted: the provider must never fetch a URL for us."""

    url: str = Field(min_length=1)
    detail: Literal["auto", "low", "high"] | None = None

    @model_validator(mode="after")
    def validate_data_url(self) -> AgentChatImageUrl:
        if not self.url.startswith("data:"):
            raise ValueError("image_url.url must be a data: URL")
        decode_base64_payload(self.url, maximum=MAX_AGENT_IMAGE_BYTES)
        return self


class AgentChatContentPart(StrictModel):
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


class AgentChatToolCallFunction(StrictModel):
    name: str = Field(min_length=1, max_length=128)
    arguments: str = Field(default="", max_length=1024 * 1024)


class AgentChatToolCall(StrictModel):
    id: str = Field(min_length=1, max_length=256)
    type: Literal["function"] = "function"
    function: AgentChatToolCallFunction


class AgentChatMessage(StrictModel):
    role: AgentChatRoleValue
    content: str | list[AgentChatContentPart] | None = None
    name: str | None = Field(default=None, max_length=128)
    tool_calls: list[AgentChatToolCall] | None = Field(default=None, max_length=32)
    tool_call_id: str | None = Field(default=None, max_length=256)

    @model_validator(mode="after")
    def validate_shape(self) -> AgentChatMessage:
        if self.role == "tool" and not self.tool_call_id:
            raise ValueError("tool messages require tool_call_id")
        if self.role != "tool" and self.tool_call_id:
            raise ValueError("tool_call_id is only valid on tool messages")
        if self.tool_calls and self.role != "assistant":
            raise ValueError("tool_calls are only valid on assistant messages")
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
        return pieces

    def image_count(self) -> int:
        if not isinstance(self.content, list):
            return 0
        return sum(1 for part in self.content if part.type == "image_url")


class AgentChatToolFunction(StrictModel):
    name: str = Field(pattern=r"^[A-Za-z0-9_-]{1,64}$")
    description: str = Field(default="", max_length=4096)
    parameters: dict[str, JsonValue] = Field(
        default_factory=lambda: {"type": "object", "properties": {}}
    )
    strict: bool | None = None


class AgentChatTool(StrictModel):
    type: Literal["function"] = "function"
    function: AgentChatToolFunction


class AgentChatRequest(StrictModel):
    """One harness turn: OpenAI-shaped messages and tools; the model is the slot's."""

    messages: list[AgentChatMessage] = Field(min_length=1, max_length=400)
    tools: list[AgentChatTool] = Field(default_factory=list, max_length=64)
    tool_choice: AgentChatToolChoiceValue | None = None
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    max_tokens: int | None = Field(default=None, ge=1, le=131072)
    prompt_cache_key: str | None = Field(default=None, min_length=1, max_length=64)
    reasoning_effort: AgentChatReasoningEffortValue | None = None
    # Vendor-specific switches (thinking modes and the like). Sidecar-owned keys
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
        reserved = _AGENT_CHAT_RESERVED_KEYS.intersection(self.extra_body)
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


# ---------------------------------------------------------------------------
# Tags: three coexisting suggestion sources
# ---------------------------------------------------------------------------

TagSuggestSourceValue = Literal["official", "danbooru", "dictionary"]


class TagSuggestItem(StrictModel):
    """One suggestion; fields a source cannot provide stay ``null``."""

    tag: str = Field(min_length=1)
    count: int | None = Field(default=None, ge=0)
    confidence: float | None = None
    category: str | None = None
    translation: str | None = None
    aliases: list[str] = Field(default_factory=list)
    matched_alias: str | None = None
    group: str | None = None
    subgroup: str | None = None


class TagSuggestResponse(StrictModel):
    source: TagSuggestSourceValue
    query: str
    items: list[TagSuggestItem] = Field(default_factory=list)
