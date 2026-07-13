"""Atomic file-backed storage for large legacy cloud-job results."""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import os
import re
import secrets
import stat
import tempfile
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from ..errors import InvalidRequestError, ResourceNotFoundError
from .secure_sqlite import (
    FileIdentity,
    StorageIntegrityError,
    assert_directory_identity,
    ensure_secure_directory,
)

_JOB_ID = re.compile(r"^[A-Za-z0-9_-]{1,200}$")
_MIME_EXTENSIONS = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
}


class CloudJobResultStore:
    """Store image bytes once and keep only bounded metadata in SQLite/events."""

    def __init__(self, root: Path, *, max_bytes: int = 64 * 1024 * 1024) -> None:
        if max_bytes <= 0:
            raise ValueError("max_bytes must be positive")
        self.root = Path(root).absolute()
        self.max_bytes = max_bytes
        self._root_identity: FileIdentity | None = None
        self._initialize_lock = asyncio.Lock()

    async def initialize(self) -> None:
        async with self._initialize_lock:
            identity = await asyncio.to_thread(
                ensure_secure_directory,
                self.root,
                create=self._root_identity is None,
            )
            if self._root_identity is not None and identity != self._root_identity:
                raise StorageIntegrityError("result storage root changed after initialization")
            self._root_identity = identity

    async def save_base64(
        self,
        job_id: str,
        encoded: str,
        *,
        mime_type: str | None = None,
    ) -> dict[str, Any]:
        _validate_job_id(job_id)
        if not isinstance(encoded, str) or not encoded:
            raise InvalidRequestError("job result is invalid")
        max_encoded = ((self.max_bytes + 2) // 3) * 4 + 4
        if len(encoded) > max_encoded:
            raise InvalidRequestError("job result is too large")
        try:
            payload = await asyncio.to_thread(base64.b64decode, encoded, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise InvalidRequestError("job result is not valid base64") from exc
        if len(payload) > self.max_bytes:
            raise InvalidRequestError("job result is too large")
        detected = _detect_image_mime(payload)
        if mime_type is not None and mime_type.split(";", 1)[0].strip().lower() != detected:
            raise InvalidRequestError("job result MIME does not match its contents")
        extension = _MIME_EXTENSIONS[detected]
        digest = hashlib.sha256(payload).hexdigest()
        # New writes are content-addressed and immutable.  Older metadata with
        # ``<job_id>.<ext>`` paths remains readable through the generic verifier.
        filename = f"{digest}.{extension}"
        await self.initialize()
        await asyncio.to_thread(self._atomic_write_immutable, filename, payload)
        return {
            "type": "file",
            "path": filename,
            "mime_type": detected,
            "size": len(payload),
            "sha256": digest,
        }

    async def load_base64(self, metadata: Mapping[str, Any]) -> str:
        payload = await self.load_bytes(metadata)
        encoded = await asyncio.to_thread(base64.b64encode, payload)
        return encoded.decode("ascii")

    async def load_bytes(self, metadata: Mapping[str, Any]) -> bytes:
        """Load and verify one persisted result without an unnecessary re-encode."""

        await self.initialize()
        return await asyncio.to_thread(self._read_verified, metadata)

    async def reconcile(
        self,
        references: Mapping[str, Mapping[str, Any] | None],
    ) -> tuple[list[str], list[str]]:
        """Validate terminal references and quarantine unreferenced complete files."""

        await self.initialize()
        return await asyncio.to_thread(self._reconcile, references)

    def _metadata_path(self, metadata: Mapping[str, Any]) -> Path:
        self._assert_root()
        if metadata.get("type") != "file":
            raise ResourceNotFoundError()
        filename = metadata.get("path")
        if not isinstance(filename, str) or Path(filename).name != filename:
            raise ResourceNotFoundError()
        path = self.root / filename
        if path.parent != self.root:
            raise ResourceNotFoundError()
        return path

    def _atomic_write_immutable(self, filename: str, payload: bytes) -> None:
        self._assert_root()
        destination = self.root / filename
        descriptor, temporary = tempfile.mkstemp(prefix=f".{filename}.", dir=self.root)
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            self._assert_root()
            try:
                # Hard-linking a complete temp file publishes it atomically and
                # fails instead of replacing an existing referenced result.
                os.link(temporary, destination)
            except FileExistsError:
                metadata = os.lstat(destination)
                if (
                    stat.S_ISLNK(metadata.st_mode)
                    or not stat.S_ISREG(metadata.st_mode)
                    or metadata.st_size != len(payload)
                    or destination.read_bytes() != payload
                ):
                    raise StorageIntegrityError(
                        "content-addressed result path contains different bytes"
                    ) from None
            os.unlink(temporary)
            self._fsync_directory(self.root)
        except BaseException:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass
            raise

    def _read_verified(self, metadata: Mapping[str, Any]) -> bytes:
        path = self._metadata_path(metadata)
        try:
            file_metadata = os.lstat(path)
            if stat.S_ISLNK(file_metadata.st_mode) or not stat.S_ISREG(file_metadata.st_mode):
                raise ResourceNotFoundError()
            payload = path.read_bytes()
        except FileNotFoundError as exc:
            raise ResourceNotFoundError() from exc
        expected_size = metadata.get("size")
        expected_hash = metadata.get("sha256")
        if len(payload) > self.max_bytes or expected_size != len(payload):
            raise ResourceNotFoundError()
        if (
            not isinstance(expected_hash, str)
            or not hashlib.sha256(payload).hexdigest() == expected_hash
        ):
            raise ResourceNotFoundError()
        return payload

    def _reconcile(
        self,
        references: Mapping[str, Mapping[str, Any] | None],
    ) -> tuple[list[str], list[str]]:
        self._assert_root()
        referenced_names: set[str] = set()
        missing: list[str] = []
        for job_id, metadata in references.items():
            if metadata is None:
                missing.append(job_id)
                continue
            try:
                path = self._metadata_path(metadata)
                referenced_names.add(path.name)
                self._read_verified(metadata)
            except ResourceNotFoundError:
                missing.append(job_id)

        quarantine = self.root / "lost+found"
        quarantined: list[str] = []
        for path in self.root.iterdir():
            if not path.is_file():
                continue
            if path.name.startswith("."):
                path.unlink(missing_ok=True)
                continue
            if path.name in referenced_names:
                continue
            ensure_secure_directory(quarantine, create=True)
            destination = quarantine / path.name
            if destination.exists():
                # Collision handling must not dereference or read an arbitrary-size
                # orphan (which may also be a symlink placed by a local attacker).
                while destination.exists():
                    suffix = secrets.token_hex(6)
                    destination = quarantine / f"{path.stem}-{suffix}{path.suffix}"
            os.replace(path, destination)
            quarantined.append(path.name)
        if quarantined:
            self._fsync_directory(quarantine)
            self._fsync_directory(self.root)
        self._assert_root()
        return missing, quarantined

    def _assert_root(self) -> None:
        identity = self._root_identity
        if identity is None:
            identity = ensure_secure_directory(self.root, create=False)
            self._root_identity = identity
        assert_directory_identity(self.root, identity)

    @staticmethod
    def _fsync_directory(path: Path) -> None:
        if os.name == "nt":  # FlushFileBuffers does not accept directory handles.
            return
        flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
        flags |= getattr(os, "O_CLOEXEC", 0)
        flags |= getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def _validate_job_id(value: str) -> None:
    if not isinstance(value, str) or _JOB_ID.fullmatch(value) is None:
        raise InvalidRequestError("job id is invalid")


def _detect_image_mime(payload: bytes) -> str:
    if payload.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if payload.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if len(payload) >= 12 and payload[:4] == b"RIFF" and payload[8:12] == b"WEBP":
        return "image/webp"
    raise InvalidRequestError("job result is not a supported image")
