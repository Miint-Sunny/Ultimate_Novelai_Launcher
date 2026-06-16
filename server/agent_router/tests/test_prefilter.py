"""
Prefilter / B3 / carryover 路径单测。

不调真实 LLM，只覆盖纯函数 helper 行为：
    - _split_prequery_from_env
    - _merge_resources
    - _line_keys_for_match
    - _extract_used_resources
    - _LAST_USED_RESOURCES 读写契约
"""
from __future__ import annotations

from agent_router.router import (
    _split_prequery_from_env,
    _merge_resources,
    _build_prequery_env_block,
    _rebuild_env_info,
    _line_keys_for_match,
    _extract_used_resources,
    _draw_specs_haystack,
    _dewrap_tag_text,
    _count_prequery_sections,
    _LAST_USED_RESOURCES,
)


# ============================================================
# _count_prequery_sections（仅用于 debug 计数，不再做触发判定）
# ============================================================

def _make_section(title: str, lines: list[str]) -> str:
    return title + "\n" + "\n".join(lines)


def test_count_sections_artist():
    merged = _make_section("## search_artist 结果", ["A1 -> x", "A2 -> y"])
    c = _count_prequery_sections(merged)
    assert c == {"artist": 2, "roleTag": 0, "oc": 0}


def test_count_sections_roletag():
    merged = _make_section(
        "## search_character 结果（source=roleTag）",
        ["fl -> flandre_scarlet", "remi -> remilia_scarlet"],
    )
    c = _count_prequery_sections(merged)
    assert c == {"artist": 0, "roleTag": 2, "oc": 0}


def test_count_sections_oc():
    merged = _make_section(
        "## search_character 结果（source=oc）",
        ["myoc -> 1girl, my_oc_tag"],
    )
    c = _count_prequery_sections(merged)
    assert c == {"artist": 0, "roleTag": 0, "oc": 1}


def test_count_sections_mixed():
    merged = (
        "## search_artist 结果\n"
        "A1 -> x\n"
        "## search_character 结果（source=oc）\n"
        "myoc -> y\n"
        "## search_character 结果（source=roleTag）\n"
        "fl -> flandre_scarlet\n"
        "remi -> remilia_scarlet"
    )
    c = _count_prequery_sections(merged)
    assert c == {"artist": 1, "roleTag": 2, "oc": 1}


def test_count_sections_empty():
    assert _count_prequery_sections("") == {"artist": 0, "roleTag": 0, "oc": 0}
    assert _count_prequery_sections("   ") == {"artist": 0, "roleTag": 0, "oc": 0}


# ============================================================
# _split_prequery_from_env
# ============================================================

def test_split_prequery_basic():
    env = (
        "[预查询资源]（说明）\n\n"
        "## search_artist 结果\n"
        "A1 -> artist:ciloranko, masterpiece\n\n"
        "## search_character 结果\n"
        "fl -> flandre_scarlet, touhou"
    )
    pq, other = _split_prequery_from_env(env)
    assert "search_artist" in pq
    assert "search_character" in pq
    assert "A1 -> artist:ciloranko, masterpiece" in pq
    assert other == ""


def test_split_prequery_with_stego_section():
    env = (
        "[预查询资源]\n"
        "## search_artist 结果\n"
        "A1 -> artist:ciloranko\n"
        "\n"
        "[回复图片 stego 元数据]\n"
        "global_positive: 1girl, solo"
    )
    pq, other = _split_prequery_from_env(env)
    assert "ciloranko" in pq
    assert "stego" not in pq      # stego 段不能漏到 prequery
    assert "[回复图片 stego 元数据]" in other
    assert "global_positive" in other


def test_split_prequery_empty():
    assert _split_prequery_from_env("") == ("", "")
    assert _split_prequery_from_env("   \n  ") == ("", "")


def test_split_prequery_only_other():
    env = "[回复图片 stego 元数据]\nglobal_positive: x"
    pq, other = _split_prequery_from_env(env)
    assert pq == ""
    assert "[回复图片 stego 元数据]" in other


# ============================================================
# _merge_resources
# ============================================================

def test_merge_basic_dedup():
    """完全相同行只保留一次，carryover 在前。"""
    raw = "## search_artist 结果\nA1 -> artist:ciloranko\nB2 -> artist:wlop"
    carry = "## search_artist 结果\nA1 -> artist:ciloranko\n## search_character 结果\nfl -> flandre_scarlet"
    merged = _merge_resources(raw, carry)
    lines = merged.split("\n")
    # 期望：## search_artist / A1 / ## search_character / fl / B2
    # （carryover 先；raw 里 A1 重复跳过；B2 在末尾）
    assert lines.count("## search_artist 结果") == 1
    assert lines.count("A1 -> artist:ciloranko") == 1
    assert "## search_character 结果" in lines
    assert "fl -> flandre_scarlet" in lines
    assert "B2 -> artist:wlop" in lines


def test_merge_variants_preserved():
    """flandre_scarlet 和 flandre_scarlet_(crimson_devil) 是不同行 → 都保留。"""
    raw = "## search_character 结果\nfl -> flandre_scarlet_(crimson_devil)"
    carry = "## search_character 结果\nfl -> flandre_scarlet, touhou"
    merged = _merge_resources(raw, carry)
    assert "fl -> flandre_scarlet, touhou" in merged
    assert "fl -> flandre_scarlet_(crimson_devil)" in merged


def test_merge_empty_inputs():
    assert _merge_resources("", "") == ""
    assert _merge_resources("a\nb", "") == "a\nb"
    assert _merge_resources("", "x\ny") == "x\ny"


def test_merge_skips_blank_lines():
    raw = "a\n\nb"
    carry = "c\n   \nd"
    merged = _merge_resources(raw, carry)
    lines = merged.split("\n")
    assert "" not in lines
    assert lines == ["c", "d", "a", "b"]


# ============================================================
# _build_prequery_env_block / _rebuild_env_info
# ============================================================

def test_build_prequery_env_block_empty():
    assert _build_prequery_env_block("") == ""
    assert _build_prequery_env_block("   ") == ""


def test_build_prequery_env_block_with_content():
    out = _build_prequery_env_block("## x\nentry")
    assert out.startswith("[预查询资源]\n")
    assert "## x\nentry" in out


def test_rebuild_env_info_combines():
    out = _rebuild_env_info("[预查询资源]\nx", "[回复图片 stego 元数据]\ny")
    assert "[预查询资源]\nx" in out
    assert "[回复图片 stego 元数据]\ny" in out


def test_rebuild_env_info_skips_empty():
    assert _rebuild_env_info("", "") == ""
    assert _rebuild_env_info("a", "") == "a"
    assert _rebuild_env_info("", "b") == "b"


# ============================================================
# _line_keys_for_match
# ============================================================

def test_line_key_strips_artist_prefix():
    assert _line_keys_for_match("A1 -> artist:ciloranko, masterpiece") == ["ciloranko"]


def test_line_key_strips_by_prefix():
    assert _line_keys_for_match("X -> by_someone, blah") == ["someone"]


def test_line_key_character_tag():
    assert _line_keys_for_match("fl -> flandre_scarlet, touhou") == ["flandre_scarlet"]


def test_line_key_arrow_variants():
    assert _line_keys_for_match("A1 → artist:wlop") == ["wlop"]
    assert _line_keys_for_match("A1 => artist:wlop") == ["wlop"]


def test_line_key_skips_short():
    """长度 <3 的 tag 返回空（无意义匹配）。"""
    assert _line_keys_for_match("X -> ab") == []


def test_line_key_empty():
    assert _line_keys_for_match("") == []
    assert _line_keys_for_match("   ") == []


def test_line_key_no_arrow():
    """没有箭头时取整行第一个 tag。"""
    keys = _line_keys_for_match("flandre_scarlet, touhou")
    assert keys == ["flandre_scarlet"]


# ============================================================
# _dewrap_tag_text
# ============================================================

def test_dewrap_weight_syntax():
    assert _dewrap_tag_text("1.5::artist:wlop::") == "artist:wlop"
    assert _dewrap_tag_text("{tag}") == "tag"
    assert _dewrap_tag_text("[tag]") == "tag"
    assert _dewrap_tag_text("{{tag}}") == "tag"


# ============================================================
# _draw_specs_haystack
# ============================================================

def test_haystack_lowercases_and_dewraps():
    specs = [{"positive": "1girl, Flandre_Scarlet, 1.5::artist:Wlop::, masterpiece"}]
    hay = _draw_specs_haystack(specs)
    assert "flandre_scarlet" in hay
    assert "wlop" in hay


def test_haystack_includes_character_positives():
    specs = [{"positive": "2girls", "characters": [
        {"name": "A", "positive": "flandre_scarlet"},
        {"name": "B", "positive": "remilia_scarlet"},
    ]}]
    hay = _draw_specs_haystack(specs)
    assert "flandre_scarlet" in hay
    assert "remilia_scarlet" in hay


def test_haystack_empty():
    assert _draw_specs_haystack([]) == ""
    assert _draw_specs_haystack([{}]) == ""


# ============================================================
# _extract_used_resources (B3 核心)
# ============================================================

def test_b3_extracts_only_adopted():
    """draw_specs 用了 wlop + flandre_scarlet；A1/ciloranko 和 remilia 没用 → 排除。"""
    draw_specs = [{
        "positive": "1girl, solo, flandre_scarlet, touhou, 1.5::artist:wlop::, masterpiece",
        "characters": [],
    }]
    pref_out = (
        "## search_artist 结果\n"
        "A1 -> artist:ciloranko, masterpiece\n"
        "B2 -> artist:wlop, masterpiece\n"
        "## search_character 结果\n"
        "fl -> flandre_scarlet, touhou\n"
        "remi -> remilia_scarlet, touhou"
    )
    used = _extract_used_resources(
        ctx_messages=[], draw_specs=draw_specs, prefilter_output=pref_out
    )
    assert "B2 -> artist:wlop, masterpiece" in used
    assert "fl -> flandre_scarlet, touhou" in used
    assert "ciloranko" not in used
    assert "remilia" not in used


def test_b3_section_titles_preserved():
    """B3 输出按候选行的 ## section 分组保留。"""
    draw_specs = [{"positive": "flandre_scarlet"}]
    pref_out = "## search_character 结果\nfl -> flandre_scarlet"
    used = _extract_used_resources(
        ctx_messages=[], draw_specs=draw_specs, prefilter_output=pref_out
    )
    assert used.startswith("## search_character 结果")
    assert "fl -> flandre_scarlet" in used


def test_b3_empty_draw_specs():
    """没绘图意图（draw_specs 为空）→ used_resources 也空。"""
    used = _extract_used_resources(
        ctx_messages=[],
        draw_specs=[],
        prefilter_output="## search_character 结果\nx -> y",
    )
    assert used == ""


def test_b3_no_hits():
    """draw_specs 里都没用任何候选 tag → 空。"""
    draw_specs = [{"positive": "1girl, white_hair, solo"}]
    pref_out = "## search_character 结果\nfl -> flandre_scarlet"
    used = _extract_used_resources(
        ctx_messages=[], draw_specs=draw_specs, prefilter_output=pref_out
    )
    assert used == ""


def test_b3_dedup_lines():
    """同样的行重复出现只算一次。"""
    draw_specs = [{"positive": "flandre_scarlet"}]
    pref_out = (
        "## search_character 结果\n"
        "fl -> flandre_scarlet\n"
        "fl -> flandre_scarlet"
    )
    used = _extract_used_resources(
        ctx_messages=[], draw_specs=draw_specs, prefilter_output=pref_out
    )
    assert used.count("fl -> flandre_scarlet") == 1


def test_b3_handles_weight_wrapped_haystack():
    """1.5::artist:wlop:: 包装的 tag 也能被识别。"""
    draw_specs = [{"positive": "1girl, 1.5::artist:wlop::, masterpiece"}]
    pref_out = "## search_artist 结果\nB2 -> artist:wlop, masterpiece"
    used = _extract_used_resources(
        ctx_messages=[], draw_specs=draw_specs, prefilter_output=pref_out
    )
    assert "wlop" in used


# ============================================================
# _LAST_USED_RESOURCES 契约
# ============================================================

def test_carryover_dict_read_default_empty():
    """未设置过的 user_key 取出来是空字符串。"""
    _LAST_USED_RESOURCES.pop("nobody", None)
    assert _LAST_USED_RESOURCES.get("nobody", "") == ""


def test_carryover_dict_set_and_get():
    _LAST_USED_RESOURCES["test_user_1"] = "## x\nA"
    assert _LAST_USED_RESOURCES.get("test_user_1") == "## x\nA"
    # 清理
    _LAST_USED_RESOURCES.pop("test_user_1", None)


def test_carryover_dict_overwrite_each_turn():
    """每轮覆盖，不累积。"""
    _LAST_USED_RESOURCES["test_user_2"] = "old"
    _LAST_USED_RESOURCES["test_user_2"] = "new"
    assert _LAST_USED_RESOURCES.get("test_user_2") == "new"
    _LAST_USED_RESOURCES.pop("test_user_2", None)


# ============================================================
# 整合：模拟 3 轮流程的 merge 行为
# ============================================================

def test_three_turn_flow():
    """
    模拟用户连续 3 轮的资料流转：
    轮1：画芙兰 A1 画风 → B3 提炼 = flandre + A1
    轮2：换 B2 画风   → carryover = 轮1 used；raw 含 B2；merge 三条；prefilter 模拟去掉 A1
    轮3：carryover = 轮2 used（含 flandre + B2，无 A1）→ A1 自然消失
    """
    # 轮 1: 模拟 B3 提炼结果
    turn1_pref = (
        "## search_artist 结果\n"
        "A1 -> artist:ciloranko, masterpiece\n"
        "## search_character 结果\n"
        "fl -> flandre_scarlet, touhou"
    )
    turn1_specs = [{"positive": "1girl, solo, flandre_scarlet, touhou, artist:ciloranko"}]
    used_t1 = _extract_used_resources(
        ctx_messages=[], draw_specs=turn1_specs, prefilter_output=turn1_pref
    )
    assert "ciloranko" in used_t1
    assert "flandre_scarlet" in used_t1

    # 轮 2: carryover = used_t1；本轮 preprocess 匹配到 B2
    raw_t2 = "## search_artist 结果\nB2 -> artist:wlop, masterpiece"
    merged_t2 = _merge_resources(raw_t2, used_t1)
    assert "ciloranko" in merged_t2
    assert "wlop" in merged_t2
    assert "flandre_scarlet" in merged_t2

    # 模拟 prefilter 输出（去 A1，留 flandre + B2）
    turn2_pref = (
        "## search_artist 结果\n"
        "B2 -> artist:wlop, masterpiece\n"
        "## search_character 结果\n"
        "fl -> flandre_scarlet, touhou"
    )
    turn2_specs = [{"positive": "1girl, solo, flandre_scarlet, touhou, artist:wlop"}]
    used_t2 = _extract_used_resources(
        ctx_messages=[], draw_specs=turn2_specs, prefilter_output=turn2_pref
    )
    # 轮 2 used 不应含 A1（A1 没写进 draw_specs）
    assert "ciloranko" not in used_t2
    assert "wlop" in used_t2
    assert "flandre_scarlet" in used_t2

    # 轮 3: carryover = used_t2 → 不再有 A1
    raw_t3 = ""  # 用户没说专有名词，preprocess 空
    merged_t3 = _merge_resources(raw_t3, used_t2)
    assert "ciloranko" not in merged_t3   # ← A1 自然消失
    assert "wlop" in merged_t3
    assert "flandre_scarlet" in merged_t3
