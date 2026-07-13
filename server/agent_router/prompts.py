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

import hashlib
import logging
import random
import re
import string
from collections.abc import Mapping
from dataclasses import dataclass
from functools import lru_cache
from importlib import resources
from pathlib import Path
from typing import Any, Protocol

import yaml

from . import resources as packaged_prompt_resources

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

_REQUIRED_CHAT_SECTIONS = ("persona", "workflow", "tools_hint", "reply_rules")
_REQUIRED_PLANNER_SECTIONS = (
    "mission",
    "input_format",
    "nsfw_authorization",
    "art_fundamentals",
    "art_principles",
    "character_rules",
    "art_advanced",
    "fixed_combos",
    "technique_combos",
    "art_craft",
    "reference_examples",
    "draw_output",
)


class _ReadableResource(Protocol):
    def is_file(self) -> bool: ...

    def read_text(self, encoding: str = "utf-8") -> str: ...


class PromptResourceError(RuntimeError):
    """The versioned Agent prompt is missing or violates its schema."""


@dataclass(frozen=True)
class AgentPromptBundle:
    """Validated prompt sections injected into one Agent request."""

    source: str
    chat_sections: Mapping[str, str]
    planner_sections: Mapping[str, str]
    lite_chat_sections: Mapping[str, str]

    def chat(self, name: str) -> str:
        return str(self.chat_sections.get(name) or "").strip()

    def planner(self, name: str) -> str:
        return str(self.planner_sections.get(name) or "").strip()

    def lite_chat(self, name: str = "system_prompt") -> str:
        return str(self.lite_chat_sections.get(name) or "").strip()


def _package_resource(filename: str) -> _ReadableResource:
    # Importing the resource package gives PyInstaller a static import edge.
    return resources.files(packaged_prompt_resources).joinpath(filename)


def packaged_prompts_path() -> Path:
    """Source-tree location expected by the desktop build preflight."""
    return Path(__file__).resolve().with_name("resources") / _PROMPTS_FILE


def _preset_file(preset: str | None) -> str:
    """按 preset 名解析到 yaml 文件名，未知 preset 走默认。"""
    if not preset:
        return _PROMPTS_FILE
    return _PRESET_FILES.get(preset, _PROMPTS_FILE)


_prompts_logger = logging.getLogger("agent_router.prompts")


@lru_cache(maxsize=16)
def _load_yaml_cached(source: str, digest: str, text: str) -> dict[str, Any]:
    """Cache by source and content hash so modified resources reload."""
    del digest
    data = _parse_and_validate_yaml(text, source)
    _prompts_logger.info(
        f"[prompts] reload {source} — "
        f"sections: chat={list((data.get('chat') or {}).keys())} "
        f"planner_count={len((data.get('planner') or {}).get('system_prompts') or [])}"
    )
    return data


def _format_missing_resource_error(filename: str, legacy_path: Path) -> str:
    return (
        f"Agent 提示词资源不存在: {filename}。已检查 legacy BOT_DATA_DIR 路径 "
        f"{legacy_path} 和包资源 {packaged_prompts_path()}。桌面构建前请将 Bot 的"
        f"生产文件放到 {packaged_prompts_path()}。"
    )


def _read_prompt_source(filename: str) -> tuple[str, str]:
    """Read legacy Bot data first, then the versioned package resource."""
    legacy_path = _data_dir() / filename
    if legacy_path.is_file():
        return str(legacy_path), legacy_path.read_text(encoding="utf-8")

    try:
        packaged = _package_resource(filename)
        if packaged.is_file():
            return (
                f"package:{__package__}.resources/{filename}",
                packaged.read_text(encoding="utf-8"),
            )
    except (FileNotFoundError, ModuleNotFoundError):
        pass

    raise PromptResourceError(_format_missing_resource_error(filename, legacy_path))


def _parse_yaml(text: str, source: str) -> dict[str, Any]:
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        raise PromptResourceError(f"Agent 提示词 YAML 无法解析 ({source}): {exc}") from exc
    if not isinstance(data, dict):
        raise PromptResourceError(f"Agent 提示词根节点必须是映射 ({source})")
    return data


def _non_empty_string(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _validate_prompt_data(data: dict[str, Any], source: str) -> None:
    errors: list[str] = []
    chat = data.get("chat")
    if not isinstance(chat, dict):
        errors.append("chat 必须是映射")
    else:
        missing = [
            name
            for name in _REQUIRED_CHAT_SECTIONS
            if not _non_empty_string(chat.get(name))
        ]
        if missing:
            errors.append(f"chat 缺少非空段: {', '.join(missing)}")

    lite_chat = data.get("lite_chat")
    if not isinstance(lite_chat, dict) or not _non_empty_string(lite_chat.get("system_prompt")):
        errors.append("lite_chat.system_prompt 必须是非空字符串")

    planner = data.get("planner")
    planner_prompts = planner.get("system_prompts") if isinstance(planner, dict) else None
    planner_names: set[str] = set()
    if not isinstance(planner_prompts, list) or not planner_prompts:
        errors.append("planner.system_prompts 必须是非空列表")
    else:
        for index, item in enumerate(planner_prompts):
            if not isinstance(item, dict):
                errors.append(f"planner.system_prompts[{index}] 必须是映射")
                continue
            if not _non_empty_string(item.get("content")):
                errors.append(f"planner.system_prompts[{index}].content 必须是非空字符串")
            name = item.get("name")
            if _non_empty_string(name):
                assert isinstance(name, str)
                if name in planner_names:
                    errors.append(f"planner.system_prompts 段名重复: {name}")
                planner_names.add(name)
        missing = [name for name in _REQUIRED_PLANNER_SECTIONS if name not in planner_names]
        if missing:
            errors.append(f"planner 缺少命名段: {', '.join(missing)}")

    if errors:
        raise PromptResourceError(f"Agent 提示词校验失败 ({source}): {'; '.join(errors)}")


def _parse_and_validate_yaml(text: str, source: str) -> dict[str, Any]:
    data = _parse_yaml(text, source)
    _validate_prompt_data(data, source)
    return data


def _load_yaml(filename: str) -> dict[str, Any]:
    source, text = _read_prompt_source(filename)
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    return _load_yaml_cached(source, digest, text)


def preflight_prompt_resource(path: str | Path | None = None) -> dict[str, Any]:
    """Validate the formal Agent prompt without raising (build/readiness API)."""
    source = str(Path(path).resolve()) if path is not None else _PROMPTS_FILE
    try:
        if path is None:
            resolved_source, text = _read_prompt_source(_PROMPTS_FILE)
        else:
            explicit = Path(path).resolve()
            if not explicit.is_file():
                raise PromptResourceError(
                    f"Agent 提示词资源不存在: {explicit}。请将 Bot 的生产 prompts.yaml 放到该路径。"
                )
            resolved_source, text = str(explicit), explicit.read_text(encoding="utf-8")
        data = _parse_and_validate_yaml(text, resolved_source)
        return {
            "ok": True,
            "file": _PROMPTS_FILE,
            "source": resolved_source,
            "chat_sections": list(data["chat"].keys()),
            "planner_prompts_count": len(data["planner"]["system_prompts"]),
        }
    except (OSError, UnicodeError, PromptResourceError) as exc:
        return {"ok": False, "file": _PROMPTS_FILE, "source": source, "error": str(exc)}


def _load_prompts(preset: str | None = None) -> dict:
    """加载合并预设。preset='anima' → prompts_anima.yaml；其他 / 空 → prompts.yaml。"""
    f = _preset_file(preset)
    _prompts_logger.debug(f"[prompts] _load_prompts preset={preset!r} -> {f}")
    return _load_yaml(f)


def _prompt_bundle_from_data(data: dict[str, Any], source: str) -> AgentPromptBundle:
    planner_items = (data.get("planner") or {}).get("system_prompts") or []
    planner_sections = {
        str(item["name"]): str(item["content"]).strip()
        for item in planner_items
        if isinstance(item, dict)
        and _non_empty_string(item.get("name"))
        and _non_empty_string(item.get("content"))
    }
    return AgentPromptBundle(
        source=source,
        chat_sections={
            str(name): str(content).strip()
            for name, content in (data.get("chat") or {}).items()
            if isinstance(content, str)
        },
        planner_sections=planner_sections,
        lite_chat_sections={
            str(name): str(content).strip()
            for name, content in (data.get("lite_chat") or {}).items()
            if isinstance(content, str)
        },
    )


def prompt_bundle_from_text(text: str, source: str = "injected") -> AgentPromptBundle:
    """Validate explicit prompt text and make a request-scoped bundle."""
    return _prompt_bundle_from_data(_parse_and_validate_yaml(text, source), source)


def load_prompt_bundle(preset: str | None = None) -> AgentPromptBundle:
    """Load a bundle through the legacy-first lookup used by the Bot."""
    filename = _preset_file(preset)
    source, text = _read_prompt_source(filename)
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    return _prompt_bundle_from_data(_load_yaml_cached(source, digest, text), source)


def load_packaged_prompt_bundle() -> AgentPromptBundle:
    """Load only the versioned desktop resource; never consult BOT_DATA_DIR."""
    try:
        packaged = _package_resource(_PROMPTS_FILE)
        if not packaged.is_file():
            raise PromptResourceError(
                f"Agent 提示词资源不存在: {packaged_prompts_path()}。"
                "请将 Bot 的生产 prompts.yaml 放到该路径。"
            )
        source = f"package:{__package__}.resources/{_PROMPTS_FILE}"
        text = packaged.read_text(encoding="utf-8")
    except PromptResourceError:
        raise
    except (FileNotFoundError, ModuleNotFoundError, OSError, UnicodeError) as exc:
        raise PromptResourceError(
            f"Agent 提示词资源无法读取: {packaged_prompts_path()}: {exc}"
        ) from exc
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    return _prompt_bundle_from_data(_load_yaml_cached(source, digest, text), source)


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
    """Legacy startup API backed by the strict Agent resource preflight."""
    result = preflight_prompt_resource()
    if result.get("ok"):
        result["chat_missing"] = []
    return {"prompts": result}
