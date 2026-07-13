"""
FastAPI 路由组 —— /api/agent/*

由 app.py 通过 `app.include_router(router)` 挂载（router 内部已声明 prefix="/api/agent"）。

Endpoints（合并版，简化后）:
    POST /api/agent/chat                 - Bot 端主对话入口（一次性 JSON 返回）
    POST /api/agent/web/generate-prompt  - Web 端 prompt 助手（SSE）
    GET  /api/agent/prompts/{tier}       - 取 prompts 文件
    GET  /api/agent/history/{user_key}   - 读取历史
    DEL  /api/agent/history/{user_key}   - 清空历史
    GET  /api/agent/health               - 探测各 tier 模型可用性

旧版 /draw-plan / /vision/describe 已下线（功能合并进 chat_agent）。
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import re
import time
from random import SystemRandom
from typing import Annotated

import httpx
from fastapi import APIRouter, Depends, HTTPException, Path, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .access import (
    AgentAccess,
    authorize_history_key,
    authorize_paid_agent_access,
    bind_chat_identity,
    require_agent_access,
    require_agent_admin,
    require_paid_agent_access,
)
from .deps import AgentDeps
from .history_adapter import (
    _load_user_history,
    append_to_history,
    clear_history,
    load_history_for_agent,
)
from .llm import BinaryContent
from .model_provider import get_model, get_model_settings
from .prompts import get_prompts_raw, warm_load_all
from .provider_errors import humanize_provider_error, is_google_prohibited_content_error
from .schemas import (
    AgentResult,
    ChatOutput,
    ChatRequest,
    ChatResponse,
    HealthResponse,
    HealthTierStatus,
    HistoryMessage,
    HistoryResponse,
    PromptsResponse,
    SseEvent,
    WebPromptRequest,
)
from .sse import SseChannel

# 注：vision/draw-plan / web_prompt 子模块已下线。
# - draw_planner_agent 已与 chat_agent 合并：绘图参数由 chat_agent 直接写进 draw_specs
# - web_prompt_agent 已删除：Web 端现在与 Bot 端共用 chat_agent + 合并预设（prompts.yaml）
#   web_generate_prompt endpoint 内部跑 chat_agent，输出再转成前端期望的 AgentResult 格式

logger = logging.getLogger("agent_router")
_RANDOM = SystemRandom()

router = APIRouter(
    prefix="/api/agent",
    tags=["agent"],
    # Future Agent endpoints inherit the same fail-closed identity boundary even
    # if a handler forgets to request the resolved principal explicitly.
    dependencies=[Depends(require_agent_access)],
)

_WEB_ARTIST_ID_RE = re.compile(r"(?<![A-Za-z])([A-Za-z])(\d{1,2})(?!\d)", re.IGNORECASE)


class ModelSwitchRequest(BaseModel):
    target: str | None = None
    current: str | None = None


# ============================================================
# 共享 httpx.AsyncClient（agent tools 调本机 API 时复用连接池）
# ============================================================

_shared_http_client: httpx.AsyncClient | None = None


def _get_http_client() -> httpx.AsyncClient:
    global _shared_http_client
    if _shared_http_client is None or _shared_http_client.is_closed:
        _shared_http_client = httpx.AsyncClient(
            timeout=httpx.Timeout(30.0),
            limits=httpx.Limits(max_connections=50, max_keepalive_connections=20),
        )
    return _shared_http_client


def _use_pure_planner() -> bool:
    """
    激进测试开关：env CPA_USE_PURE_PLANNER=true 时所有请求改走 pure_planner_agent。
    pure_planner 没有 chat 层任务（无 reply_text / 无 should_draw 决策），
    只产 DrawSpec，用来验证"嵌套深度 + 任务分离"对约束力的影响。
    """
    import os

    return os.environ.get("CPA_USE_PURE_PLANNER", "").strip().lower() in ("1", "true", "yes", "on")


def _build_user_key(req: ChatRequest) -> str:
    """
    Build the server-side history key.

    Private chats are persisted by user. Group chats are intentionally still
    memory-only, but their context is separated per user inside the group so one
    member's drawing/chat context does not leak into another member's turn.
    """
    if req.user_key:
        return req.user_key
    platform = req.platform.lower()
    if req.group_id:
        return f"{platform}_g_{req.group_id}_u_{req.user_id}"
    return f"{platform}_p_{req.user_id}"


def _web_text_hit(text: str, value: object) -> bool:
    value_s = str(value or "").strip()
    return bool(value_s) and (value_s in text or value_s.lower() in text.lower())


def _compact_artist_match_text(text: str) -> tuple[str, list[int]]:
    compact: list[str] = []
    index_map: list[int] = []
    for idx, ch in enumerate(text):
        if ch.isspace():
            continue
        compact.append("，" if ch == "," else ch.lower())
        index_map.append(idx)
    return "".join(compact), index_map


def _split_artist_prompt_tags(text: str) -> list[str]:
    tags: list[str] = []
    for raw in re.split(r"[,，]", text or ""):
        tag = raw.strip().lower()
        if not tag:
            continue
        tag = re.sub(r"^-?\d+(?:\.\d+)?::(.+?)::$", r"\1", tag)
        tag = tag.strip("{}[] ")
        if tag:
            tags.append(tag)
    return tags


def _find_artist_prompt_span(positive: str, prompt: str) -> tuple[int, int] | None:
    """Find a prompt span while tolerating harmless spacing/comma differences."""
    if not positive or not prompt:
        return None

    start = positive.find(prompt)
    if start >= 0:
        return start, start + len(prompt)

    compact_positive, index_map = _compact_artist_match_text(positive)
    compact_prompt, _ = _compact_artist_match_text(prompt)
    compact_start = compact_positive.find(compact_prompt)
    if compact_start >= 0 and compact_prompt:
        compact_end = compact_start + len(compact_prompt) - 1
        return index_map[compact_start], index_map[compact_end] + 1

    prompt_tags = _split_artist_prompt_tags(prompt)
    if not prompt_tags:
        return None
    positive_tags = list(re.finditer(r"[^,，]+", positive))
    normalized_positive: list[str] = []
    for m in positive_tags:
        tags = _split_artist_prompt_tags(m.group(0))
        normalized_positive.append(tags[0] if tags else "")
    for i in range(0, len(normalized_positive) - len(prompt_tags) + 1):
        if normalized_positive[i : i + len(prompt_tags)] == prompt_tags:
            return positive_tags[i].start(), positive_tags[i + len(prompt_tags) - 1].end()
    return None


def _wrap_web_artist_markers(positive: str, deps: AgentDeps) -> str:
    """Wrap known Web artist prompts for the frontend chip renderer only."""
    if deps.scene != "web" or not positive or "<<" in positive:
        return positive

    artists: list[tuple[str, str]] = []
    seen: set[str] = set()
    for item in deps.web_artists or []:
        if not isinstance(item, dict):
            continue
        prompt = str(item.get("prompt") or item.get("artist_string") or "").strip()
        name = str(item.get("name") or item.get("id") or "").strip() or "artist"
        if not prompt or prompt in seen:
            continue
        seen.add(prompt)
        artists.append((name, prompt))

    replacements: list[tuple[int, int, str]] = []
    occupied: list[tuple[int, int]] = []
    for name, prompt in sorted(artists, key=lambda pair: len(pair[1]), reverse=True):
        span = _find_artist_prompt_span(positive, prompt)
        if span:
            start, end = span
            if any(start < used_end and end > used_start for used_start, used_end in occupied):
                continue
            occupied.append((start, end))
            replacements.append((start, end, f"<<artist:{name}:{prompt}>>"))
    for start, end, marker in sorted(replacements, key=lambda item: item[0], reverse=True):
        positive = positive[:start] + marker + positive[end:]
    return positive


def _build_current_prompt_context(req: WebPromptRequest) -> str:
    """Build Web current prompt context for edit-on-existing requests."""
    has_current = (
        bool((req.current_positive or "").strip())
        or bool((req.current_negative or "").strip())
        or bool(req.current_characters)
    )
    if not has_current:
        return ""

    env_lines: list[str] = []
    env_lines.append("[当前画面提示词]")
    env_lines.append(f"全局正向 (positive): {req.current_positive or '(空)'}")
    env_lines.append(f"全局反向 (negative): {req.current_negative or '(空)'}")
    if req.current_characters:
        env_lines.append("分角色:")
        for i, c in enumerate(req.current_characters, 1):
            if not isinstance(c, dict):
                continue
            name = (c.get("name") or f"角色{i}").strip() or f"角色{i}"
            pos = (c.get("positive") or "").strip()
            neg = (c.get("negative") or "").strip()
            line = f"  - {name}: {pos or '(空)'}"
            if neg:
                line += f"  [负向: {neg}]"
            env_lines.append(line)
    env_lines.append(
        "如果用户要求基于这些现有提示词做修改/补充/微调/换装/换风格，"
        "请以它们为基础，在 draw_specs 中输出修改后的**完整** positive / negative / characters，"
        "不要从零重写、不要遗漏原有的关键 tag。"
        "如果用户的请求与现有提示词无关（全新主题），可以忽略此段。"
    )
    return "\n".join(env_lines)


async def _build_web_prequery_context(req: WebPromptRequest, deps: AgentDeps) -> str:
    """
    Build bot-style prequery candidates for Web.

    Raw candidates are only shown to chat_agent. Planner still receives the
    chat-filtered selected_resources, plus the explicit current prompt context.
    """
    text = (req.user_request or "").strip()
    if not text:
        return ""

    try:
        from .tools.knowledge import _get_role_mapping, _load_artists_for_deps, _load_ocs_for_deps
    except Exception:
        return ""

    sections: list[str] = []

    try:
        all_artists = _load_artists_for_deps(deps)
        lines: list[str] = []
        seen_ids: set[str] = set()
        for letter, number in _WEB_ARTIST_ID_RE.findall(text):
            artist_id = f"{letter.upper()}{number}"
            for artist in all_artists:
                aid = str(artist.get("id") or "").strip()
                name = str(artist.get("name") or "").strip()
                prompt = str(artist.get("artist_string") or "").strip()
                if not prompt:
                    continue
                if aid.upper() == artist_id or name.upper() == artist_id:
                    marker = aid.upper() or name.upper()
                    if marker in seen_ids:
                        continue
                    seen_ids.add(marker)
                    lines.append(f"{aid or name} → {prompt}")
                    break
        if "随机画师串" in text and all_artists:
            candidates = [a for a in all_artists if str(a.get("artist_string") or "").strip()]
            if candidates:
                artist = _RANDOM.choice(candidates)
                aid = str(artist.get("id") or artist.get("name") or "").strip()
                prompt = str(artist.get("artist_string") or "").strip()
                marker = aid.upper()
                if prompt and marker not in seen_ids:
                    lines.append(f"{aid} → {prompt}")
        if lines:
            sections.append("## search_artist 结果\n" + "\n".join(lines[:10]))
    except Exception as e:
        logger.debug(f"Web artist prequery failed: {e}")

    try:
        oc_hits: list[tuple[int, str]] = []
        for oc in _load_ocs_for_deps(deps):
            en_name = str(oc.get("en_name") or "").strip()
            zh_name = str(oc.get("zh_name") or "").strip()
            aliases = [str(a).strip() for a in (oc.get("zh_aliases") or []) if str(a).strip()]
            tag_group = str(oc.get("tag_group") or "").strip()
            names = [n for n in [zh_name, *aliases, en_name] if n]
            hits = [n for n in names if _web_text_hit(text, n)]
            if not hits:
                continue
            label = "、".join(dict.fromkeys(hits))
            line = f"{label} → {tag_group}" if tag_group else label
            oc_hits.append((max(len(h) for h in hits), line))
        if oc_hits:
            ranked = [line for _, line in sorted(oc_hits, key=lambda x: x[0], reverse=True)[:10]]
            sections.append("## search_character 结果（source=oc）\n" + "\n".join(ranked))
    except Exception as e:
        logger.debug(f"Web OC prequery failed: {e}")

    try:
        mapping = await _get_role_mapping(deps)
        role_hits: list[tuple[int, str]] = []
        for key, info in (mapping or {}).items():
            if not isinstance(info, dict):
                continue
            role_en = str(info.get("role_en") or key or "").strip()
            role_zh = [str(z).strip() for z in (info.get("role_zh") or []) if str(z).strip()]
            names = [n for n in [*role_zh, role_en, str(key)] if n]
            hits = [n for n in names if _web_text_hit(text, n)]
            if not hits:
                continue
            origin_en = str(info.get("origin_en") or "").strip()
            origin_zh = [str(z).strip() for z in (info.get("origin_zh") or []) if str(z).strip()]
            origin_zh_text = "、".join(origin_zh)
            origin_part = origin_en
            if origin_zh_text and origin_zh_text != origin_en:
                origin_part += f" ({origin_zh_text})" if origin_part else origin_zh_text
            role_hits.append(
                (
                    max(len(h) for h in hits),
                    f"{role_en or key} → 中文: {'、'.join(role_zh)} / 出处: {origin_part}",
                )
            )
        if role_hits:
            ranked = [line for _, line in sorted(role_hits, key=lambda x: x[0], reverse=True)[:10]]
            sections.append("## search_character 结果（source=roleTag）\n" + "\n".join(ranked))
    except Exception as e:
        logger.debug(f"Web roleTag prequery failed: {e}")

    if not sections:
        return ""
    return "[预查询资源]（chat_agent 已用对应工具预查过，结果如下可直接使用）\n\n" + "\n\n".join(
        sections
    )


# ============================================================
# chat_agent 智能重试包装
# ============================================================

CHAT_MAX_ATTEMPTS = 3


def _has_binary_content(parts: list) -> bool:
    """检查 parts 列表里是否含图片字节"""
    return any(isinstance(p, BinaryContent) for p in parts)


def _strip_images(parts: list) -> list:
    """剥掉所有 BinaryContent，附加显式重试提示"""
    text_only = [p for p in parts if not isinstance(p, BinaryContent)]
    reminder = "【重试中：上次可能因上下文过大失败，已剥去图片，请基于剩余文本简洁回复】"
    if text_only:
        text_only.append(reminder)
    else:
        text_only = ["（图片处理失败，请重新文字描述）", reminder]
    return text_only


def _debug_serialize_part(part) -> dict:
    if isinstance(part, str):
        return {"type": "text", "text": part}
    if isinstance(part, BinaryContent):
        data = part.data or b""
        return {
            "type": "image",
            "media_type": part.media_type,
            "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest() if data else "",
        }
    return {"type": type(part).__name__, "repr": repr(part)}


def _debug_serialize_parts(parts: list) -> list[dict]:
    return [_debug_serialize_part(p) for p in parts]


def _debug_serialize_model_messages(
    messages: list,
    *,
    system_prompt_parts: list | None = None,
) -> list[dict]:
    """
    把 PydanticAI 的 ModelMessage 列表序列化成 dict。

    PydanticAI 1.x 在带 message_history 时不把 SystemPromptPart 放进 messages——
    传入 system_prompt_parts（来自 agent.system_prompt_parts() 公共 API）会被作为
    虚拟 system message 拼到最前面，**只在 messages 第一条不含 SystemPromptPart 时拼**，
    避免重复。
    """
    from .llm.messages import (
        ModelRequest,
        ModelResponse,
        SystemPromptPart,
        TextPart,
        UserPromptPart,
    )

    out: list[dict] = []

    if system_prompt_parts:
        first_has_system = False
        if messages:
            first = messages[0]
            if isinstance(first, ModelRequest):
                first_has_system = any(
                    isinstance(p, SystemPromptPart) for p in getattr(first, "parts", []) or []
                )
        if not first_has_system:
            sys_parts_out: list[dict] = []
            for p in system_prompt_parts:
                sys_parts_out.append(
                    {
                        "type": "system_prompt",
                        "text": getattr(p, "content", "") or "",
                    }
                )
            if sys_parts_out:
                out.append({"role": "system", "parts": sys_parts_out})

    for msg in messages:
        if isinstance(msg, ModelRequest):
            role = "user"
        elif isinstance(msg, ModelResponse):
            role = "assistant"
        else:
            role = type(msg).__name__
        parts_out: list[dict] = []
        for p in getattr(msg, "parts", []) or []:
            if isinstance(p, SystemPromptPart):
                parts_out.append({"type": "system_prompt", "text": getattr(p, "content", "") or ""})
            elif isinstance(p, UserPromptPart):
                content = p.content
                if isinstance(content, str):
                    parts_out.append({"type": "text", "text": content})
                elif isinstance(content, list):
                    parts_out.extend(_debug_serialize_part(x) for x in content)
                else:
                    parts_out.append({"type": type(content).__name__, "repr": repr(content)})
            elif isinstance(p, TextPart):
                parts_out.append({"type": "text", "text": getattr(p, "content", "") or ""})
            else:
                item = {"type": type(p).__name__}
                content = getattr(p, "content", None)
                if content is not None:
                    item["content"] = str(content)
                tool_name = getattr(p, "tool_name", None)
                if tool_name:
                    item["tool_name"] = tool_name
                parts_out.append(item)
        out.append({"role": role, "parts": parts_out})
    return out


def _record_agent_messages(
    deps: AgentDeps,
    *,
    model_role: str,
    messages: list,
    system_prompt_parts: list | None = None,
    extra: dict | None = None,
) -> None:
    """
    把 agent.run() 实际产生的 ModelMessage 序列原样写进 debug_contexts。
    messages 通常是 result.all_messages()——真实提交给 LLM 的完整内容
    （含 SystemPromptPart / UserPromptPart / TextPart / ToolCallPart / ToolReturnPart）。

    PydanticAI 1.x 在带 message_history 时不把 SystemPromptPart 放进 messages，
    所以同时传 system_prompt_parts（来自 agent.system_prompt_parts(deps=...) 公共 API）
    才能在序列化时把真实预设拼到最前面。

    extra 用来挂额外结构化字段（如 output_draw_spec、attempt 标签）。
    """
    if not deps.debug_context:
        return
    entry: dict = {
        "model_role": model_role,
        "messages": _debug_serialize_model_messages(
            messages or [],
            system_prompt_parts=system_prompt_parts,
        ),
    }
    if extra:
        entry.update(extra)
    deps.debug_contexts.append(entry)


async def _resolve_system_prompt_parts(agent, deps) -> list:
    """
    安全地调一次 agent.system_prompt_parts(deps=...) 拿真实预设。
    失败时返回 []——不影响主流程，只是日志少一段 system_prompt。
    """
    try:
        parts = await agent.system_prompt_parts(deps=deps)
        return list(parts) if parts else []
    except Exception:
        return []


def _is_useful_output(output) -> bool:
    """判断 ChatOutput 是否有效——非空 reply_text 或者有绘图触发"""
    if output is None:
        return False
    if (output.reply_text or "").strip():
        return True
    if output.draw_spec:
        return True
    if output.should_draw:
        return True
    return False


def _history_user_text_from_parts(parts: list) -> str:
    texts: list[str] = []
    for part in parts:
        if not isinstance(part, str):
            continue
        if part.lstrip().startswith("[环境信息]"):
            continue
        texts.append(part.strip())
    return "\n".join(t for t in texts if t).strip()


# ============================================================
# Prefilter / B3 / carryover —— 预匹配资料的多轮管理
# ============================================================
# 工作流（每个 user_key 一份）：
#   轮 N 开始：
#     carryover = _LAST_USED_RESOURCES.get(user_key, "")  # 上一轮 B3 提炼
#     raw = preprocess 产物（Bot 端塞进 ChatRequest.environment_info）
#     merged = _merge_resources(raw, carryover)
#     refined = run_prefilter(user_text, merged)  # 小模型语义筛
#     替换 parts 里的 [预查询资源] 段为 refined
#   轮 N 结束：
#     used = _extract_used_resources(ctx.messages, draw_specs, refined)
#     _LAST_USED_RESOURCES[user_key] = used
#
# carryover 不进 history（history 纯语义）。重启后 dict 清空：最差第一轮多筛一次，可接受。

_LAST_USED_RESOURCES: dict[str, str] = {}


_PREQUERY_HEADER_RE = re.compile(r"^\[预查询资源\]")
_ENV_INFO_HEADER_RE = re.compile(r"^\[环境信息\]")


def _split_prequery_from_env(env_text: str) -> tuple[str, str]:
    """
    把 environment_info 拆成 (prequery_block, other_sections)。

    Bot preprocess 产出形如：
        [预查询资源]（...说明...）

        ## search_artist 结果
        A1 → ...
        ## search_character 结果
        芙兰 → ...

        [回复图片 stego 元数据]
        ...

    返回:
        prequery_block: 仅 [预查询资源] 段（包括内部所有 ## 子段，不含 [回复图片...] 等）
        other_sections: 余下段（[上次...] 之类，原样保留）
    """
    if not env_text or not env_text.strip():
        return "", ""
    lines = env_text.split("\n")
    in_prequery = False
    prequery_lines: list[str] = []
    other_lines: list[str] = []
    for line in lines:
        stripped = line.lstrip()
        if stripped.startswith("[预查询资源]"):
            in_prequery = True
            continue
        # 任何新 [xxx] 段开头都终结 prequery
        if in_prequery and stripped.startswith("[") and "]" in stripped:
            in_prequery = False
            other_lines.append(line)
            continue
        if in_prequery:
            prequery_lines.append(line)
        else:
            other_lines.append(line)
    return "\n".join(prequery_lines).strip(), "\n".join(other_lines).strip()


def _count_prequery_sections(merged: str) -> dict[str, int]:
    """
    扫合并后的预匹配文本，按 section 类目数候选行数。

    识别 Bot preprocess 写出的三类 ## 标题：
        ## search_artist 结果                       → artist
        ## search_character 结果（source=roleTag）  → roleTag
        ## search_character 结果（source=oc）       → oc

    返回 {'artist': N, 'roleTag': N, 'oc': N}。
    无标题或未知标题段下的行不计入（应为空，因为 Bot preprocess 总会带标题）。
    """
    counts = {"artist": 0, "roleTag": 0, "oc": 0}
    if not merged or not merged.strip():
        return counts
    current: str | None = None
    for line in merged.split("\n"):
        s = line.lstrip()
        if not s:
            continue
        if s.startswith("## search_artist"):
            current = "artist"
            continue
        if s.startswith("## search_character"):
            if "source=roleTag" in s:
                current = "roleTag"
            elif "source=oc" in s:
                current = "oc"
            else:
                current = None
            continue
        if s.startswith("##"):
            current = None
            continue
        if current is not None:
            counts[current] += 1
    return counts


def _merge_resources(raw: str, carryover: str) -> str:
    """
    按行简单去重合并预查询资源。
    保持出现顺序（carryover 在前，raw 在后），完全相同的行只留一次。
    """
    if not (raw or carryover):
        return ""
    seen: dict[str, None] = {}
    for src in (carryover, raw):
        if not src:
            continue
        for line in src.split("\n"):
            stripped = line.rstrip()
            if stripped:
                seen[stripped] = None
    return "\n".join(seen.keys())


def _build_prequery_env_block(refined: str) -> str:
    """把 prefilter 输出包装成 [预查询资源] 段（供塞回 user parts）。"""
    refined = (refined or "").strip()
    if not refined:
        return ""
    return f"[预查询资源]\n{refined}"


def _rebuild_env_info(prequery_block: str, other_sections: str) -> str:
    """把 prequery + 其他段拼回完整 environment_info 文本。"""
    parts = [p for p in (prequery_block.strip(), other_sections.strip()) if p]
    return "\n\n".join(parts)


def _dewrap_tag_text(text: str) -> str:
    """剥 NovelAI 权重壳，便于 substring 匹配。"""
    if not text:
        return ""
    # 1.5::xxx:: → xxx（非贪婪，允许内部有冒号如 artist:wlop）；{tag} → tag；[tag] → tag
    text = re.sub(r"\d+(?:\.\d+)?::(.+?)::", r"\1", text)
    text = re.sub(r"[\{\}\[\]]", "", text)
    return text


def _draw_specs_haystack(draw_specs: list[dict]) -> str:
    """把 draw_specs 所有 positive 拼成一个去权重的小写大字符串，供包含匹配。"""
    chunks: list[str] = []
    for spec in draw_specs or []:
        if not isinstance(spec, dict):
            continue
        chunks.append(str(spec.get("positive") or ""))
        for ch in spec.get("characters") or []:
            if isinstance(ch, dict):
                chunks.append(str(ch.get("positive") or ""))
    return _dewrap_tag_text(" ".join(chunks)).lower()


_ARROW_RE = re.compile(r"(?:→|->|=>|:\s)")
_ARTIST_LINE_RE = re.compile(r"^\s*([A-Za-z]\d+|[A-Za-z0-9_-]{1,32})\s*(?:→|->|=>)\s*(.*)$")


def _clean_artist_prompt_text(prompt: str) -> str:
    prompt = (prompt or "").strip()
    prompt = re.sub(r"\s*\n\s*", " ", prompt)
    prompt = re.sub(r",\s*[,，]\s*", ", ", prompt)
    prompt = re.sub(r"^[,\s，]+", "", prompt)
    prompt = re.sub(r"[\s,，]+$", "", prompt)
    return prompt


def _artist_prompt_identity(prompt: str) -> str:
    text = _dewrap_tag_text(prompt or "").lower()
    match = re.search(r"(?:artist:|by_)[a-z0-9_().:-]+", text)
    if match:
        return match.group(0).strip(" ,，:")
    tags = _split_artist_prompt_tags(text)
    return tags[0] if tags else ""


def _extract_artist_resources(prequery_output: str) -> list[tuple[str, str]]:
    """Extract complete artist strings from search_artist sections, including continuation lines."""
    resources: list[tuple[str, str]] = []
    in_artist_section = False
    current_name = ""
    current_parts: list[str] = []

    def _flush() -> None:
        nonlocal current_name, current_parts
        prompt = _clean_artist_prompt_text("\n".join(current_parts))
        if current_name and prompt:
            resources.append((current_name, prompt))
        current_name = ""
        current_parts = []

    for raw_line in (prequery_output or "").splitlines():
        line = raw_line.rstrip()
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("##"):
            _flush()
            in_artist_section = "search_artist" in stripped
            continue
        if not in_artist_section:
            continue
        match = _ARTIST_LINE_RE.match(line)
        if match:
            _flush()
            current_name = match.group(1).strip()
            current_parts = [match.group(2).strip()]
        elif current_name:
            current_parts.append(stripped)

    _flush()
    return resources


def _complete_artist_prompts_in_positive(
    positive: str, artist_resources: list[tuple[str, str]]
) -> str:
    if not positive or not artist_resources:
        return positive

    completed_identities: set[str] = set()
    for _name, prompt in sorted(artist_resources, key=lambda item: len(item[1]), reverse=True):
        prompt = _clean_artist_prompt_text(prompt)
        if not prompt:
            continue
        identity = _artist_prompt_identity(prompt)
        if not identity:
            continue
        if identity in completed_identities:
            continue
        if _find_artist_prompt_span(positive, prompt):
            completed_identities.add(identity)
            continue
        span = _find_artist_prompt_span(positive, identity)
        if not span:
            continue
        start, end = span
        positive = positive[:start] + prompt + positive[end:]
        completed_identities.add(identity)
    return positive


def _complete_artist_prompts_in_draw_specs(
    draw_specs: list[dict], prequery_output: str
) -> list[dict]:
    artist_resources = _extract_artist_resources(prequery_output)
    if not draw_specs or not artist_resources:
        return draw_specs

    for spec in draw_specs:
        if not isinstance(spec, dict):
            continue
        spec["positive"] = _complete_artist_prompts_in_positive(
            str(spec.get("positive") or ""),
            artist_resources,
        )
    return draw_specs


_CHARACTER_SPLIT_KEYWORDS = (
    "分角色",
    "角色提示词",
    "分区提示",
    "分区",
    "char",
    "character prompt",
    "character prompts",
)


def _wants_character_prompts(user_text: str) -> bool:
    text = (user_text or "").lower()
    return any(keyword in text for keyword in _CHARACTER_SPLIT_KEYWORDS)


def _extract_character_resources(prequery_output: str) -> list[tuple[str, str]]:
    resources: list[tuple[str, str]] = []
    in_character_section = False

    for raw_line in (prequery_output or "").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("##"):
            in_character_section = "search_character" in line
            continue
        if not in_character_section:
            continue

        match = _ARROW_RE.search(line)
        if not match:
            continue

        left = line[: match.start()].strip()
        right = line[match.end() :].strip()
        source_tag = right.split(",", 1)[0].strip()

        if "source=roleTag" in line or re.match(r"^[a-z0-9_().-]+$", left, re.IGNORECASE):
            tag = left
            if tag and tag not in {"中文", "出处"}:
                resources.append((tag, tag))
            continue

        if source_tag:
            resources.append((left or source_tag, source_tag))

    seen: set[str] = set()
    deduped: list[tuple[str, str]] = []
    for name, tag in resources:
        key = tag.lower()
        if key in seen:
            continue
        seen.add(key)
        deduped.append((name, tag))
    return deduped


def _remove_global_character_tags(positive: str, character_tags: list[str]) -> str:
    if not positive or not character_tags:
        return positive
    remove = {tag.strip().lower() for tag in character_tags if tag.strip()}
    kept: list[str] = []
    for raw in re.split(r"([,，])", positive):
        if raw in {",", "，"}:
            continue
        tag = raw.strip()
        if not tag:
            continue
        if _dewrap_tag_text(tag).strip().lower() in remove:
            continue
        kept.append(tag)
    return ", ".join(kept)


def _ensure_requested_character_prompts(
    draw_specs: list[dict],
    *,
    user_text: str,
    prequery_output: str,
) -> list[dict]:
    if not draw_specs or not _wants_character_prompts(user_text):
        return draw_specs

    resources = _extract_character_resources(prequery_output)
    if len(resources) < 2:
        return draw_specs

    for spec in draw_specs:
        if not isinstance(spec, dict):
            continue
        chars = spec.get("characters")
        if isinstance(chars, list) and any(
            isinstance(c, dict) and str(c.get("positive") or "").strip() for c in chars
        ):
            continue

        selected = resources[:6]
        spec["characters"] = [
            {"name": name or f"char{i}", "positive": tag, "negative": ""}
            for i, (name, tag) in enumerate(selected, 1)
            if tag
        ]
        spec["positive"] = _remove_global_character_tags(
            str(spec.get("positive") or ""),
            [tag for _name, tag in selected],
        )
    return draw_specs


def _merge_characters_into_positive(draw_specs: list[dict]) -> list[dict]:
    """Backends without character channels must not lose DrawSpec.characters."""
    for spec in draw_specs or []:
        if not isinstance(spec, dict):
            continue
        chars = spec.get("characters")
        if not isinstance(chars, list) or not chars:
            spec["characters"] = []
            continue

        positive_parts = [str(spec.get("positive") or "").strip()]
        negative_parts = [str(spec.get("negative") or "").strip()]
        for char in chars:
            if not isinstance(char, dict):
                continue
            name = str(char.get("name") or "").strip()
            pos = str(char.get("positive") or "").strip()
            neg = str(char.get("negative") or "").strip()
            if pos:
                if name and name.lower() not in pos.lower():
                    positive_parts.append(f"{name}, {pos}")
                else:
                    positive_parts.append(pos)
            if neg:
                negative_parts.append(neg)

        spec["positive"] = ", ".join(part for part in positive_parts if part)
        spec["negative"] = ", ".join(part for part in negative_parts if part)
        spec["characters"] = []
    return draw_specs


def _line_keys_for_match(line: str) -> list[str]:
    """
    从一行候选资料抽出关键 key（用于匹配 draw_specs.positive 是否包含它）。

    候选行典型形如：
        A1 → artist:ciloranko, masterpiece
        芙兰 → flandre_scarlet, touhou
    取 `→` 后的第一个 tag（去 `artist:` / `by_` 前缀、剥权重壳）作为主 key。
    这样通用 tag（masterpiece / touhou / 1girl）不会被当成"命中依据"。
    """
    if not line.strip():
        return []
    m = _ARROW_RE.search(line)
    tail = line[m.end() :].strip() if m else line.strip()
    first_tag = tail.split(",", 1)[0].strip()
    if not first_tag:
        return []
    # 剥 artist: / by_ 前缀
    low = first_tag.lower()
    for prefix in ("artist:", "by_"):
        if low.startswith(prefix):
            first_tag = first_tag[len(prefix) :]
            low = first_tag.lower()
    # 剥权重壳
    first_tag = _dewrap_tag_text(first_tag).strip()
    if not first_tag or len(first_tag) < 3:
        return []
    return [first_tag.lower()]


def _extract_used_resources(
    *,
    ctx_messages: list,
    draw_specs: list[dict],
    prefilter_output: str,
) -> str:
    """
    B3 提炼：从 (prefilter_output + ctx.messages 里的 ToolReturnPart) 列出的候选条目中，
    挑出"被实际写进 draw_specs"的那些，按原格式输出。

    输出和 raw / prefilter_output 同格式（## 标题 + 行条目），下一轮可直接做 merge dedup。
    无命中返回空字符串。
    """
    if not draw_specs:
        return ""
    haystack = _draw_specs_haystack(draw_specs)
    if not haystack:
        return ""

    # 收集候选条目：(section_title, line)，保持出现顺序
    candidates: list[tuple[str, str]] = []

    def _scan(text: str) -> None:
        if not text or not text.strip():
            return
        current_section = ""
        for line in text.split("\n"):
            s = line.rstrip()
            if not s.strip():
                continue
            if s.lstrip().startswith("##"):
                current_section = s.lstrip()
                continue
            candidates.append((current_section, s))

    _scan(prefilter_output)

    # 扫 ctx.messages 里 search_* 工具返回（合并 agent 自调的 search_character/search_artist 等）
    try:
        from .llm.messages import ModelRequest, ToolReturnPart

        for msg in ctx_messages or []:
            if not isinstance(msg, ModelRequest):
                continue
            for part in getattr(msg, "parts", []):
                if not isinstance(part, ToolReturnPart):
                    continue
                tool_name = getattr(part, "tool_name", "") or ""
                if not tool_name.startswith("search_"):
                    continue
                content = getattr(part, "content", None)
                # ToolReturnPart.content 是结构化（list[Character]/list[Artist] 等）
                # 转成 "name → tag 串" 行格式
                if isinstance(content, list):
                    section_title = f"## {tool_name} 结果"
                    for item in content:
                        if isinstance(item, dict):
                            name = item.get("name") or ""
                            # Character.tags / Artist.prompt
                            tags = item.get("tags") or item.get("prompt") or ""
                            if name and tags:
                                candidates.append((section_title, f"{name} → {tags}"))
                        elif hasattr(item, "name"):
                            name = getattr(item, "name", "")
                            tags = getattr(item, "tags", "") or getattr(item, "prompt", "")
                            if name and tags:
                                candidates.append((section_title, f"{name} → {tags}"))
    except Exception:
        logger.debug("无法解析模型上下文中的已用资源", exc_info=True)

    # 对每条候选，检查关键 token 是否出现在 haystack
    sections: dict[str, list[str]] = {}
    seen_lines: set[str] = set()
    for section, line in candidates:
        if line in seen_lines:
            continue
        keys = _line_keys_for_match(line)
        if not keys:
            continue
        hit = any(k in haystack for k in keys)
        if not hit:
            continue
        seen_lines.add(line)
        sections.setdefault(section or "## 资源", []).append(line)

    if not sections:
        return ""
    out_lines: list[str] = []
    for section, lines in sections.items():
        if section:
            out_lines.append(section)
        out_lines.extend(lines)
    return "\n".join(out_lines).strip()


def _sanitized_chat_history_entries(
    *,
    parts: list,
    output: ChatOutput,
    draw_specs: list[dict],
    should_draw: bool,
) -> list[dict]:
    """
    Store semantic history, not raw provider messages.

    PromptedOutput/OpenAI-compatible channels put chain-of-thought-like planning
    text plus JSON into ModelResponse text. Persisting result.new_messages()
    leaks that raw transcript into the next turn and pollutes context.
    """
    entries: list[dict] = []
    user_text = _history_user_text_from_parts(parts)
    if user_text:
        entries.append({"role": "user", "content": user_text})

    reply = (output.reply_text or "").strip()
    assistant_blocks: list[str] = []
    if reply:
        assistant_blocks.append(reply)

    if should_draw and draw_specs:
        lines = ["[上一轮绘图参数]"]
        for i, spec in enumerate(draw_specs[:3], 1):
            if not isinstance(spec, dict):
                continue
            positive = str(spec.get("positive") or "").strip()
            negative = str(spec.get("negative") or "").strip()
            size = str(spec.get("size") or "").strip()
            lines.append(f"图{i}:")
            if positive:
                lines.append(f"positive: {positive}")
            if negative:
                lines.append(f"negative: {negative}")
            if size:
                lines.append(f"size: {size}")
        assistant_blocks.append("\n".join(lines))

    if assistant_blocks:
        entries.append({"role": "assistant", "content": "\n".join(assistant_blocks)})
    return entries


# 视作"瞬时"的上游错误：值得无脑重试一次（含 504/503/429 / 网络超时 / 连接断开）
# 注意：401/403/400 这种鉴权/参数错误不在列，重试也无效，要让它直接冒上去
_TRANSIENT_STATUS = {408, 425, 429, 500, 502, 503, 504}
_TRANSIENT_EXC_NAMES = {
    "TimeoutError",
    "TimeoutException",
    "ReadTimeout",
    "ConnectTimeout",
    "WriteTimeout",
    "PoolTimeout",
    "ConnectError",
    "ReadError",
    "RemoteProtocolError",
}


def _is_transient_error(e: Exception) -> bool:
    """识别 Google/Anthropic/OpenAI 上游瞬时错误，触发额外重试。"""
    sc = getattr(e, "status_code", None)
    if isinstance(sc, int) and sc in _TRANSIENT_STATUS:
        return True
    if type(e).__name__ in _TRANSIENT_EXC_NAMES:
        return True
    # ModelHTTPError 把 status 拼在 message 里时（个别 wrapper），兜一下
    msg = str(e).lower()
    if "deadline_exceeded" in msg or "deadline expired" in msg:
        return True
    return False


def _iter_exception_chain(e: Exception):
    cur: BaseException | None = e
    seen: set[int] = set()
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        yield cur
        cur = cur.__cause__ or cur.__context__


def _is_empty_model_output_error(e: Exception) -> bool:
    """
    PydanticAI raises UnexpectedModelBehavior after the model repeatedly returns
    neither text nor a tool call. Local OpenAI-compatible gateways sometimes do
    this for a single turn, so let the outer chat retry loop try a fresh request.
    """
    markers = (
        "exceeded maximum output retries",
        "please return text or include your response in a tool call",
    )
    for item in _iter_exception_chain(e):
        msg = str(item).lower()
        if any(marker in msg for marker in markers):
            return True
    return False


# 注：旧的 _chat_with_recovery（chat_agent 智能重试包装）已随 chat.py 一并下线。
# 生产 /chat 流程改走 lite_chat + pure_planner 两阶段，不再经过合并 chat_agent。
# 下方 _is_transient_error / _is_empty_model_output_error / _iter_exception_chain 原是给
# _chat_with_recovery 用的"瞬时错/空输出"识别工具，**现已无调用方**——两阶段 planner 出错
# 直接降级（与下线前的实际行为一致：旧 _chat_with_recovery 本就未被接入主流程）。保留它们
# 仅作异常分类工具备查；若要恢复"瞬时错自动重试"，在 planner 的 except 块里接回即可。


# ============================================================
# POST /api/agent/chat —— Bot 主入口
# ============================================================


@router.post("/chat", response_model=ChatResponse)
async def chat(
    request: Request,
    req: ChatRequest,
    access: Annotated[AgentAccess, Depends(require_agent_access)],
) -> ChatResponse:
    """
    Bot 端主对话入口（一次性 JSON 返回）。

    流程:
        1. 加载历史（私聊持久化）
        2. 用 chat_agent 跑一轮
        3. 持久化新消息
        4. 返回 reply_text + draw_specs；Bot 端自己用 enqueue_image_generation 出图
    """
    req = bind_chat_identity(req, access)
    await authorize_paid_agent_access(request, access)
    user_key = _build_user_key(req)

    # 按 req.image_model 解析 prompt 预设 + 图像后端（与 LLM 渠道 req.model 正交）。
    # bot 端读 NOVELAI_MODEL_MODE[ctx] 后归一化为 anima / nai_v45_full / nai_v45_curated，
    # 通过 ChatRequest.image_model 透传到这里。
    #   image_model == "anima" → preset="anima"（用 prompts_anima.yaml） + backend="anima"
    #   其他 / 空 / 任何 nai_* 值 → 默认 prompts.yaml + backend="novelai"
    _image_model = (req.image_model or "").strip().lower()
    if _image_model == "anima":
        _prompt_preset = "anima"
        _image_backend = "anima"
    else:
        _prompt_preset = "prompt2"
        _image_backend = "novelai"

    # 构造 agent input
    parts: list = []
    if req.text:
        parts.append(req.text)
    if req.environment_info:
        parts.append(f"[环境信息]\n{req.environment_info}")
    for img in req.images:
        try:
            import base64 as _b64

            parts.append(
                BinaryContent(
                    data=_b64.b64decode(img.base64),
                    media_type=img.mime_type or "image/png",
                )
            )
        except Exception:
            logger.debug("忽略无法解码的聊天图片", exc_info=True)
            continue
    if not parts:
        parts = ["（用户没发任何内容）"]

    # 历史
    try:
        if req.clear_history:
            # 完整清理一个会话：磁盘/内存历史 + 本进程的 carryover 资料缓存。
            # `_LAST_USED_RESOURCES` 是 B3 提炼出的"上一轮采用清单"，下一轮 lite_chat 起手
            # 会把它合进 prequery；如果不清，重置后第一次绘图仍会带上一轮的画师串/角色。
            cleared = await clear_history(user_key, persistent=req.scene == "private")
            had_carryover = _LAST_USED_RESOURCES.pop(user_key, None) is not None
            logger.info(
                f"[reset] user_key={user_key} scene={req.scene} "
                f"history_cleared={cleared} carryover_cleared={had_carryover}"
            )
            history = []
        else:
            history = await load_history_for_agent(
                user_key,
                persistent=req.scene == "private",
            )
    except Exception as e:
        logger.warning(f"加载历史失败 {user_key}: {e}")
        history = []

    deps = AgentDeps(
        user_id=req.user_id,
        user_key=user_key,
        platform=req.platform,
        scene=req.scene,
        group_id=req.group_id,
        selected_model=req.model,
        prompt_preset=_prompt_preset,
        debug_context=req.debug_context,
        http_client=_get_http_client(),
    )

    # ===== Lite 阶段：回复 + 意图判断 + 资料筛选三合一 =====
    # 替代之前的 prefilter——lite 同时完成 prefilter 工作 + chat 层 reply_text + should_draw 决策。
    refined_resources = ""
    artist_source = ""
    lite_reply = "本喵在喵~"
    try:
        carryover = _LAST_USED_RESOURCES.get(user_key, "")
        raw_prequery, other_env = _split_prequery_from_env(req.environment_info or "")
        merged = _merge_resources(raw_prequery, carryover)
        artist_source = merged if merged.strip() else ""

        from .agents.lite_chat import run_lite_chat

        lite_result, lite_messages, lite_sys_parts = await run_lite_chat(
            user_text=req.text or "",
            candidates=merged,
            history=history,
            deps=deps,
        )
        lite_reply = (lite_result.reply_text or "本喵在喵~").strip() or "本喵在喵~"
        refined_resources = (lite_result.refined_resources or "").strip()
        should_draw_lite = bool(lite_result.should_draw)

        if refined_resources:
            artist_source = refined_resources

        # debug 记录：lite agent 真实提交给 LLM 的 messages + 解析后的输出
        _record_agent_messages(
            deps,
            model_role="lite_chat",
            messages=lite_messages,
            system_prompt_parts=lite_sys_parts,
            extra={
                "output_reply_text": lite_reply,
                "output_should_draw": should_draw_lite,
                "output_refined_resources": refined_resources,
            },
        )

        # ===== 闲聊路径：lite 已收尾，无需 planner =====
        if not should_draw_lite:
            # history 持久化（私聊）
            if req.scene in ("private", "group"):
                try:
                    fake_output = ChatOutput(
                        reply_text=lite_reply,
                        draw_spec=None,
                        should_draw=False,
                        mood=None,
                    )
                    history_entries = _sanitized_chat_history_entries(
                        parts=parts,
                        output=fake_output,
                        draw_specs=[],
                        should_draw=False,
                    )
                    await append_to_history(
                        user_key,
                        [],
                        persistent=req.scene == "private",
                        extra_entries=history_entries,
                    )
                except Exception as e:
                    logger.warning(f"追加历史失败 {user_key}: {e}")
            return ChatResponse(
                reply_text=lite_reply,
                draw_specs=[],
                should_draw=False,
                history_updated=True,
                degraded=False,
                image_backend=_image_backend,
                debug={
                    "model_contexts": list(deps.debug_contexts),
                }
                if deps.debug_context
                else {},
            )

        # ===== 绘图路径：用 refined 替换 parts 里的 [环境信息] 段，交棒给 planner =====
        new_env = _rebuild_env_info(
            _build_prequery_env_block(refined_resources),
            other_env,
        )
        parts = [
            p for p in parts if not (isinstance(p, str) and p.lstrip().startswith("[环境信息]"))
        ]
        if new_env:
            insert_idx = 1 if (parts and isinstance(parts[0], str)) else 0
            parts.insert(insert_idx, f"[环境信息]\n{new_env}")
    except Exception as e:
        logger.warning(f"lite_chat 阶段异常（降级用 raw env_info）: {e}")
        _record_agent_messages(
            deps,
            model_role="lite_chat",
            messages=[],
            extra={"decision": f"error (降级): {type(e).__name__}: {e}"},
        )

    # ===== Planner 阶段：pure_planner 出 DrawSpec =====
    pp_result = None
    pp_sys_parts: list = []
    try:
        from .agents.pure_planner import pure_planner_agent

        pp_sys_parts = await _resolve_system_prompt_parts(pure_planner_agent, deps)
        pp_result = await pure_planner_agent.run(
            parts,
            deps=deps,
            message_history=history,
            model=get_model(req.model),
            model_settings=get_model_settings(req.model),
        )
        spec = pp_result.output  # DrawSpec
        try:
            pp_messages = list(pp_result.all_messages())
        except Exception:
            pp_messages = []
        _record_agent_messages(
            deps,
            model_role="pure_planner",
            messages=pp_messages,
            system_prompt_parts=pp_sys_parts,
            extra={"output_draw_spec": spec.model_dump()},
        )
        output = ChatOutput(
            reply_text=lite_reply,
            draw_spec=spec.model_dump(),
            should_draw=True,
            mood=None,
        )
    except Exception as e:
        if is_google_prohibited_content_error(e):
            message = humanize_provider_error(e)
            return ChatResponse(
                reply_text=message,
                error=message,
                degraded=True,
                image_backend=_image_backend,
            )
        logger.exception(f"pure_planner 失败: {e}")
        _record_agent_messages(
            deps,
            model_role="pure_planner",
            messages=[],
            system_prompt_parts=pp_sys_parts,
            extra={"decision": f"error: {type(e).__name__}: {e}"},
        )
        return ChatResponse(
            reply_text="(AI 暂时不可用，请稍后再试)",
            error=humanize_provider_error(e),
            degraded=True,
            image_backend=_image_backend,
        )

    # 后处理：补全画师串；Anima 没有分角色通道，需把 characters 合并回 positive
    final_draw_specs = [output.draw_spec] if output.draw_spec else []
    final_draw_specs = _complete_artist_prompts_in_draw_specs(final_draw_specs, artist_source)
    if _image_backend == "anima":
        final_draw_specs = _merge_characters_into_positive(final_draw_specs)
    else:
        final_draw_specs = _ensure_requested_character_prompts(
            final_draw_specs,
            user_text=req.text or "",
            prequery_output=artist_source,
        )
    final_should_draw = output.should_draw

    # ===== B3 阶段：提炼"采用清单"存入 _LAST_USED_RESOURCES =====
    try:
        ctx_messages = (
            pp_result.new_messages() if (pp_result and hasattr(pp_result, "new_messages")) else []
        )
        used = _extract_used_resources(
            ctx_messages=ctx_messages,
            draw_specs=final_draw_specs,
            prefilter_output=refined_resources,
        )
        _LAST_USED_RESOURCES[user_key] = used
    except Exception as e:
        logger.warning(f"B3 提炼采用清单异常（不影响主流程）: {e}")

    # Persist semantic history only. Raw provider messages from PromptedOutput
    # may contain planning text and JSON wrappers that pollute the next turn.
    if req.scene in ("private", "group"):
        try:
            history_entries = _sanitized_chat_history_entries(
                parts=parts,
                output=output,
                draw_specs=final_draw_specs,
                should_draw=final_should_draw,
            )
            await append_to_history(
                user_key,
                [],
                persistent=req.scene == "private",
                extra_entries=history_entries,
            )
        except Exception as e:
            logger.warning(f"追加历史失败 {user_key}: {e}")

    return ChatResponse(
        reply_text=output.reply_text,
        draw_specs=final_draw_specs,
        should_draw=final_should_draw,
        history_updated=True,
        degraded=deps.degraded,
        image_backend=_image_backend,
        debug={
            "model_contexts": list(deps.debug_contexts),
        }
        if deps.debug_context
        else {},
    )


# ============================================================
# ChatOutput → AgentResult 转换（Web 端前端兼容）
# ============================================================


def _chat_output_to_agent_result(output: ChatOutput, deps: AgentDeps) -> AgentResult:
    """
    把统一的 ChatOutput 转成前端 agentService.ts 期望的 AgentResult 格式。

    映射规则:
      - thinking = reply_text（前端把它渲染成对话气泡）
      - 用 output.draw_spec（合并架构：单数 + Optional；已经过 _normalize_draw_spec 规范化）
      - 没有绘图意图 → positive/negative 留空字符串
    """
    thinking = (output.reply_text or "").strip()

    spec = output.draw_spec
    if spec is None:
        return AgentResult(thinking=thinking, positive="", negative="", characters=[])
    if not isinstance(spec, dict):
        # 兜底：意外的非 dict 输入
        return AgentResult(thinking=thinking, positive="", negative="", characters=[])

    positive = _wrap_web_artist_markers(str(spec.get("positive", "") or ""), deps)
    negative = str(spec.get("negative", "") or "")

    # characters 规范化：必须是 list[dict]，每个含 name/positive/negative
    chars_raw = spec.get("characters")
    characters: list[dict[str, str]] = []
    if isinstance(chars_raw, list):
        for c in chars_raw:
            if not isinstance(c, dict):
                continue
            characters.append(
                {
                    "name": str(c.get("name", "") or ""),
                    "positive": str(c.get("positive", "") or ""),
                    "negative": str(c.get("negative", "") or ""),
                }
            )

    return AgentResult(
        thinking=thinking,
        positive=positive,
        negative=negative,
        characters=characters,
    )


# ============================================================
# POST /api/agent/web/generate-prompt —— Web SSE 入口
# ============================================================


@router.post("/web/generate-prompt")
async def web_generate_prompt(
    req: WebPromptRequest,
    _access: Annotated[AgentAccess, Depends(require_paid_agent_access)],
):
    """
    Web 端 prompt 助手 —— SSE 流式响应。

    架构变更（与 Bot 端统一）：
      - 内部跑 chat_agent（与 /api/agent/chat 同一套合并 agent）
      - 预设统一用 prompts.yaml（不再有 web 专版 / assist / create 分预设）
      - chat_agent 直接产出 draw_specs，经 _chat_output_to_agent_result 转换为前端期望的 AgentResult

    事件类型:
        agent_token / tool_call / tool_result / final / error / degraded

    最后一个事件必然是 final，data 字段为 AgentResult.model_dump()
    """
    channel = SseChannel()

    async def run_agent():
        try:
            # 构造 input
            parts: list = []
            # 当前画面提示词上下文（让 chat_agent 知道用户已经写了什么、可以在此基础上改）
            current_prompt_context = _build_current_prompt_context(req)

            deps = AgentDeps(
                user_id="web_anon",
                user_key="",
                platform="web",
                scene="web",
                selected_model=req.model,
                http_client=_get_http_client(),
                sse_emitter=channel.emit,
                use_codex=req.use_codex,
                knowledge_sources=list(req.knowledge_sources),
                web_artists=list(req.web_artists),
                web_ocs=list(req.web_ocs),
                web_current_prompt_context=current_prompt_context,
            )

            env_blocks: list[str] = []
            if current_prompt_context:
                env_blocks.append(current_prompt_context)
            web_prequery_context = await _build_web_prequery_context(req, deps)
            if web_prequery_context:
                env_blocks.append(web_prequery_context)
            full_env_info = "\n\n".join(env_blocks).strip()
            if full_env_info:
                parts.append("[环境信息]\n" + full_env_info)
            parts.append(req.user_request)
            if req.image_b64:
                try:
                    import base64 as _b64

                    parts.append(
                        BinaryContent(
                            data=_b64.b64decode(req.image_b64),
                            media_type="image/png",
                        )
                    )
                except Exception:
                    logger.debug("忽略无法解码的 Web Agent 图片", exc_info=True)

            # Web 端历史：前端传过来即可，无服务端持久化
            from .history_adapter import (
                WEB_HISTORY_BUDGET_TOKENS,
                apply_token_budget,
                to_model_messages,
            )

            try:
                budgeted = (
                    apply_token_budget(req.history, WEB_HISTORY_BUDGET_TOKENS)
                    if req.history
                    else []
                )
                history_msgs = to_model_messages(budgeted, trim=True) if budgeted else []
            except Exception as e:
                logger.warning(f"Web 历史转换失败: {e}")
                history_msgs = []

            # ===== Prefilter 阶段 =====
            # web 端 user_key 空且无 carryover；按类目阈值决定是否调小模型。
            web_artist_source = ""
            try:
                raw_pq, other_env = _split_prequery_from_env(full_env_info)
                web_artist_source = raw_pq if raw_pq.strip() else ""
                refined_resources = ""
                lite_reply = "本喵在喵~"
                should_draw_lite = True  # Web 端始终视为绘图意图（前端只有一个"生成"按钮）

                from .agents.lite_chat import run_lite_chat

                lite_result, lite_messages, lite_sys_parts = await run_lite_chat(
                    user_text=req.user_request or "",
                    candidates=raw_pq,
                    history=history_msgs,
                    deps=deps,
                )
                lite_reply = (lite_result.reply_text or "本喵在喵~").strip() or "本喵在喵~"
                refined_resources = (lite_result.refined_resources or "").strip()
                # Web 端忽略 should_draw（前端已经发送"生成"请求）；但若 lite 没筛资料就用 raw
                if not refined_resources and raw_pq.strip():
                    refined_resources = raw_pq

                if refined_resources:
                    web_artist_source = refined_resources

                _record_agent_messages(
                    deps,
                    model_role="lite_chat",
                    messages=lite_messages,
                    system_prompt_parts=lite_sys_parts,
                    extra={
                        "output_reply_text": lite_reply,
                        "output_should_draw": should_draw_lite,
                        "output_refined_resources": refined_resources,
                    },
                )

                if refined_resources:
                    new_env = _rebuild_env_info(
                        _build_prequery_env_block(refined_resources), other_env
                    )
                    parts = [
                        p
                        for p in parts
                        if not (isinstance(p, str) and p.lstrip().startswith("[环境信息]"))
                    ]
                    if new_env:
                        parts.insert(0, f"[环境信息]\n{new_env}")
            except Exception as e:
                logger.warning(f"web lite_chat 阶段异常（降级用 raw env_info）: {e}")
                lite_reply = "本喵在喵~"
                _record_agent_messages(
                    deps,
                    model_role="lite_chat",
                    messages=[],
                    extra={"decision": f"error (降级): {type(e).__name__}: {e}"},
                )

            # ===== Planner 阶段：pure_planner 出 DrawSpec =====
            from .agents.pure_planner import pure_planner_agent

            pp_sys_parts = await _resolve_system_prompt_parts(pure_planner_agent, deps)
            pp_result = await pure_planner_agent.run(
                parts,
                deps=deps,
                message_history=history_msgs,
                model=get_model(req.model),
                model_settings=get_model_settings(req.model),
            )
            spec = pp_result.output
            try:
                pp_messages = list(pp_result.all_messages())
            except Exception:
                pp_messages = []
            _record_agent_messages(
                deps,
                model_role="pure_planner",
                messages=pp_messages,
                system_prompt_parts=pp_sys_parts,
                extra={"output_draw_spec": spec.model_dump()},
            )
            chat_output = ChatOutput(
                reply_text=lite_reply,
                draw_spec=spec.model_dump(),
                should_draw=True,
                mood=None,
            )
            # 合并架构：绘图参数就是 chat_output.draw_spec（单数 + Optional）。
            # "确认绘图却没产出 spec" 的情况由 _retry_draw_confirmation_without_specs 内部触发重试。
            # 复用既有的 list-based helper：包成 [spec] 跑完再拆回 single Optional。
            _spec_list = [chat_output.draw_spec] if chat_output.draw_spec else []
            _spec_list = _complete_artist_prompts_in_draw_specs(_spec_list, web_artist_source)
            _spec_list = _ensure_requested_character_prompts(
                _spec_list,
                user_text=req.user_request or "",
                prequery_output=web_artist_source,
            )
            chat_output.draw_spec = _spec_list[0] if _spec_list else None

            if deps.degraded:
                await channel.emit(
                    SseEvent(event="degraded", data={"reason": "fallback_safe_mode"})
                )

            # ChatOutput → AgentResult 转换（保持前端 schema 兼容）
            agent_result = _chat_output_to_agent_result(chat_output, deps)
            await channel.emit_final(agent_result.model_dump())
        except Exception as e:
            logger.exception(f"web chat_agent 失败: {e}")
            await channel.emit_error(humanize_provider_error(e))
        finally:
            await channel.close()

    producer_task = asyncio.create_task(run_agent())
    channel.bind_producer(producer_task)

    return StreamingResponse(
        channel.iter_sse(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # 禁用 nginx buffering
        },
    )


# 旧版 /api/agent/draw-plan 和 /api/agent/vision/describe 已下线。
# 单独"自然语言转 DrawSpec"功能由 /api/agent/chat 自带；单独识图能力由 chat_agent
# 多模态消息直接处理（图片塞进 ChatRequest.images 即可）。


# ============================================================
# GET /api/agent/prompts
# ============================================================


@router.get("/prompts", response_model=PromptsResponse)
async def get_prompts(
    _access: Annotated[AgentAccess, Depends(require_agent_admin)],
):
    """返回合并后的统一预设配置（tier 已移除）"""
    try:
        raw = get_prompts_raw()
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    return PromptsResponse(
        system_prompts=raw.get("system_prompts", []),
        prison_break=raw.get("prison_break", []),
    )


# ============================================================
# GET /api/agent/history/{user_key}
# ============================================================


@router.get("/history/{user_key}", response_model=HistoryResponse)
async def get_history(
    access: Annotated[AgentAccess, Depends(require_agent_access)],
    user_key: str = Path(..., description="如 qq_p_123456"),
):
    """读取用户历史（仅文件持久化部分，内存语义群聊不持久）"""
    user_key = authorize_history_key(user_key, access)
    try:
        history = await _load_user_history(user_key)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"读取历史失败: {e}") from e

    messages = [
        HistoryMessage(
            role=h.get("role", "user"),
            content=h.get("content"),
            **(
                {"_is_generated_image": h["_is_generated_image"]}
                if "_is_generated_image" in h
                else {}
            ),
            **({"generated_params": h["generated_params"]} if "generated_params" in h else {}),
        )
        for h in history
    ]
    return HistoryResponse(user_key=user_key, messages=messages)


@router.delete("/history/{user_key}")
async def delete_history(
    access: Annotated[AgentAccess, Depends(require_agent_access)],
    user_key: str = Path(...),
):
    """清空历史但保留 mode 等设置"""
    user_key = authorize_history_key(user_key, access)
    ok = await clear_history(user_key, persistent="_g_" not in user_key)
    if not ok:
        return {"ok": False, "message": "user not found or already empty"}
    return {"ok": True}


# ============================================================
# /api/agent/models —— 列出 / 切换 / 解析可选 model
# ============================================================


@router.get("/models")
async def get_models():
    """列出所有可选 model + 当前全局默认。"""
    from config import get_model_status  # type: ignore

    return get_model_status()


@router.post("/models")
async def switch_model(
    req: ModelSwitchRequest,
    _access: Annotated[AgentAccess, Depends(require_agent_admin)],
):
    """切换全局默认 model。"""
    try:
        from config import switch_model as _switch_model  # type: ignore

        key, choice = _switch_model(req.target)
        return {"ok": True, "active": key, "choice": choice}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.post("/models/resolve")
async def resolve_model(req: ModelSwitchRequest):
    """解析目标 model（不改全局状态），供单次调用临时指定。"""
    try:
        from config import resolve_model as _resolve_model  # type: ignore

        key, choice = _resolve_model(req.target, current=req.current)
        return {"ok": True, "active": key, "choice": choice}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


# ============================================================
# GET /api/agent/health
# ============================================================


@router.get("/health", response_model=HealthResponse)
async def agent_health(
    _access: Annotated[AgentAccess, Depends(require_agent_admin)],
):
    """探测当前默认 model 可用性 + prompts 加载状态"""
    from config import ACTIVE_MODEL  # type: ignore

    from .model_provider import resolve_choice_to_model_name

    prompts_status = warm_load_all()

    tiers: list[HealthTierStatus] = []
    test_input = "ping"

    # 合并 agent + 单一 model 架构：只探测当前全局默认 model（切换后下次 health 反映新值）。
    model_key = ACTIVE_MODEL
    model_name = resolve_choice_to_model_name(model_key) or "(unknown)"
    ts = HealthTierStatus(
        tier=model_key,  # type: ignore[arg-type]
        model=model_name,
        ok=False,
    )
    start = time.time()
    try:
        from .llm import Agent as _Agent

        probe = _Agent(get_model(model_key), output_type=str)
        r = await asyncio.wait_for(probe.run(test_input), timeout=15)
        ts.ok = bool(r.output)
        ts.latency_ms = (time.time() - start) * 1000
    except Exception as e:
        ts.error = str(e)
    tiers.append(ts)

    all_ok = all(t.ok for t in tiers) and all(s.get("ok") for s in prompts_status.values())
    return HealthResponse(ok=all_ok, tiers=tiers)
