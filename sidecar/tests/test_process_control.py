from __future__ import annotations

import asyncio

from sidecar.process_control import ProcessControl


async def test_shutdown_waiter_is_notified_without_polling() -> None:
    control = ProcessControl()
    waiter = asyncio.create_task(control.wait_for_shutdown())
    await asyncio.sleep(0)

    control.request_shutdown()

    await asyncio.wait_for(waiter, timeout=1)
    assert control.draining
    assert control.shutdown_requested


async def test_shutdown_waiter_returns_when_shutdown_was_already_requested() -> None:
    control = ProcessControl()
    control.request_shutdown()

    await asyncio.wait_for(control.wait_for_shutdown(), timeout=1)


async def test_stale_shutdown_callback_does_not_block_live_waiter() -> None:
    control = ProcessControl()
    waiter = asyncio.create_task(control.wait_for_shutdown())
    await asyncio.sleep(0)

    def stale_callback() -> None:
        raise RuntimeError("event loop already closed")

    with control._callback_lock:
        control._callbacks.add(stale_callback)

    control.request_shutdown()

    await asyncio.wait_for(waiter, timeout=1)
    assert control.shutdown_requested
