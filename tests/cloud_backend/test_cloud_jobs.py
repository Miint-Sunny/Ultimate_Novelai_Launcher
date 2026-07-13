from __future__ import annotations

import asyncio
import base64
import hashlib
import os
from pathlib import Path

import pytest

from backend_core.jobs import JobStatus
from cloud_backend.errors import (
    IdempotencyConflictError,
    InvalidRequestError,
    JobStateConflictError,
    ResourceNotFoundError,
)
from cloud_backend.identity import ResourceOwner
from cloud_backend.infrastructure import CloudJobResultStore, SQLiteCloudJobRepository
from cloud_backend.infrastructure.sqlite_jobs import request_hash

_PNG = b"\x89PNG\r\n\x1a\n" + b"test-payload"
_PNG_ALT = b"\x89PNG\r\n\x1a\n" + b"different-payload"
_JPEG = b"\xff\xd8\xff" + b"jpeg-payload"
_WEBP = b"RIFF\x04\x00\x00\x00WEBP" + b"webp-payload"


async def _repository(tmp_path: Path) -> SQLiteCloudJobRepository:
    repository = SQLiteCloudJobRepository(tmp_path / "cloud-jobs.db")
    await repository.initialize()
    return repository


@pytest.mark.asyncio
async def test_create_is_owner_scoped_idempotent_and_uses_wal(tmp_path: Path) -> None:
    repository = await _repository(tmp_path)
    owner = ResourceOwner("tenant-a", "owner-a")
    digest = request_hash({"prompt": "cat"})

    first = await repository.create(
        job_id="job-a",
        resource=owner,
        request_hash=digest,
        payload={"prompt": "cat"},
        idempotency_key="submit-a",
        quota_reservation_id="reservation-a",
        cost_units=2,
        total_steps=4,
    )
    replay = await repository.create(
        job_id="ignored-on-replay",
        resource=owner,
        request_hash=digest,
        payload={"prompt": "cat"},
        idempotency_key="submit-a",
    )

    assert await repository.journal_mode() == "wal"
    assert first.created is True
    assert replay.created is False
    assert replay.job.id == "job-a"
    assert replay.job.resource == owner
    assert replay.job.quota_reservation_id == "reservation-a"
    assert replay.job.cost_units == 2
    with pytest.raises(IdempotencyConflictError):
        await repository.create(
            job_id="job-b",
            resource=owner,
            request_hash=request_hash({"prompt": "dog"}),
            payload={"prompt": "dog"},
            idempotency_key="submit-a",
        )


@pytest.mark.asyncio
async def test_events_are_monotonic_and_reconnect_after_sequence(tmp_path: Path) -> None:
    repository = await _repository(tmp_path)
    await repository.create(
        job_id="events-job",
        resource=ResourceOwner("tenant-a", "owner-a"),
        request_hash=request_hash({"prompt": "cat"}),
        payload={"prompt": "cat"},
        idempotency_key=None,
        total_steps=2,
    )
    await repository.transition("events-job", JobStatus.RUNNING, kind="started")
    await repository.transition(
        "events-job",
        JobStatus.RUNNING,
        kind="progress",
        step=1,
        total_steps=2,
        data={"step": 1, "total_steps": 2},
    )
    await repository.transition(
        "events-job",
        JobStatus.SUCCEEDED,
        kind="succeeded",
        step=2,
        total_steps=2,
        result={"type": "file", "path": "events-job.png"},
    )

    replay = [event async for event in repository.watch_events("events-job", after_sequence=2)]
    assert [event.sequence for event in replay] == [3, 4]
    assert [event.kind for event in replay] == ["progress", "succeeded"]
    assert all("imageBase64" not in event.data for event in replay)


@pytest.mark.asyncio
async def test_crash_recovery_interrupts_active_jobs_and_preserves_cost_stage(
    tmp_path: Path,
) -> None:
    repository = await _repository(tmp_path)
    owner = ResourceOwner("tenant-a", "owner-a")
    for job_id in ("queued-job", "attempted-job", "complete-job"):
        await repository.create(
            job_id=job_id,
            resource=owner,
            request_hash=request_hash({"job": job_id}),
            payload={"job": job_id},
            idempotency_key=job_id,
            quota_reservation_id=f"reservation-{job_id}",
            cost_units=1,
        )
    await repository.transition("attempted-job", JobStatus.RUNNING)
    await repository.mark_provider_attempted("attempted-job")
    await repository.transition("complete-job", JobStatus.RUNNING)
    await repository.mark_provider_attempted("complete-job")
    await repository.mark_cost_committed("complete-job")
    await repository.transition("complete-job", JobStatus.SUCCEEDED)

    restarted = SQLiteCloudJobRepository(repository.path)
    await restarted.initialize()
    recovered = await restarted.recover_interrupted()

    assert {job.id for job in recovered} == {"queued-job", "attempted-job"}
    queued = await restarted.get("queued-job")
    attempted = await restarted.get("attempted-job")
    complete = await restarted.get("complete-job")
    assert queued and queued.status is JobStatus.INTERRUPTED
    assert queued.provider_attempted is False
    assert attempted and attempted.status is JobStatus.INTERRUPTED
    assert attempted.provider_attempted is True
    assert attempted.cost_committed is False
    assert complete and complete.status is JobStatus.SUCCEEDED


@pytest.mark.asyncio
async def test_concurrent_idempotent_create_enqueues_one_job(tmp_path: Path) -> None:
    repository = await _repository(tmp_path)
    owner = ResourceOwner("tenant-a", "owner-a")
    digest = request_hash({"prompt": "cat"})

    results = await asyncio.gather(
        *(
            repository.create(
                job_id=f"candidate-{index}",
                resource=owner,
                request_hash=digest,
                payload={"prompt": "cat"},
                idempotency_key="one-submit",
            )
            for index in range(8)
        )
    )

    assert sum(result.created for result in results) == 1
    assert len({result.job.id for result in results}) == 1


@pytest.mark.asyncio
async def test_result_store_round_trip_and_rejects_binary_event_data(tmp_path: Path) -> None:
    store = CloudJobResultStore(tmp_path / "results")
    encoded = base64.b64encode(_PNG).decode("ascii")
    metadata = await store.save_base64("image-job", encoded, mime_type="image/png")

    assert metadata["path"] == f"{hashlib.sha256(_PNG).hexdigest()}.png"
    assert await store.load_base64(metadata) == encoded
    assert await store.load_bytes(metadata) == _PNG
    legacy_path = store.root / "legacy-image-job.png"
    await asyncio.to_thread(legacy_path.write_bytes, _PNG)
    assert await store.load_bytes(
        {
            **metadata,
            "path": legacy_path.name,
        }
    ) == _PNG

    repository = await _repository(tmp_path)
    await repository.create(
        job_id="image-job",
        resource=ResourceOwner("tenant-a", "owner-a"),
        request_hash=request_hash({"prompt": "cat"}),
        payload={"prompt": "cat"},
        idempotency_key=None,
    )
    with pytest.raises(InvalidRequestError):
        await repository.transition(
            "image-job",
            JobStatus.RUNNING,
            data={"imageBase64": encoded},
        )


@pytest.mark.asyncio
async def test_immutable_results_survive_concurrent_conflicting_transitions(
    tmp_path: Path,
) -> None:
    store = CloudJobResultStore(tmp_path / "results")
    repository = await _repository(tmp_path)
    await repository.create(
        job_id="racing-result",
        resource=ResourceOwner("tenant-a", "owner-a"),
        request_hash=request_hash({"prompt": "cat"}),
        payload={"prompt": "cat"},
        idempotency_key=None,
    )
    await repository.transition("racing-result", JobStatus.RUNNING)
    all_saved = asyncio.Event()
    saved: list[tuple[dict[str, object], bytes]] = []

    async def finish(status: JobStatus, payload: bytes):
        metadata = await store.save_base64(
            "racing-result",
            base64.b64encode(payload).decode("ascii"),
        )
        saved.append((metadata, payload))
        if len(saved) == 2:
            all_saved.set()
        await all_saved.wait()
        return await repository.transition(
            "racing-result",
            status,
            result=metadata,
        )

    outcomes = await asyncio.gather(
        finish(JobStatus.SUCCEEDED, _PNG),
        finish(JobStatus.FAILED, _PNG_ALT),
        return_exceptions=True,
    )

    assert sum(isinstance(outcome, JobStateConflictError) for outcome in outcomes) == 1
    assert len({str(metadata["path"]) for metadata, _payload in saved}) == 2
    for metadata, payload in saved:
        assert await store.load_bytes(metadata) == payload
    terminal = await repository.get("racing-result")
    assert terminal is not None and terminal.result is not None
    assert await store.load_bytes(terminal.result) in {_PNG, _PNG_ALT}


@pytest.mark.asyncio
async def test_result_reconcile_quarantines_orphans_and_invalidates_missing_terminal(
    tmp_path: Path,
) -> None:
    store = CloudJobResultStore(tmp_path / "results")
    encoded = base64.b64encode(_PNG).decode("ascii")
    metadata = await store.save_base64("terminal-job", encoded)
    await asyncio.to_thread((store.root / "orphan.png").write_bytes, _PNG)

    missing, orphaned = await store.reconcile({"terminal-job": metadata})
    assert missing == []
    assert orphaned == ["orphan.png"]
    assert await asyncio.to_thread((store.root / "lost+found" / "orphan.png").is_file)

    await asyncio.to_thread((store.root / str(metadata["path"])).unlink)
    missing, _ = await store.reconcile({"terminal-job": metadata})
    assert missing == ["terminal-job"]

    repository = await _repository(tmp_path)
    await repository.create(
        job_id="terminal-job",
        resource=ResourceOwner("tenant-a", "owner-a"),
        request_hash=request_hash({"prompt": "cat"}),
        payload={"prompt": "cat"},
        idempotency_key=None,
    )
    await repository.transition("terminal-job", JobStatus.RUNNING)
    await repository.transition(
        "terminal-job",
        JobStatus.SUCCEEDED,
        result=metadata,
    )
    repaired = await repository.invalidate_missing_result("terminal-job")
    assert repaired.status is JobStatus.INTERRUPTED
    assert repaired.result is None
    assert (await repository.list_events("terminal-job"))[-1].kind == "result_missing"


@pytest.mark.asyncio
async def test_result_reconcile_collision_does_not_read_or_replace_existing_quarantine(
    tmp_path: Path,
) -> None:
    store = CloudJobResultStore(tmp_path / "results")
    await store.initialize()
    orphan = store.root / "orphan.png"
    orphan.write_bytes(_PNG)
    quarantine = store.root / "lost+found"
    quarantine.mkdir()
    existing = quarantine / orphan.name
    existing.write_bytes(b"existing")

    missing, quarantined = await store.reconcile({})

    assert missing == []
    assert quarantined == ["orphan.png"]
    assert existing.read_bytes() == b"existing"
    collision_files = [path for path in quarantine.iterdir() if path.name != orphan.name]
    assert len(collision_files) == 1
    assert collision_files[0].read_bytes() == _PNG


@pytest.mark.parametrize("max_bytes", [0, -1])
def test_result_store_rejects_non_positive_limit(tmp_path: Path, max_bytes: int) -> None:
    with pytest.raises(ValueError):
        CloudJobResultStore(tmp_path, max_bytes=max_bytes)


@pytest.mark.asyncio
@pytest.mark.parametrize("job_id", ["", "../escape", "bad id", 12])
async def test_result_store_rejects_invalid_job_id(tmp_path: Path, job_id) -> None:
    store = CloudJobResultStore(tmp_path)
    with pytest.raises(InvalidRequestError):
        await store.save_base64(job_id, base64.b64encode(_PNG).decode("ascii"))


@pytest.mark.asyncio
async def test_result_store_validates_encoding_size_mime_and_format(tmp_path: Path) -> None:
    store = CloudJobResultStore(tmp_path / "small", max_bytes=8)
    with pytest.raises(InvalidRequestError, match="invalid"):
        await store.save_base64("job", "")
    with pytest.raises(InvalidRequestError, match="too large"):
        await store.save_base64("job", "A" * 17)
    with pytest.raises(InvalidRequestError, match="base64"):
        await store.save_base64("job", "%%%")
    with pytest.raises(InvalidRequestError, match="too large"):
        await store.save_base64("job", base64.b64encode(_PNG[:9]).decode("ascii"))

    store = CloudJobResultStore(tmp_path / "formats")
    png = base64.b64encode(_PNG).decode("ascii")
    with pytest.raises(InvalidRequestError, match="MIME"):
        await store.save_base64("png", png, mime_type="image/jpeg")
    with pytest.raises(InvalidRequestError, match="supported"):
        await store.save_base64("text", base64.b64encode(b"not-image").decode("ascii"))
    jpeg = await store.save_base64("jpeg", base64.b64encode(_JPEG).decode("ascii"))
    webp = await store.save_base64("webp", base64.b64encode(_WEBP).decode("ascii"))
    assert jpeg["mime_type"] == "image/jpeg"
    assert jpeg["path"] == f"{hashlib.sha256(_JPEG).hexdigest()}.jpg"
    assert webp["mime_type"] == "image/webp"
    assert webp["path"] == f"{hashlib.sha256(_WEBP).hexdigest()}.webp"


@pytest.mark.asyncio
async def test_result_store_rejects_invalid_or_corrupt_metadata(tmp_path: Path) -> None:
    store = CloudJobResultStore(tmp_path / "results")
    metadata = await store.save_base64("job", base64.b64encode(_PNG).decode("ascii"))
    invalid = [
        {**metadata, "type": "inline"},
        {**metadata, "path": "../job.png"},
        {**metadata, "size": len(_PNG) + 1},
        {**metadata, "sha256": 123},
        {**metadata, "sha256": "0" * 64},
    ]
    for candidate in invalid:
        with pytest.raises(ResourceNotFoundError):
            await store.load_base64(candidate)

    (store.root / str(metadata["path"])).unlink()
    with pytest.raises(ResourceNotFoundError):
        await store.load_base64(metadata)

    outside = tmp_path / "outside.png"
    outside.write_bytes(_PNG)
    (store.root / "linked.png").symlink_to(outside)
    with pytest.raises(ResourceNotFoundError):
        await store.load_base64({**metadata, "path": "linked.png"})


@pytest.mark.asyncio
async def test_result_reconcile_marks_none_and_corrupt_and_removes_crash_temp(
    tmp_path: Path,
) -> None:
    store = CloudJobResultStore(tmp_path / "results")
    metadata = await store.save_base64("job", base64.b64encode(_PNG).decode("ascii"))
    (store.root / str(metadata["path"])).write_bytes(b"corrupt")
    (store.root / ".job.png.crash").write_bytes(b"partial")
    (store.root / "directory").mkdir()

    missing, quarantined = await store.reconcile({"none": None, "corrupt": metadata})

    assert missing == ["none", "corrupt"]
    assert quarantined == []
    assert not (store.root / ".job.png.crash").exists()
    assert (store.root / "directory").is_dir()


def test_result_atomic_write_cleans_temp_when_publish_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = CloudJobResultStore(tmp_path / "results")
    store.root.mkdir()

    def fail_link(source, destination) -> None:
        raise OSError("disk failure")

    monkeypatch.setattr(os, "link", fail_link)
    with pytest.raises(OSError, match="disk failure"):
        store._atomic_write_immutable("job.png", _PNG)
    assert list(store.root.iterdir()) == []


@pytest.mark.asyncio
async def test_active_and_owner_lists_are_persistent_bounded_views(tmp_path: Path) -> None:
    repository = await _repository(tmp_path)
    owner = ResourceOwner("tenant-a", "owner-a")
    other = ResourceOwner("tenant-a", "owner-b")
    for job_id, resource in (("owner-old", owner), ("owner-new", owner), ("other", other)):
        await repository.create(
            job_id=job_id,
            resource=resource,
            request_hash=request_hash({"job": job_id}),
            payload={"kind": "workshop", "job": job_id},
            idempotency_key=None,
        )
    await repository.transition("owner-old", JobStatus.RUNNING)
    await repository.transition("owner-old", JobStatus.SUCCEEDED)

    active = await repository.list_active()
    owner_jobs = await repository.list_for_owner(owner, limit=1, payload_kind="workshop")

    assert {job.id for job in active} == {"owner-new", "other"}
    assert [job.id for job in owner_jobs] == ["owner-new"]
    for invalid_limit in (0, 1_001, True):
        with pytest.raises(InvalidRequestError, match="limit"):
            await repository.list_for_owner(owner, limit=invalid_limit)
    with pytest.raises(InvalidRequestError, match="payload kind"):
        await repository.list_for_owner(owner, payload_kind="")
