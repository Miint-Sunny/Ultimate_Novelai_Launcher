from __future__ import annotations

import asyncio
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

from backend_core.errors import InvalidArgumentError, RuntimeNotReadyError
from backend_core.jobs import GenerationJob, JobStatus
from sidecar.application.settings import SettingsStore
from sidecar.config import Settings
from sidecar.llm.client import LLMConversionError, LLMNotConfiguredError
from sidecar.nai.client import NovelAIError
from sidecar.nai.models import GenerationParams, ResolvedPrompt
from sidecar.persistence import Database
from sidecar.services import generation as generation_module
from sidecar.services.assets import AssetService
from sidecar.services.generation import GenerationJobCoordinator, NovelAIGenerationExecutor
from sidecar.services.jobs import JobService


def _job(payload: dict[str, object], *, job_id: str = "executor-job") -> GenerationJob:
    now = datetime.now(timezone.utc)
    return GenerationJob(
        id=job_id,
        status=JobStatus.RUNNING,
        payload=payload,  # type: ignore[arg-type]
        request_hash="hash",
        queue_sequence=1,
        created_at=now,
        updated_at=now,
    )


def _settings(root: Path, *, mock_generation: bool) -> Settings:
    return Settings(
        host="127.0.0.1",
        port=0,
        data_dir=root,
        nai_token="test-token",
        nai_base_url="https://image.novelai.net",
        llm_base_url="",
        llm_api_key="",
        llm_model="",
        mock_generation=mock_generation,
    )


def _executor(root: Path, *, mock_generation: bool) -> NovelAIGenerationExecutor:
    database = Database(root / "executor.sqlite3")
    assets = AssetService(
        database,
        root / "assets",
        quota_bytes=64 * 1024 * 1024,
        reserve_bytes=0,
    )
    return NovelAIGenerationExecutor(
        SettingsStore(_settings(root, mock_generation=mock_generation), loader=None),
        assets,
    )


async def _persistent_executor_job(
    root: Path,
    payload: dict[str, object],
    *,
    mock_generation: bool,
    job_id: str = "executor-job",
) -> tuple[NovelAIGenerationExecutor, GenerationJob]:
    database = Database(root / "executor.sqlite3")
    assets = AssetService(
        database,
        root / "assets",
        quota_bytes=64 * 1024 * 1024,
        reserve_bytes=0,
    )
    jobs = JobService(database)
    await jobs.initialize()
    await jobs.create_job(payload, job_id=job_id)  # type: ignore[arg-type]
    job = await jobs.claim_next()
    assert job is not None
    executor = NovelAIGenerationExecutor(
        SettingsStore(_settings(root, mock_generation=mock_generation), loader=None),
        assets,
    )
    await executor.initialize()
    return executor, job


class GenerationCoordinatorTests(unittest.IsolatedAsyncioTestCase):
    def test_worker_count_is_bounded(self) -> None:
        async def execute(_job: GenerationJob) -> dict[str, str]:
            return {}

        with tempfile.TemporaryDirectory() as directory:
            service = JobService(Database(Path(directory) / "jobs.sqlite3"))
            with self.assertRaises(ValueError):
                GenerationJobCoordinator(service, execute, workers=0)
            with self.assertRaises(ValueError):
                GenerationJobCoordinator(service, execute, workers=5)

    async def test_worker_completes_a_persisted_job(self) -> None:
        with tempfile.TemporaryDirectory() as directory:

            async def execute(job: GenerationJob) -> dict[str, str]:
                return {"prompt": str(job.payload["prompt"])}

            coordinator = GenerationJobCoordinator(
                JobService(Database(Path(directory) / "jobs.sqlite3"), capacity=2),
                execute,
                poll_interval=0.01,
            )
            await coordinator.start()
            try:
                created = await coordinator.create_job({"prompt": "cat"})
                completed = await coordinator.wait_for_terminal(created.job.id, timeout=2)
            finally:
                await coordinator.stop()

        self.assertEqual(completed.status, JobStatus.SUCCEEDED)
        self.assertEqual(completed.result, {"prompt": "cat"})

    async def test_protocol_wrappers_and_idempotent_start(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            class InitializingExecutor:
                def __init__(self) -> None:
                    self.initialized = False

                async def initialize(self) -> None:
                    self.initialized = True

                async def __call__(self, job: GenerationJob) -> dict[str, str]:
                    return {"prompt": str(job.payload["prompt"])}

            executor = InitializingExecutor()

            coordinator = GenerationJobCoordinator(
                JobService(Database(Path(directory) / "jobs.sqlite3"), capacity=2),
                executor,
                poll_interval=0.01,
            )
            await coordinator.initialize()
            await coordinator.start()
            self.assertTrue(executor.initialized)
            created = await coordinator.create_job(
                {"prompt": "cat"},
                idempotency_key="same",
            )
            replay = await coordinator.create_job(
                {"prompt": "cat"},
                idempotency_key="same",
            )
            completed = await coordinator.wait_for_terminal(created.job.id, timeout=2)
            listed = await coordinator.list_jobs(statuses=(JobStatus.SUCCEEDED,))
            snapshot, watermark = await coordinator.snapshot_with_watermark(completed.id)
            events = await coordinator.list_events(completed.id)
            watcher = coordinator.watch_events(completed.id, after_sequence=watermark)
            try:
                self.assertFalse(replay.created)
                self.assertEqual((await coordinator.get_job(completed.id)).id, completed.id)  # type: ignore[union-attr]
                self.assertEqual([job.id for job in listed], [completed.id])
                self.assertEqual(snapshot.id, completed.id)
                self.assertGreaterEqual(watermark, 1)
                self.assertTrue(events)
                self.assertIsNotNone(watcher)
                self.assertFalse(await coordinator.begin_drain(timeout=0))
            finally:
                await coordinator.stop()

    async def test_executor_failure_is_persisted_without_leaking_details(self) -> None:
        with tempfile.TemporaryDirectory() as directory:

            async def execute(_job: GenerationJob) -> dict[str, str]:
                raise RuntimeError("sensitive upstream details")

            coordinator = GenerationJobCoordinator(
                JobService(Database(Path(directory) / "jobs.sqlite3"), capacity=2),
                execute,
                poll_interval=0.01,
            )
            await coordinator.start()
            try:
                created = await coordinator.create_job({"prompt": "cat"})
                completed = await coordinator.wait_for_terminal(created.job.id, timeout=2)
            finally:
                await coordinator.stop()

        self.assertEqual(completed.status, JobStatus.FAILED)
        self.assertEqual(completed.error_code, "generation_failed")
        self.assertEqual(completed.error_message, "generation failed")

    async def test_unexpected_executor_cancellation_is_persisted_as_interrupted(self) -> None:
        with tempfile.TemporaryDirectory() as directory:

            async def execute(_job: GenerationJob) -> dict[str, str]:
                current = asyncio.current_task()
                assert current is not None
                current.cancel()
                await asyncio.sleep(0)
                raise AssertionError("cancelled executor resumed")

            coordinator = GenerationJobCoordinator(
                JobService(Database(Path(directory) / "jobs.sqlite3"), capacity=2),
                execute,
                poll_interval=0.01,
            )
            await coordinator.start()
            try:
                created = await coordinator.create_job({"prompt": "cat"})
                completed = await coordinator.wait_for_terminal(created.job.id, timeout=2)
            finally:
                await coordinator.stop()

        self.assertEqual(completed.status, JobStatus.INTERRUPTED)

    async def test_running_cancel_propagates_to_executor(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            started = asyncio.Event()
            cancelled = asyncio.Event()

            async def execute(_job: GenerationJob) -> dict[str, str]:
                started.set()
                try:
                    await asyncio.Event().wait()
                finally:
                    cancelled.set()
                raise AssertionError("executor should only exit through cancellation")

            coordinator = GenerationJobCoordinator(
                JobService(Database(Path(directory) / "jobs.sqlite3"), capacity=2),
                execute,
                poll_interval=0.01,
            )
            await coordinator.start()
            try:
                created = await coordinator.create_job({"prompt": "cat"})
                await asyncio.wait_for(started.wait(), timeout=2)
                cancelling = await coordinator.cancel_job(created.job.id)
                completed = await coordinator.wait_for_terminal(created.job.id, timeout=2)
            finally:
                await coordinator.stop()

        self.assertEqual(cancelling.status, JobStatus.CANCELLING)
        self.assertEqual(completed.status, JobStatus.CANCELLED)
        self.assertTrue(cancelled.is_set())

    async def test_begin_drain_cancels_upstream_and_rejects_new_jobs(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            started = asyncio.Event()
            cancelled = asyncio.Event()

            async def execute(_job: GenerationJob) -> dict[str, str]:
                started.set()
                try:
                    await asyncio.Event().wait()
                finally:
                    cancelled.set()
                raise AssertionError("executor should only exit through cancellation")

            coordinator = GenerationJobCoordinator(
                JobService(Database(Path(directory) / "jobs.sqlite3"), capacity=2),
                execute,
                poll_interval=0.01,
            )
            await coordinator.start()
            created = await coordinator.create_job({"prompt": "cat"})
            await asyncio.wait_for(started.wait(), timeout=2)
            queued = await coordinator.create_job({"prompt": "dog"})

            drained = await coordinator.begin_drain(timeout=2)

            self.assertTrue(drained)
            self.assertTrue(cancelled.is_set())
            self.assertTrue(coordinator.draining)
            with self.assertRaises(RuntimeNotReadyError):
                await coordinator.create_job({"prompt": "dog"})
            running_cancelled = await coordinator.get_job(created.job.id)
            queued_cancelled = await coordinator.get_job(queued.job.id)
            self.assertIsNotNone(running_cancelled)
            self.assertIsNotNone(queued_cancelled)
            assert running_cancelled is not None
            assert queued_cancelled is not None
            self.assertEqual(running_cancelled.status, JobStatus.CANCELLED)
            self.assertEqual(queued_cancelled.status, JobStatus.CANCELLED)

    async def test_terminal_wait_timeout_does_not_cancel_its_caller(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            started = asyncio.Event()

            async def execute(_job: GenerationJob) -> dict[str, str]:
                started.set()
                await asyncio.Event().wait()
                raise AssertionError("executor should only exit through cancellation")

            coordinator = GenerationJobCoordinator(
                JobService(Database(Path(directory) / "jobs.sqlite3"), capacity=2),
                execute,
                poll_interval=0.01,
            )
            await coordinator.start()
            try:
                created = await coordinator.create_job({"prompt": "cat"})
                await asyncio.wait_for(started.wait(), timeout=2)

                with self.assertRaises(TimeoutError):
                    await coordinator.wait_for_terminal(created.job.id, timeout=0.01)

                caller = asyncio.current_task()
                assert caller is not None
                await asyncio.sleep(0)
                self.assertFalse(caller.cancelled())
                await coordinator.cancel_job(created.job.id)
                completed = await coordinator.wait_for_terminal(created.job.id, timeout=2)
                self.assertEqual(completed.status, JobStatus.CANCELLED)
            finally:
                await coordinator.stop()

    async def test_cancelled_drain_waiter_does_not_cancel_coordinator_cleanup(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            started = asyncio.Event()
            cancellation_started = asyncio.Event()
            release_cancellation = asyncio.Event()

            async def execute(_job: GenerationJob) -> dict[str, str]:
                started.set()
                try:
                    await asyncio.Event().wait()
                finally:
                    cancellation_started.set()
                    await release_cancellation.wait()
                raise AssertionError("executor should only exit through cancellation")

            coordinator = GenerationJobCoordinator(
                JobService(Database(Path(directory) / "jobs.sqlite3"), capacity=2),
                execute,
                poll_interval=0.01,
            )
            await coordinator.start()
            created = await coordinator.create_job({"prompt": "cat"})
            await asyncio.wait_for(started.wait(), timeout=2)
            drain_waiter = asyncio.create_task(coordinator.begin_drain(timeout=2))
            try:
                await asyncio.wait_for(cancellation_started.wait(), timeout=2)
                drain_waiter.cancel()
                await asyncio.gather(drain_waiter, return_exceptions=True)
                self.assertTrue(drain_waiter.cancelled())

                intermediate = await coordinator.get_job(created.job.id)
                assert intermediate is not None
                self.assertEqual(intermediate.status, JobStatus.CANCELLING)

                release_cancellation.set()
                completed = await coordinator.wait_for_terminal(created.job.id, timeout=2)
                self.assertEqual(completed.status, JobStatus.CANCELLED)
            finally:
                release_cancellation.set()
                await coordinator.stop()

    async def test_drain_timeout_leaves_late_cancellation_acknowledgement_owned(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            started = asyncio.Event()
            cancellation_started = asyncio.Event()
            release_cancellation = asyncio.Event()

            async def execute(_job: GenerationJob) -> dict[str, str]:
                started.set()
                try:
                    await asyncio.Event().wait()
                finally:
                    cancellation_started.set()
                    await release_cancellation.wait()
                raise AssertionError("executor should only exit through cancellation")

            coordinator = GenerationJobCoordinator(
                JobService(Database(Path(directory) / "jobs.sqlite3"), capacity=2),
                execute,
                poll_interval=0.01,
            )
            await coordinator.start()
            created = await coordinator.create_job({"prompt": "cat"})
            await asyncio.wait_for(started.wait(), timeout=2)
            try:
                drained = await coordinator.begin_drain(timeout=0.01)
                self.assertFalse(drained)
                await asyncio.wait_for(cancellation_started.wait(), timeout=2)

                intermediate = await coordinator.get_job(created.job.id)
                assert intermediate is not None
                self.assertEqual(intermediate.status, JobStatus.CANCELLING)

                release_cancellation.set()
                completed = await coordinator.wait_for_terminal(created.job.id, timeout=2)
                self.assertEqual(completed.status, JobStatus.CANCELLED)
                self.assertTrue(await coordinator.begin_drain(timeout=2))
            finally:
                release_cancellation.set()
                await coordinator.stop()


class NovelAIGenerationExecutorTests(unittest.IsolatedAsyncioTestCase):
    async def test_mock_tag_generation_persists_an_asset(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            payload = {
                "input": "cat",
                "mode": "tags",
                "tags": "cat, smile",
                "negative": "bad anatomy",
                "params": {},
            }
            executor, job = await _persistent_executor_job(
                root,
                payload,
                mock_generation=True,
            )

            result = await executor(job)

            self.assertEqual(result["tags"], "cat, smile")
            self.assertEqual(result["negative"], "bad anatomy")
            self.assertTrue((root / "assets" / str(result["image_path"])).is_file())

    async def test_invalid_and_empty_prompts_are_rejected_locally(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            executor = _executor(Path(directory), mock_generation=True)
            await executor.initialize()

            with self.assertRaises(InvalidArgumentError) as invalid:
                await executor(_job({"mode": "tags", "params": {}}))
            with self.assertRaises(InvalidArgumentError) as empty:
                await executor(
                    _job(
                        {
                            "input": "   ",
                            "mode": "tags",
                            "tags": "   ",
                            "params": {},
                        },
                        job_id="empty-job",
                    )
                )

            self.assertEqual(invalid.exception.code_value, "invalid_generation_request")
            self.assertEqual(empty.exception.code_value, "empty_prompt")

    async def test_natural_prompt_uses_injected_conversion_result(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            converted = ResolvedPrompt(
                tags="1girl, blue eyes",
                negative="bad anatomy",
                params=GenerationParams(seed=7),
            )
            convert = AsyncMock(return_value=converted)
            payload = {
                "input": "a blue-eyed girl",
                "mode": "natural",
                "negative": "",
                "params": {},
            }
            executor, job = await _persistent_executor_job(
                Path(directory),
                payload,
                mock_generation=True,
            )

            with patch("sidecar.services.generation.convert_natural_to_tags", convert):
                result = await executor(job)

            self.assertEqual(result["tags"], converted.tags)
            self.assertEqual(result["negative"], converted.negative)
            convert.assert_awaited_once()

    async def test_legacy_and_canonical_upstreams_are_selected_without_paid_calls(self) -> None:
        base_request = {
            "input": "cat",
            "mode": "tags",
            "tags": "cat",
            "negative": "",
            "params": {},
        }
        with tempfile.TemporaryDirectory() as legacy_directory:
            legacy_payload = {**base_request, "legacy_payload": {"input": "cat"}}
            legacy_executor, legacy_job = await _persistent_executor_job(
                Path(legacy_directory),
                legacy_payload,
                mock_generation=False,
                job_id="legacy-job",
            )
            legacy_call = AsyncMock(return_value=b"legacy-image")
            with patch(
                "sidecar.services.generation.generate_image_from_payload",
                legacy_call,
            ):
                await legacy_executor(legacy_job)
            legacy_call.assert_awaited_once()

        with tempfile.TemporaryDirectory() as canonical_directory:
            canonical_executor, canonical_job = await _persistent_executor_job(
                Path(canonical_directory),
                base_request,
                mock_generation=False,
                job_id="canonical-job",
            )
            canonical_call = AsyncMock(return_value=b"canonical-image")
            with patch("sidecar.services.generation.generate_image", canonical_call):
                await canonical_executor(canonical_job)
            canonical_call.assert_awaited_once()

    def test_error_messages_expose_only_expected_domain_failures(self) -> None:
        long_message = "x" * 600
        self.assertEqual(
            generation_module._safe_error_message(InvalidArgumentError(long_message)),
            long_message[:500],
        )
        self.assertEqual(
            generation_module._safe_error_message(LLMNotConfiguredError("not configured")),
            "not configured",
        )
        self.assertEqual(
            generation_module._safe_error_message(LLMConversionError("conversion failed")),
            "conversion failed",
        )
        self.assertEqual(
            generation_module._safe_error_message(NovelAIError("provider failed")),
            "provider failed",
        )
        self.assertEqual(
            generation_module._safe_error_message(RuntimeError("secret")),
            "generation failed",
        )


if __name__ == "__main__":
    unittest.main()
