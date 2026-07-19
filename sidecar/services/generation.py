from __future__ import annotations

import asyncio
import base64
from collections.abc import AsyncIterator, Awaitable, Callable, Iterable, Mapping, Sequence
from typing import Any

from pydantic import ValidationError

from backend_core.errors import InvalidArgumentError, RuntimeNotReadyError
from backend_core.jobs import GenerationJob, JobCreateResult, JobEvent, JobStatus
from backend_core.types import JsonValue
from sidecar.application.settings import SettingsStore
from sidecar.infrastructure import HttpClientPool
from sidecar.llm.client import LLMConversionError, LLMNotConfiguredError, convert_natural_to_tags
from sidecar.nai.client import NovelAIError, generate_image, generate_image_from_payload
from sidecar.nai.models import GenerateRequest, ResolvedPrompt
from sidecar.services.assets import AssetService
from sidecar.services.jobs import JobNotCancellableError, JobService

_ONE_PIXEL_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
)

JobExecutor = Callable[[GenerationJob], Awaitable[Mapping[str, JsonValue]]]


class GenerationJobCoordinator:
    """Application service combining the persistent queue with cancellable workers."""

    def __init__(
        self,
        jobs: JobService,
        executor: JobExecutor,
        *,
        workers: int = 1,
        poll_interval: float = 0.25,
    ) -> None:
        if workers < 1 or workers > 4:
            raise ValueError("generation workers must be between 1 and 4")
        self.store = jobs
        self.executor = executor
        self.workers = workers
        self.poll_interval = poll_interval
        self._worker_tasks: list[asyncio.Task[None]] = []
        self._active: dict[str, asyncio.Task[Mapping[str, JsonValue]]] = {}
        self._wake = asyncio.Event()
        self._stopping = False
        self._stop_task: asyncio.Task[None] | None = None

    async def start(self) -> None:
        if self._worker_tasks:
            return
        await self.store.initialize()
        initializer = getattr(self.executor, "initialize", None)
        if callable(initializer):
            initialized = initializer()
            if isinstance(initialized, Awaitable):
                await initialized
        self._stopping = False
        self._stop_task = None
        self._worker_tasks = [
            asyncio.create_task(self._worker(index), name=f"generation-worker-{index}")
            for index in range(self.workers)
        ]
        self._wake.set()

    async def initialize(self) -> None:
        """Queue protocol alias; application lifecycle uses ``start``."""

        await self.start()

    async def stop(self) -> None:
        stop_task = self._ensure_stop_task()
        # A caller (for example the process-wide drain deadline) may be
        # cancelled while shutdown is in progress.  Keep the coordinator-owned
        # cleanup alive so worker cancellation can still be acknowledged in the
        # persistent state machine.
        await asyncio.shield(stop_task)

    def _ensure_stop_task(self) -> asyncio.Task[None]:
        if self._stop_task is None:
            self._stopping = True
            self._stop_task = asyncio.create_task(
                self._stop_once(),
                name="generation-coordinator-stop",
            )
        return self._stop_task

    async def _stop_once(self) -> None:
        self._stopping = True
        # A controlled shutdown is a real cancellation, not a crash. Persist the
        # queued -> cancelled and running -> cancelling transitions before the
        # upstream tasks are cancelled. ``interrupted`` remains
        # reserved for jobs recovered after an unclean process exit.
        await self._cancel_persisted_work()
        for task in list(self._active.values()):
            task.cancel()
        # Idle workers must observe ``_stopping`` too.  Do not cancel workers:
        # the worker owns the cancelling -> cancelled acknowledgement and must
        # be allowed to persist it after the upstream task exits.
        self._wake.set()
        try:
            await asyncio.gather(*self._worker_tasks, return_exceptions=True)
        finally:
            self._worker_tasks = [task for task in self._worker_tasks if not task.done()]
            self._active = {
                job_id: task for job_id, task in self._active.items() if not task.done()
            }

    async def begin_drain(self, timeout: float = 8.0) -> bool:
        """Idempotently reject new work and bound cancellation of active upstreams."""

        self._stopping = True
        stop_task = self._ensure_stop_task()
        if timeout <= 0:
            return False
        done, _pending = await asyncio.wait({stop_task}, timeout=timeout)
        if not done:
            # The process owns the final hard-kill deadline.  The shielded stop
            # task remains responsible for any late upstream acknowledgement;
            # cancelling it here would recreate the persistent ``cancelling``
            # race this deadline is intended to contain.
            return False
        stop_task.result()
        return True

    close = stop

    @property
    def draining(self) -> bool:
        return self._stopping

    async def create_job(
        self,
        payload: Mapping[str, JsonValue],
        *,
        idempotency_key: str | None = None,
        job_id: str | None = None,
    ) -> JobCreateResult:
        if self._stopping:
            raise RuntimeNotReadyError(
                "sidecar is draining and cannot accept generation jobs",
                code="service_draining",
                retryable=True,
            )
        result = await self.store.create_job(
            payload,
            idempotency_key=idempotency_key,
            job_id=job_id,
        )
        if result.created:
            self._wake.set()
        return result

    async def list_jobs(
        self,
        *,
        limit: int = 100,
        offset: int = 0,
        statuses: Iterable[JobStatus | str] | None = None,
    ) -> Sequence[GenerationJob]:
        return await self.store.list_jobs(limit=limit, offset=offset, statuses=statuses)

    async def get_job(self, job_id: str) -> GenerationJob | None:
        return await self.store.get_job(job_id)

    async def snapshot_with_watermark(self, job_id: str) -> tuple[GenerationJob, int]:
        return await self.store.snapshot_with_watermark(job_id)

    async def cancel_job(self, job_id: str, reason: str | None = None) -> GenerationJob:
        job = await self.store.cancel_job(job_id, reason=reason)
        if job.status is JobStatus.CANCELLING:
            task = self._active.get(job.id)
            if task is not None:
                task.cancel()
        self._wake.set()
        return job

    async def list_events(
        self,
        job_id: str,
        *,
        after_sequence: int = 0,
        limit: int = 1000,
    ) -> Sequence[JobEvent]:
        return await self.store.list_events(
            job_id,
            after_sequence=after_sequence,
            limit=limit,
        )

    def watch_events(
        self,
        job_id: str,
        *,
        after_sequence: int = 0,
        poll_interval: float = 0.25,
    ) -> AsyncIterator[JobEvent]:
        return self.store.watch_events(
            job_id,
            after_sequence=after_sequence,
            poll_interval=poll_interval,
        )

    async def _cancel_persisted_work(self) -> None:
        reason = "sidecar is shutting down"
        # Cancelling changes every selected row out of this status set, so reading
        # the first page repeatedly is safe even at the maximum queue capacity.
        while True:
            jobs = await self.store.list_jobs(
                limit=100,
                statuses=(JobStatus.QUEUED, JobStatus.RUNNING),
            )
            if not jobs:
                return
            for job in jobs:
                try:
                    await self.store.cancel_job(job.id, reason=reason)
                except JobNotCancellableError:
                    # An executor may win the race and commit its terminal result.
                    # That is a completed job, not a shutdown failure.
                    continue

    async def wait_for_terminal(
        self,
        job_id: str,
        *,
        timeout: float = 300.0,
    ) -> GenerationJob:
        # Poll against an explicit deadline rather than wrapping this caller in
        # ``asyncio.wait_for``.  A wait timeout is a domain timeout, not task
        # cancellation; keeping those signals separate also prevents a timed-out
        # compatibility request from retaining a pending cancellation state.
        loop = asyncio.get_running_loop()
        deadline = loop.time() + max(0.0, timeout)
        while True:
            job = await self.store.require_job(job_id)
            if job.terminal:
                return job
            remaining = deadline - loop.time()
            if remaining <= 0:
                raise TimeoutError(f"generation job did not finish within {timeout} seconds")
            await asyncio.sleep(min(self.poll_interval, remaining))

    async def _worker(self, index: int) -> None:
        del index
        while not self._stopping:
            job = await self.store.claim_next()
            if job is None:
                self._wake.clear()
                try:
                    await asyncio.wait_for(self._wake.wait(), timeout=self.poll_interval)
                except TimeoutError:
                    pass
                continue

            claimed_job = job

            async def execute_job(
                job_to_execute: GenerationJob = claimed_job,
            ) -> Mapping[str, JsonValue]:
                return await self.executor(job_to_execute)

            execution = asyncio.create_task(
                execute_job(),
                name=f"generation-job-{job.id}",
            )
            self._active[job.id] = execution
            try:
                await self.store.update_progress(job.id, 0.01)
                # Treat upstream cancellation as data instead of relying on a
                # CancelledError raised through this worker.  Besides keeping
                # worker ownership explicit, this is stable under tracing and
                # coverage instrumentation, where cancellation propagation can
                # otherwise bypass the typed exception handler.
                outcome = (await asyncio.gather(execution, return_exceptions=True))[0]
                current = await self.store.require_job(job.id)
                if execution.cancelled():
                    if current.status is JobStatus.CANCELLING:
                        await self.store.mark_cancelled(job.id)
                    elif current.status is JobStatus.RUNNING:
                        await self.store.interrupt_job(
                            job.id,
                            "generation executor was cancelled unexpectedly",
                        )
                elif isinstance(outcome, Exception):
                    if current.status is JobStatus.CANCELLING:
                        await self.store.mark_cancelled(job.id)
                    elif current.status is JobStatus.RUNNING:
                        code = str(getattr(outcome, "code", "generation_failed"))
                        await self.store.fail_job(
                            job.id,
                            code,
                            _safe_error_message(outcome),
                        )
                elif isinstance(outcome, BaseException):
                    raise outcome
                elif current.status is JobStatus.CANCELLING:
                    await self.store.mark_cancelled(job.id)
                else:
                    await self.store.succeed_job(job.id, outcome)
            except Exception as exc:
                current = await self.store.get_job(job.id)
                if current is not None and current.status is JobStatus.CANCELLING:
                    await self.store.mark_cancelled(job.id)
                elif current is not None and current.status is JobStatus.RUNNING:
                    code = str(getattr(exc, "code", "generation_failed"))
                    await self.store.fail_job(job.id, code, _safe_error_message(exc))
            finally:
                if not execution.done():
                    execution.cancel()
                    await asyncio.gather(execution, return_exceptions=True)
                self._active.pop(job.id, None)


class NovelAIGenerationExecutor:
    """Execute one immutable job snapshot against the current local settings."""

    def __init__(
        self,
        settings: SettingsStore,
        assets: AssetService,
        http: HttpClientPool | None = None,
    ) -> None:
        self.settings = settings
        self.assets = assets
        self.http = http

    async def initialize(self) -> None:
        await self.assets.initialize()

    async def __call__(self, job: GenerationJob) -> Mapping[str, JsonValue]:
        try:
            request = GenerateRequest.model_validate(dict(job.payload))
        except ValidationError as exc:
            raise InvalidArgumentError(
                "generation job payload is invalid",
                code="invalid_generation_request",
            ) from exc

        settings = self.settings.current
        resolved = await _resolve_prompt(settings, request, http=self.http)
        if not resolved.tags:
            raise InvalidArgumentError("prompt tags are empty", code="empty_prompt")

        if settings.mock_generation:
            # Keep the job in a running, cancellable state for the configured
            # window so cancellation can be exercised against instant mock output.
            if settings.mock_generation_delay_ms > 0:
                await asyncio.sleep(settings.mock_generation_delay_ms / 1000)
            payload = _ONE_PIXEL_PNG
        elif request.legacy_payload:
            payload = await generate_image_from_payload(
                settings=settings,
                payload=request.legacy_payload,
                http=self.http,
            )
        else:
            payload = await generate_image(
                settings=settings,
                tags=resolved.tags,
                negative=resolved.negative,
                params=resolved.params,
                http=self.http,
            )
        asset = await self.assets.store_bytes(
            job.id,
            f"generations/{job.id}.png",
            payload,
            kind="generation",
            media_type="image/png",
            source_job_id=job.id,
            metadata={"tags": resolved.tags, "negative": resolved.negative},
        )

        return {
            "asset_id": asset.id,
            "image_id": job.id,
            "image_url": f"/images/{job.id}",
            "image_path": asset.relative_path,
            "input": request.input,
            "mode": request.mode,
            "tags": resolved.tags,
            "negative": resolved.negative,
            "params": resolved.params.model_dump(mode="json"),
            "created_at": asset.created_at,
        }


async def _resolve_prompt(
    settings: Any,
    request: GenerateRequest,
    *,
    http: HttpClientPool | None = None,
) -> ResolvedPrompt:
    negative = request.negative or ""
    if request.mode == "tags":
        return ResolvedPrompt(
            tags=(request.tags or request.input).strip(),
            negative=negative,
            params=request.params,
        )
    return await convert_natural_to_tags(
        settings=settings,
        user_input=request.input,
        fallback_params=request.params,
        fallback_negative=negative,
        http=http,
    )


def _safe_error_message(exc: Exception) -> str:
    if isinstance(exc, (InvalidArgumentError, LLMNotConfiguredError, LLMConversionError)):
        return str(exc)[:500]
    if isinstance(exc, NovelAIError):
        return str(exc)[:500]
    return "generation failed"


__all__ = ["GenerationJobCoordinator", "NovelAIGenerationExecutor"]
