from __future__ import annotations

import os
import stat
import subprocess
import sys
from pathlib import Path

SERVICE_NAME = "NAI Studio"
ACCOUNT_NAME = "novelai-token"


def get_stored_token(data_dir: Path) -> str:
    if sys.platform == "darwin":
        token = _macos_get_password()
        if token:
            return token
    return _file_get_token(data_dir)


def set_stored_token(data_dir: Path, token: str) -> bool:
    token = token.strip()
    if not token:
        delete_stored_token(data_dir)
        return True
    if sys.platform == "darwin" and _macos_set_password(token):
        _file_delete_token(data_dir)
        return True
    _file_set_token(data_dir, token)
    return True


def delete_stored_token(data_dir: Path) -> None:
    if sys.platform == "darwin":
        _macos_delete_password()
    _file_delete_token(data_dir)


def _macos_get_password() -> str:
    try:
        result = subprocess.run(
            ["security", "find-generic-password", "-s", SERVICE_NAME, "-a", ACCOUNT_NAME, "-w"],
            capture_output=True,
            check=False,
            text=True,
            timeout=5,
        )
    except Exception:
        return ""
    return result.stdout.strip() if result.returncode == 0 else ""


def _macos_set_password(token: str) -> bool:
    try:
        result = subprocess.run(
            [
                "security",
                "add-generic-password",
                "-U",
                "-s",
                SERVICE_NAME,
                "-a",
                ACCOUNT_NAME,
                "-w",
                token,
            ],
            capture_output=True,
            check=False,
            text=True,
            timeout=5,
        )
    except Exception:
        return False
    return result.returncode == 0


def _macos_delete_password() -> None:
    try:
        subprocess.run(
            ["security", "delete-generic-password", "-s", SERVICE_NAME, "-a", ACCOUNT_NAME],
            capture_output=True,
            check=False,
            text=True,
            timeout=5,
        )
    except Exception:
        return


def _token_path(data_dir: Path) -> Path:
    return data_dir / "secrets" / "novelai.token"


def _file_get_token(data_dir: Path) -> str:
    path = _token_path(data_dir)
    try:
        return path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return ""
    except Exception:
        return ""


def _file_set_token(data_dir: Path, token: str) -> None:
    path = _token_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(token, encoding="utf-8")
    try:
        os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
    except Exception:
        pass


def _file_delete_token(data_dir: Path) -> None:
    try:
        _token_path(data_dir).unlink()
    except FileNotFoundError:
        return
    except Exception:
        return
