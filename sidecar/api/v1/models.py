"""Strict wire models for the stable v1 API."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from pydantic import Field, model_validator

from backend_core.types import JsonValue
from sidecar.nai.models import GenerateRequest

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
