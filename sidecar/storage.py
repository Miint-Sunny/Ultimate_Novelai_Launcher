from __future__ import annotations

import base64
from pathlib import Path

from .config import Settings

_ONE_PIXEL_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
)


def ensure_storage(settings: Settings) -> None:
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    settings.images_dir.mkdir(parents=True, exist_ok=True)


def image_path(settings: Settings, image_id: str) -> Path:
    return settings.images_dir / f"{image_id}.png"


def save_image(settings: Settings, image_id: str, payload: bytes) -> Path:
    ensure_storage(settings)
    path = image_path(settings, image_id)
    path.write_bytes(payload)
    return path


def write_mock_image(settings: Settings, image_id: str) -> Path:
    return save_image(settings, image_id, _ONE_PIXEL_PNG)
