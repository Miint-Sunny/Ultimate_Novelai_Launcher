"""
按需读 nai5-prompting skill 的小节。

为什么要工具而不是整份塞系统提示词:见 agent_router/skills.py 顶部。
一句话:两份参考约 100KB,而 planner 的分段实测是「单段 ~1.5KB 时注意力才匀」。
"""

from __future__ import annotations

from typing import Any

from ..deps import AgentDeps
from ..llm import Agent, RunContext
from ..skills import load_index, load_sections, read_section
from ..sse import SseEvent


async def _emit_tool_call(ctx: RunContext[AgentDeps], name: str, args: dict) -> None:
    await ctx.deps.emit(SseEvent(event="tool_call", data={"name": name, "arguments": args}))


async def _emit_tool_result(ctx: RunContext[AgentDeps], name: str, summary: str) -> None:
    await ctx.deps.emit(SseEvent(event="tool_result", data={"name": name, "summary": summary}))


def register_skill_tools(agent: Agent[AgentDeps, Any]) -> None:
    """把方法层的按需读取工具挂到 agent 上。"""

    @agent.tool(strict=True)
    async def read_prompting_skill(ctx: RunContext[AgentDeps], section: str) -> str:
        """
        读 nai5-prompting 方法层的一节原文。**写 V5 提示词之前必须先读**。

        什么时候读哪节(skill 自己的规矩):
          - 用户只给了半句话 / 一个方向 → 先读 `构思/先分档：用户给了多少`,
            按它的分档决定要补到哪一步,必要时再读 `构思/构思是一条动画管线`。
          - 要落笔了 → 至少读 `写法/0`(字段模板与内容顺序)。
          - 拿不准某块该写成词组还是句子 → `写法/2` 是判据,
            `写法/3` 是必须词组化的清单,`写法/4` 是必须写成句子的清单。
          - 多角色互动 → `写法/4`(§4.9 施受与锚点);漫画分格 → `写法/4`(§4.10)。
          - 出图不对劲要排查 → `写法/8`;**发出去之前过一遍 `写法/9`**。

        Args:
            section: 小节 id,例如 `写法/0`、`写法/3`、`构思/先分档：用户给了多少`。
                     认不出来时会把可用的 id 列表回给你,照着重点一次。

        Returns:
            该节的原文(markdown)。
        """
        await _emit_tool_call(ctx, "read_prompting_skill", {"section": section})
        text = read_section(section)
        if text is None:
            await _emit_tool_result(ctx, "read_prompting_skill", f"没有这一节: {section}")
            return (
                f"没有 `{section}` 这一节。可用的小节如下,照着重点一次:\n{load_index()}"
            )
        await _emit_tool_result(
            ctx, "read_prompting_skill", f"{section}（{len(text)} 字）"
        )
        return text

    @agent.tool(strict=True)
    async def list_prompting_skill(ctx: RunContext[AgentDeps]) -> str:
        """列出方法层的全部小节 id 与标题。不确定该读哪节时先调这个。"""
        await _emit_tool_call(ctx, "list_prompting_skill", {})
        await _emit_tool_result(ctx, "list_prompting_skill", f"{len(load_sections())} 节")
        return load_index()
