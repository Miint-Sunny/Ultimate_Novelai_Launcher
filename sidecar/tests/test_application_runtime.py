from __future__ import annotations

import asyncio
import tempfile
import unittest
from pathlib import Path

from backend_core.errors import RuntimeNotReadyError
from sidecar.application import MutationGate, SettingsStore, TaskSupervisor
from sidecar.config import Settings
from sidecar.runtime import AppRuntime


def settings(data_dir: Path) -> Settings:
    return Settings(
        host="127.0.0.1",
        port=0,
        data_dir=data_dir,
        nai_token="",
        nai_base_url="https://image.novelai.net",
        llm_base_url="",
        llm_api_key="",
        llm_model="",
        mock_generation=True,
        instance_id="instance",
        sidecar_auth_token="token",
    )


class ApplicationRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_settings_store_keeps_process_identity(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            current = settings(Path(directory))
            store = SettingsStore(current, loader=lambda: settings(Path(directory)))
            updated = await store.update({"llm_model": "test-model"})
            self.assertEqual(updated.instance_id, "instance")
            self.assertEqual(updated.sidecar_auth_token, "token")

    async def test_task_supervisor_cancels_and_rejects_paid_work_after_drain(self) -> None:
        supervisor = TaskSupervisor()
        cancelled = asyncio.Event()

        async def work() -> None:
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        supervisor.create_task(work(), name="work", paid=True)
        await asyncio.sleep(0)
        await supervisor.begin_drain(timeout=1)
        self.assertTrue(cancelled.is_set())

        never_started = work()
        with self.assertRaises(RuntimeNotReadyError):
            supervisor.create_task(never_started, name="rejected", paid=True)

    async def test_mutation_gate_seals_admission_and_waits_for_active_write(self) -> None:
        gate = MutationGate()
        entered = asyncio.Event()
        release = asyncio.Event()

        async def mutate() -> None:
            async with gate.admit():
                entered.set()
                await release.wait()

        task = asyncio.create_task(mutate())
        await entered.wait()
        await gate.seal()
        with self.assertRaises(RuntimeNotReadyError):
            async with gate.admit():
                self.fail("sealed mutation gate admitted a new write")
        self.assertFalse(await gate.wait_until_idle(timeout=0.001))
        release.set()
        await task
        self.assertTrue(await gate.wait_until_idle(timeout=0.1))

    async def test_runtime_reports_drain_timeout_and_can_recheck_quiescence(self) -> None:
        runtime = AppRuntime()
        await runtime.startup()
        entered = asyncio.Event()
        release = asyncio.Event()

        async def mutate() -> None:
            async with runtime.mutations.admit():
                entered.set()
                await release.wait()

        task = asyncio.create_task(mutate())
        await entered.wait()
        self.assertFalse(await runtime.begin_drain(timeout=0.001))
        release.set()
        await task
        self.assertTrue(await runtime.begin_drain(timeout=0.1))
        await runtime.shutdown()

    async def test_runtime_drain_contains_checkpoint_failure(self) -> None:
        class FailingDatabase:
            async def checkpoint(self) -> None:
                raise OSError("simulated checkpoint failure")

        runtime = AppRuntime(database=FailingDatabase())
        self.assertFalse(await runtime.begin_drain(timeout=0.1))
        self.assertTrue(runtime.draining)

    async def test_failed_temporary_quiescence_reopens_mutation_admission(self) -> None:
        gate = MutationGate()
        release = asyncio.Event()
        entered = asyncio.Event()

        async def first() -> None:
            async with gate.admit():
                entered.set()
                await release.wait()

        task = asyncio.create_task(first())
        await entered.wait()
        self.assertFalse(await gate.try_quiesce(timeout=0))
        async with gate.admit():
            self.assertEqual(gate.active_count, 2)
        release.set()
        await task

    async def test_dynamic_required_health_probe_controls_readiness(self) -> None:
        class Unhealthy:
            async def start(self) -> None:
                return None

            async def check(self) -> bool:
                return False

        runtime = AppRuntime()
        runtime.register("unhealthy", Unhealthy())
        await runtime.startup()
        report = await runtime.probe_readiness(cache_seconds=0)
        self.assertFalse(report["ready"])
        self.assertFalse(report["components"]["unhealthy"]["ready"])
        self.assertEqual(
            report["components"]["unhealthy"]["detail"],
            "health check failed",
        )
        await runtime.shutdown()


if __name__ == "__main__":
    unittest.main()
