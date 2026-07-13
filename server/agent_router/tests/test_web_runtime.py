from __future__ import annotations

import json
from typing import Any, cast

import pytest

from agent_router.deps import AgentDeps
from agent_router.llm.messages import (
    BinaryContent,
    ModelResponse,
    TextPart,
    ToolCallPart,
    UserPromptPart,
)
from agent_router.llm.models.base import Model
from agent_router.llm.output import OUTPUT_TOOL_NAME
from agent_router.llm.result import Usage
from agent_router.schemas import WebPromptRequest
from agent_router.tools.knowledge import (
    _get_role_mapping,
    _internal_get,
    _load_artists_for_deps,
    _load_ocs_for_deps,
)
from agent_router.web_hooks import build_web_agent_hooks
from agent_router.web_runtime import WebAgentRuntime, run_web_agent


class FakeModel(Model):
    def __init__(self, responses):
        self.model_name = "fake"
        self._responses = list(responses)
        self.calls: list[dict] = []

    async def request(self, messages, *, system_parts, tools, require_tool, model_settings=None):
        self.calls.append(
            {
                "messages": list(messages),
                "system_parts": list(system_parts),
                "tools": list(tools),
                "require_tool": require_tool,
                "model_settings": model_settings,
            }
        )
        return self._responses.pop(0), Usage(requests=1)


def _user_texts(call: dict) -> list[str]:
    out: list[str] = []
    for message in call["messages"]:
        for part in getattr(message, "parts", []):
            if not isinstance(part, UserPromptPart):
                continue
            content = part.content
            if isinstance(content, str):
                out.append(content)
            elif isinstance(content, list):
                out.extend(item for item in content if isinstance(item, str))
    return out


@pytest.mark.asyncio
async def test_web_runtime_runs_two_stages_with_request_first_snapshot(tmp_data_dir):
    lite = FakeModel(
        [
            ModelResponse(
                parts=[
                    ToolCallPart(
                        tool_name=OUTPUT_TOOL_NAME,
                        args={
                            "reply_text": "开工了喵~",
                            "should_draw": True,
                            "refined_resources": "",
                        },
                        tool_call_id="lite-1",
                    )
                ]
            ),
        ]
    )
    planner = FakeModel(
        [
            ModelResponse(
                parts=[
                    TextPart(
                        content=json.dumps(
                            {
                                "positive": "1girl, artist:req_style, masterpiece",
                                "negative": "lowres",
                                "characters": [],
                                "size": "Portrait",
                            }
                        )
                    )
                ]
            ),
        ]
    )
    req = WebPromptRequest.model_validate(
        {
            "user_request": "用A1画普拉娜",
            "history": [{"role": "user", "content": "上一轮画了校服"}],
            "image_b64": "iVBORw0KGgpwYXlsb2Fk",
            "knowledge_sources": ["artists", "ocs", "roleTags"],
            "web_artists": [{"id": "A1", "name": "Request A1", "prompt": "artist:req_style"}],
            "web_ocs": [
                {
                    "id": "plana",
                    "name": "普拉娜",
                    "zh_name": "普拉娜",
                    "positive": "request_oc",
                }
            ],
            "current_positive": "1girl, school uniform",
            "current_negative": "bad hands",
            "current_characters": [{"name": "普拉娜", "positive": "long hair", "negative": ""}],
        }
    )
    runtime = WebAgentRuntime(
        planner_model=planner,
        prefilter_model=lite,
        hooks=build_web_agent_hooks(),
        planner_model_settings={"temperature": 0.2},
        prefilter_model_settings={"temperature": 0.1},
        runtime_artists=[
            {"id": "A1", "name": "Runtime duplicate", "artist_string": "artist:runtime_style"},
            {"id": "B2", "name": "Runtime B2", "artist_string": "artist:b2"},
        ],
        runtime_ocs=[
            {"en_name": "plana", "zh_name": "普拉娜", "tag_group": "runtime_oc"},
            {"en_name": "arona", "zh_name": "阿罗娜", "tag_group": "arona_runtime"},
        ],
        role_mapping={
            "plana_(blue_archive)": {
                "role_en": "plana_(blue_archive)",
                "role_zh": ["普拉娜"],
                "origin_en": "blue_archive",
                "origin_zh": ["蔚蓝档案"],
            }
        },
    )
    events = []

    async def emit(event):
        events.append(event)

    result = await run_web_agent(req, runtime, emit)

    assert result.thinking == "开工了喵~"
    assert result.positive == "1girl, <<artist:Request A1:artist:req_style>>, masterpiece"
    assert result.negative == "lowres"
    assert events == []
    assert lite.calls[0]["model_settings"] == {"temperature": 0.1}
    assert planner.calls[0]["model_settings"] == {"temperature": 0.2}

    lite_input = "\n".join(_user_texts(lite.calls[0]))
    assert "A1 → artist:req_style" in lite_input
    assert "artist:runtime_style" not in lite_input
    assert "普拉娜 → request_oc" in lite_input
    assert "runtime_oc" not in lite_input
    assert "plana_(blue_archive)" in lite_input

    planner_input = "\n".join(_user_texts(planner.calls[0]))
    assert "[当前画面提示词]" in planner_input
    assert "1girl, school uniform" in planner_input
    assert "long hair" in planner_input
    assert "上一轮画了校服" in planner_input
    assert any(
        isinstance(item, BinaryContent)
        for message in planner.calls[0]["messages"]
        for part in getattr(message, "parts", [])
        if isinstance(part, UserPromptPart) and isinstance(part.content, list)
        for item in part.content
    )


@pytest.mark.asyncio
async def test_knowledge_snapshot_honors_selected_sources():
    deps = AgentDeps(
        user_id="web",
        platform="web",
        scene="web",
        knowledge_sources=["artists"],
        web_artists=[{"id": "A1", "name": "A1", "prompt": "artist:a"}],
        web_ocs=[{"id": "o1", "name": "OC", "positive": "oc_tag"}],
        role_mapping={"role": {"role_en": "role"}},
        knowledge_snapshot_injected=True,
    )

    assert [item["id"] for item in _load_artists_for_deps(deps)] == ["A1"]
    assert _load_ocs_for_deps(deps) == []
    assert await _get_role_mapping(deps) == {}


def test_request_entries_win_dedup_by_stable_identity():
    from agent_router.web_runtime import _merge_artist_contexts, _merge_oc_contexts

    artists = _merge_artist_contexts(
        [{"id": "A1", "name": "request", "prompt": "request_prompt"}],
        [{"id": "a1", "name": "runtime", "artist_string": "runtime_prompt"}],
    )
    ocs = _merge_oc_contexts(
        [{"id": "one", "name": "同名", "positive": "request_oc"}],
        [{"en_name": "other", "zh_name": "同名", "tag_group": "runtime_oc"}],
    )

    assert artists == [{"id": "A1", "name": "request", "prompt": "request_prompt"}]
    assert ocs == [{"id": "one", "name": "同名", "positive": "request_oc"}]


@pytest.mark.asyncio
async def test_internal_knowledge_calls_use_transport_headers():
    class FakeHttpClient:
        def __init__(self) -> None:
            self.kwargs: dict[str, Any] = {}

        async def get(self, _url: str, **kwargs: Any) -> object:
            self.kwargs = kwargs
            return object()

    client = FakeHttpClient()
    deps = AgentDeps(
        user_id="web",
        http_client=cast(Any, client),
        session_id="legacy-session",
        internal_headers={"Authorization": "Bearer process-token"},
    )

    await _internal_get(deps, "/api/test", {"query": "x"})

    assert client.kwargs["params"] == {"query": "x", "session_id": "legacy-session"}
    assert client.kwargs["headers"] == {"Authorization": "Bearer process-token"}
