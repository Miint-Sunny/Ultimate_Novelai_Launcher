"""
pydantic 模型 round-trip 测试 —— 与 PydanticAI 无关，可在任何环境跑。
"""

from __future__ import annotations

import pytest

from agent_router.schemas import (
    AgentResult,
    ChatImage,
    ChatRequest,
    ChatResponse,
    DrawSpec,
    HistoryMessage,
    SseEvent,
    WebPromptRequest,
)


def test_draw_spec_minimal():
    spec = DrawSpec(positive="1girl, smile")
    assert spec.positive == "1girl, smile"
    assert spec.negative == ""
    assert spec.characters == []
    # round-trip
    raw = spec.model_dump()
    spec2 = DrawSpec(**raw)
    assert spec2 == spec


def test_draw_spec_with_characters():
    # DrawSpec 简化后字段只剩 positive/negative/characters/size
    spec = DrawSpec.model_validate(
        {
            "positive": "2girls",
            "characters": [
                {"name": "A", "positive": "1girl, blonde", "negative": ""},
                {"name": "B", "positive": "1girl, black hair", "negative": "hat"},
            ],
            "size": "Portrait",
        }
    )
    assert len(spec.characters) == 2
    # characters 现为具名 DrawCharacter；生产代码统一经 model_dump() 取 dict 形态消费。
    dumped = spec.model_dump()["characters"]
    assert dumped[0]["negative"] == ""
    assert dumped[1]["negative"] == "hat"
    assert dumped[0]["name"] == "A" and dumped[0]["positive"] == "1girl, blonde"
    raw = spec.model_dump()
    spec2 = DrawSpec(**raw)
    assert spec2 == spec


def test_chat_request_default_scene():
    req = ChatRequest(user_id="123", text="你好")
    assert req.scene == "private"
    assert req.model == ""  # 空 = 用全局默认 model
    assert req.image_model == ""
    assert req.platform == "qq"
    assert req.images == []


def test_chat_request_with_image():
    req = ChatRequest(
        user_id="123",
        text="画一张",
        images=[ChatImage(base64="abc==", mime_type="image/png")],
        scene="group",
        group_id="999",
    )
    assert req.scene == "group"
    assert req.images[0].base64 == "abc=="
    assert req.images[0].is_generated is False


def test_chat_response_defaults():
    resp = ChatResponse(reply_text="你好喵~")
    assert resp.should_draw is False
    assert resp.degraded is False
    assert resp.draw_specs == []
    assert resp.history_updated is True


def test_agent_result_matches_frontend_schema():
    """前端 agentService.ts 期望的 AgentResult 形状（vibes 字段已删除）"""
    r = AgentResult(
        thinking="思考内容",
        positive="1girl",
        negative="bad quality",
        characters=[{"name": "A", "positive": "x", "negative": ""}],
    )
    raw = r.model_dump()
    assert set(raw.keys()) >= {"thinking", "positive", "negative", "characters"}
    assert "vibes" not in raw  # 已删除


def test_sse_event_serialization():
    evt = SseEvent(
        event="tool_call", data={"name": "search_artist", "arguments": {"keyword": "k1"}}
    )
    raw = evt.model_dump()
    assert raw["event"] == "tool_call"
    assert raw["data"]["name"] == "search_artist"


def test_web_prompt_request_default_knowledge_sources():
    req = WebPromptRequest(user_request="画 hatsune")
    assert req.model == ""  # 空 = 用全局默认 model
    assert req.image_model == ""
    assert "roleTags" in req.knowledge_sources
    assert req.history == []
    assert req.use_codex is False


def test_web_prompt_request_accepts_web_local_context():
    req = WebPromptRequest.model_validate(
        {
            "user_request": "画我的 OC，使用 A1",
            "web_artists": [{"id": "A1", "name": "A1", "prompt": "artist:test"}],
            "web_ocs": [{"id": "oc1", "name": "自设", "positive": "my_oc, blue hair"}],
        }
    )
    assert req.web_artists[0].prompt == "artist:test"
    assert req.web_ocs[0].positive == "my_oc, blue hair"


def test_web_prompt_request_accepts_image_only_and_preserves_mime():
    req = WebPromptRequest(
        user_request="",
        image_b64="/9j/cGF5bG9hZA==",
        image_mime_type="image/jpeg",
    )
    assert req.image_mime_type == "image/jpeg"

    inferred = WebPromptRequest(user_request="", image_b64="/9j/cGF5bG9hZA==")
    assert inferred.image_mime_type == "image/jpeg"


@pytest.mark.parametrize(
    "payload",
    [
        {"user_request": ""},
        {"user_request": "x", "image_b64": "not base64"},
        {
            "user_request": "x",
            "image_b64": "/9j/cGF5bG9hZA==",
            "image_mime_type": "image/png",
        },
        {
            "user_request": "x",
            "image_b64": "/9j/cGF5bG9hZA==",
            "image_mime_type": "image/svg+xml",
        },
    ],
)
def test_web_prompt_request_rejects_missing_or_invalid_image(payload):
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        WebPromptRequest.model_validate(payload)


def test_web_prompt_request_nested_models_preserve_wire_shape():
    req = WebPromptRequest.model_validate(
        {
            "user_request": "在原图上修改",
            "history": [{"role": "user", "content": "上一轮"}],
            "web_artists": [{"id": "A1", "name": "画师", "prompt": ""}],
            "web_ocs": [{"id": "oc1", "name": "OC", "zh_name": "自设"}],
            "current_characters": [{"name": "角色A", "positive": "x"}],
        }
    )
    dumped = req.model_dump()
    assert dumped["history"] == [{"role": "user", "content": "上一轮"}]
    assert dumped["web_artists"] == [{"id": "A1", "name": "画师", "prompt": ""}]
    assert dumped["current_characters"][0]["positive"] == "x"


@pytest.mark.parametrize(
    "payload",
    [
        {"user_request": "x", "unknown": True},
        {"user_request": "x", "history": [{"role": "user", "content": "x", "extra": 1}]},
        {
            "user_request": "x",
            "web_artists": [{"id": "A1", "name": "A1", "prompt": "x", "extra": 1}],
        },
        {"user_request": "x", "web_ocs": [{"id": "o", "name": "o", "extra": 1}]},
        {"user_request": "x", "web_codex": [{"title": "t", "content": "c", "extra": 1}]},
    ],
)
def test_web_prompt_request_forbids_unknown_fields(payload):
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        WebPromptRequest.model_validate(payload)


@pytest.mark.asyncio
async def test_web_prequery_context_matches_bot_style(monkeypatch):
    from agent_router.deps import AgentDeps
    from agent_router.tools import knowledge
    from agent_router.web_hooks import _build_web_prequery_context

    monkeypatch.setattr(
        knowledge,
        "_load_artists_for_deps",
        lambda deps: [{"id": "A36", "name": "A36", "artist_string": "artist:test_style"}],
    )
    monkeypatch.setattr(
        knowledge,
        "_load_ocs_for_deps",
        lambda deps: [
            {"en_name": "oc_plana", "zh_name": "普拉娜", "zh_aliases": [], "tag_group": "plana_oc"}
        ],
    )

    async def fake_role_mapping(deps):
        return {
            "plana_(blue_archive)": {
                "role_en": "plana_(blue_archive)",
                "role_zh": ["普拉娜"],
                "origin_en": "blue_archive",
                "origin_zh": ["蔚蓝档案"],
            }
        }

    monkeypatch.setattr(knowledge, "_get_role_mapping", fake_role_mapping)

    req = WebPromptRequest(user_request="用A36画普拉娜")
    deps = AgentDeps(user_id="web_anon", platform="web", scene="web")
    context = await _build_web_prequery_context(req, deps)

    assert "[预查询资源]" in context
    assert "## search_artist 结果" in context
    assert "A36 → artist:test_style" in context
    assert "## search_character 结果（source=oc）" in context
    assert "普拉娜 → plana_oc" in context
    assert "## search_character 结果（source=roleTag）" in context
    assert "plana_(blue_archive)" in context


@pytest.mark.asyncio
async def test_web_codex_toggle_controls_request_context():
    from agent_router.deps import AgentDeps
    from agent_router.web_hooks import _build_web_prequery_context

    codex = [
        {
            "id": "common_1",
            "category": "科幻",
            "title": "赛博月光",
            "content": "cyberpunk city, blue moonlight, neon reflections",
            "is_r18": False,
        }
    ]
    req = WebPromptRequest.model_validate(
        {"user_request": "画一张赛博月光城市", "use_codex": True, "web_codex": codex}
    )
    enabled = AgentDeps(
        user_id="web",
        platform="web",
        scene="web",
        use_codex=True,
        web_codex=codex,
        knowledge_sources=[],
        knowledge_snapshot_injected=True,
        role_mapping={},
    )
    disabled = AgentDeps(
        user_id="web",
        platform="web",
        scene="web",
        use_codex=False,
        web_codex=codex,
        knowledge_sources=[],
        knowledge_snapshot_injected=True,
        role_mapping={},
    )

    assert "## search_codex 结果" in await _build_web_prequery_context(req, enabled)
    assert "search_codex" not in await _build_web_prequery_context(req, disabled)


def test_history_message_alias():
    """HistoryMessage 字段 alias: _is_generated_image → is_generated_image"""
    m = HistoryMessage.model_validate(
        {"role": "assistant", "content": "hi", "_is_generated_image": True}
    )
    assert m.is_generated_image is True

    # 反过来：用 python 名字写
    m2 = HistoryMessage(role="user", content="x", is_generated_image=False)
    assert m2.is_generated_image is False


def test_group_user_key_is_separated_by_user():
    from agent_router.router import _build_user_key

    first = ChatRequest(user_id="111", platform="qq", scene="group", group_id="999", text="a")
    second = ChatRequest(user_id="222", platform="qq", scene="group", group_id="999", text="b")
    private = ChatRequest(user_id="111", platform="qq", scene="private", text="c")

    assert _build_user_key(first) == "qq_g_999_u_111"
    assert _build_user_key(second) == "qq_g_999_u_222"
    assert _build_user_key(first) != _build_user_key(second)
    assert _build_user_key(private) == "qq_p_111"


def test_web_agent_result_wraps_artist_markers_only_for_web():
    from agent_router.deps import AgentDeps
    from agent_router.schemas import ChatOutput
    from agent_router.web_hooks import _chat_output_to_agent_result

    output = ChatOutput(
        reply_text="ok",
        should_draw=True,
        draw_spec={
            "positive": "1girl, artist:test_style, masterpiece",
            "negative": "",
            "characters": [],
        },
    )

    web_deps = AgentDeps(
        user_id="web",
        platform="web",
        scene="web",
        web_artists=[{"id": "A1", "name": "A1", "prompt": "artist:test_style"}],
    )
    bot_deps = AgentDeps(user_id="bot", platform="qq", scene="private")

    assert _chat_output_to_agent_result(output, web_deps).positive == (
        "1girl, <<artist:A1:artist:test_style>>, masterpiece"
    )
    assert (
        _chat_output_to_agent_result(output, bot_deps).positive
        == "1girl, artist:test_style, masterpiece"
    )


def test_requested_character_prompts_are_restored_from_prequery_resources():
    from agent_router.web_hooks import _ensure_requested_character_prompts

    prequery = (
        "## search_character 结果（source=roleTag）\n"
        "plana_(blue_archive) → 中文: 普拉娜、星奈 / 出处: blue_archive\n"
        "arona_(blue_archive) → 中文: 阿罗娜、彩奈 / 出处: blue_archive"
    )
    draw_specs = [
        {
            "positive": "2girls, plana_(blue_archive), arona_(blue_archive), simple background",
            "negative": "",
            "characters": [],
        }
    ]

    out = _ensure_requested_character_prompts(
        draw_specs,
        user_text="c18画一个普拉娜和阿罗娜，用分角色提示词",
        prequery_output=prequery,
    )

    assert out[0]["characters"] == [
        {"name": "plana_(blue_archive)", "positive": "plana_(blue_archive)", "negative": ""},
        {"name": "arona_(blue_archive)", "positive": "arona_(blue_archive)", "negative": ""},
    ]
    assert "plana_(blue_archive)" not in out[0]["positive"]
    assert "arona_(blue_archive)" not in out[0]["positive"]
    assert "2girls" in out[0]["positive"]


def test_web_current_prompt_context_tells_agent_to_edit_existing_prompt():
    from agent_router.schemas import WebPromptRequest
    from agent_router.web_hooks import _build_current_prompt_context

    req = WebPromptRequest.model_validate(
        {
            "user_request": "给她换成冬装",
            "current_positive": "1girl, blue eyes, school uniform",
            "current_negative": "lowres",
            "current_characters": [
                {
                    "name": "角色A",
                    "positive": "long hair",
                    "negative": "bad hands",
                }
            ],
        }
    )

    context = _build_current_prompt_context(req)

    assert "[当前画面提示词]" in context
    assert "全局正向 (positive): 1girl, blue eyes, school uniform" in context
    assert "全局反向 (negative): lowres" in context
    assert "角色A: long hair" in context
    assert "请以它们为基础" in context
    assert "完整" in context
