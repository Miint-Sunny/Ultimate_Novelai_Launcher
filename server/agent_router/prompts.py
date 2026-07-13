"""
统一 prompts 加载器 —— 读取 chat / planner 提示词段。

文件布局（data/）:
    prompts.yaml                 # 唯一的合并预设（单 agent，tier 已移除）
    （prompts_assist.yaml / prompts_create.yaml 是合并前的两套预设，保留备查、loader 不再加载）
    （prompts_assist_claude.yaml 是更早期 Claude XML 专版，已弃用、保留备查）

架构说明：chat_agent 与 draw_planner_agent 已合并为单 agent；assist/create tier 已彻底移除。
chat 段（行为层）与 planner 段（知识层）拼成**同一个** agent 的 system prompt。

注意：旧 prompts_web.yaml 已下线，Web 端与 Bot 端统一用同一套合并预设。

文件 schema:
    chat:
      persona: |
        ...
      workflow: |
        ...
      tools_hint: |
        ...
      reply_rules: |
        ...
    planner:
      system_prompts:
        - role: system
          content: |
            ...

加载 API:
    load_chat_section(name)           - 读 chat.{name} 字符串段
    load_planner_system_prompts()     - 读 planner.system_prompts 列表，拼接为单段

兼容旧 API:
    load_static_system_prompts()
    dynamic_prison_break()
    get_prompts_raw()
    warm_load_all()
"""

from __future__ import annotations

import logging
import random
import re
import string
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml

# ============================================================
# 文件位置 + 加载
# ============================================================


def _data_dir() -> Path:
    try:
        from config import BOT_DATA_DIR  # type: ignore

        return Path(BOT_DATA_DIR)
    except Exception:
        return Path(__file__).resolve().parents[3] / "data"


# 合并后只有一份预设文件（tier 已移除）。
_PROMPTS_FILE = "prompts.yaml"

# 按 preset 名分发到对应文件。MODEL_CHOICES[*].prompt_preset 取这里的 key。
# anima 渠道用 prompts_anima.yaml（结构和 prompts.yaml 一致：chat / planner / lite_chat）。
_PRESET_FILES: dict[str, str] = {
    "default": _PROMPTS_FILE,
    "prompt2": "prompts2.yaml",
    "anima": "prompts_anima.yaml",
}


def _preset_file(preset: str | None) -> str:
    """按 preset 名解析到 yaml 文件名，未知 preset 走默认。"""
    if not preset:
        return _PROMPTS_FILE
    return _PRESET_FILES.get(preset, _PROMPTS_FILE)


_prompts_logger = logging.getLogger("agent_router.prompts")


@lru_cache(maxsize=16)
def _load_yaml_cached(filename: str, mtime: float) -> dict:
    """按 (filename, mtime) 缓存。mtime 变了 key 也变,文件改动自动失效。"""
    path = _data_dir() / filename
    if not path.exists():
        raise FileNotFoundError(f"prompts 配置文件不存在: {path}")
    text = path.read_text(encoding="utf-8")
    data = yaml.safe_load(text) or {}
    if not isinstance(data, dict):
        raise ValueError(f"{path} root 必须是 dict")
    _prompts_logger.info(
        f"[prompts] reload {filename} (mtime={mtime}) — "
        f"sections: chat={list((data.get('chat') or {}).keys())} "
        f"planner_count={len((data.get('planner') or {}).get('system_prompts') or [])}"
    )
    return data


def _load_yaml(filename: str) -> dict:
    """加载指定 YAML 文件,按 mtime 自动失效缓存。"""
    path = _data_dir() / filename
    try:
        mtime = path.stat().st_mtime
    except FileNotFoundError:
        mtime = 0.0
    return _load_yaml_cached(filename, mtime)


def _load_prompts(preset: str | None = None) -> dict:
    """加载合并预设。preset='anima' → prompts_anima.yaml；其他 / 空 → prompts.yaml。"""
    f = _preset_file(preset)
    _prompts_logger.debug(f"[prompts] _load_prompts preset={preset!r} -> {f}")
    return _load_yaml(f)


# ============================================================
# 模板变量替换
# ============================================================

_RANDOM_STRING_PAT = re.compile(r"\{random_string\}")


def _fresh_random_string() -> str:
    rng = random.SystemRandom()
    return "测试号: " + "".join(rng.choice(string.ascii_letters + string.digits) for _ in range(76))


def _substitute(content: str) -> str:
    if "{random_string}" in content:
        content = _RANDOM_STRING_PAT.sub(_fresh_random_string(), content)
    return content


def _flatten_prompts_list(items: list) -> str:
    """把 [{role, content}, ...] 列表拼成一段大字符串"""
    parts = []
    for item in items or []:
        if isinstance(item, dict):
            content = item.get("content", "")
            if isinstance(content, str):
                parts.append(content)
    return "\n\n".join(parts)


# ============================================================
# 新 API（推荐）
# ============================================================


def load_chat_section(name: str, preset: str | None = None) -> str:
    """
    读取合并预设 chat.{name} 段。
    name ∈ {"persona", "workflow", "tools_hint", "reply_rules"}
    preset: 渠道预设名（None / "default" / "anima" 等）；未识别走 prompts.yaml。
    """
    data = _load_prompts(preset)
    section = data.get("chat") or {}
    content = section.get(name, "")
    if not isinstance(content, str):
        return ""
    return content.strip()


def load_planner_system_prompts(preset: str | None = None) -> str:
    """读取合并预设 planner.system_prompts 列表，拼接为单段（旧 API，一锅端）。"""
    data = _load_prompts(preset)
    section = data.get("planner") or {}
    items = section.get("system_prompts") or []
    return _flatten_prompts_list(items)


def load_planner_section(name: str, preset: str | None = None) -> str:
    """
    按 name 取 planner.system_prompts 中的**单段** content（拆分 + U 型重复用）。
    preset 用法同 load_chat_section。
    """
    data = _load_prompts(preset)
    section = data.get("planner") or {}
    items = section.get("system_prompts") or []
    for item in items:
        if isinstance(item, dict) and item.get("name") == name:
            content = item.get("content", "")
            if isinstance(content, str):
                return content.strip()
    return ""


def load_prefilter_section(name: str = "system_prompt", preset: str | None = None) -> str:
    """读取 prefilter.{name} 段（旧 prefilter agent 用，已废弃，留作兼容）。"""
    data = _load_prompts(preset)
    section = data.get("prefilter") or {}
    content = section.get(name, "")
    if not isinstance(content, str):
        return ""
    return content.strip()


def load_lite_chat_section(name: str = "system_prompt", preset: str | None = None) -> str:
    """读取 lite_chat.{name} 段（前置 Lite agent：回复 + 意图 + 筛选 三合一）。"""
    data = _load_prompts(preset)
    section = data.get("lite_chat") or {}
    content = section.get(name, "")
    if not isinstance(content, str):
        return ""
    return content.strip()


# ============================================================
# 兼容旧 API
# ============================================================


def load_static_system_prompts() -> str:
    """旧 API 兼容：等价 load_planner_system_prompts()。"""
    return load_planner_system_prompts()


def dynamic_prison_break() -> str:
    """旧 API 兼容：无 prison_break，永远返回空。"""
    return ""


def get_prompts_raw() -> dict:
    """GET /api/agent/prompts endpoint 用——返回 {system_prompts, prison_break}。"""
    data = _load_prompts()
    section = data.get("planner") or {}
    return {
        "system_prompts": section.get("system_prompts") or [],
        "prison_break": [],
    }


def warm_load_all() -> dict:
    """启动期预加载并做基本校验"""
    status: dict[str, Any] = {}
    try:
        data = _load_yaml(_PROMPTS_FILE)
    except Exception as e:
        status["prompts"] = {"ok": False, "error": str(e)}
        return status

    chat = data.get("chat") or {}
    planner = data.get("planner") or {}
    planner_prompts = planner.get("system_prompts") or []
    status["prompts"] = {
        "ok": True,
        "file": _PROMPTS_FILE,
        "chat_sections": list(chat.keys()),
        "chat_missing": [
            n for n in ("persona", "workflow", "tools_hint", "reply_rules") if n not in chat
        ],
        "planner_prompts_count": len(planner_prompts),
    }
    return status
