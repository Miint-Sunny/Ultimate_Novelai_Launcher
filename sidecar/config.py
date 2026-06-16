from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path

from .credentials import get_stored_token
from .local_settings import read_local_settings


def _default_data_dir() -> Path:
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Ultimate_Novelai_launcher"
    if sys.platform == "win32":
        base = os.environ.get("APPDATA")
        if base:
            return Path(base) / "Ultimate_Novelai_launcher"
        return Path.home() / "AppData" / "Roaming" / "Ultimate_Novelai_launcher"
    return Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "Ultimate_Novelai_launcher"


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

    @property
    def db_path(self) -> Path:
        return self.data_dir / "ultimate_novelai_launcher.sqlite3"

    @property
    def images_dir(self) -> Path:
        return self.data_dir / "images"

    @property
    def nai_configured(self) -> bool:
        return bool(self.nai_token.strip()) or self.mock_generation

    @property
    def llm_configured(self) -> bool:
        return all(
            value.strip()
            for value in (self.llm_base_url, self.llm_api_key, self.llm_model)
        )


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

    return Settings(
        host=(
            os.environ.get("ULTIMATE_NOVELAI_LAUNCHER_SIDECAR_HOST")
            or os.environ.get("NAI_STUDIO_SIDECAR_HOST", "127.0.0.1")
        ).strip() or "127.0.0.1",
        port=int(port_raw),
        data_dir=data_dir,
        nai_token=env_token or get_stored_token(data_dir),
        nai_base_url=os.environ.get("NAI_API_BASE_URL", local.get("nai_base_url", "https://image.novelai.net")).rstrip("/"),
        llm_base_url=os.environ.get("LLM_BASE_URL", local.get("llm_base_url", "")).rstrip("/"),
        llm_api_key=os.environ.get("LLM_API_KEY", "").strip(),
        llm_model=os.environ.get("LLM_MODEL", local.get("llm_model", "")).strip(),
        mock_generation=(
            os.environ.get("ULTIMATE_NOVELAI_LAUNCHER_MOCK_GENERATION")
            or os.environ.get("NAI_STUDIO_MOCK_GENERATION", "")
        ).strip().lower()
        in {"1", "true", "yes", "on"},
    )
