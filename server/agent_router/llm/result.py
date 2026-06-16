"""
自研 LLM 框架 —— RunResult / Usage（替代 pydantic_ai AgentRunResult + RunUsage）。

外部访问点（来自审计）：
    result.output            -> 校验后的 output_type 实例（BaseModel 或 str）
    result.all_messages()    -> 完整消息列表（history + 本轮）
    result.new_messages()    -> 仅本轮新增（不含传入的 history），含工具返回那几条 ModelRequest
    result.usage             -> 带 .input_tokens 的对象（cli 调试用，容忍属性或方法）

**关键契约**：当 run 带了 message_history 时，all_messages() 不包含 SystemPromptPart
（与 pydantic_ai 1.x 一致）——这是在 Agent.run 组装消息时就保证的（system 段只在
无 history 时并入首条 ModelRequest），本类只是忠实持有那份列表。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class Usage:
    """一次 run 的 token 用量（尽力从 provider 响应解析；解析不到则为 0）。"""

    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    requests: int = 0

    def incorporate(self, other: "Usage | None") -> None:
        """把单次请求的用量累加进来。"""
        if other is None:
            return
        self.input_tokens += other.input_tokens
        self.output_tokens += other.output_tokens
        self.total_tokens += other.total_tokens
        self.requests += other.requests or 1


class RunResult:
    """Agent.run 的返回值。"""

    def __init__(
        self,
        output: Any,
        messages: list,
        *,
        history_len: int,
        usage: Usage | None = None,
    ) -> None:
        self._output = output
        self._messages = list(messages)
        self._history_len = max(0, history_len)
        self._usage = usage or Usage()

    @property
    def output(self) -> Any:
        return self._output

    def all_messages(self) -> list:
        """完整消息列表（history + 本轮新增）。"""
        return list(self._messages)

    def new_messages(self) -> list:
        """仅本轮新增的消息（不含传入 history），含工具返回的 ModelRequest。"""
        return list(self._messages[self._history_len:])

    @property
    def usage(self) -> Usage:
        return self._usage


__all__ = ["RunResult", "Usage"]
