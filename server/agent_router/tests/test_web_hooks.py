from __future__ import annotations

from types import SimpleNamespace
from typing import Any, cast

import pytest

from agent_router.deps import AgentDeps
from agent_router.llm.messages import (
    BinaryContent,
    ModelRequest,
    ModelResponse,
    SystemPromptPart,
    TextPart,
    ThinkingPart,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)
from agent_router.web_hooks import (
    _build_web_prequery_context,
    _complete_artist_prompts_in_positive,
    _debug_serialize_model_messages,
    _debug_serialize_part,
    _record_agent_messages,
    _resolve_system_prompt_parts,
)


def test_debug_serialization_covers_every_supported_message_part() -> None:
    external_system = [SystemPromptPart("external")]
    with_virtual_system = _debug_serialize_model_messages(
        [ModelRequest(parts=[UserPromptPart("hello")])],
        system_prompt_parts=external_system,
    )
    assert with_virtual_system[0] == {
        "role": "system",
        "parts": [{"type": "system_prompt", "text": "external"}],
    }

    messages = [
        ModelRequest(
            parts=[
                SystemPromptPart("inline"),
                UserPromptPart("plain"),
                UserPromptPart(["mixed", BinaryContent(b"png", "image/png")]),
                UserPromptPart(cast(Any, 123)),
                ToolReturnPart("lookup", {"ok": True}),
            ]
        ),
        ModelResponse(
            parts=[
                TextPart("answer"),
                ThinkingPart("reasoning"),
                ToolCallPart("search_artist", {"id": "A1"}, "call-1"),
            ]
        ),
        SimpleNamespace(parts=[]),
    ]
    serialized = _debug_serialize_model_messages(
        messages,
        system_prompt_parts=external_system,
    )

    assert serialized[0]["role"] == "user"
    assert serialized[1]["role"] == "assistant"
    assert serialized[2]["role"] == "SimpleNamespace"
    request_parts = serialized[0]["parts"]
    assert any(part.get("type") == "image" and part.get("bytes") == 3 for part in request_parts)
    assert any(part.get("tool_name") == "lookup" for part in request_parts)
    response_parts = serialized[1]["parts"]
    assert any(part.get("tool_name") == "search_artist" for part in response_parts)
    assert _debug_serialize_part(object())["type"] == "object"


def test_record_agent_messages_is_debug_gated_and_merges_extra() -> None:
    disabled = AgentDeps(user_id="off")
    _record_agent_messages(disabled, model_role="planner", messages=[])
    assert disabled.debug_contexts == []

    enabled = AgentDeps(user_id="on", debug_context=True)
    _record_agent_messages(
        enabled,
        model_role="planner",
        messages=[ModelResponse(parts=[TextPart("ok")])],
        system_prompt_parts=[SystemPromptPart("system")],
        extra={"attempt": 2},
    )
    assert enabled.debug_contexts[0]["model_role"] == "planner"
    assert enabled.debug_contexts[0]["attempt"] == 2
    assert enabled.debug_contexts[0]["messages"]


@pytest.mark.asyncio
async def test_resolve_system_prompt_parts_is_best_effort() -> None:
    class WorkingAgent:
        async def system_prompt_parts(self, *, deps):
            assert deps.user_id == "web"
            return [SystemPromptPart("system")]

    class EmptyAgent:
        async def system_prompt_parts(self, *, deps):
            return None

    class BrokenAgent:
        async def system_prompt_parts(self, *, deps):
            raise RuntimeError("boom")

    deps = AgentDeps(user_id="web")
    assert len(await _resolve_system_prompt_parts(WorkingAgent(), deps)) == 1
    assert await _resolve_system_prompt_parts(EmptyAgent(), deps) == []
    assert await _resolve_system_prompt_parts(BrokenAgent(), deps) == []


@pytest.mark.asyncio
async def test_prequery_random_artist_and_failure_isolation(monkeypatch) -> None:
    from agent_router import web_hooks
    from agent_router.schemas import WebPromptRequest
    from agent_router.tools import knowledge

    monkeypatch.setattr(
        knowledge,
        "_load_artists_for_deps",
        lambda deps: [
            {"id": "empty", "artist_string": ""},
            {"id": "A7", "artist_string": "artist:random_style"},
        ],
    )
    monkeypatch.setattr(knowledge, "_load_ocs_for_deps", lambda deps: [])

    async def no_roles(deps):
        return {}

    monkeypatch.setattr(knowledge, "_get_role_mapping", no_roles)
    monkeypatch.setattr(web_hooks, "_RANDOM", SimpleNamespace(choice=lambda values: values[0]))
    req = WebPromptRequest(user_request="随机画师串")
    deps = AgentDeps(user_id="web", platform="web", scene="web")
    context = await _build_web_prequery_context(req, deps)
    assert "A7 → artist:random_style" in context

    def broken_loader(deps):
        raise RuntimeError("broken local library")

    async def broken_roles(deps):
        raise RuntimeError("broken role mapping")

    monkeypatch.setattr(knowledge, "_load_artists_for_deps", broken_loader)
    monkeypatch.setattr(knowledge, "_load_ocs_for_deps", broken_loader)
    monkeypatch.setattr(knowledge, "_get_role_mapping", broken_roles)
    monkeypatch.setattr(
        web_hooks,
        "_web_codex_query_terms",
        lambda text: (_ for _ in ()).throw(RuntimeError("broken codex")),
    )
    codex_req = WebPromptRequest.model_validate(
        {
            "user_request": "codex lookup",
            "use_codex": True,
            "web_codex": [{"id": "1", "title": "entry", "content": "content"}],
        }
    )
    codex_deps = AgentDeps(
        user_id="web",
        platform="web",
        scene="web",
        use_codex=True,
        web_codex=[{"id": "1", "title": "entry", "content": "content"}],
    )
    assert await _build_web_prequery_context(codex_req, codex_deps) == ""


def test_artist_completion_handles_identity_edge_cases() -> None:
    assert _complete_artist_prompts_in_positive(
        "1girl, artist:foo, portrait",
        [("A1", "artist:foo, masterpiece")],
    ) == "1girl, artist:foo, masterpiece, portrait"
    assert _complete_artist_prompts_in_positive(
        "1girl",
        [
            ("empty", "{}"),
            ("missing", "artist:missing, detailed"),
        ],
    ) == "1girl"
    assert _complete_artist_prompts_in_positive(
        "artist:foo, masterpiece",
        [
            ("A1", "artist:foo, masterpiece"),
            ("duplicate", "artist:foo, alternate"),
        ],
    ) == "artist:foo, masterpiece"
