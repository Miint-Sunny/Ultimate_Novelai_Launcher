"""Owner-scoped storage and authorization for the legacy shared library.

The compatibility server historically derived a directory by deleting unsafe
characters from ``bot_user_id``.  That operation is not injective: for example,
``alice/team`` and ``aliceteam`` selected the same private directory.  This
module keeps transport credentials out of the storage layer and derives a
stable namespace from a verified :class:`~cloud_backend.identity.Principal`.
"""

from __future__ import annotations

import hashlib
import json
import os
import stat
import threading
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from .errors import InvalidRequestError, ResourceNotFoundError
from .identity import Principal, ResourceAccessPolicy, ResourceOwner
from .infrastructure.secure_json import SecureJsonObjectStore
from .infrastructure.secure_sqlite import (
    FileIdentity,
    StorageIntegrityError,
    assert_directory_identity,
    ensure_secure_directory,
)

_MANIFEST_NAME = ".owner.json"
_NAMESPACE_VERSION = 1
_RESERVED_SEGMENTS = {".", "..", "owners"}


class LibraryOwnershipService:
    """Apply one owner/tenant rule to private and public contributed records."""

    def __init__(self, policy: ResourceAccessPolicy | None = None) -> None:
        self._policy = policy or ResourceAccessPolicy()

    def private_owner(self, principal: Principal) -> ResourceOwner:
        """Return the only private-library owner a principal may address."""

        owner_id = principal.effective_owner_id
        if principal.tenant_id is None or owner_id is None:
            raise InvalidRequestError("a user owner and tenant are required")
        resource = ResourceOwner(principal.tenant_id, owner_id)
        return self._policy.require_access(principal, resource)

    def stamp(self, principal: Principal) -> dict[str, str]:
        """Return canonical ownership fields for a newly contributed record."""

        owner = self.private_owner(principal)
        if owner.owner_id is None:  # pragma: no cover - private_owner invariant
            raise InvalidRequestError("an owner is required")
        return {"tenant_id": owner.tenant_id, "owner_id": owner.owner_id}

    def require_record(
        self,
        principal: Principal,
        record: Mapping[str, Any],
        *,
        legacy_owner_fields: Sequence[str] = (),
        legacy_tenant_id: str | None = None,
    ) -> ResourceOwner:
        """Authorize an existing record, obscuring missing ownership as not found.

        Older public-library records used fields such as ``uploader_id`` and
        ``added_by``.  They remain owner-editable inside the configured legacy
        tenant, but a body/query owner claim is never consulted.
        """

        raw_owner = record.get("owner_id")
        if raw_owner is None:
            raw_owner = next(
                (record.get(field) for field in legacy_owner_fields if record.get(field)),
                None,
            )
        if raw_owner is None:
            raise ResourceNotFoundError()

        raw_tenant = record.get("tenant_id")
        if raw_tenant is None:
            raw_tenant = legacy_tenant_id
        if raw_tenant is None:
            raise ResourceNotFoundError()

        try:
            resource = ResourceOwner(str(raw_tenant), str(raw_owner))
        except InvalidRequestError as exc:
            raise ResourceNotFoundError() from exc
        return self._policy.require_access(principal, resource)


class OwnerScopedLibraryStorage:
    """Map verified principals to collision-resistant, self-identifying folders.

    Each namespace contains an owner manifest, so ownership remains persistent
    and independently verifiable instead of being inferred from a lossy path.
    Existing directories whose names exactly equal a safe owner id are migrated
    atomically on first access.  Ambiguous legacy names are never claimed.
    """

    def __init__(
        self,
        root: Path,
        ownership: LibraryOwnershipService | None = None,
    ) -> None:
        self.root = Path(root).absolute()
        self._owners_root = self.root / "owners"
        self._ownership = ownership or LibraryOwnershipService()
        self._root_identity: FileIdentity | None = None
        self._owners_identity: FileIdentity | None = None
        self._lock = threading.RLock()

    def namespace(self, principal: Principal) -> Path:
        """Return the caller's private namespace, creating or migrating it safely."""

        owner = self._ownership.private_owner(principal)
        if owner.owner_id is None:  # pragma: no cover - private_owner invariant
            raise InvalidRequestError("an owner is required")
        expected = {
            "version": _NAMESPACE_VERSION,
            "tenant_id": owner.tenant_id,
            "owner_id": owner.owner_id,
        }
        target = self._owners_root / _namespace_key(owner)

        with self._lock:
            self._prepare_roots()
            if not _path_exists(target):
                legacy = self._legacy_directory(owner.owner_id)
                if legacy is not None and _path_exists(legacy):
                    _require_real_directory(legacy)
                    self._write_or_verify_manifest(legacy, expected, allow_create=True)
                    self._assert_roots()
                    os.replace(legacy, target)
                    _fsync_directory(self.root)
                    _fsync_directory(self._owners_root)
                else:
                    target.mkdir(mode=0o700, exist_ok=False)
                    self._write_or_verify_manifest(target, expected, allow_create=True)
                    _fsync_directory(self._owners_root)

            _require_real_directory(target)
            self._write_or_verify_manifest(target, expected, allow_create=False)
            self._assert_roots()
            return target

    def _prepare_roots(self) -> None:
        current_root = ensure_secure_directory(self.root, create=True)
        current_owners = ensure_secure_directory(self._owners_root, create=True)
        if self._root_identity is None:
            self._root_identity = current_root
            self._owners_identity = current_owners
            return
        if current_root != self._root_identity or current_owners != self._owners_identity:
            raise StorageIntegrityError("library storage root changed")

    def _assert_roots(self) -> None:
        if self._root_identity is None or self._owners_identity is None:
            raise StorageIntegrityError("library storage is not initialized")
        assert_directory_identity(self.root, self._root_identity)
        assert_directory_identity(self._owners_root, self._owners_identity)

    def _legacy_directory(self, owner_id: str) -> Path | None:
        if owner_id in _RESERVED_SEGMENTS:
            return None
        if not owner_id or any(not (char.isalnum() or char in "._-") for char in owner_id):
            return None
        return self.root / owner_id

    @staticmethod
    def _write_or_verify_manifest(
        directory: Path,
        expected: dict[str, str | int],
        *,
        allow_create: bool,
    ) -> None:
        store = SecureJsonObjectStore(directory / _MANIFEST_NAME, max_bytes=4096)
        current = store.load()
        if not current:
            if not allow_create:
                raise StorageIntegrityError("library owner manifest is missing")
            store.save(expected)
            current = store.load()
        if current != expected:
            raise StorageIntegrityError("library owner manifest does not match its namespace")


def _namespace_key(owner: ResourceOwner) -> str:
    payload = json.dumps(
        [owner.tenant_id, owner.owner_id],
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _path_exists(path: Path) -> bool:
    try:
        os.lstat(path)
    except FileNotFoundError:
        return False
    return True


def _require_real_directory(path: Path) -> None:
    metadata = os.lstat(path)
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        raise StorageIntegrityError("library namespace is not a real directory")


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
