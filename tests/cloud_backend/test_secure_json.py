from __future__ import annotations

import json
import os
import stat
from pathlib import Path

import pytest

from cloud_backend.infrastructure import SecureJsonObjectStore, StorageIntegrityError
from cloud_backend.infrastructure import secure_json as secure_json_module


def test_missing_store_is_empty_without_creating_parent(tmp_path: Path) -> None:
    path = tmp_path / "missing" / "sessions.json"
    store = SecureJsonObjectStore(path)

    assert store.load() == {}
    assert not path.parent.exists()


def test_save_and_load_are_atomic_owner_only_and_unicode_safe(tmp_path: Path) -> None:
    path = tmp_path / "sessions.json"
    store = SecureJsonObjectStore(path)
    expected = {"session": {"user": "薄荷", "active": 1.5}}

    store.save(expected)
    store.save(expected)

    assert store.load() == expected
    assert not list(tmp_path.glob(".*.tmp"))
    if os.name != "nt":
        assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_existing_permissions_are_tightened(tmp_path: Path) -> None:
    path = tmp_path / "sessions.json"
    path.write_text("{}", encoding="utf-8")
    path.chmod(0o644)

    assert SecureJsonObjectStore(path).load() == {}
    if os.name != "nt":
        assert stat.S_IMODE(path.stat().st_mode) == 0o600


@pytest.mark.parametrize("payload", [b"not-json", b"[]", b'"text"', b"\xff"])
def test_corrupt_or_non_object_store_fails_closed(tmp_path: Path, payload: bytes) -> None:
    path = tmp_path / "sessions.json"
    path.write_bytes(payload)

    with pytest.raises(StorageIntegrityError):
        SecureJsonObjectStore(path).load()


def test_size_and_serialization_limits_fail_closed(tmp_path: Path) -> None:
    path = tmp_path / "sessions.json"
    path.write_bytes(b'{"value":"0123456789"}')
    store = SecureJsonObjectStore(path, max_bytes=16)

    with pytest.raises(StorageIntegrityError, match="size limit"):
        store.load()
    with pytest.raises(StorageIntegrityError, match="size limit"):
        store.save({"value": "0123456789"})
    with pytest.raises(StorageIntegrityError, match="not serializable"):
        SecureJsonObjectStore(path).save({"value": object()})
    with pytest.raises(StorageIntegrityError, match="not serializable"):
        SecureJsonObjectStore(path).save({"value": float("nan")})
    with pytest.raises(ValueError, match="max_bytes"):
        SecureJsonObjectStore(path, max_bytes=1)


def test_target_symlink_and_hardlink_are_rejected(tmp_path: Path) -> None:
    outside = tmp_path / "outside.json"
    outside.write_text('{"secret": true}', encoding="utf-8")
    symlink = tmp_path / "sessions-link.json"
    symlink.symlink_to(outside)

    with pytest.raises(StorageIntegrityError):
        SecureJsonObjectStore(symlink).load()
    with pytest.raises(StorageIntegrityError):
        SecureJsonObjectStore(symlink).save({})

    hardlink = tmp_path / "sessions-hard.json"
    os.link(outside, hardlink)
    with pytest.raises(StorageIntegrityError, match="hard linked"):
        SecureJsonObjectStore(hardlink).load()

    directory = tmp_path / "sessions-directory.json"
    directory.mkdir()
    with pytest.raises(StorageIntegrityError, match="regular file"):
        SecureJsonObjectStore(directory).load()


def test_directory_symlink_and_dangling_symlink_are_rejected(tmp_path: Path) -> None:
    real = tmp_path / "real"
    real.mkdir()
    linked = tmp_path / "linked"
    linked.symlink_to(real, target_is_directory=True)
    dangling = tmp_path / "dangling"
    dangling.symlink_to(tmp_path / "absent", target_is_directory=True)

    with pytest.raises(StorageIntegrityError):
        SecureJsonObjectStore(linked / "sessions.json").load()
    with pytest.raises(StorageIntegrityError):
        SecureJsonObjectStore(dangling / "sessions.json").load()


def test_initialized_directory_replacement_is_rejected(tmp_path: Path) -> None:
    root = tmp_path / "data"
    root.mkdir()
    store = SecureJsonObjectStore(root / "sessions.json")
    assert store.load() == {}

    old = tmp_path / "old-data"
    root.rename(old)
    root.mkdir()

    with pytest.raises(StorageIntegrityError, match="directory changed"):
        store.save({"session": {}})


def test_atomic_replace_failure_cleans_temporary_file(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "sessions.json"
    store = SecureJsonObjectStore(path)

    def fail_replace(source: Path, destination: Path) -> None:
        raise OSError(f"cannot replace {source.name} with {destination.name}")

    monkeypatch.setattr(os, "replace", fail_replace)

    with pytest.raises(OSError, match="cannot replace"):
        store.save({"session": {}})
    assert not path.exists()
    assert not list(tmp_path.glob(".*.tmp"))


def test_failure_after_replace_also_cleans_without_masking_error(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "sessions.json"
    store = SecureJsonObjectStore(path)
    calls = 0

    def fail_after_replace() -> int:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise FileNotFoundError
        raise StorageIntegrityError("installed file verification failed")

    monkeypatch.setattr(store, "_open_target", fail_after_replace)

    with pytest.raises(StorageIntegrityError, match="verification failed"):
        store.save({"session": {}})
    assert path.exists()
    assert not list(tmp_path.glob(".*.tmp"))


def test_path_identity_change_during_open_fails_closed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "sessions.json"
    replacement = tmp_path / "other.json"
    store = SecureJsonObjectStore(path)
    store.save({"version": 1})
    replacement.write_text("{}", encoding="utf-8")
    original_lstat = secure_json_module.os.lstat

    def swapped_lstat(candidate: str | os.PathLike[str]) -> os.stat_result:
        if Path(candidate) == path:
            return original_lstat(replacement)
        return original_lstat(candidate)

    monkeypatch.setattr(secure_json_module.os, "lstat", swapped_lstat)

    with pytest.raises(StorageIntegrityError, match="changed while opening"):
        store.load()


def test_different_file_owner_fails_closed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "sessions.json"
    path.write_text("{}", encoding="utf-8")
    getuid = getattr(os, "getuid", None)
    if getuid is None:
        pytest.skip("ownership metadata is unavailable")
    monkeypatch.setattr(secure_json_module.os, "getuid", lambda: getuid() + 1)

    with pytest.raises(StorageIntegrityError, match="different owner"):
        SecureJsonObjectStore(path).load()


def test_growth_after_metadata_check_is_still_bounded(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "sessions.json"
    path.write_bytes(b"x" * 17)
    descriptor = os.open(path, os.O_RDONLY)
    metadata = os.fstat(descriptor)
    fields = list(metadata)
    fields[6] = 0
    reported_small = os.stat_result(fields)
    monkeypatch.setattr(
        secure_json_module,
        "_validate_descriptor",
        lambda _descriptor, *, require_single_link: reported_small,
    )
    try:
        with pytest.raises(StorageIntegrityError, match="size limit"):
            secure_json_module._read_bounded(descriptor, 16)
    finally:
        os.close(descriptor)


def test_file_replacement_between_reads_is_seen_as_new_valid_state(tmp_path: Path) -> None:
    path = tmp_path / "sessions.json"
    store = SecureJsonObjectStore(path)
    store.save({"version": 1})
    replacement = tmp_path / "replacement.json"
    replacement.write_text(json.dumps({"version": 2}), encoding="utf-8")
    replacement.replace(path)

    assert store.load() == {"version": 2}
