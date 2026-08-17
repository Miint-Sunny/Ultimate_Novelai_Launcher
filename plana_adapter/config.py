"""适配器配置:全部来自环境变量,fail-fast。"""

from __future__ import annotations

import os
from dataclasses import dataclass


class ConfigError(RuntimeError):
    """必需配置缺失或非法。"""


@dataclass(frozen=True)
class AdapterConfig:
    # 上游后端基址(本项目的云宿主),不含尾斜杠、不含 /api。
    upstream_base: str
    # 适配器自身监听地址。
    host: str
    port: int
    # 转发上游的超时(秒)。生成提交与 vibe 编码可能偏慢,分开给。
    request_timeout: float
    generate_timeout: float
    # 可选:把适配器领取到的一次性 poll_token 保存上限(内存中 code→token 映射)。
    max_pending_codes: int


def _env_str(name: str, default: str | None = None) -> str:
    value = os.environ.get(name)
    if value is None or value.strip() == "":
        if default is None:
            raise ConfigError(f"missing required env var: {name}")
        return default
    return value.strip()


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise ConfigError(f"invalid integer for {name}: {raw!r}") from exc


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return float(raw)
    except ValueError as exc:
        raise ConfigError(f"invalid number for {name}: {raw!r}") from exc


def load_config() -> AdapterConfig:
    upstream = _env_str("PLANA_ADAPTER_UPSTREAM").rstrip("/")
    if not (upstream.startswith("http://") or upstream.startswith("https://")):
        raise ConfigError("PLANA_ADAPTER_UPSTREAM must be an http(s) URL")
    if upstream.endswith("/api"):
        upstream = upstream[: -len("/api")]
    return AdapterConfig(
        upstream_base=upstream,
        host=_env_str("PLANA_ADAPTER_HOST", "127.0.0.1"),
        port=_env_int("PLANA_ADAPTER_PORT", 8765),
        request_timeout=_env_float("PLANA_ADAPTER_TIMEOUT", 30.0),
        generate_timeout=_env_float("PLANA_ADAPTER_GENERATE_TIMEOUT", 120.0),
        max_pending_codes=_env_int("PLANA_ADAPTER_MAX_PENDING_CODES", 2000),
    )


__all__ = ["AdapterConfig", "ConfigError", "load_config"]
