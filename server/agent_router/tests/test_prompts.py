"""
prompts.py 测试 —— 合并预设加载（单文件、tier 已移除，不依赖 PydanticAI 运行时）。
"""

from __future__ import annotations


def test_load_chat_section(tmp_data_dir):
    """从合并预设 prompts.yaml 读 chat 段"""
    from agent_router import prompts as p

    persona = p.load_chat_section("persona")
    assert "测试合并猫娘" in persona

    # workflow / tools_hint / reply_rules 段也来自同一文件
    assert "工作流" in p.load_chat_section("workflow")

    # 不存在的段返回空串
    assert p.load_chat_section("not_exist") == ""


def test_load_planner_system_prompts(tmp_data_dir):
    from agent_router import prompts as p

    text = p.load_planner_system_prompts()
    assert "你是绘图助手" in text
    # planner 不做 random_string 替换（保留 placeholder）
    assert "{random_string}" in text


def test_warm_load_all_basic(tmp_data_dir):
    from agent_router import prompts as p

    status = p.warm_load_all()

    # 合并后只有一份预设，key 为 "prompts"
    assert status["prompts"]["ok"] is True
    assert "persona" in status["prompts"]["chat_sections"]
    assert status["prompts"]["chat_missing"] == []
    assert status["prompts"]["planner_prompts_count"] == 2


def test_get_prompts_raw(tmp_data_dir):
    """get_prompts_raw 返回 {system_prompts, prison_break} 字典（无 tier 参数）"""
    from agent_router import prompts as p

    raw = p.get_prompts_raw()
    assert "system_prompts" in raw
    assert "prison_break" in raw
    assert isinstance(raw["system_prompts"], list)
    assert len(raw["system_prompts"]) > 0
    assert raw["prison_break"] == []  # planner 没有 prison_break
