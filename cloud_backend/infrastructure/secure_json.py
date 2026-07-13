"""Owner-only, fail-closed JSON object persistence for legacy credentials."""

from __future__ import annotations

import json
import os
import secrets
import stat
from pathlib import Path
from typing import Any

from .secure_sqlite import (
    FileIdentity,
    StorageIntegrityError,
    assert_directory_identity,
    ensure_secure_directory,
)


class SecureJsonObjectStore:
    """Persist one bounded JSON object without following attacker-controlled links.

    The directory and file identities are checked around every operation. Writes
    use an owner-only temporary file, ``fsync`` it, atomically replace the target,
    and finally ``fsync`` the containing directory.
    """

    def __init__(self, path: Path, *, max_bytes: int = 4 * 1024 * 1024) -> None:
        if max_bytes < 2:
            raise ValueError("max_bytes must allow a JSON object")
        self.path = Path(path).absolute()
        self.max_bytes = max_bytes
        self._directory_identity: FileIdentity | None = None

    def load(self) -> dict[str, Any]:
        """Load the object, returning an empty object only when no file exists."""

        if not self._prepare_directory(create=False):
            return {}
        try:
            descriptor = self._open_target()
        except FileNotFoundError:
            return {}
        try:
            payload = _read_bounded(descriptor, self.max_bytes)
        finally:
            os.close(descriptor)
        try:
            value = json.loads(payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise StorageIntegrityError("JSON session store is corrupt") from exc
        if not isinstance(value, dict):
            raise StorageIntegrityError("JSON session store root must be an object")
        return value

    def save(self, value: dict[str, Any]) -> None:
        """Atomically replace the object after validating path confinement."""

        try:
            payload = json.dumps(
                value,
                ensure_ascii=False,
                indent=2,
                allow_nan=False,
            ).encode("utf-8")
        except (TypeError, ValueError) as exc:
            raise StorageIntegrityError("JSON session store value is not serializable") from exc
        if len(payload) > self.max_bytes:
            raise StorageIntegrityError("JSON session store exceeds its size limit")

        self._prepare_directory(create=True)
        try:
            existing = self._open_target()
        except FileNotFoundError:
            pass
        else:
            os.close(existing)

        temporary_name = f".{self.path.name}.{secrets.token_hex(8)}.tmp"
        temporary = self.path.parent / temporary_name
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        flags |= getattr(os, "O_CLOEXEC", 0)
        flags |= getattr(os, "O_NOFOLLOW", 0)
        flags |= getattr(os, "O_BINARY", 0)
        try:
            descriptor = os.open(temporary, flags, 0o600)
            try:
                _validate_descriptor(descriptor, require_single_link=True)
                fchmod = getattr(os, "fchmod", None)
                if fchmod is not None:  # pragma: no branch - available on supported Unix
                    fchmod(descriptor, 0o600)
                _write_all(descriptor, payload)
                os.fsync(descriptor)
            finally:
                os.close(descriptor)

            self._assert_directory()
            os.replace(temporary, self.path)
            self._assert_directory()
            installed = self._open_target()
            os.close(installed)
            _fsync_directory(self.path.parent)
        except BaseException:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass
            raise

    def _prepare_directory(self, *, create: bool) -> bool:
        try:
            current = ensure_secure_directory(self.path.parent, create=create)
        except StorageIntegrityError:
            if not create:
                try:
                    os.lstat(self.path.parent)
                except FileNotFoundError:
                    return False
            raise
        if self._directory_identity is None:
            self._directory_identity = current
        elif current != self._directory_identity:
            raise StorageIntegrityError("JSON session store directory changed")
        return True

    def _assert_directory(self) -> None:
        identity = self._directory_identity
        if identity is None:  # pragma: no cover - internal invariant
            raise StorageIntegrityError("JSON session store is not initialized")
        assert_directory_identity(self.path.parent, identity)

    def _open_target(self) -> int:
        self._assert_directory()
        flags = os.O_RDONLY
        flags |= getattr(os, "O_CLOEXEC", 0)
        flags |= getattr(os, "O_NOFOLLOW", 0)
        flags |= getattr(os, "O_BINARY", 0)
        try:
            descriptor = os.open(self.path, flags)
        except FileNotFoundError:
            raise
        except OSError as exc:
            raise StorageIntegrityError("JSON session store could not be opened safely") from exc
        try:
            descriptor_metadata = _validate_descriptor(descriptor, require_single_link=True)
            if os.name != "nt" and stat.S_IMODE(descriptor_metadata.st_mode) != 0o600:
                os.fchmod(descriptor, 0o600)
                descriptor_metadata = _validate_descriptor(
                    descriptor,
                    require_single_link=True,
                )
            path_metadata = os.lstat(self.path)
            if (
                stat.S_ISLNK(path_metadata.st_mode)
                or not stat.S_ISREG(path_metadata.st_mode)
                or (path_metadata.st_dev, path_metadata.st_ino)
                != (descriptor_metadata.st_dev, descriptor_metadata.st_ino)
            ):
                raise StorageIntegrityError("JSON session store path changed while opening")
            self._assert_directory()
            return descriptor
        except BaseException:
            os.close(descriptor)
            raise


def _validate_descriptor(descriptor: int, *, require_single_link: bool) -> os.stat_result:
    metadata = os.fstat(descriptor)
    if not stat.S_ISREG(metadata.st_mode):
        raise StorageIntegrityError("JSON session store path is not a regular file")
    if require_single_link and metadata.st_nlink != 1:
        raise StorageIntegrityError("JSON session store must not be hard linked")
    getuid = getattr(os, "getuid", None)
    if getuid is not None and metadata.st_uid != getuid():
        raise StorageIntegrityError("JSON session store has a different owner")
    return metadata


def _read_bounded(descriptor: int, limit: int) -> bytes:
    metadata = _validate_descriptor(descriptor, require_single_link=True)
    if metadata.st_size > limit:
        raise StorageIntegrityError("JSON session store exceeds its size limit")
    chunks: list[bytes] = []
    remaining = limit + 1
    while remaining:
        chunk = os.read(descriptor, min(64 * 1024, remaining))
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    payload = b"".join(chunks)
    if len(payload) > limit:
        raise StorageIntegrityError("JSON session store exceeds its size limit")
    return payload


def _write_all(descriptor: int, payload: bytes) -> None:
    view = memoryview(payload)
    while view:
        written = os.write(descriptor, view)
        if written <= 0:  # pragma: no cover - regular-file invariant
            raise OSError("JSON session store write made no progress")
        view = view[written:]


def _fsync_directory(path: Path) -> None:
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    flags |= getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError:
        if os.name == "nt":  # pragma: no cover - Windows directory fsync fallback
            return
        raise
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


__all__ = ["SecureJsonObjectStore"]
