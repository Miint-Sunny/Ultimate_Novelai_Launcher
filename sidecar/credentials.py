"""Cross-platform secure storage for the NovelAI token.

The token is only ever persisted through an OS-managed secret store:

- macOS: Keychain (via the ``security`` CLI).
- Windows: Credential Manager (via the Win32 ``Cred*`` API through ctypes).
- Linux/BSD: Secret Service / libsecret (via the ``secret-tool`` CLI).

If no secure store is available the caller receives a :class:`CredentialStorageError`
instead of the token being written to disk in plaintext. The legacy plaintext
``novelai.token`` file is no longer written; it is only read once for migration
and then deleted.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

SERVICE_NAME = "Ultimate Novelai launcher"
ACCOUNT_NAME = "novelai-token"


class CredentialStorageError(RuntimeError):
    """Raised when the token cannot be stored or removed via a secure OS store."""


def get_stored_token(data_dir: Path) -> str:
    """Return the stored token, migrating any legacy plaintext file if present."""
    token = _secure_get()
    if token:
        return token
    # One-time migration: a previous build may have written a plaintext file.
    legacy = _file_get_token(data_dir)
    if legacy:
        if _secure_available() and _secure_set(legacy):
            _file_delete_token(data_dir)
        return legacy
    return ""


def set_stored_token(data_dir: Path, token: str) -> bool:
    """Persist the token in a secure OS store.

    Returns ``True`` on success. Raises :class:`CredentialStorageError` when no
    secure store is available so the token is never written in plaintext.
    """
    token = token.strip()
    if not token:
        delete_stored_token(data_dir)
        return True
    if _secure_set(token):
        # Remove any leftover plaintext from older builds now that it is in the store.
        _file_delete_token(data_dir)
        return True
    if not _secure_available():
        raise CredentialStorageError(
            "未找到可用的系统安全凭据存储 "
            "(macOS Keychain / Windows Credential Manager / Linux Secret Service)，"
            "为避免明文保存，token 未被写入。"
        )
    raise CredentialStorageError(
        "系统安全凭据存储写入失败，token 未被保存。"
    )


def delete_stored_token(data_dir: Path) -> None:
    """Remove the token from the secure store and clean up any legacy plaintext."""
    _secure_delete()
    _file_delete_token(data_dir)


# ---------------------------------------------------------------------------
# Secure backend dispatch (per platform)
# ---------------------------------------------------------------------------


def _secure_available() -> bool:
    if sys.platform == "darwin":
        return shutil.which("security") is not None
    if sys.platform == "win32":
        return _windows_advapi() is not None
    return shutil.which("secret-tool") is not None


def _secure_get() -> str:
    if sys.platform == "darwin":
        return _macos_get_password()
    if sys.platform == "win32":
        return _windows_get_password()
    return _secret_tool_get()


def _secure_set(token: str) -> bool:
    if sys.platform == "darwin":
        return _macos_set_password(token)
    if sys.platform == "win32":
        return _windows_set_password(token)
    return _secret_tool_set(token)


def _secure_delete() -> None:
    if sys.platform == "darwin":
        _macos_delete_password()
    elif sys.platform == "win32":
        _windows_delete_password()
    else:
        _secret_tool_delete()


# ---------------------------------------------------------------------------
# macOS Keychain (security CLI)
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# Linux/BSD Secret Service (secret-tool CLI)
# ---------------------------------------------------------------------------

_SECRET_TOOL_ATTRS = ["service", SERVICE_NAME, "account", ACCOUNT_NAME]


def _secret_tool_get() -> str:
    if shutil.which("secret-tool") is None:
        return ""
    try:
        result = subprocess.run(
            ["secret-tool", "lookup", *_SECRET_TOOL_ATTRS],
            capture_output=True,
            check=False,
            text=True,
            timeout=5,
        )
    except Exception:
        return ""
    return result.stdout.strip() if result.returncode == 0 else ""


def _secret_tool_set(token: str) -> bool:
    if shutil.which("secret-tool") is None:
        return False
    try:
        # The secret is read from stdin, keeping it out of the process argv list.
        result = subprocess.run(
            ["secret-tool", "store", "--label", SERVICE_NAME, *_SECRET_TOOL_ATTRS],
            input=token,
            capture_output=True,
            check=False,
            text=True,
            timeout=10,
        )
    except Exception:
        return False
    return result.returncode == 0


def _secret_tool_delete() -> None:
    if shutil.which("secret-tool") is None:
        return
    try:
        subprocess.run(
            ["secret-tool", "clear", *_SECRET_TOOL_ATTRS],
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

_WINDOWS_TARGET = f"{SERVICE_NAME}/{ACCOUNT_NAME}"
_CRED_TYPE_GENERIC = 1
_CRED_PERSIST_LOCAL_MACHINE = 2


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


def _windows_get_password() -> str:
    advapi = _windows_advapi()
    if advapi is None:
        return ""
    try:
        ctypes, wintypes, CREDENTIAL = _windows_structs()
        cred_ptr = ctypes.POINTER(CREDENTIAL)()
        ok = advapi.CredReadW(
            _WINDOWS_TARGET, _CRED_TYPE_GENERIC, 0, ctypes.byref(cred_ptr)
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


def _windows_set_password(token: str) -> bool:
    advapi = _windows_advapi()
    if advapi is None:
        return False
    try:
        ctypes, wintypes, CREDENTIAL = _windows_structs()
        blob = token.encode("utf-16-le")
        blob_buf = ctypes.create_string_buffer(blob, len(blob))
        cred = CREDENTIAL()
        cred.Type = _CRED_TYPE_GENERIC
        cred.TargetName = _WINDOWS_TARGET
        cred.CredentialBlobSize = len(blob)
        cred.CredentialBlob = ctypes.cast(blob_buf, ctypes.POINTER(ctypes.c_byte))
        cred.Persist = _CRED_PERSIST_LOCAL_MACHINE
        cred.UserName = ACCOUNT_NAME
        return bool(advapi.CredWriteW(ctypes.byref(cred), 0))
    except Exception:
        return False


def _windows_delete_password() -> None:
    advapi = _windows_advapi()
    if advapi is None:
        return
    try:
        import ctypes

        advapi.CredDeleteW(_WINDOWS_TARGET, _CRED_TYPE_GENERIC, 0)
    except Exception:
        return


# ---------------------------------------------------------------------------
# Legacy plaintext file (read + delete only, for migration/cleanup)
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
