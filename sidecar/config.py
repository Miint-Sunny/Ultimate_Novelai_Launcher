from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .credentials import get_stored_llm_backup_key, get_stored_llm_key, get_stored_token
from .local_settings import read_local_settings
from .security import OutboundPolicy

# Per-protocol default base URLs (used when the user leaves base URL blank).
LLM_DEFAULT_BASES = {
    "anthropic": "https://api.anthropic.com",
    "gemini": "https://generativelanguage.googleapis.com",
}
_LLM_PROVIDERS = frozenset(LLM_DEFAULT_BASES) | {"openai"}
_NETWORK_SCOPES = frozenset({"public", "loopback", "trusted-lan"})
# A local ComfyUI endpoint is loopback (or an explicit LAN box) by design; the
# public internet is never a valid destination for this channel.
_COMFY_NETWORK_SCOPES = frozenset({"loopback", "trusted-lan"})


@dataclass(frozen=True)
class LlmSlot:
    provider: str  # "openai" | "anthropic" | "gemini"
    base_url: str
    api_key: str
    model: str


def _resolve_llm_base(provider: str, base_url: str) -> str:
    base = (base_url or "").strip().rstrip("/")
    if base:
        return base
    return LLM_DEFAULT_BASES.get(provider, "")


def _configured_string(
    local: dict[str, Any],
    env_name: str,
    local_key: str,
    default: str = "",
) -> str:
    """Resolve an environment override while preserving an explicit empty value."""

    value = os.environ.get(env_name)
    if value is None:
        value = local.get(local_key, default)
    return value if isinstance(value, str) else default


def _configured_networks(
    local: dict[str, Any],
    env_name: str,
    local_key: str,
) -> tuple[str, ...]:
    """Resolve an explicit trusted-LAN CIDR allowlist.

    Environment values are comma-separated. Persisted settings use a JSON list.
    Validation happens again when the outbound policy is constructed, so an invalid
    environment override fails closed instead of broadening network access.
    """

    raw = os.environ.get(env_name)
    if raw is not None:
        values = tuple(item.strip() for item in raw.split(",") if item.strip())
    else:
        value = local.get(local_key, [])
        if not isinstance(value, list):
            return ()
        values = tuple(item for item in value if isinstance(item, str))
    if not values:
        return ()
    try:
        policy = OutboundPolicy("trusted-lan", trusted_networks=values)
    except ValueError as exc:
        raise ValueError(f"{env_name} contains an invalid trusted LAN network") from exc
    return tuple(dict.fromkeys(str(network) for network in policy.trusted_networks))


def _configured_choice(
    local: dict[str, Any],
    env_name: str,
    local_key: str,
    default: str,
    allowed: frozenset[str],
) -> str:
    value = _configured_string(local, env_name, local_key, default).strip().lower() or default
    if value not in allowed:
        raise ValueError(f"{env_name} must be one of: {', '.join(sorted(allowed))}")
    return value


def _default_data_dir() -> Path:
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Ultimate_Novelai_launcher"
    if sys.platform == "win32":
        base = os.environ.get("APPDATA")
        if base:
            return Path(base) / "Ultimate_Novelai_launcher"
        return Path.home() / "AppData" / "Roaming" / "Ultimate_Novelai_launcher"
    base = os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share"
    return Path(base) / "Ultimate_Novelai_launcher"


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    data_dir: Path
    nai_token: str
    nai_base_url: str
    llm_base_url: str
    llm_api_key: str
    llm_model: str
    mock_generation: bool
    # Optional artificial delay for mock generation so a job stays cancellable
    # long enough for tests/smoke checks to exercise cancellation; 0 = instant.
    mock_generation_delay_ms: int = 0
    danbooru_proxy_url: str = ""
    llm_provider: str = "openai"
    llm_backup_provider: str = "openai"
    llm_backup_base_url: str = ""
    llm_backup_api_key: str = ""
    llm_backup_model: str = ""
    # Per-session shared secret injected by the Tauri shell. AuthManager requires
    # it on every route except the liveness and one-time pairing exchange paths.
    sidecar_auth_token: str = ""
    instance_id: str = ""
    protocol_version: int = 1
    unsafe_dev_no_auth: bool = False
    generation_workers: int = 1
    generation_queue_capacity: int = 32
    storage_quota_bytes: int = 10 * 1024 * 1024 * 1024
    storage_reserve_bytes: int = 1024 * 1024 * 1024
    llm_network_scope: str = "public"
    llm_backup_network_scope: str = "public"
    llm_trusted_networks: tuple[str, ...] = ()
    llm_backup_trusted_networks: tuple[str, ...] = ()
    comfy_base_url: str = ""
    comfy_network_scope: str = "loopback"
    comfy_trusted_networks: tuple[str, ...] = ()

    @property
    def db_path(self) -> Path:
        return self.data_dir / "ultimate_novelai_launcher.sqlite3"

    @property
    def comfy_workflows_dir(self) -> Path:
        return self.data_dir / "comfy-workflows"

    @property
    def comfy_configured(self) -> bool:
        return bool(self.comfy_base_url.strip())

    @property
    def images_dir(self) -> Path:
        return self.data_dir / "images"

    @property
    def nai_configured(self) -> bool:
        return bool(self.nai_token.strip()) or self.mock_generation

    def llm_slots(self) -> list[LlmSlot]:
        """Usable endpoints in priority order without promoting a backup.

        A backup credential is meaningful only after a complete primary slot.
        Treating a backup-only configuration as the primary would make the UI and
        the request-level ``degraded`` contract lie about which provider is active.
        """

        def resolve(
            provider: str,
            base: str,
            key: str,
            model: str,
        ) -> LlmSlot | None:
            provider = (provider or "openai").strip().lower()
            key = (key or "").strip()
            model = (model or "").strip()
            base = _resolve_llm_base(provider, base)
            if key and model and base:
                return LlmSlot(provider, base, key, model)
            return None

        primary = resolve(
            self.llm_provider,
            self.llm_base_url,
            self.llm_api_key,
            self.llm_model,
        )
        if primary is None:
            return []
        slots = [primary]
        backup = resolve(
            self.llm_backup_provider,
            self.llm_backup_base_url,
            self.llm_backup_api_key,
            self.llm_backup_model,
        )
        if backup is not None:
            slots.append(backup)
        return slots

    @property
    def llm_configured(self) -> bool:
        return bool(self.llm_slots())


def load_settings() -> Settings:
    data_dir_raw = (
        os.environ.get("ULTIMATE_NOVELAI_LAUNCHER_DATA_DIR")
        or os.environ.get("NAI_STUDIO_DATA_DIR", "")
    ).strip()
    data_dir = Path(data_dir_raw).expanduser() if data_dir_raw else _default_data_dir()
    local = read_local_settings(data_dir)
    port_raw = (
        os.environ.get("ULTIMATE_NOVELAI_LAUNCHER_SIDECAR_PORT")
        or os.environ.get("NAI_STUDIO_SIDECAR_PORT", "38176")
    ).strip()
    env_token = os.environ.get("NAI_TOKEN", "").strip()
    # 端口不走 _env_int 的"越界即钳位"语义:操作员显式指定的监听端口若无法解析,
    # 静默回落到默认端口会让 sidecar 悄悄听在非预期地址上。这里保持 fail-fast,
    # 只是把裸 ValueError 换成能直接看懂的信息。
    try:
        port = int(port_raw)
    except ValueError as exc:
        raise ValueError(
            f"ULTIMATE_NOVELAI_LAUNCHER_SIDECAR_PORT must be an integer, got {port_raw!r}"
        ) from exc
    if not 0 <= port <= 65535:
        raise ValueError(
            f"ULTIMATE_NOVELAI_LAUNCHER_SIDECAR_PORT must be between 0 and 65535, got {port}"
        )

    return Settings(
        host=(
            os.environ.get("ULTIMATE_NOVELAI_LAUNCHER_SIDECAR_HOST")
            or os.environ.get("NAI_STUDIO_SIDECAR_HOST", "127.0.0.1")
        ).strip() or "127.0.0.1",
        port=port,
        data_dir=data_dir,
        nai_token=env_token or get_stored_token(data_dir),
        nai_base_url=(
            _configured_string(local, "NAI_API_BASE_URL", "nai_base_url")
            or "https://image.novelai.net"
        ).rstrip("/"),
        llm_base_url=_configured_string(
            local,
            "LLM_BASE_URL",
            "llm_base_url",
        ).rstrip("/"),
        llm_api_key=(
            os.environ.get("LLM_API_KEY", "").strip() or get_stored_llm_key(data_dir)
        ),
        llm_model=_configured_string(local, "LLM_MODEL", "llm_model").strip(),
        mock_generation=(
            os.environ.get("ULTIMATE_NOVELAI_LAUNCHER_MOCK_GENERATION")
            or os.environ.get("NAI_STUDIO_MOCK_GENERATION", "")
        ).strip().lower()
        in {"1", "true", "yes", "on"},
        danbooru_proxy_url=os.environ.get("DANBOORU_PROXY_URL", "").strip(),
        llm_provider=_configured_choice(
            local,
            "LLM_PROVIDER",
            "llm_provider",
            "openai",
            _LLM_PROVIDERS,
        ),
        llm_backup_provider=_configured_choice(
            local,
            "LLM_BACKUP_PROVIDER",
            "llm_backup_provider",
            "openai",
            _LLM_PROVIDERS,
        ),
        llm_backup_base_url=_configured_string(
            local,
            "LLM_BACKUP_BASE_URL",
            "llm_backup_base_url",
        ).rstrip("/"),
        llm_backup_api_key=(
            os.environ.get("LLM_BACKUP_API_KEY", "").strip()
            or get_stored_llm_backup_key(data_dir)
        ),
        llm_backup_model=_configured_string(
            local,
            "LLM_BACKUP_MODEL",
            "llm_backup_model",
        ).strip(),
        sidecar_auth_token=os.environ.get("ULTIMATE_NOVELAI_LAUNCHER_SIDECAR_AUTH", "").strip(),
        instance_id=os.environ.get("ULTIMATE_NOVELAI_LAUNCHER_INSTANCE_ID", "").strip(),
        protocol_version=_env_int("ULTIMATE_NOVELAI_LAUNCHER_PROTOCOL", 1, minimum=1, maximum=1),
        unsafe_dev_no_auth=_env_bool("ULTIMATE_NOVELAI_LAUNCHER_UNSAFE_DEV_NO_AUTH"),
        mock_generation_delay_ms=_env_int(
            "ULTIMATE_NOVELAI_LAUNCHER_MOCK_GENERATION_DELAY_MS", 0, minimum=0, maximum=60_000
        ),
        generation_workers=_env_int(
            "ULTIMATE_NOVELAI_LAUNCHER_GENERATION_WORKERS", 1, minimum=1, maximum=4
        ),
        generation_queue_capacity=_env_int(
            "ULTIMATE_NOVELAI_LAUNCHER_QUEUE_CAPACITY", 32, minimum=1, maximum=256
        ),
        storage_quota_bytes=_env_int(
            "ULTIMATE_NOVELAI_LAUNCHER_STORAGE_QUOTA_BYTES",
            10 * 1024 * 1024 * 1024,
            minimum=1024 * 1024,
        ),
        storage_reserve_bytes=_env_int(
            "ULTIMATE_NOVELAI_LAUNCHER_STORAGE_RESERVE_BYTES",
            1024 * 1024 * 1024,
            minimum=0,
        ),
        llm_network_scope=_configured_choice(
            local,
            "LLM_NETWORK_SCOPE",
            "llm_network_scope",
            "public",
            _NETWORK_SCOPES,
        ),
        llm_backup_network_scope=_configured_choice(
            local,
            "LLM_BACKUP_NETWORK_SCOPE",
            "llm_backup_network_scope",
            "public",
            _NETWORK_SCOPES,
        ),
        llm_trusted_networks=_configured_networks(
            local,
            "LLM_TRUSTED_NETWORKS",
            "llm_trusted_networks",
        ),
        llm_backup_trusted_networks=_configured_networks(
            local,
            "LLM_BACKUP_TRUSTED_NETWORKS",
            "llm_backup_trusted_networks",
        ),
        comfy_base_url=_configured_string(
            local,
            "ULTIMATE_NOVELAI_LAUNCHER_COMFY_URL",
            "comfy_base_url",
        ).strip().rstrip("/"),
        comfy_network_scope=_configured_choice(
            local,
            "ULTIMATE_NOVELAI_LAUNCHER_COMFY_NETWORK_SCOPE",
            "comfy_network_scope",
            "loopback",
            _COMFY_NETWORK_SCOPES,
        ),
        comfy_trusted_networks=_configured_networks(
            local,
            "ULTIMATE_NOVELAI_LAUNCHER_COMFY_TRUSTED_NETWORKS",
            "comfy_trusted_networks",
        ),
    )


def _env_bool(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def _env_int(
    name: str,
    default: int,
    *,
    minimum: int,
    maximum: int | None = None,
) -> int:
    raw = os.environ.get(name, "").strip()
    try:
        value = int(raw) if raw else default
    except ValueError:
        return default
    value = max(minimum, value)
    return min(maximum, value) if maximum is not None else value
