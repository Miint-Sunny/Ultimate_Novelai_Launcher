"""
lite_chat_agent —— 前置 Lite agent：回复 + 意图判断 + 资料筛选三合一。

设计:
    用 Vertex Gemini 3.1 Flash Lite，每次请求都跑一次。
    output_type=LiteResponse（3 个 primitive 字段，零嵌套）—— 避免 ChatOutput 多层
    嵌套带来的 "characters=[] 逃避" / "幻想字段死循环" 等 schema 污染问题。

工作流:
    用户消息 → preprocess → lite_chat_agent
        ↓ output: { reply_text, should_draw, refined_resources }
        ├─ should_draw=False → router 用 reply_text 收尾，结束
        └─ should_draw=True  → 把 refined_resources 喂给 pure_planner 出 DrawSpec

不挂工具：lite 只做决策 + 筛选 + 短回复，需要 search_* 的场景由 planner 自己调。
看短历史：路由层裁剪到最近 ~10 轮再喂给 lite，覆盖多轮延续指代场景。
"""
from __future__ import annotations

from ..llm import Agent, RunContext

from ..deps import AgentDeps
from ..schemas import LiteResponse
from ..model_provider import get_prefilter_model, get_prefilter_model_settings
from ..prompts import load_lite_chat_section


lite_chat_agent: Agent[AgentDeps, LiteResponse] = Agent(
    get_prefilter_model(),    # 复用 PREFILTER_MODEL 配置
    deps_type=AgentDeps,
    output_type=LiteResponse,
    retries=3,
)


@lite_chat_agent.system_prompt
async def _lite_system_prompt(ctx: RunContext[AgentDeps]) -> str:
    return load_lite_chat_section("system_prompt", preset=ctx.deps.prompt_preset)


@lite_chat_agent.system_prompt
async def _anti_marker(ctx: RunContext[AgentDeps]) -> str:
    """防上游指纹标记（env CPA_ENABLE_ANTI_MARKER=true 时启用，每次生成新噪声）"""
    from .anti_marker import make_anti_marker_noise
    return make_anti_marker_noise()


def _trim_history(history: list, max_turns: int = 10) -> list:
    """裁剪 message_history 到最近 max_turns 轮（user + assistant 算 1 轮）。"""
    if not history:
        return []
    return history[-(max_turns * 2):]


async def run_lite_chat(
    *,
    user_text: str,
    candidates: str,
    history: list,
    deps: AgentDeps,
    timeout_s: float = 30.0,
) -> tuple[LiteResponse, list, list]:
    """
    跑一次 lite_chat。失败 / 超时**降级为直接进入生成**——把决策权交给 planner，
    避免绘图意图被误判成闲聊导致用户失去图。

    Args:
        user_text: 用户本轮原话
        candidates: 合并后的预查询资料（带 ## 标题的纯文本），可能为空
        history: 完整 ModelMessage 历史；函数内部会裁剪到最近 3 轮
        deps: AgentDeps
        timeout_s: 整体超时（含 retries），默认 30s

    Returns:
        (LiteResponse, all_messages, system_prompt_parts)。永不抛异常。
        降级时 all_messages = []，system_prompt_parts 仍尽量取出（不依赖 run 成功）。
    """
    import asyncio
    import logging

    logger = logging.getLogger(__name__)

    # 组装 user prompt：原话 + 候选资料（如有）
    if candidates.strip():
        prompt = (
            f"用户原话：{user_text.strip()}\n\n"
            f"[预查询资源]\n{candidates.strip()}"
        )
    else:
        prompt = f"用户原话：{user_text.strip()}"

    short_history = _trim_history(history)

    # debug 用：拿真实的 system_prompt（PydanticAI 1.x 带 history 时不会注入到 messages 里）
    try:
        sys_parts = list(await lite_chat_agent.system_prompt_parts(deps=deps))
    except Exception:
        sys_parts = []

    try:
        result = await asyncio.wait_for(
            lite_chat_agent.run(
                prompt,
                deps=deps,
                message_history=short_history,
                model=get_prefilter_model(),
                model_settings=get_prefilter_model_settings(),
            ),
            timeout=timeout_s,
        )
        try:
            all_msgs = list(result.all_messages())
        except Exception:
            all_msgs = []
        return result.output, all_msgs, sys_parts
    except asyncio.TimeoutError:
        logger.warning(f"lite_chat timeout >{timeout_s}s，降级直接进入生成")
    except Exception as e:
        logger.warning(f"lite_chat failed ({type(e).__name__}: {e})，降级直接进入生成")

    # 降级：直接进入生成（lite 超时/失败时把决策权交给 planner）
    # refined_resources 用 candidates 原文不筛选——让 planner 拿到完整资料自己挑
    # 选择 should_draw=True 而非 False：宁可偶尔把闲聊误判成绘图（多一张随机图），
    # 也不能让明确的绘图意图被误判成闲聊（用户失去图）
    return (
        LiteResponse(
            reply_text="好喵~本喵开工了。",
            should_draw=True,
            refined_resources=candidates,
        ),
        [],
        sys_parts,
    )
