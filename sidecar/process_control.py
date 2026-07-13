from __future__ import annotations

import asyncio
import threading
from collections.abc import Callable


class ProcessControl:
    """Small process-wide bridge between HTTP lifecycle routes and the ASGI runner."""

    def __init__(self) -> None:
        self._draining = threading.Event()
        self._shutdown_requested = threading.Event()
        self._callbacks: set[Callable[[], None]] = set()
        self._callback_lock = threading.Lock()

    @property
    def draining(self) -> bool:
        return self._draining.is_set()

    @property
    def shutdown_requested(self) -> bool:
        return self._shutdown_requested.is_set()

    def begin_drain(self) -> None:
        self._draining.set()

    def request_shutdown(self) -> None:
        self._draining.set()
        self._shutdown_requested.set()
        with self._callback_lock:
            callbacks = tuple(self._callbacks)
        for callback in callbacks:
            try:
                callback()
            except RuntimeError:
                # A loop can close between the waiter registering and a shutdown
                # arriving from another thread.  One stale waiter must not stop
                # the remaining lifecycle listeners from receiving the signal.
                continue

    async def wait_for_shutdown(self) -> None:
        """Wait without polling and remain safe when signalled from another thread."""

        if self.shutdown_requested:
            return
        loop = asyncio.get_running_loop()
        event = asyncio.Event()

        def notify() -> None:
            loop.call_soon_threadsafe(event.set)

        with self._callback_lock:
            self._callbacks.add(notify)
            already_requested = self.shutdown_requested
        if already_requested:
            notify()
        try:
            await event.wait()
        finally:
            with self._callback_lock:
                self._callbacks.discard(notify)

    def reset(self) -> None:
        """Start a fresh app lifecycle in the current interpreter.

        Production creates one app per process; this also keeps app-factory tests
        isolated when several lifespans are exercised sequentially.
        """

        self._draining.clear()
        self._shutdown_requested.clear()


process_control = ProcessControl()
