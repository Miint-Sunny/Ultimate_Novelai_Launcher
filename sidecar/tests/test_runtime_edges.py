from __future__ import annotations

import asyncio
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

import sidecar.application.tasks as tasks_module
from backend_core.errors import InvalidArgumentError, RuntimeNotReadyError
from backend_core.types import RuntimeState
from sidecar.application import MutationGate, SettingsStore, TaskSupervisor
from sidecar.config import Settings
from sidecar.runtime import AppRuntime


def _settings(root: Path, **changes: Any) -> Settings:
    base = Settings(
        host="127.0.0.1",
        port=0,
        data_dir=root,
        nai_token="",
        nai_base_url="https://image.novelai.net",
        llm_base_url="",
        llm_api_key="",
        llm_model="",
        mock_generation=True,
        instance_id="process-instance",
        protocol_version=1,
        sidecar_auth_token="process-token",
    )
    return replace(base, **changes)


@pytest.mark.asyncio
async def test_settings_store_supports_loaderless_updates_replace_set_and_reload(
    tmp_path: Path,
) -> None:
    initial = _settings(tmp_path)
    store = SettingsStore(initial, loader=None)
    assert store.current is initial

    updated = await store.update({"llm_model": "model-a"})
    assert updated.llm_model == "model-a"
    assert await store.reload() is updated
    replaced = store.replace(llm_model="model-b")
    assert replaced.llm_model == "model-b"
    replacement = _settings(tmp_path, llm_model="model-c")
    assert store.set(replacement) is replacement


@pytest.mark.asyncio
async def test_settings_store_reload_preserves_process_handshake_and_validates_networks(
    tmp_path: Path,
) -> None:
    loaded = _settings(
        tmp_path,
        instance_id="loaded-instance",
        protocol_version=999,
        sidecar_auth_token="loaded-token",
        llm_model="loaded-model",
    )
    store = SettingsStore(_settings(tmp_path), loader=lambda: loaded)

    refreshed = await store.reload()
    assert refreshed.llm_model == "loaded-model"
    assert refreshed.instance_id == "process-instance"
    assert refreshed.protocol_version == 1
    assert refreshed.sidecar_auth_token == "process-token"

    with pytest.raises(InvalidArgumentError, match="trusted-lan"):
        await store.update({"llm_network_scope": "trusted-lan", "llm_trusted_networks": []})
    with pytest.raises(InvalidArgumentError, match="unknown"):
        await store.update({"unknown_setting": "value"})
    transport_store = SettingsStore(_settings(tmp_path), loader=None)
    with pytest.raises(InvalidArgumentError, match="HTTPS"):
        await transport_store.update({"llm_base_url": "http://llm.example/v1"})
    await transport_store.update(
        {
            "llm_network_scope": "trusted-lan",
            "llm_trusted_networks": ["192.168.1.0/24"],
            "llm_base_url": "http://192.168.1.8:8080/v1",
        }
    )
    with pytest.raises(InvalidArgumentError, match="HTTPS"):
        await transport_store.update({"llm_network_scope": "public"})


@pytest.mark.asyncio
async def test_mutation_gate_reopen_start_and_successful_quiescence() -> None:
    gate = MutationGate()
    assert gate.draining is False and gate.active_count == 0
    async with gate.admit():
        assert gate.active_count == 1
        with pytest.raises(RuntimeError, match="writes are active"):
            await gate.start()
    assert await gate.try_quiesce(timeout=0.1) is True
    assert gate.draining is True
    await gate.reopen()
    await gate.start()
    async with gate.admit():
        pass
    await gate.stop()
    assert gate.draining is True


@pytest.mark.asyncio
async def test_task_supervisor_empty_drain_nonpaid_work_and_close() -> None:
    supervisor = TaskSupervisor()
    assert supervisor.draining is False and supervisor.active_count == 0
    await supervisor.begin_drain(timeout=0)
    assert supervisor.draining is True

    ran = asyncio.Event()

    async def free_work() -> None:
        ran.set()

    task = supervisor.create_task(free_work(), name="free", paid=False)
    await task
    assert ran.is_set()
    await supervisor.close()


@pytest.mark.asyncio
async def test_task_supervisor_contains_drain_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    supervisor = TaskSupervisor()

    async def work() -> None:
        await asyncio.Event().wait()

    async def force_timeout(awaitable, *, timeout: float):
        awaitable.cancel()
        await asyncio.gather(awaitable, return_exceptions=True)
        raise TimeoutError

    monkeypatch.setattr(tasks_module.asyncio, "wait_for", force_timeout)

    supervisor.create_task(work(), name="work", paid=True)
    await asyncio.sleep(0)
    await supervisor.begin_drain(timeout=0)
    assert supervisor.draining is True


def test_runtime_registration_and_readiness_guards() -> None:
    runtime = AppRuntime(capability_provider=lambda: {"configured": True})
    with pytest.raises(RuntimeNotReadyError):
        runtime.assert_ready()
    with pytest.raises(ValueError, match="must not be empty"):
        runtime.register(" ", object())
    runtime.register("resource", object())
    with pytest.raises(ValueError, match="already registered"):
        runtime.register("resource", object())
    report = runtime.readiness()
    assert report["capabilities"] == {"configured": True}
    assert report["components"]["resource"]["ready"] is False


@pytest.mark.asyncio
async def test_runtime_start_stop_aliases_idempotency_and_hookless_resource() -> None:
    runtime = AppRuntime()
    runtime.register_hooks("hookless")
    await runtime.start()
    await runtime.startup()
    runtime.assert_ready()
    with pytest.raises(RuntimeError, match="before startup"):
        runtime.register("late", object())
    await runtime.stop()
    await runtime.shutdown()
    assert runtime.state is RuntimeState.STOPPED

    never_started = AppRuntime()
    await never_started.shutdown()
    assert never_started.state is RuntimeState.STOPPED


@pytest.mark.asyncio
async def test_runtime_rejects_invalid_transitional_lifecycle_states() -> None:
    runtime = AppRuntime()
    runtime.state = RuntimeState.STARTING
    with pytest.raises(RuntimeError, match="cannot start"):
        await runtime.startup()
    with pytest.raises(RuntimeError, match="cannot stop"):
        await runtime.shutdown()


@pytest.mark.asyncio
async def test_runtime_shutdown_reports_stop_failures() -> None:
    class BrokenStop:
        async def start(self) -> None:
            return None

        async def stop(self) -> None:
            raise OSError("close failed")

    runtime = AppRuntime()
    runtime.register("broken", BrokenStop())
    await runtime.startup()
    with pytest.raises(RuntimeError, match="broken: close failed"):
        await runtime.shutdown()
    assert runtime.state is RuntimeState.FAILED


@pytest.mark.asyncio
async def test_runtime_drain_invokes_controller_and_contains_sync_adapter_failures() -> None:
    class Controller:
        draining = False

        def begin_drain(self) -> None:
            self.draining = True

    class BrokenDrain:
        draining = False

        def begin_drain(self, *, timeout: float):
            raise RuntimeError("adapter failed")

    class SyncDatabase:
        def checkpoint(self) -> None:
            return None

    controller = Controller()
    runtime = AppRuntime(
        jobs=BrokenDrain(),  # type: ignore[arg-type]
        tasks=BrokenDrain(),
        database=SyncDatabase(),
        process_control=controller,
    )
    assert await runtime.begin_drain(timeout=0.1) is False
    assert controller.draining is True
    assert runtime.draining is True


@pytest.mark.asyncio
async def test_runtime_drain_times_out_async_checkpoint() -> None:
    class SlowDatabase:
        async def checkpoint(self) -> None:
            await asyncio.Event().wait()

    runtime = AppRuntime(database=SlowDatabase())
    assert await runtime.begin_drain(timeout=0) is False


@pytest.mark.asyncio
async def test_runtime_health_probe_cache_timeout_exception_and_sync_check() -> None:
    class Healthy:
        def __init__(self) -> None:
            self.calls = 0

        async def start(self) -> None:
            return None

        def check(self) -> bool:
            self.calls += 1
            return True

    class Slow:
        async def start(self) -> None:
            return None

        async def check(self) -> bool:
            await asyncio.Event().wait()
            return True

    class Broken:
        async def start(self) -> None:
            return None

        async def check(self) -> bool:
            raise OSError("probe failed")

    healthy = Healthy()
    runtime = AppRuntime()
    runtime.register("healthy", healthy)
    runtime.register("slow", Slow(), required=False)
    runtime.register("broken", Broken(), required=False)
    await runtime.startup()
    first = await runtime.probe_readiness(timeout=0)
    second = await runtime.probe_readiness(timeout=1, cache_seconds=100)
    assert first == second
    assert healthy.calls == 1
    assert first["components"]["slow"]["detail"] == "health check timed out"
    assert first["components"]["broken"]["detail"] in {"probe failed", "health check timed out"}
    runtime.invalidate_readiness()
    await runtime.shutdown()


@pytest.mark.asyncio
async def test_runtime_lifespan_starts_and_stops() -> None:
    runtime = AppRuntime()
    async with runtime.lifespan() as active:
        assert active is runtime and runtime.ready
    assert runtime.state is RuntimeState.STOPPED
