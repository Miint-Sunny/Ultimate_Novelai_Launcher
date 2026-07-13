from __future__ import annotations

import asyncio
from collections.abc import Coroutine
from typing import Any

from backend_core.errors import RuntimeNotReadyError


class TaskSupervisor:
    """Own background tasks and provide one bounded drain point."""

    def __init__(self) -> None:
        self._tasks: set[asyncio.Task[Any]] = set()
        self._draining = False
        self._lock = asyncio.Lock()

    @property
    def draining(self) -> bool:
        return self._draining

    @property
    def active_count(self) -> int:
        return sum(not task.done() for task in self._tasks)

    def create_task(
        self,
        coroutine: Coroutine[Any, Any, Any],
        *,
        name: str,
        paid: bool = False,
    ) -> asyncio.Task[Any]:
        if paid and self._draining:
            coroutine.close()
            raise RuntimeNotReadyError(
                "sidecar is draining and cannot accept paid work",
                code="service_draining",
                retryable=True,
            )
        task = asyncio.create_task(coroutine, name=name)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    async def begin_drain(self, timeout: float = 8.0) -> None:
        async with self._lock:
            self._draining = True
            tasks = [task for task in self._tasks if not task.done()]
            if not tasks:
                return
            for task in tasks:
                task.cancel()
            try:
                await asyncio.wait_for(
                    asyncio.gather(*tasks, return_exceptions=True),
                    timeout=max(0.0, timeout),
                )
            except TimeoutError:
                return

    async def close(self) -> None:
        await self.begin_drain()

    stop = close
