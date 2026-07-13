"""
CLI 预匹配模拟器 —— 给 cli.py 调试用，复刻 bot 端 preprocess_user_message 的 env_info 构建逻辑。

为什么单独写一份？
    Bot 真实路径 preprocess_user_message 依赖 nonebot 包（logger、Bot 等），
    CLI 是纯 Python 进程，不想把 nonebot 引入。

简化范围:
    - 直接读 data/*.json，不走 bot 的缓存层
    - artist:  regex + 字面 lookup（跟 bot 原版一致）
    - OC:      字面 substring 匹配 + 别名长度排序（跟 bot 原版一致）
    - role:    简化版字面匹配（无多层 fuzzy），用 CLI 调试足够；
               想看完整 fuzzy 行为请走真实 bot 路径

输出格式与 nai_agent.py 的 env_info 完全一致，AI 看到的内容跟生产路径无差异。
"""

from __future__ import annotations

import json
import re
from pathlib import Path

# 与 nai_agent.py 第 47 行保持一致
_ARTIST_PATTERN = re.compile(r"(?<![a-zA-Z])([a-zA-Z])(\d{1,2})(?!\d)", re.IGNORECASE)


def _data_dir() -> Path:
    """优先用 server config 的 BOT_DATA_DIR（与 agent_router/prompts.py 同源）"""
    try:
        from config import BOT_DATA_DIR  # type: ignore

        return Path(BOT_DATA_DIR)
    except Exception:
        # 兜底：以本文件位置往上推 3 层 + data
        return Path(__file__).resolve().parents[3] / "data"


def _read_json(path: Path) -> dict | list | None:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


# ============================================================
# 三段预匹配
# ============================================================


def _build_artist_context(msg: str, data_dir: Path) -> str:
    """正则匹配 A1/B2 等画师编号 → 查本地 artist_strings.json"""
    matches = _ARTIST_PATTERN.findall(msg)
    if not matches:
        return ""

    artist_data = _read_json(data_dir / "artist_strings.json")
    if not isinstance(artist_data, dict):
        return ""

    lines = []
    for letter, number in matches:
        artist_id = f"{letter.upper()}{number}"
        rec = artist_data.get(artist_id)
        if isinstance(rec, dict) and rec.get("artist_string"):
            lines.append(f"{artist_id} → {rec['artist_string']}")

    if not lines:
        return ""
    return "## search_artist 结果\n" + "\n".join(lines)


def _build_oc_context(msg: str, data_dir: Path, max_items: int = 10) -> str:
    """OC 库字面 substring 匹配 + 按别名长度降序排"""
    oc_data = _read_json(data_dir / "oc_data.json")
    if not isinstance(oc_data, dict):
        return ""

    matched: list[tuple[str, list[str], str]] = []
    for en, data in oc_data.items():
        if not isinstance(data, dict):
            continue
        zh_name = data.get("zh_name") or ""
        zh_aliases = data.get("zh_aliases") or []
        check_list = [zh_name] + list(zh_aliases)
        en_stripped = re.sub(r"^(?i)oc_", "", en or "")
        if en_stripped and en_stripped not in check_list:
            check_list.append(en_stripped)

        hit_aliases = []
        for name in sorted([c for c in check_list if c], key=len, reverse=True):
            if name and name in msg:
                hit_aliases.append(name)
        if hit_aliases:
            tag_group = data.get("tag_group") or ""
            matched.append((en, hit_aliases, tag_group))

    if not matched:
        return ""

    ranked = sorted(matched, key=lambda x: sum(len(a) for a in x[1]), reverse=True)[:max_items]

    lines = []
    for _en, aliases, tag_group in ranked:
        cn_text = "、".join(aliases)
        tg = str(tag_group or "")
        if cn_text and tg:
            lines.append(f"{cn_text} → {tg}")
        elif cn_text:
            lines.append(cn_text)

    if not lines:
        return ""
    return "## search_character 结果（source=oc）\n" + "\n".join(lines)


def _build_role_context(msg: str, data_dir: Path, max_lines: int = 10) -> str:
    """
    通用角色库匹配。简化版：字面 substring（含小写）+ 按命中别名长度降序。
    Bot 的真实匹配带 NFKC 标准化 + bigram fuzzy，更宽松；CLI 这里收紧匹配规则，
    误判少但漏报多——用于调试目的足够。
    """
    raw = _read_json(data_dir / "role_tag_mapping.json")
    if not isinstance(raw, dict):
        return ""

    msg_lower = msg.lower()

    matched: dict[str, list[str]] = {}
    for en, info in raw.items():
        if not isinstance(info, dict):
            continue
        origin = info.get("origin_en")
        if origin in ("original_character", "oc"):
            continue
        if isinstance(en, str) and en.lower().startswith("oc_"):
            continue

        cn_list = info.get("role_zh") or []
        hits = []
        for cn in sorted([c for c in cn_list if c], key=len, reverse=True):
            if cn in msg or cn.lower() in msg_lower:
                hits.append(cn)
        # 英文 role_en 也试一下
        role_en = str(info.get("role_en") or "")
        if role_en and role_en.lower() in msg_lower:
            hits.append(role_en)

        if hits:
            matched[en] = hits

    if not matched:
        return ""

    ranked = sorted(matched.items(), key=lambda kv: max(len(a) for a in kv[1]), reverse=True)[
        :max_lines
    ]

    lines = []
    for en, _hits in ranked:
        info = raw.get(en) or {}
        cn_list = info.get("role_zh") or []
        origin_en = info.get("origin_en") or ""
        origin_zh_list = info.get("origin_zh") or []
        cn_text = "、".join([s for s in cn_list if s])
        origin_zh_text = "、".join([s for s in origin_zh_list if s]) if origin_zh_list else ""
        origin_part = origin_en + (
            f" ({origin_zh_text})" if origin_zh_text and origin_zh_text != origin_en else ""
        )
        lines.append(f"{en} → 中文: {cn_text} / 出处: {origin_part}")

    return "## search_character 结果（source=roleTag）\n" + "\n".join(lines)


# ============================================================
# 主入口
# ============================================================


def build_env_info_for_cli(msg: str) -> str:
    """
    根据用户原始消息构建 env_info 字符串，复刻 bot 端 preprocess_user_message 的输出。

    返回的字符串可以直接拼到 user prompt 末尾，模拟 router.py 把 env_info 注入用户输入的行为。

    Args:
        msg: 用户原始输入

    Returns:
        env_info 字符串（无内容时返回 ""）
    """
    if not msg:
        return ""

    data_dir = _data_dir()
    parts = [
        _build_artist_context(msg, data_dir),
        _build_oc_context(msg, data_dir, max_items=10),
        _build_role_context(msg, data_dir, max_lines=10),
    ]
    parts = [p for p in parts if p]

    if not parts:
        return ""

    return "[预查询资源]（chat_agent 已用对应工具预查过，结果如下可直接使用）\n\n" + "\n\n".join(
        parts
    )
