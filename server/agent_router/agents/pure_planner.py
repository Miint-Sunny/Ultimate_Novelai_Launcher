"""
pure_planner_agent —— 单职责 NovelAI 绘图 planner。

设计：
  - output_type=PromptedOutput(DrawSpec)，避免 OpenAI-compatible 网关校验
    final_result array schema 失败
  - system_prompt 只挂 prompts.yaml 的 planner.system_prompts 各段，每段独立一条 role:system
  - 不要人格 / 不要对话规则 / 不要 reply_text 约束 / 不要 should_draw 决策
  - 仍挂 search_* 工具
"""

from __future__ import annotations

from ..deps import AgentDeps
from ..llm import Agent, PromptedOutput, RunContext
from ..model_family import ModelFamily
from ..prompts import load_packaged_prompt_bundle, load_planner_section
from ..schemas import DrawSpec
from ..skills import load_index, load_mandate
from ..tools import register_knowledge_tools, register_skill_tools

# Both the legacy router and desktop runner inject the request-scoped model.
# Importing this module must not read deployment-specific config.py.
pure_planner_agent: Agent[AgentDeps, DrawSpec] = Agent(
    None,
    deps_type=AgentDeps,
    output_type=PromptedOutput(DrawSpec),
    retries=3,
)


# ============================================================
# 知识层：拆段独立装载，每段一条 role:system
# ============================================================
# pydantic-ai 会把每个 @system_prompt 装饰函数发成一条 role:system。
# 拆段后单段都不超 ~1.5KB，注意力分布均匀（拼一锅 ~5KB 时中段会塌）。
# 段名必须跟 prompts.yaml 里 planner.system_prompts[*].name 完全对得上，
# 否则 load_planner_section 会返回 ""，等于塞一条空 system 进去。
_PLANNER_SECTIONS = [
    "mission",
    "skill_mandate",
    "input_format",
    "art_fundamentals",
    "art_principles",
    "character_rules",
    "art_advanced",
    "fixed_combos",
    "technique_combos",
    "art_craft",
    "reference_examples",
    "draw_output",
]

_MODEL_FAMILY_SECTION_OVERRIDES: dict[ModelFamily, dict[str, str]] = {
    "v45": {"skill_mandate": "skill_mandate_v45"},
}


def _planner_section_name(name: str, family: ModelFamily) -> str:
    """Resolve the one model-specific planner section at the assembly boundary."""

    return _MODEL_FAMILY_SECTION_OVERRIDES.get(family, {}).get(name, name)


def _register_planner_sections() -> None:
    """把每个 yaml 段注册成一个独立 @system_prompt（每段一条 role:system）。
    preset 由 deps.prompt_preset 决定（空 → prompts.yaml；'anima' → prompts_anima.yaml）。"""
    for section_name in _PLANNER_SECTIONS:

        def _make_loader(name: str):
            async def _loader(ctx: RunContext[AgentDeps]) -> str:
                selected_name = _planner_section_name(name, ctx.deps.image_model_family)
                if ctx.deps.prompt_bundle is not None:
                    content = ctx.deps.prompt_bundle.planner(selected_name)
                    if content or selected_name == name:
                        return content
                    return load_packaged_prompt_bundle().planner(selected_name)
                return load_planner_section(selected_name, preset=ctx.deps.prompt_preset)

            _loader.__name__ = f"_planner_{name}"
            return _loader

        pure_planner_agent.system_prompt(_make_loader(section_name))


_register_planner_sections()


@pure_planner_agent.system_prompt
async def _skill_manifest(ctx: RunContext[AgentDeps]) -> str:
    """
    方法层的铁律 + 小节目录。

    直接从内置的 skill 文件生成,**不在 prompts.yaml 里复述** ——
    上游改了方法,这里跟着变;复述一份就迟早两处说两套话。
    正文按需读(read_prompting_skill),这里只放够模型自己挑节的信息。
    """
    return (
        f"{load_mandate()}\n\n"
        f"可读的小节(用 read_prompting_skill 取原文):\n{load_index()}"
    )


@pure_planner_agent.system_prompt
async def _anti_marker(ctx: RunContext[AgentDeps]) -> str:
    """防上游指纹标记（env CPA_ENABLE_ANTI_MARKER=true 时启用，每次生成新噪声）"""
    from .anti_marker import make_anti_marker_noise

    return make_anti_marker_noise()


# 复用 4 个本地查询工具（search_character / search_artist / random_artist / search_danbooru）
register_knowledge_tools(pure_planner_agent)
# 方法层按需读取（read_prompting_skill / list_prompting_skill）
register_skill_tools(pure_planner_agent)
