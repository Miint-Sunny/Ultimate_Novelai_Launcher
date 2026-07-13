"""
SSE 编组测试。
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncGenerator
from typing import cast

import pytest


@pytest.mark.asyncio
async def test_sse_channel_basic_flow():
    from agent_router.schemas import SseEvent
    from agent_router.sse import SseChannel

    ch = SseChannel()

    async def producer():
        await ch.emit(SseEvent(event="tool_call", data={"name": "x"}))
        await ch.emit(SseEvent(event="tool_result", data={"name": "x", "summary": "ok"}))
        await ch.emit_final(
            {"thinking": "done", "positive": "1girl", "negative": "", "characters": []}
        )
        await ch.close()

    async def consumer():
        events = []
        async for line in ch.iter_sse():
            events.append(line)
        return events

    producer_task = asyncio.create_task(producer())
    events = await consumer()
    await producer_task

    # 三个事件 = 三个 block
    assert len(events) == 3

    # 每个 block 都有 event: 行和 data: 行
    for block in events:
        assert block.startswith("event: ")
        assert "data: " in block
        assert block.endswith("\n\n")

    # 解析最后一个 final 事件
    final_block = events[-1]
    assert "event: final" in final_block
    data_line = [line for line in final_block.split("\n") if line.startswith("data:")][0]
    payload = json.loads(data_line[5:].strip())
    assert payload["thinking"] == "done"
    assert payload["positive"] == "1girl"


@pytest.mark.asyncio
async def test_sse_close_terminates_iter():
    from agent_router.sse import SseChannel

    ch = SseChannel()

    async def consumer():
        events = []
        async for line in ch.iter_sse():
            events.append(line)
        return events

    # 不发任何事件，直接 close —— iter_sse 应立即结束
    await ch.close()
    events = await asyncio.wait_for(consumer(), timeout=2)
    assert events == []


@pytest.mark.asyncio
async def test_sse_disconnect_cancels_bound_producer():
    from agent_router.schemas import SseEvent
    from agent_router.sse import SseChannel

    channel = SseChannel(queue_size=2)
    cancelled = asyncio.Event()

    async def producer() -> None:
        try:
            await channel.emit(SseEvent(event="agent_token", data={"value": "one"}))
            await asyncio.sleep(30)
        except asyncio.CancelledError:
            cancelled.set()
            raise

    task = asyncio.create_task(producer())
    channel.bind_producer(task)
    stream = channel.iter_sse()
    await stream.__anext__()
    await cast(AsyncGenerator[str, None], stream).aclose()

    await asyncio.wait_for(cancelled.wait(), timeout=2)
    with pytest.raises(asyncio.CancelledError):
        await task


@pytest.mark.asyncio
async def test_sse_close_does_not_block_when_queue_is_full():
    from agent_router.schemas import SseEvent
    from agent_router.sse import SseChannel

    channel = SseChannel(queue_size=1)
    await channel.emit(SseEvent(event="agent_token", data={"value": "one"}))
    await asyncio.wait_for(channel.close(), timeout=1)
