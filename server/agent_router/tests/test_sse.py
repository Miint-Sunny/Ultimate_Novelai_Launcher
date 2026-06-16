"""
SSE 编组测试。
"""
from __future__ import annotations

import asyncio
import json
import pytest


@pytest.mark.asyncio
async def test_sse_channel_basic_flow():
    from agent_router.sse import SseChannel
    from agent_router.schemas import SseEvent

    ch = SseChannel()

    async def producer():
        await ch.emit(SseEvent(event="tool_call", data={"name": "x"}))
        await ch.emit(SseEvent(event="tool_result", data={"name": "x", "summary": "ok"}))
        await ch.emit_final({"thinking": "done", "positive": "1girl", "negative": "", "characters": []})
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
