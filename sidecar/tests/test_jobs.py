from __future__ import annotations

import asyncio
import tempfile
import unittest
from pathlib import Path

from backend_core.errors import ConflictError, InvalidArgumentError
from backend_core.jobs import JobStatus
from sidecar.persistence import Database
from sidecar.services.jobs import (
    IdempotencyConflictError,
    InvalidJobTransitionError,
    JobNotCancellableError,
    JobNotFoundError,
    JobService,
    QueueFullError,
)


class JobServiceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.database = Database(Path(self.temporary.name) / "app.sqlite3")
        self.service = JobService(self.database, capacity=2)
        await self.service.initialize()

    async def asyncTearDown(self) -> None:
        self.temporary.cleanup()

    async def test_idempotency_replays_same_request_and_rejects_different_request(self) -> None:
        first = await self.service.create_job({"prompt": "one"}, idempotency_key="request-1")
        replay = await self.service.create_job({"prompt": "one"}, idempotency_key="request-1")
        self.assertTrue(first.created)
        self.assertFalse(replay.created)
        self.assertEqual(replay.job.id, first.job.id)
        with self.assertRaises(IdempotencyConflictError) as raised:
            await self.service.create_job({"prompt": "two"}, idempotency_key="request-1")
        self.assertEqual(raised.exception.code_value, "idempotency_conflict")

    async def test_concurrent_idempotent_creates_produce_exactly_one_job(self) -> None:
        results = await asyncio.gather(
            *(
                self.service.create_job({"prompt": "same"}, idempotency_key="concurrent")
                for _ in range(8)
            )
        )
        self.assertEqual(sum(result.created for result in results), 1)
        self.assertEqual(len({result.job.id for result in results}), 1)
        self.assertEqual(await self.service.active_count(), 1)

    async def test_capacity_fifo_and_terminal_job_releases_capacity(self) -> None:
        first = (await self.service.create_job({"n": 1})).job
        second = (await self.service.create_job({"n": 2})).job
        with self.assertRaises(QueueFullError) as raised:
            await self.service.create_job({"n": 3})
        self.assertEqual(raised.exception.code_value, "queue_full")
        claimed_first = await self.service.claim_next()
        assert claimed_first is not None
        self.assertEqual(claimed_first.id, first.id)
        # Capacity describes the waiting queue; an executing worker does not
        # consume one of those slots.
        third = (await self.service.create_job({"n": 3})).job
        with self.assertRaises(QueueFullError):
            await self.service.create_job({"n": 4})
        await self.service.succeed_job(first.id, {"asset_id": "asset-1"})
        claimed_second = await self.service.claim_next()
        assert claimed_second is not None
        self.assertEqual(claimed_second.id, second.id)
        cancelling = await self.service.cancel_job(second.id)
        self.assertEqual(cancelling.status, JobStatus.CANCELLING)
        self.assertEqual(await self.service.active_count(), 2)
        await self.service.mark_cancelled(second.id)
        claimed_third = await self.service.claim_next()
        assert claimed_third is not None
        self.assertEqual(claimed_third.id, third.id)

    async def test_cancel_is_idempotent_but_completed_jobs_are_not_cancellable(self) -> None:
        queued = (await self.service.create_job({"prompt": "queued"})).job
        cancelled = await self.service.cancel_job(queued.id, "user request")
        again = await self.service.cancel_job(queued.id)
        self.assertEqual(cancelled.status, JobStatus.CANCELLED)
        self.assertEqual(again.status, JobStatus.CANCELLED)
        self.assertEqual(len(await self.service.list_events(queued.id)), 2)

        running = (await self.service.create_job({"prompt": "run"})).job
        await self.service.claim_next()
        await self.service.succeed_job(running.id)
        with self.assertRaises(JobNotCancellableError):
            await self.service.cancel_job(running.id)
        with self.assertRaises(JobNotFoundError):
            await self.service.cancel_job("missing")

    async def test_progress_and_events_persist_in_sequence(self) -> None:
        created = (await self.service.create_job({"prompt": "x"})).job
        await self.service.claim_next()
        await self.service.update_progress(created.id, 0.25, {"stage": "request"})
        await self.service.update_progress(created.id, 0.75)
        completed = await self.service.succeed_job(created.id, {"ok": True})
        events = await self.service.list_events(created.id)
        self.assertEqual(completed.progress, 1.0)
        self.assertEqual(
            [event.kind for event in events],
            ["queued", "started", "progress", "progress", "succeeded"],
        )
        self.assertEqual(
            [event.sequence for event in events],
            sorted(event.sequence for event in events),
        )
        self.assertEqual(events[2].data["stage"], "request")
        with self.assertRaises(InvalidJobTransitionError):
            await self.service.fail_job(created.id, "late", "too late")

        snapshot, watermark = await self.service.snapshot_with_watermark(created.id)
        self.assertEqual(snapshot.status, JobStatus.SUCCEEDED)
        self.assertEqual(watermark, events[-1].sequence)

    async def test_restart_interrupts_active_jobs_and_preserves_queued_jobs(self) -> None:
        running = (await self.service.create_job({"n": 1})).job
        queued = (await self.service.create_job({"n": 2})).job
        await self.service.claim_next()
        restarted = JobService(Database(self.database.path), capacity=2)
        await restarted.initialize()
        self.assertEqual((await restarted.require_job(running.id)).status, JobStatus.INTERRUPTED)
        self.assertEqual((await restarted.require_job(queued.id)).status, JobStatus.QUEUED)
        events = await restarted.list_events(running.id)
        self.assertEqual(events[-1].kind, "interrupted")
        self.assertEqual(events[-1].data["error_code"], "worker_restarted")

        await restarted.claim_next()
        cancelling = await restarted.cancel_job(queued.id)
        self.assertEqual(cancelling.status, JobStatus.CANCELLING)
        restarted_again = JobService(Database(self.database.path), capacity=2)
        await restarted_again.initialize()
        self.assertEqual(
            (await restarted_again.require_job(queued.id)).status,
            JobStatus.INTERRUPTED,
        )

    async def test_running_cancel_waits_for_worker_acknowledgement(self) -> None:
        job = (await self.service.create_job({"n": 1})).job
        await self.service.claim_next()
        cancelling = await self.service.cancel_job(job.id, "stop upstream")
        replay = await self.service.cancel_job(job.id, "duplicate")
        self.assertEqual(cancelling.status, JobStatus.CANCELLING)
        self.assertEqual(replay.status, JobStatus.CANCELLING)
        self.assertEqual(await self.service.active_count(), 1)
        cancelled = await self.service.mark_cancelled(job.id)
        self.assertEqual(cancelled.status, JobStatus.CANCELLED)
        self.assertEqual(await self.service.active_count(), 0)
        self.assertEqual(
            [event.kind for event in await self.service.list_events(job.id)],
            ["queued", "started", "cancel_requested", "cancelled"],
        )

    async def test_initialize_is_safe_to_call_twice_on_one_service(self) -> None:
        job = (await self.service.create_job({"n": 1})).job
        await self.service.claim_next()
        await self.service.initialize()
        self.assertEqual((await self.service.require_job(job.id)).status, JobStatus.RUNNING)

    async def test_validation_empty_queue_and_duplicate_identifier_edges(self) -> None:
        with self.assertRaises(ValueError):
            JobService(self.database, capacity=0)
        self.assertIsNone(await self.service.claim_next())
        await self.service.create_job({"value": 1}, job_id="fixed")
        with self.assertRaises(ConflictError):
            await self.service.create_job({"value": 2}, job_id="fixed")
        with self.assertRaises(JobNotFoundError):
            await self.service.require_job("missing")
        with self.assertRaises(InvalidArgumentError):
            await self.service.list_jobs(limit=0)
        with self.assertRaises(InvalidArgumentError):
            await self.service.list_jobs(limit=1001)
        with self.assertRaises(InvalidArgumentError):
            await self.service.list_jobs(offset=-1)
        with self.assertRaises(InvalidArgumentError):
            await self.service.list_jobs(statuses=["unknown"])

    async def test_transition_and_event_validation_edges(self) -> None:
        queued = (await self.service.create_job({"value": 1})).job
        with self.assertRaises(InvalidJobTransitionError):
            await self.service.mark_cancelled(queued.id)
        for progress in (float("nan"), -0.1, 1.1):
            with self.assertRaises(InvalidArgumentError):
                await self.service.update_progress(queued.id, progress)
        with self.assertRaises(InvalidJobTransitionError):
            await self.service.update_progress(queued.id, 0.5)
        with self.assertRaises(InvalidArgumentError):
            await self.service.fail_job(queued.id, "", "message")
        for kwargs in ({"after_sequence": -1}, {"limit": 0}, {"limit": 5001}):
            with self.assertRaises(InvalidArgumentError):
                await self.service.list_events(queued.id, **kwargs)
        with self.assertRaises(JobNotFoundError):
            await self.service.list_events("missing")
        with self.assertRaises(InvalidArgumentError):
            async for _ in self.service.watch_events(queued.id, poll_interval=0):
                pass

    async def test_progress_cannot_move_backwards_and_cancel_ack_is_idempotent(self) -> None:
        job = (await self.service.create_job({"value": 1})).job
        await self.service.claim_next()
        await self.service.update_progress(job.id, 0.8)
        with self.assertRaises(InvalidArgumentError):
            await self.service.update_progress(job.id, 0.7)
        await self.service.cancel_job(job.id)
        cancelled = await self.service.mark_cancelled(job.id)
        replay = await self.service.mark_cancelled(job.id)
        self.assertEqual(replay, cancelled)


if __name__ == "__main__":
    unittest.main()
