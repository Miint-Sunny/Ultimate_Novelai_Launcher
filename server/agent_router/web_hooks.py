"""Framework-independent hooks shared by the legacy and desktop Web Agent."""

from __future__ import annotations

import hashlib
import logging
import re
from random import SystemRandom

from .deps import AgentDeps
from .llm import BinaryContent
from .schemas import AgentResult, ChatOutput, WebPromptRequest
from .web_runtime import WebAgentHooks

logger = logging.getLogger("agent_router")

_RANDOM = SystemRandom()

_WEB_ARTIST_ID_RE = re.compile(r"(?<![A-Za-z])([A-Za-z])(\d{1,2})(?!\d)", re.IGNORECASE)


def _web_text_hit(text: str, value: object) -> bool:
    value_s = str(value or "").strip()
    return bool(value_s) and (value_s in text or value_s.lower() in text.lower())


def _web_codex_query_terms(text: str) -> list[str]:
    """Small deterministic lexical query for request-provided Codex entries."""
    lowered = (text or "").casefold()
    terms = {
        token
        for token in re.findall(r"[a-z0-9_()\-]{2,}", lowered)
        if token not in {"draw", "image", "please"}
    }
    stop = {"一个", "一张", "帮我", "画一", "来一", "图片", "风格", "使用"}
    for chunk in re.findall(r"[\u3400-\u9fff]{2,}", lowered):
        for size in range(2, min(4, len(chunk)) + 1):
            for start in range(0, len(chunk) - size + 1):
                term = chunk[start : start + size]
                if term not in stop:
                    terms.add(term)
    return sorted(terms, key=lambda item: (-len(item), item))


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
            if hasattr(c, "model_dump"):
                c = c.model_dump()
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

    if deps.use_codex and deps.web_codex:
        try:
            terms = _web_codex_query_terms(text)
            ranked_codex: list[tuple[int, str]] = []
            for item in deps.web_codex:
                title = str(item.get("title") or item.get("id") or "").strip()
                category = str(item.get("category") or "").strip()
                content = str(item.get("content") or "").strip()
                if not title or not content:
                    continue
                title_l = title.casefold()
                category_l = category.casefold()
                content_l = content.casefold()
                score = sum(
                    len(term)
                    * (
                        5
                        if term in title_l
                        else 3
                        if term in category_l
                        else 1
                        if term in content_l
                        else 0
                    )
                    for term in terms
                )
                if score <= 0:
                    continue
                label = f"{title} [{category}]" if category else title
                ranked_codex.append((score, f"{label} → {content[:3_000]}"))
            if ranked_codex:
                lines = [
                    line
                    for _, line in sorted(ranked_codex, key=lambda pair: pair[0], reverse=True)[:6]
                ]
                sections.append("## search_codex 结果\n" + "\n".join(lines))
        except Exception as e:
            logger.debug(f"Web Codex prequery failed: {e}")

    if not sections:
        return ""
    return "[预查询资源]（chat_agent 已用对应工具预查过，结果如下可直接使用）\n\n" + "\n\n".join(
        sections
    )


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


def build_web_agent_hooks() -> WebAgentHooks:
    """Inject the existing pure helpers into the transport-neutral runner."""
    return WebAgentHooks(
        build_current_prompt_context=_build_current_prompt_context,
        build_prequery_context=_build_web_prequery_context,
        split_prequery_from_env=_split_prequery_from_env,
        build_prequery_env_block=_build_prequery_env_block,
        rebuild_env_info=_rebuild_env_info,
        complete_artist_prompts=_complete_artist_prompts_in_draw_specs,
        ensure_character_prompts=_ensure_requested_character_prompts,
        to_agent_result=_chat_output_to_agent_result,
        record_agent_messages=_record_agent_messages,
        resolve_system_prompt_parts=_resolve_system_prompt_parts,
    )


__all__ = [
    "WebAgentHooks",
    "build_web_agent_hooks",
]
