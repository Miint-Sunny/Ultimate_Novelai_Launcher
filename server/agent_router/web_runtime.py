"""Transport-neutral orchestration for the two-stage Web Agent."""

from __future__ import annotations

import base64
import logging
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import httpx

from .deps import AgentDeps
from .llm import BinaryContent
from .model_family import normalize_model_family
from .prompts import AgentPromptBundle
from .schemas import AgentResult, ChatOutput, SseEvent, WebPromptRequest

logger = logging.getLogger("agent_router.web_runtime")

EventEmitter = Callable[[SseEvent], Awaitable[None]]


@dataclass(frozen=True)
class WebAgentHooks:
    """Application callbacks kept outside the transport-neutral runner."""

    build_current_prompt_context: Callable[[WebPromptRequest], str]
    build_prequery_context: Callable[[WebPromptRequest, AgentDeps], Awaitable[str]]
    split_prequery_from_env: Callable[[str], tuple[str, str]]
    build_prequery_env_block: Callable[[str], str]
    rebuild_env_info: Callable[[str, str], str]
    complete_artist_prompts: Callable[[list[dict], str], list[dict]]
    ensure_character_prompts: Callable[..., list[dict]]
    to_agent_result: Callable[[ChatOutput, AgentDeps], AgentResult]
    record_agent_messages: Callable[..., None] | None = None
    resolve_system_prompt_parts: Callable[[Any, AgentDeps], Awaitable[list]] | None = None


@dataclass(frozen=True)
class WebAgentRuntime:
    """External dependencies injected for one stateless Web Agent request."""

    planner_model: Any
    prefilter_model: Any
    hooks: WebAgentHooks
    planner_model_settings: Mapping[str, Any] | None = None
    prefilter_model_settings: Mapping[str, Any] | None = None
    prefilter_timeout_s: float | None = 30.0
    http_client: httpx.AsyncClient | None = None
    internal_base_url: str = "http://127.0.0.1:8765"
    internal_headers: Mapping[str, str] | None = None
    prompt_preset: str = ""
    prompt_bundle: AgentPromptBundle | None = None
    runtime_artists: Sequence[Mapping[str, Any]] | None = None
    runtime_ocs: Sequence[Mapping[str, Any]] | None = None
    role_mapping: Mapping[str, Any] | None = None


def _as_dict(item: Any) -> dict[str, Any]:
    if hasattr(item, "model_dump"):
        value = item.model_dump()
        return dict(value) if isinstance(value, Mapping) else {}
    return dict(item) if isinstance(item, Mapping) else {}


def _merge_artist_contexts(
    request_items: Sequence[Any],
    runtime_items: Sequence[Mapping[str, Any]] | None,
) -> list[dict[str, Any]]:
    """Merge request-first, treating either stable ID or name as identity."""
    out: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    seen_names: set[str] = set()
    for raw in [*request_items, *(runtime_items or ())]:
        item = _as_dict(raw)
        item_id = str(item.get("id") or "").strip().casefold()
        name = str(item.get("name") or item.get("id") or "").strip().casefold()
        if (item_id and item_id in seen_ids) or (name and name in seen_names):
            continue
        if item_id:
            seen_ids.add(item_id)
        if name:
            seen_names.add(name)
        out.append(item)
    return out


def _merge_oc_contexts(
    request_items: Sequence[Any],
    runtime_items: Sequence[Mapping[str, Any]] | None,
) -> list[dict[str, Any]]:
    """Merge request-first by ID, English name, or display name."""
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in [*request_items, *(runtime_items or ())]:
        item = _as_dict(raw)
        identities = {
            str(item.get(key) or "").strip().casefold()
            for key in ("id", "en_name", "name", "zh_name", "zhName")
            if str(item.get(key) or "").strip()
        }
        if identities & seen:
            continue
        seen.update(identities)
        out.append(item)
    return out


async def _system_prompt_parts(agent: Any, deps: AgentDeps, hooks: WebAgentHooks) -> list:
    if hooks.resolve_system_prompt_parts is not None:
        return await hooks.resolve_system_prompt_parts(agent, deps)
    return list(await agent.system_prompt_parts(deps=deps))


def _record(hooks: WebAgentHooks, deps: AgentDeps, **kwargs: Any) -> None:
    if hooks.record_agent_messages is not None:
        hooks.record_agent_messages(deps, **kwargs)


async def run_web_agent(
    req: WebPromptRequest,
    runtime: WebAgentRuntime,
    emit: EventEmitter,
) -> AgentResult:
    """Run Lite and Planner; the transport owns final/error event encoding."""
    hooks = runtime.hooks
    current_prompt_context = hooks.build_current_prompt_context(req)
    snapshot_injected = any(
        value is not None
        for value in (runtime.runtime_artists, runtime.runtime_ocs, runtime.role_mapping)
    )
    deps = AgentDeps(
        user_id="web_anon",
        platform="web",
        scene="web",
        selected_model=req.model,
        image_model_family=normalize_model_family(req.image_model),
        prompt_preset=runtime.prompt_preset,
        prompt_bundle=runtime.prompt_bundle,
        http_client=runtime.http_client,  # type: ignore[arg-type]
        internal_base_url=runtime.internal_base_url,
        internal_headers=dict(runtime.internal_headers or {}),
        sse_emitter=emit,
        use_codex=req.use_codex,
        knowledge_sources=list(req.knowledge_sources),
        web_artists=_merge_artist_contexts(req.web_artists, runtime.runtime_artists),
        web_ocs=_merge_oc_contexts(req.web_ocs, runtime.runtime_ocs),
        web_codex=[_as_dict(item) for item in req.web_codex] if req.use_codex else [],
        role_mapping=dict(runtime.role_mapping) if runtime.role_mapping is not None else None,
        knowledge_snapshot_injected=snapshot_injected,
        web_current_prompt_context=current_prompt_context,
    )

    parts: list[Any] = []
    env_blocks: list[str] = []
    if current_prompt_context:
        env_blocks.append(current_prompt_context)
    prequery_context = await hooks.build_prequery_context(req, deps)
    if prequery_context:
        env_blocks.append(prequery_context)
    full_env_info = "\n\n".join(env_blocks).strip()
    if full_env_info:
        parts.append("[环境信息]\n" + full_env_info)
    if req.user_request.strip():
        parts.append(req.user_request)
    if req.image_b64:
        parts.append(
            BinaryContent(
                data=base64.b64decode(req.image_b64, validate=True),
                media_type=req.image_mime_type,
            )
        )

    from .history_adapter import WEB_HISTORY_BUDGET_TOKENS, apply_token_budget, to_model_messages

    history_dicts = [_as_dict(message) for message in req.history]
    budgeted = apply_token_budget(history_dicts, WEB_HISTORY_BUDGET_TOKENS) if history_dicts else []
    history_msgs = to_model_messages(budgeted, trim=True) if budgeted else []

    raw_prequery, other_env = hooks.split_prequery_from_env(full_env_info)
    artist_source = raw_prequery if raw_prequery.strip() else ""
    lite_reply = "本喵在喵~"
    from .agents.lite_chat import run_lite_chat

    lite_result, lite_messages, lite_system_parts = await run_lite_chat(
        user_text=req.user_request,
        candidates=raw_prequery,
        history=history_msgs,
        deps=deps,
        model=runtime.prefilter_model,
        model_settings=(
            dict(runtime.prefilter_model_settings) if runtime.prefilter_model_settings else None
        ),
        timeout_s=runtime.prefilter_timeout_s,
    )
    lite_reply = (lite_result.reply_text or lite_reply).strip() or lite_reply
    refined_resources = (lite_result.refined_resources or "").strip() or raw_prequery
    if refined_resources:
        artist_source = refined_resources
    _record(
        hooks,
        deps,
        model_role="lite_chat",
        messages=lite_messages,
        system_prompt_parts=lite_system_parts,
        extra={
            "output_reply_text": lite_reply,
            "output_should_draw": True,
            "output_refined_resources": refined_resources,
        },
    )
    if refined_resources:
        new_env = hooks.rebuild_env_info(
            hooks.build_prequery_env_block(refined_resources),
            other_env,
        )
        parts = [
            part
            for part in parts
            if not (isinstance(part, str) and part.lstrip().startswith("[环境信息]"))
        ]
        if new_env:
            parts.insert(0, f"[环境信息]\n{new_env}")

    from .agents.pure_planner import pure_planner_agent

    planner_system_parts = await _system_prompt_parts(pure_planner_agent, deps, hooks)
    planner_result = await pure_planner_agent.run(
        parts,
        deps=deps,
        message_history=history_msgs,
        model=runtime.planner_model,
        model_settings=(
            dict(runtime.planner_model_settings) if runtime.planner_model_settings else None
        ),
    )
    spec = planner_result.output
    try:
        planner_messages = list(planner_result.all_messages())
    except Exception:
        planner_messages = []
    spec_dict = spec.model_dump()
    _record(
        hooks,
        deps,
        model_role="pure_planner",
        messages=planner_messages,
        system_prompt_parts=planner_system_parts,
        extra={"output_draw_spec": spec_dict},
    )

    specs = hooks.complete_artist_prompts([spec_dict], artist_source)
    specs = hooks.ensure_character_prompts(
        specs,
        user_text=req.user_request,
        prequery_output=artist_source,
    )
    output = ChatOutput(
        reply_text=lite_reply,
        draw_spec=specs[0] if specs else None,
        should_draw=True,
    )
    if deps.degraded:
        await emit(SseEvent(event="degraded", data={"reason": "fallback_safe_mode"}))
    return hooks.to_agent_result(output, deps)


__all__ = ["EventEmitter", "WebAgentHooks", "WebAgentRuntime", "run_web_agent"]
