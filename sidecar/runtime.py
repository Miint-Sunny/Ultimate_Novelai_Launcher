"""Process-local lifecycle and dependency container for sidecar adapters.

``AppRuntime`` knows when infrastructure is usable, but it does not know how HTTP,
SQLite, credentials, or generation are implemented.  Concrete services are supplied
by the composition root and consumed through protocols in ``backend_core``.
"""

from __future__ import annotations

import asyncio
import inspect
from collections.abc import AsyncIterator, Callable, Iterable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from backend_core.errors import RuntimeNotReadyError
from backend_core.protocols import JobService, RequestAuthenticator
from backend_core.types import Clock, RuntimeState, utc_now

from . import APP_VERSION
from .application.mutations import MutationGate

LifecycleHook = Callable[[], Any]


@dataclass
class _RegisteredResource:
    name: str
    value: Any
    required: bool = True
    started: bool = False
    error: str | None = None


@dataclass
class _HookResource:
    startup: LifecycleHook | None = None
    shutdown: LifecycleHook | None = None

    def start(self) -> Any:
        if self.startup is not None:
            return self.startup()
        return None

    def stop(self) -> Any:
        if self.shutdown is not None:
            return self.shutdown()
        return None


@dataclass
class AppRuntime:
    """Own application services and coordinate their process lifecycle.

    Services are intentionally optional so a small test app or migration adapter can
    mount only the capabilities it implements.  Objects with ``start``/``stop`` are
    preferred; ``startup``/``shutdown``, ``initialize`` and ``close`` are accepted to
    make existing infrastructure easy to compose.
    """

    settings: Any = None
    jobs: JobService | None = None
    security: RequestAuthenticator | None = None
    library: Any = None
    database: Any = None
    assets: Any = None
    backups: Any = None
    pairing: Any = None
    tasks: Any = None
    mutations: MutationGate = field(default_factory=MutationGate)
    process_control: Any = None
    capability_provider: Callable[[], dict[str, Any]] | None = None
    version: str = APP_VERSION
    clock: Clock = utc_now

    state: RuntimeState = field(default=RuntimeState.NEW, init=False)
    started_at: datetime | None = field(default=None, init=False)
    stopped_at: datetime | None = field(default=None, init=False)
    failure: str | None = field(default=None, init=False)
    _draining: bool = field(default=False, init=False, repr=False)
    _resources: list[_RegisteredResource] = field(default_factory=list, init=False, repr=False)
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock, init=False, repr=False)
    _drain_lock: asyncio.Lock = field(default_factory=asyncio.Lock, init=False, repr=False)
    _health_lock: asyncio.Lock = field(default_factory=asyncio.Lock, init=False, repr=False)
    _health_checked_at: float = field(default=0.0, init=False, repr=False)
    _health: dict[str, tuple[bool, str | None]] = field(
        default_factory=dict,
        init=False,
        repr=False,
    )

    def __post_init__(self) -> None:
        self._register_if_present("mutation_gate", self.mutations)
        self._register_if_present("jobs", self.jobs)
        self._register_if_present("security", self.security)
        self._register_if_present("library", self.library)

    @property
    def ready(self) -> bool:
        return self.state is RuntimeState.READY and not self.draining

    @property
    def draining(self) -> bool:
        controller_draining = bool(getattr(self.process_control, "draining", False))
        task_draining = bool(getattr(self.tasks, "draining", False))
        job_draining = bool(getattr(self.jobs, "draining", False))
        mutation_draining = self.mutations.draining
        return (
            self._draining
            or controller_draining
            or task_draining
            or job_draining
            or mutation_draining
        )

    @property
    def resource_names(self) -> tuple[str, ...]:
        return tuple(resource.name for resource in self._resources)

    def register(self, name: str, value: Any, *, required: bool = True) -> Any:
        """Register a service or lifecycle resource before startup.

        The value is returned so composition roots can use this as a small fluent
        helper.  Duplicate names and mutations after startup are rejected early.
        """

        normalized = name.strip()
        if not normalized:
            raise ValueError("resource name must not be empty")
        if self.state is not RuntimeState.NEW:
            raise RuntimeError("resources can only be registered before startup")
        if any(item.name == normalized for item in self._resources):
            raise ValueError(f"resource is already registered: {normalized}")
        self._resources.append(_RegisteredResource(normalized, value, required))
        return value

    def register_hooks(
        self,
        name: str,
        *,
        startup: LifecycleHook | None = None,
        shutdown: LifecycleHook | None = None,
        required: bool = True,
    ) -> None:
        self.register(name, _HookResource(startup=startup, shutdown=shutdown), required=required)

    async def startup(self) -> None:
        """Start resources in registration order and roll back on failure."""

        async with self._lock:
            if self.state is RuntimeState.READY:
                return
            if self.state not in {RuntimeState.NEW, RuntimeState.STOPPED}:
                raise RuntimeError(f"cannot start runtime while state is {self.state.value}")

            self.state = RuntimeState.STARTING
            self._draining = False
            self.failure = None
            self.invalidate_readiness()
            self.stopped_at = None
            started: list[_RegisteredResource] = []
            current: _RegisteredResource | None = None
            try:
                for current in self._resources:
                    current.error = None
                    try:
                        await _invoke_first(
                            current.value,
                            ("start", "startup", "initialize", "open"),
                        )
                    except Exception as exc:
                        current.error = str(exc) or exc.__class__.__name__
                        if current.required:
                            raise
                        continue
                    current.started = True
                    started.append(current)
            except Exception as exc:
                error = str(exc) or exc.__class__.__name__
                if current is not None:
                    current.error = error
                self.failure = error
                await _stop_all(reversed(started))
                self.state = RuntimeState.FAILED
                raise

            self.started_at = self.clock()
            self.state = RuntimeState.READY

    async def start(self) -> None:
        """Lifecycle-protocol alias for ``startup``."""

        await self.startup()

    async def shutdown(self) -> None:
        """Stop started resources in reverse order; safe to call repeatedly."""

        async with self._lock:
            if self.state is RuntimeState.STOPPED:
                return
            if self.state is RuntimeState.NEW:
                self.state = RuntimeState.STOPPED
                self.stopped_at = self.clock()
                return
            if self.state is RuntimeState.STARTING:
                raise RuntimeError("cannot stop runtime while it is starting")

            self._draining = True
            self.state = RuntimeState.STOPPING
            errors = await _stop_all(reversed(self._resources))
            self.stopped_at = self.clock()
            if errors:
                self.failure = "; ".join(errors)
                self.state = RuntimeState.FAILED
                raise RuntimeError(f"runtime shutdown failed: {self.failure}")
            self.state = RuntimeState.STOPPED
            self.invalidate_readiness()

    async def stop(self) -> None:
        """Lifecycle-protocol alias for ``shutdown``."""

        await self.shutdown()

    async def begin_drain(self, timeout: float = 8.0) -> bool:
        """Reject new paid work and cancel supervised/upstream tasks within a bound."""

        async with self._drain_lock:
            loop = asyncio.get_running_loop()
            deadline = loop.time() + max(0.0, timeout)
            first_drain = not self._draining
            self._draining = True
            if first_drain:
                controller = self.process_control
                begin_process_drain = getattr(controller, "begin_drain", None)
                if callable(begin_process_drain):
                    begin_process_drain()

            await self.mutations.seal()
            operations: list[Any] = [self.mutations.wait_until_idle(timeout)]
            drained = True
            begin_tasks_drain = getattr(self.tasks, "begin_drain", None)
            if callable(begin_tasks_drain):
                try:
                    operations.append(begin_tasks_drain(timeout=timeout))
                except Exception:
                    drained = False
            begin_jobs_drain = getattr(self.jobs, "begin_drain", None)
            if callable(begin_jobs_drain):
                try:
                    operations.append(begin_jobs_drain(timeout=timeout))
                except Exception:
                    drained = False

            aggregate = asyncio.gather(*operations, return_exceptions=True)
            done, _pending = await asyncio.wait(
                {aggregate},
                timeout=max(0.0, deadline - loop.time()),
            )
            if done:
                results = aggregate.result()
                drained = drained and all(
                    not isinstance(result, BaseException) and result is not False
                    for result in results
                )
            else:
                drained = False
                aggregate.cancel()
                await asyncio.gather(aggregate, return_exceptions=True)

            checkpoint = getattr(self.database, "checkpoint", None)
            if callable(checkpoint):
                try:
                    result = checkpoint()
                    if inspect.isawaitable(result):
                        checkpoint_task = asyncio.ensure_future(result)
                        done, _pending = await asyncio.wait(
                            {checkpoint_task},
                            timeout=max(0.0, deadline - loop.time()),
                        )
                        if done:
                            try:
                                checkpoint_task.result()
                            except Exception:
                                drained = False
                        else:
                            checkpoint_task.cancel()
                            await asyncio.gather(checkpoint_task, return_exceptions=True)
                            drained = False
                except Exception:
                    drained = False
            return drained

    def assert_ready(self) -> None:
        if not self.ready:
            raise RuntimeNotReadyError(
                "application runtime is not ready",
                details={"state": self.state.value},
            )

    def readiness(self) -> dict[str, Any]:
        """Return transport-neutral readiness data without exposing service objects."""

        capabilities = self.capability_provider() if self.capability_provider else {}
        components: dict[str, dict[str, Any]] = {}
        required_healthy = True
        for resource in self._resources:
            health_ready, health_detail = self._health.get(resource.name, (True, None))
            resource_ready = resource.started and resource.error is None and health_ready
            if resource.required and not resource_ready:
                required_healthy = False
            component: dict[str, Any] = {
                "ready": resource_ready,
                "required": resource.required,
            }
            detail = resource.error or health_detail
            if detail:
                component["detail"] = detail
            components[resource.name] = component
        return {
            "ready": self.ready and required_healthy,
            "draining": self.draining,
            "state": self.state.value,
            "version": self.version,
            "started_at": self.started_at,
            "components": components,
            "capabilities": capabilities,
        }

    async def probe_readiness(
        self,
        *,
        timeout: float = 1.0,
        cache_seconds: float = 0.5,
    ) -> dict[str, Any]:
        """Run bounded infrastructure probes and return a short-lived snapshot."""

        loop = asyncio.get_running_loop()
        if self._health_checked_at and loop.time() - self._health_checked_at < cache_seconds:
            return self.readiness()
        async with self._health_lock:
            if self._health_checked_at and loop.time() - self._health_checked_at < cache_seconds:
                return self.readiness()
            probes: dict[str, asyncio.Task[bool]] = {}
            for resource in self._resources:
                checker = getattr(resource.value, "check", None)
                if callable(checker):
                    probes[resource.name] = asyncio.create_task(
                        _run_health_check(checker),
                        name=f"health-{resource.name}",
                    )
            if probes:
                done, pending = await asyncio.wait(
                    set(probes.values()),
                    timeout=max(0.0, timeout),
                )
                for task in pending:
                    task.cancel()
                if pending:
                    await asyncio.gather(*pending, return_exceptions=True)
                for name, task in probes.items():
                    if task not in done:
                        self._health[name] = (False, "health check timed out")
                        continue
                    try:
                        healthy = task.result()
                    except Exception as exc:
                        self._health[name] = (
                            False,
                            str(exc) or exc.__class__.__name__,
                        )
                    else:
                        self._health[name] = (
                            healthy,
                            None if healthy else "health check failed",
                        )
            self._health_checked_at = loop.time()
            return self.readiness()

    def invalidate_readiness(self) -> None:
        self._health_checked_at = 0.0
        self._health.clear()

    @asynccontextmanager
    async def lifespan(self) -> AsyncIterator[AppRuntime]:
        await self.startup()
        try:
            yield self
        finally:
            await self.shutdown()

    def _register_if_present(self, name: str, value: Any) -> None:
        if value is not None:
            self.register(name, value)


async def _invoke_first(value: Any, names: Iterable[str]) -> None:
    for name in names:
        method = getattr(value, name, None)
        if not callable(method):
            continue
        result = method()
        if inspect.isawaitable(result):
            await result
        return


async def _run_health_check(checker: LifecycleHook) -> bool:
    result = checker()
    if inspect.isawaitable(result):
        result = await result
    return bool(result)


async def _stop_all(resources: Iterable[_RegisteredResource]) -> list[str]:
    errors: list[str] = []
    for resource in resources:
        if not resource.started:
            continue
        try:
            await _invoke_first(resource.value, ("stop", "shutdown", "close", "aclose"))
        except Exception as exc:  # finish unwinding the remaining resources
            resource.error = str(exc) or exc.__class__.__name__
            errors.append(f"{resource.name}: {resource.error}")
        finally:
            resource.started = False
    return errors
