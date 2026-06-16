from __future__ import annotations

import base64
import binascii
import re
from datetime import datetime
from pathlib import Path
from typing import Any

from .config import Settings

SAFE_NAME_RE = re.compile(r"[^a-zA-Z0-9_.-]+")
DATA_URL_RE = re.compile(r"^data:(?P<mime>[-\w.]+/[-\w+.]+);base64,(?P<data>.+)$", re.S)


def ensure_asset_dirs(settings: Settings) -> None:
    for kind in ("oc", "artists", "cr", "vibes"):
        asset_dir(settings, kind).mkdir(parents=True, exist_ok=True)


def asset_dir(settings: Settings, kind: str) -> Path:
    return settings.data_dir / "assets" / kind


def save_base64_asset(settings: Settings, kind: str, key: str, value: Any) -> Path | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        payload, ext = decode_base64_asset(value)
    except ValueError:
        return None
    path = asset_dir(settings, kind) / f"{safe_name(key)}.{ext}"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    return path


def decode_base64_asset(value: str) -> tuple[bytes, str]:
    text = value.strip()
    match = DATA_URL_RE.match(text)
    mime = "image/png"
    if match:
        mime = match.group("mime")
        text = match.group("data")
    try:
        payload = base64.b64decode(text, validate=False)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("invalid base64 asset") from exc
    ext = "jpg" if mime in {"image/jpeg", "image/jpg"} else "png"
    return payload, ext


def safe_name(value: str) -> str:
    safe = SAFE_NAME_RE.sub("_", Path(str(value)).name).strip("._")
    if not safe:
        raise ValueError("invalid asset name")
    return safe[:120]


def safe_existing_path(settings: Settings, kind: str, value: str) -> Path:
    root = asset_dir(settings, kind).resolve()
    path = Path(value).resolve()
    if root not in path.parents and path != root:
        raise ValueError("asset path escapes storage directory")
    if not path.exists():
        raise FileNotFoundError(path)
    return path


def delete_file_if_safe(settings: Settings, kind: str, value: str) -> None:
    try:
        safe_existing_path(settings, kind, value).unlink()
    except (FileNotFoundError, ValueError):
        return


def unique_filename(settings: Settings, name: str, item_id: str) -> str:
    del settings
    stem = safe_name(slug(name) or f"vibe-{item_id[:8]}")
    return f"{stem}-{item_id[:8]}.json"


def slug(value: str) -> str:
    return SAFE_NAME_RE.sub("_", value.lower()).strip("._")[:48]


def string_or_none(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def to_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def to_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def now_ms() -> int:
    return int(datetime.now().timestamp() * 1000)


def format_ms(value: int) -> str:
    return datetime.fromtimestamp(int(value) / 1000).strftime("%Y-%m-%d %H:%M:%S")


def model_to_encoding_key(model: str) -> str:
    return {
        "nai-diffusion-4-full": "v4full",
        "nai-diffusion-4-curated": "v4curated",
        "nai-diffusion-4-5-full": "v4-5full",
        "nai-diffusion-4-5-curated": "v4-5curated",
        "nai-diffusion-3": "v3",
    }.get(model, model)
