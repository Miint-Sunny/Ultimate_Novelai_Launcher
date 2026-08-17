"""适配器代管的 code→poll_token 映射(内存,带 TTL 与上限)。

后端的授权 generate 会多返一个 256-bit poll_token(dev 分支的反爆破加固),
而 Plana 客户端不知道这个字段。适配器代客户端保管它:generate 时截获并存下,
check 时补回去转发。映射是短命的(授权码 TTL 内)、有界的。
"""

from __future__ import annotations

import time
from collections import OrderedDict
from collections.abc import Callable


class PendingCodeStore:
    def __init__(
        self,
        *,
        ttl_seconds: float = 300.0,
        max_entries: int = 2000,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if ttl_seconds < 1 or max_entries < 1:
            raise ValueError("invalid pending-code store limits")
        self.ttl_seconds = ttl_seconds
        self.max_entries = max_entries
        self._clock = clock
        # code -> (poll_token, expires_at);OrderedDict 便于 FIFO 逐出。
        self._entries: OrderedDict[str, tuple[str, float]] = OrderedDict()

    def _prune(self) -> None:
        now = self._clock()
        expired = [code for code, (_, exp) in self._entries.items() if now >= exp]
        for code in expired:
            self._entries.pop(code, None)

    def put(self, code: str, poll_token: str) -> None:
        self._prune()
        # 满了先逐出最旧的(而非拒绝新授权)。
        while len(self._entries) >= self.max_entries:
            self._entries.popitem(last=False)
        self._entries[code] = (poll_token, self._clock() + self.ttl_seconds)
        self._entries.move_to_end(code)

    def get(self, code: str) -> str | None:
        self._prune()
        entry = self._entries.get(code)
        return entry[0] if entry else None

    def discard(self, code: str) -> None:
        self._entries.pop(code, None)

    def __len__(self) -> int:
        self._prune()
        return len(self._entries)


__all__ = ["PendingCodeStore"]
