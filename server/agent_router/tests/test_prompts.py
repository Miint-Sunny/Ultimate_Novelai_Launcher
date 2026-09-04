"""
prompts.py 测试 —— 合并预设加载（单文件、tier 已移除，不依赖 PydanticAI 运行时）。
"""

from __future__ import annotations

import pytest


def _prompt_yaml(planner_names: tuple[str, ...]) -> str:
    planner = "".join(
        "    - role: system\n"
        f"      name: {name}\n"
        f"      content: {name} override\n"
        for name in planner_names
    )
    return (
        "chat:\n"
        "  persona: test\n"
        "  workflow: test\n"
        "  tools_hint: test\n"
        "  reply_rules: test\n"
        "lite_chat:\n"
        "  system_prompt: test\n"
        "planner:\n"
        "  system_prompts:\n"
        + planner
    )


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
    assert status["prompts"]["planner_prompts_count"] == len(p._REQUIRED_PLANNER_SECTIONS)


def test_get_prompts_raw(tmp_data_dir):
    """get_prompts_raw 返回 {system_prompts, prison_break} 字典（无 tier 参数）"""
    from agent_router import prompts as p

    raw = p.get_prompts_raw()
    assert "system_prompts" in raw
    assert "prison_break" in raw
    assert isinstance(raw["system_prompts"], list)
    assert len(raw["system_prompts"]) > 0
    assert raw["prison_break"] == []  # planner 没有 prison_break


def test_package_resource_fallback(tmp_data_dir, tmp_path, monkeypatch):
    from agent_router import prompts as p

    packaged = tmp_data_dir / "prompts.yaml"
    empty_legacy_dir = tmp_path / "legacy-empty"
    empty_legacy_dir.mkdir()
    monkeypatch.setattr(p, "_data_dir", lambda: empty_legacy_dir)
    monkeypatch.setattr(p, "_package_resource", lambda filename: packaged)
    p._load_yaml_cached.cache_clear()

    assert "测试合并猫娘" in p.load_chat_section("persona")


def test_prompt_bundle_exposes_validated_sections(tmp_data_dir):
    from agent_router import prompts as p

    bundle = p.load_prompt_bundle()
    assert "测试合并猫娘" in bundle.chat("persona")
    assert bundle.lite_chat("system_prompt")
    assert "你是绘图助手" in bundle.planner("mission")


def test_prompt_contract_matches_sections_consumed_by_agents():
    from agent_router import prompts as p
    from agent_router.agents.pure_planner import (
        _MODEL_FAMILY_SECTION_OVERRIDES,
        _PLANNER_SECTIONS,
    )

    consumed = set(_PLANNER_SECTIONS)
    for overrides in _MODEL_FAMILY_SECTION_OVERRIDES.values():
        consumed.update(overrides.values())
    assert consumed == set(p._REQUIRED_PLANNER_SECTIONS)
    assert p._REQUIRED_CHAT_SECTIONS == ("persona", "workflow", "tools_hint", "reply_rules")


def test_prompt2_override_keeps_base_sections_and_falls_back_for_v45(
    tmp_data_dir,
):
    from agent_router import prompts as p

    (tmp_data_dir / "prompts2.yaml").write_text(
        _prompt_yaml(p._BASE_REQUIRED_PLANNER_SECTIONS),
        encoding="utf-8",
    )
    p._load_yaml_cached.cache_clear()

    assert p.load_planner_section("mission", preset="prompt2") == "mission override"
    assert "V4.5 纯 tag 路线" in p.load_planner_section(
        "skill_mandate_v45",
        preset="prompt2",
    )


def test_missing_prompt2_uses_packaged_default(tmp_data_dir):
    from agent_router import prompts as p

    assert "V4.5 纯 tag 路线" in p.load_planner_section(
        "skill_mandate_v45",
        preset="prompt2",
    )


def test_formal_prompt_preflight_requires_v45_mandate(tmp_path):
    from agent_router import prompts as p

    prompt = tmp_path / "prompts.yaml"
    prompt.write_text(
        _prompt_yaml(p._BASE_REQUIRED_PLANNER_SECTIONS),
        encoding="utf-8",
    )

    status = p.preflight_prompt_resource(prompt)

    assert status["ok"] is False
    assert "skill_mandate_v45" in status["error"]


def test_packaged_bundle_never_falls_back_to_legacy(tmp_data_dir, tmp_path, monkeypatch):
    from agent_router import prompts as p

    missing = tmp_path / "package-empty" / "prompts.yaml"
    monkeypatch.setattr(p, "_package_resource", lambda filename: missing)
    with pytest.raises(p.PromptResourceError):
        p.load_packaged_prompt_bundle()


def test_preflight_missing_resource_is_clear(tmp_path):
    from agent_router import prompts as p

    missing = tmp_path / "prompts.yaml"
    status = p.preflight_prompt_resource(missing)
    assert status["ok"] is False
    assert str(missing) in status["error"]
    assert "不存在" in status["error"]


def test_preflight_rejects_incomplete_prompt(tmp_path):
    from agent_router import prompts as p

    incomplete = tmp_path / "prompts.yaml"
    incomplete.write_text("chat: {}\nplanner: {}\n", encoding="utf-8")
    status = p.preflight_prompt_resource(incomplete)
    assert status["ok"] is False
    assert "lite_chat.system_prompt" in status["error"]
    assert "planner.system_prompts" in status["error"]
