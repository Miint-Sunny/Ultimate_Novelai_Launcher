from __future__ import annotations

import json
from pathlib import Path
from typing import Any

EDITABLE_KEYS = {
    "nai_base_url",
    "llm_base_url",
    "llm_model",
}


def settings_path(data_dir: Path) -> Path:
    return data_dir / "settings.json"


def read_local_settings(data_dir: Path) -> dict[str, Any]:
    path = settings_path(data_dir)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except Exception:
        return {}
    if not isinstance(data, dict):
        return {}
    return {key: data[key] for key in EDITABLE_KEYS if isinstance(data.get(key), str)}


def write_local_settings(data_dir: Path, updates: dict[str, Any]) -> dict[str, Any]:
    current = read_local_settings(data_dir)
    for key, value in updates.items():
        if key in EDITABLE_KEYS and isinstance(value, str):
            current[key] = value.strip()
    path = settings_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(current, ensure_ascii=False, indent=2), encoding="utf-8")
    return current
