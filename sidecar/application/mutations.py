from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from backend_core.errors import RuntimeNotReadyError


class MutationGate:
    """Seal process-local writes and wait for admitted mutations to finish.

    HTTP adapters use this around every state-changing request.  Restore and
    shutdown control requests are deliberately outside the gate so they can seal
    admission first, wait for already-admitted writes, and then replace or close
    infrastructure without racing a late settings/asset/database write.
    """

    def __init__(self) -> None:
        self._draining = False
        self._active = 0
        self._idle = asyncio.Event()
        self._idle.set()

    @property
    def draining(self) -> bool:
        return self._draining

    @property
    def active_count(self) -> int:
        return self._active

    async def start(self) -> None:
        if self._active:
            raise RuntimeError("cannot reopen mutation admission while writes are active")
        self._draining = False
        self._idle.set()

    @asynccontextmanager
    async def admit(self) -> AsyncIterator[None]:
        # Admission and the counter update contain no await, so they are atomic
        # with respect to every task on the ASGI event loop.  Keeping release
        # synchronous also makes it impossible for response cancellation to leak
        # an active mutation slot.
        if self._draining:
            raise RuntimeNotReadyError(
                "sidecar is draining and cannot accept state changes",
                code="service_draining",
                retryable=True,
            )
        self._active += 1
        self._idle.clear()
        try:
            yield
        finally:
            self._active -= 1
            if self._active == 0:
                self._idle.set()

    async def seal(self) -> None:
        self._draining = True

    async def reopen(self) -> None:
        """Reopen admission after a maintenance attempt that changed no state."""

        self._draining = False

    async def try_quiesce(self, timeout: float = 8.0) -> bool:
        """Temporarily seal writes; reopen automatically when the wait times out."""

        await self.seal()
        idle = await self.wait_until_idle(timeout)
        if not idle:
            await self.reopen()
        return idle

    async def wait_until_idle(self, timeout: float = 8.0) -> bool:
        waiter = asyncio.create_task(self._idle.wait())
        done, _pending = await asyncio.wait({waiter}, timeout=max(0.0, timeout))
        if not done:
            waiter.cancel()
            await asyncio.gather(waiter, return_exceptions=True)
            return False
        waiter.result()
        return True

    async def begin_drain(self, timeout: float = 8.0) -> bool:
        await self.seal()
        return await self.wait_until_idle(timeout)

    async def stop(self) -> None:
        await self.begin_drain()


__all__ = ["MutationGate"]
