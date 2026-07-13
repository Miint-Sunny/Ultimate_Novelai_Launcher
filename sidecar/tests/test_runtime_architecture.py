from __future__ import annotations

import unittest

from backend_core.types import RuntimeState
from sidecar.runtime import AppRuntime


class RuntimeArchitectureTests(unittest.IsolatedAsyncioTestCase):
    async def test_lifecycle_runs_in_order_and_stops_in_reverse(self) -> None:
        calls: list[str] = []
        runtime = AppRuntime(version="test")
        runtime.register_hooks(
            "database",
            startup=lambda: calls.append("start:database"),
            shutdown=lambda: calls.append("stop:database"),
        )
        runtime.register_hooks(
            "worker",
            startup=lambda: calls.append("start:worker"),
            shutdown=lambda: calls.append("stop:worker"),
        )

        await runtime.startup()
        self.assertTrue(runtime.ready)
        self.assertEqual(runtime.resource_names, ("mutation_gate", "database", "worker"))
        self.assertEqual(calls, ["start:database", "start:worker"])

        await runtime.shutdown()
        self.assertEqual(runtime.state, RuntimeState.STOPPED)
        self.assertEqual(
            calls,
            ["start:database", "start:worker", "stop:worker", "stop:database"],
        )

        await runtime.shutdown()
        self.assertEqual(len(calls), 4)

    async def test_startup_failure_rolls_back_started_resources(self) -> None:
        calls: list[str] = []

        async def fail() -> None:
            calls.append("start:failing")
            raise RuntimeError("cannot start")

        runtime = AppRuntime()
        runtime.register_hooks(
            "first",
            startup=lambda: calls.append("start:first"),
            shutdown=lambda: calls.append("stop:first"),
        )
        runtime.register_hooks("failing", startup=fail)

        with self.assertRaisesRegex(RuntimeError, "cannot start"):
            await runtime.startup()

        self.assertEqual(runtime.state, RuntimeState.FAILED)
        self.assertEqual(calls, ["start:first", "start:failing", "stop:first"])

    async def test_job_service_is_an_optional_managed_dependency(self) -> None:
        class Jobs:
            def __init__(self) -> None:
                self.initialized = 0

            async def initialize(self) -> None:
                self.initialized += 1

        jobs = Jobs()
        runtime = AppRuntime(jobs=jobs)  # type: ignore[arg-type]

        await runtime.startup()
        self.assertEqual(jobs.initialized, 1)
        self.assertEqual(runtime.readiness()["components"]["jobs"]["ready"], True)
        await runtime.shutdown()

    async def test_optional_resource_failure_does_not_block_readiness(self) -> None:
        async def fail() -> None:
            raise RuntimeError("optional integration is offline")

        runtime = AppRuntime()
        runtime.register_hooks("optional", startup=fail, required=False)

        await runtime.startup()

        self.assertTrue(runtime.ready)
        self.assertEqual(runtime.readiness()["components"]["optional"]["ready"], False)
        await runtime.shutdown()
