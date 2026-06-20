"""Cross-platform secure storage for app secrets (NovelAI token, LLM API key).

Each secret is stored under its own account in an OS-managed secret store:

- macOS: Keychain (via the ``security`` CLI).
- Windows: Credential Manager (via the Win32 ``Cred*`` API through ctypes).
- Linux/BSD: Secret Service / libsecret (via the ``secret-tool`` CLI).

If no secure store is available the caller receives a :class:`CredentialStorageError`
instead of the secret being written to disk in plaintext. The legacy plaintext
``novelai.token`` file (NovelAI token only) is no longer written; it is read once
for migration and then deleted.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

SERVICE_NAME = "Ultimate Novelai launcher"
ACCOUNT_NOVELAI = "novelai-token"
ACCOUNT_LLM = "llm-api-key"
ACCOUNT_LLM_BACKUP = "llm-api-key-backup"


class CredentialStorageError(RuntimeError):
    """Raised when a secret cannot be stored or removed via a secure OS store."""


# ---------------------------------------------------------------------------
# NovelAI token (public API — unchanged behaviour, incl. legacy file migration)
# ---------------------------------------------------------------------------


def get_stored_token(data_dir: Path) -> str:
    """Return the stored NovelAI token, migrating any legacy plaintext file if present."""
    token = _secure_get(ACCOUNT_NOVELAI)
    if token:
        return token
    # One-time migration: a previous build may have written a plaintext file.
    legacy = _file_get_token(data_dir)
    if legacy:
        if _secure_available() and _secure_set(ACCOUNT_NOVELAI, legacy):
            _file_delete_token(data_dir)
        return legacy
    return ""


def set_stored_token(data_dir: Path, token: str) -> bool:
    """Persist the NovelAI token in a secure OS store (raises if none available)."""
    token = token.strip()
    if not token:
        delete_stored_token(data_dir)
        return True
    if _secure_set(ACCOUNT_NOVELAI, token):
        # Remove any leftover plaintext from older builds now that it is in the store.
        _file_delete_token(data_dir)
        return True
    raise _no_store_error()


def delete_stored_token(data_dir: Path) -> None:
    """Remove the NovelAI token from the secure store and clean up legacy plaintext."""
    _secure_delete(ACCOUNT_NOVELAI)
    _file_delete_token(data_dir)


# ---------------------------------------------------------------------------
# LLM API key (secure store only; never had a plaintext file)
# ---------------------------------------------------------------------------


def get_stored_llm_key(data_dir: Path) -> str:
    """Return the stored LLM API key, or "" if none."""
    return _secure_get(ACCOUNT_LLM)


def set_stored_llm_key(data_dir: Path, api_key: str) -> bool:
    """Persist the LLM API key in a secure OS store (raises if none available)."""
    api_key = api_key.strip()
    if not api_key:
        delete_stored_llm_key(data_dir)
        return True
    if _secure_set(ACCOUNT_LLM, api_key):
        return True
    raise _no_store_error()


def delete_stored_llm_key(data_dir: Path) -> None:
    """Remove the LLM API key from the secure store."""
    _secure_delete(ACCOUNT_LLM)


def get_stored_llm_backup_key(data_dir: Path) -> str:
    """Return the stored backup LLM API key, or "" if none."""
    return _secure_get(ACCOUNT_LLM_BACKUP)


def set_stored_llm_backup_key(data_dir: Path, api_key: str) -> bool:
    """Persist the backup LLM API key in a secure OS store (raises if none available)."""
    api_key = api_key.strip()
    if not api_key:
        delete_stored_llm_backup_key(data_dir)
        return True
    if _secure_set(ACCOUNT_LLM_BACKUP, api_key):
        return True
    raise _no_store_error()


def delete_stored_llm_backup_key(data_dir: Path) -> None:
    """Remove the backup LLM API key from the secure store."""
    _secure_delete(ACCOUNT_LLM_BACKUP)


def _no_store_error() -> CredentialStorageError:
    if not _secure_available():
        return CredentialStorageError(
            "未找到可用的系统安全凭据存储 "
            "(macOS Keychain / Windows Credential Manager / Linux Secret Service)，"
            "为避免明文保存，密钥未被写入。"
        )
    return CredentialStorageError("系统安全凭据存储写入失败，密钥未被保存。")


# ---------------------------------------------------------------------------
# Secure backend dispatch (per platform), keyed by account
# ---------------------------------------------------------------------------


def _secure_available() -> bool:
    if sys.platform == "darwin":
        return shutil.which("security") is not None
    if sys.platform == "win32":
        return _windows_advapi() is not None
    return shutil.which("secret-tool") is not None


def _secure_get(account: str) -> str:
    if sys.platform == "darwin":
        return _macos_get_password(account)
    if sys.platform == "win32":
        return _windows_get_password(account)
    return _secret_tool_get(account)


def _secure_set(account: str, value: str) -> bool:
    if sys.platform == "darwin":
        return _macos_set_password(account, value)
    if sys.platform == "win32":
        return _windows_set_password(account, value)
    return _secret_tool_set(account, value)


def _secure_delete(account: str) -> None:
    if sys.platform == "darwin":
        _macos_delete_password(account)
    elif sys.platform == "win32":
        _windows_delete_password(account)
    else:
        _secret_tool_delete(account)


# ---------------------------------------------------------------------------
# macOS Keychain (security CLI)
# ---------------------------------------------------------------------------


def _macos_get_password(account: str) -> str:
    try:
        result = subprocess.run(
            ["security", "find-generic-password", "-s", SERVICE_NAME, "-a", account, "-w"],
            capture_output=True,
            check=False,
            text=True,
            timeout=5,
        )
    except Exception:
        return ""
    return result.stdout.strip() if result.returncode == 0 else ""


def _macos_set_password(account: str, value: str) -> bool:
    try:
        result = subprocess.run(
            [
                "security",
                "add-generic-password",
                "-U",
                "-s",
                SERVICE_NAME,
                "-a",
                account,
                "-w",
                value,
            ],
            capture_output=True,
            check=False,
            text=True,
            timeout=5,
        )
    except Exception:
        return False
    return result.returncode == 0


def _macos_delete_password(account: str) -> None:
    try:
        subprocess.run(
            ["security", "delete-generic-password", "-s", SERVICE_NAME, "-a", account],
            capture_output=True,
            check=False,
            text=True,
            timeout=5,
        )
    except Exception:
        return


# ---------------------------------------------------------------------------
# Linux/BSD Secret Service (secret-tool CLI)
# ---------------------------------------------------------------------------


def _secret_tool_attrs(account: str) -> list[str]:
    return ["service", SERVICE_NAME, "account", account]


def _secret_tool_get(account: str) -> str:
    if shutil.which("secret-tool") is None:
        return ""
    try:
        result = subprocess.run(
            ["secret-tool", "lookup", *_secret_tool_attrs(account)],
            capture_output=True,
            check=False,
            text=True,
            timeout=5,
        )
    except Exception:
        return ""
    return result.stdout.strip() if result.returncode == 0 else ""


def _secret_tool_set(account: str, value: str) -> bool:
    if shutil.which("secret-tool") is None:
        return False
    try:
        # The secret is read from stdin, keeping it out of the process argv list.
        result = subprocess.run(
            ["secret-tool", "store", "--label", SERVICE_NAME, *_secret_tool_attrs(account)],
            input=value,
            capture_output=True,
            check=False,
            text=True,
            timeout=10,
        )
    except Exception:
        return False
    return result.returncode == 0


def _secret_tool_delete(account: str) -> None:
    if shutil.which("secret-tool") is None:
        return
    try:
        subprocess.run(
            ["secret-tool", "clear", *_secret_tool_attrs(account)],
            capture_output=True,
            check=False,
            text=True,
            timeout=5,
        )
    except Exception:
        return


# ---------------------------------------------------------------------------
# Windows Credential Manager (Win32 Cred* API via ctypes)
# ---------------------------------------------------------------------------

_CRED_TYPE_GENERIC = 1
_CRED_PERSIST_LOCAL_MACHINE = 2


def _windows_target(account: str) -> str:
    return f"{SERVICE_NAME}/{account}"


def _windows_advapi():
    if sys.platform != "win32":
        return None
    try:
        import ctypes

        return ctypes.WinDLL("advapi32", use_last_error=True)
    except Exception:
        return None


def _windows_structs():
    import ctypes
    from ctypes import wintypes

    class CREDENTIAL(ctypes.Structure):
        _fields_ = [
            ("Flags", wintypes.DWORD),
            ("Type", wintypes.DWORD),
            ("TargetName", wintypes.LPWSTR),
            ("Comment", wintypes.LPWSTR),
            ("LastWritten", wintypes.FILETIME),
            ("CredentialBlobSize", wintypes.DWORD),
            ("CredentialBlob", ctypes.POINTER(ctypes.c_byte)),
            ("Persist", wintypes.DWORD),
            ("AttributeCount", wintypes.DWORD),
            ("Attributes", ctypes.c_void_p),
            ("TargetAlias", wintypes.LPWSTR),
            ("UserName", wintypes.LPWSTR),
        ]

    return ctypes, wintypes, CREDENTIAL


def _windows_get_password(account: str) -> str:
    advapi = _windows_advapi()
    if advapi is None:
        return ""
    try:
        ctypes, wintypes, CREDENTIAL = _windows_structs()
        cred_ptr = ctypes.POINTER(CREDENTIAL)()
        ok = advapi.CredReadW(
            _windows_target(account), _CRED_TYPE_GENERIC, 0, ctypes.byref(cred_ptr)
        )
        if not ok:
            return ""
        try:
            cred = cred_ptr.contents
            size = int(cred.CredentialBlobSize)
            if size <= 0 or not cred.CredentialBlob:
                return ""
            blob = ctypes.string_at(cred.CredentialBlob, size)
            return blob.decode("utf-16-le", errors="ignore").strip()
        finally:
            advapi.CredFree(cred_ptr)
    except Exception:
        return ""


def _windows_set_password(account: str, value: str) -> bool:
    advapi = _windows_advapi()
    if advapi is None:
        return False
    try:
        ctypes, wintypes, CREDENTIAL = _windows_structs()
        blob = value.encode("utf-16-le")
        blob_buf = ctypes.create_string_buffer(blob, len(blob))
        cred = CREDENTIAL()
        cred.Type = _CRED_TYPE_GENERIC
        cred.TargetName = _windows_target(account)
        cred.CredentialBlobSize = len(blob)
        cred.CredentialBlob = ctypes.cast(blob_buf, ctypes.POINTER(ctypes.c_byte))
        cred.Persist = _CRED_PERSIST_LOCAL_MACHINE
        cred.UserName = account
        return bool(advapi.CredWriteW(ctypes.byref(cred), 0))
    except Exception:
        return False


def _windows_delete_password(account: str) -> None:
    advapi = _windows_advapi()
    if advapi is None:
        return
    try:
        import ctypes  # noqa: F401

        advapi.CredDeleteW(_windows_target(account), _CRED_TYPE_GENERIC, 0)
    except Exception:
        return


# ---------------------------------------------------------------------------
# Legacy plaintext file (NovelAI token only; read + delete for migration)
# ---------------------------------------------------------------------------


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


def _file_delete_token(data_dir: Path) -> None:
    try:
        _token_path(data_dir).unlink()
    except FileNotFoundError:
        return
    except Exception:
        return
