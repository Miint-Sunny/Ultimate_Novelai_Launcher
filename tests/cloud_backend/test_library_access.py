from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from cloud_backend.errors import InvalidRequestError, ResourceNotFoundError
from cloud_backend.identity import Principal
from cloud_backend.infrastructure import StorageIntegrityError
from cloud_backend.library_access import (
    LibraryOwnershipService,
    OwnerScopedLibraryStorage,
)


def test_private_namespaces_are_owner_and_tenant_scoped_without_lossy_collisions(
    tmp_path: Path,
) -> None:
    storage = OwnerScopedLibraryStorage(tmp_path / "library")
    punctuated = Principal.user("alice/team", "tenant-a")
    flattened = Principal.user("aliceteam", "tenant-a")
    other_tenant = Principal.user("aliceteam", "tenant-b")

    first = storage.namespace(punctuated)
    second = storage.namespace(flattened)
    third = storage.namespace(other_tenant)

    assert len({first, second, third}) == 3
    assert all(path.parent.name == "owners" for path in (first, second, third))
    assert json.loads((first / ".owner.json").read_text(encoding="utf-8")) == {
        "version": 1,
        "tenant_id": "tenant-a",
        "owner_id": "alice/team",
    }


def test_safe_legacy_namespace_is_claimed_and_migrated_atomically(tmp_path: Path) -> None:
    root = tmp_path / "library"
    legacy = root / "123456"
    legacy.mkdir(parents=True)
    (legacy / "saved.naiv4vibe").write_text('{"name":"saved"}', encoding="utf-8")
    storage = OwnerScopedLibraryStorage(root)

    namespace = storage.namespace(Principal.user("123456", "bot-tenant"))

    assert not legacy.exists()
    assert (namespace / "saved.naiv4vibe").read_text(encoding="utf-8") == '{"name":"saved"}'
    assert json.loads((namespace / ".owner.json").read_text(encoding="utf-8"))[
        "owner_id"
    ] == "123456"


def test_ambiguous_legacy_namespace_is_never_claimed(tmp_path: Path) -> None:
    root = tmp_path / "library"
    ambiguous = root / "aliceteam"
    ambiguous.mkdir(parents=True)
    (ambiguous / "private.naiv4vibe").write_text("secret", encoding="utf-8")
    storage = OwnerScopedLibraryStorage(root)

    namespace = storage.namespace(Principal.user("alice/team", "tenant"))

    assert ambiguous.exists()
    assert not (namespace / "private.naiv4vibe").exists()


def test_manifest_or_namespace_tampering_fails_closed(tmp_path: Path) -> None:
    root = tmp_path / "library"
    storage = OwnerScopedLibraryStorage(root)
    principal = Principal.user("owner", "tenant")
    namespace = storage.namespace(principal)
    (namespace / ".owner.json").write_text(
        '{"version":1,"tenant_id":"tenant","owner_id":"attacker"}',
        encoding="utf-8",
    )

    with pytest.raises(StorageIntegrityError, match="does not match"):
        storage.namespace(principal)

    (namespace / ".owner.json").unlink()
    with pytest.raises(StorageIntegrityError, match="missing"):
        storage.namespace(principal)


def test_symlink_and_root_replacement_fail_closed(tmp_path: Path) -> None:
    root = tmp_path / "library"
    storage = OwnerScopedLibraryStorage(root)
    principal = Principal.user("owner", "tenant")
    namespace = storage.namespace(principal)
    outside = tmp_path / "outside"
    outside.mkdir()

    namespace.rename(namespace.with_name("original"))
    namespace.symlink_to(outside, target_is_directory=True)
    with pytest.raises(StorageIntegrityError, match="not a real directory"):
        storage.namespace(principal)

    namespace.unlink()
    namespace.with_name("original").rename(namespace)
    root.rename(tmp_path / "moved-library")
    root.mkdir()
    with pytest.raises(StorageIntegrityError, match="root changed"):
        storage.namespace(principal)


def test_hard_linked_owner_manifest_is_rejected(tmp_path: Path) -> None:
    if os.name == "nt":
        pytest.skip("hard-link ownership metadata behavior is platform-specific")
    storage = OwnerScopedLibraryStorage(tmp_path / "library")
    principal = Principal.user("owner", "tenant")
    namespace = storage.namespace(principal)
    manifest = namespace / ".owner.json"
    os.link(manifest, tmp_path / "manifest-copy")

    with pytest.raises(StorageIntegrityError, match="hard linked"):
        storage.namespace(principal)


def test_public_contributions_use_persisted_owner_not_request_claims() -> None:
    service = LibraryOwnershipService()
    owner = Principal.user("owner", "tenant")
    attacker = Principal.user("attacker", "tenant")
    other_tenant = Principal.user("owner", "other-tenant")

    assert service.stamp(owner) == {"tenant_id": "tenant", "owner_id": "owner"}
    record = {
        "tenant_id": "tenant",
        "owner_id": "owner",
        "created_by": "attacker",
    }
    assert service.require_record(owner, record).owner_id == "owner"
    with pytest.raises(ResourceNotFoundError):
        service.require_record(attacker, record)
    with pytest.raises(ResourceNotFoundError):
        service.require_record(other_tenant, record)


def test_legacy_public_owner_field_is_scoped_to_explicit_tenant() -> None:
    service = LibraryOwnershipService()
    owner = Principal.user("owner", "tenant")
    record = {"added_by": "owner"}

    assert service.require_record(
        owner,
        record,
        legacy_owner_fields=("added_by",),
        legacy_tenant_id="tenant",
    ).owner_id == "owner"
    with pytest.raises(ResourceNotFoundError):
        service.require_record(owner, record, legacy_owner_fields=("added_by",))
    with pytest.raises(ResourceNotFoundError):
        service.require_record(
            owner,
            {},
            legacy_owner_fields=("added_by",),
            legacy_tenant_id="tenant",
        )


def test_private_library_requires_an_effective_user_or_delegated_bot_owner() -> None:
    service = LibraryOwnershipService()
    delegated = Principal.bot("bot", "tenant", delegated_owner_id="owner")

    assert service.private_owner(delegated).owner_id == "owner"
    with pytest.raises(InvalidRequestError):
        service.private_owner(Principal.admin("admin", "tenant"))
