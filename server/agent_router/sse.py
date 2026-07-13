"""
SSE 事件编组工具。

为 /api/agent/web/generate-prompt 提供:
    - 标准 text/event-stream 格式编码
    - asyncio.Queue 作为事件 buffer，让 agent 主流程 emit 事件、HTTP 响应消费事件
    - 关闭信号（None sentinel）
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator

from .schemas import SseEvent

_CLOSE_SENTINEL: object = object()


class SseChannel:
    """
    单次 HTTP 响应对应的 SSE 通道。

    用法（router 内）:
        ch = SseChannel()
        deps = AgentDeps(..., sse_emitter=ch.emit)

        async def run_agent():
            try:
                ...await agent.run_stream(..., deps=deps)...
                await ch.emit_final(payload)
            finally:
                await ch.close()

        asyncio.create_task(run_agent())
        return StreamingResponse(ch.iter_sse(), media_type="text/event-stream")
    """

    def __init__(self, queue_size: int = 256) -> None:
        self._queue: asyncio.Queue = asyncio.Queue(maxsize=queue_size)
        self._closed = False
        self._producer_task: asyncio.Task[None] | None = None

    def bind_producer(self, task: asyncio.Task[None]) -> None:
        """Bind paid/background work so disconnect finalization can cancel it."""
        self._producer_task = task

    async def emit(self, event: SseEvent) -> None:
        if self._closed:
            return
        await self._queue.put(event)

    async def emit_final(self, data) -> None:
        await self.emit(SseEvent(event="final", data=data))

    async def emit_error(self, message: str) -> None:
        await self.emit(SseEvent(event="error", data={"message": message}))

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self._queue.put_nowait(_CLOSE_SENTINEL)
        except asyncio.QueueFull:
            # A disappeared consumer must never make producer cleanup deadlock.
            try:
                self._queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
            self._queue.put_nowait(_CLOSE_SENTINEL)

    async def iter_sse(self) -> AsyncIterator[str]:
        """生成 text/event-stream 行。每个事件占两行：event: + data:"""
        saw_close = False
        try:
            while True:
                item = await self._queue.get()
                if item is _CLOSE_SENTINEL:
                    saw_close = True
                    break
                assert isinstance(item, SseEvent)
                try:
                    payload = json.dumps(
                        item.data
                        if not hasattr(item.data, "model_dump")
                        else item.data.model_dump(),
                        ensure_ascii=False,
                        default=str,
                    )
                except Exception as e:
                    payload = json.dumps({"_encode_error": str(e)}, ensure_ascii=False)
                yield f"event: {item.event}\ndata: {payload}\n\n"
        finally:
            # Generator finalization without our sentinel means the client left.
            if not saw_close:
                self._closed = True
                producer = self._producer_task
                if (
                    producer is not None
                    and producer is not asyncio.current_task()
                    and not producer.done()
                ):
                    producer.cancel()


def format_sse_event(event: str, data) -> str:
    """工具函数：手动编码一条 SSE 事件（不通过 channel）"""
    payload = json.dumps(
        data if not hasattr(data, "model_dump") else data.model_dump(),
        ensure_ascii=False,
        default=str,
    )
    return f"event: {event}\ndata: {payload}\n\n"
