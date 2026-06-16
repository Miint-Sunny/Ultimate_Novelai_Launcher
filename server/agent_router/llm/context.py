"""
自研 LLM 框架 —— RunContext（替代 pydantic_ai.RunContext）。

依赖注入容器：一次 run 内创建一个实例，**同一个对象**传给该轮所有
system_prompt 函数、output_validator、tool，使得对 deps 的就地修改
（如 deps.degraded=True、deps.debug_contexts.append(...)）对各处可见。

全仓库只访问 `ctx.deps`（见审计）；其余字段为兼容/调试附带，无外部依赖。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Generic, TypeVar

DepsT = TypeVar("DepsT")


@dataclass
class RunContext(Generic[DepsT]):
    """运行时上下文。`deps` 为调用方通过 Agent.run(deps=...) 传入的依赖容器。"""

    deps: DepsT
    # 以下字段仅为与 pydantic_ai 行为对齐 / 调试可见性，本项目未直接读取：
    retry: int = 0                      # 当前是第几次重试（从 0 起）
    tool_name: str = ""                 # 若在工具上下文，当前工具名
    messages: list = field(default_factory=list)  # 截至当前的消息列表（只读视图）


__all__ = ["RunContext"]
