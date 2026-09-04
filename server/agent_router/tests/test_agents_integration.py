"""
集成测试：用 FakeModel 驱动**真实**的 pure_planner_agent（生产实例），
验证真实 agent 配置（11 段 system prompt + 4 个知识工具 + DrawSpec 原生输出）
在自研框架下端到端可用。

不打真实 LLM / 不需要 server 在跑：FakeModel 按脚本返回，知识工具读本地库（缺则返回 []）。
"""

from __future__ import annotations

import json
import logging
from dataclasses import replace
from hashlib import sha256

import pytest

from agent_router.deps import AgentDeps
from agent_router.llm.messages import ModelResponse, TextPart, ToolCallPart
from agent_router.llm.models.base import Model
from agent_router.llm.output import OUTPUT_TOOL_NAME
from agent_router.llm.result import Usage


class FakeModel(Model):
    def __init__(self, responses):
        self.model_name = "fake"
        self._responses = list(responses)
        self.calls: list[dict] = []

    async def request(self, messages, *, system_parts, tools, require_tool, model_settings=None):
        self.calls.append(
            {
                "tool_names": [t.name for t in tools],
                "system_n": len(system_parts),
                "system_parts": list(system_parts),
                "require_tool": require_tool,
            }
        )
        return self._responses.pop(0), Usage(requests=1)


@pytest.mark.asyncio
async def test_pure_planner_produces_drawspec():
    from agent_router.agents.pure_planner import pure_planner_agent
    from agent_router.schemas import DrawSpec

    spec_args = {
        "positive": "1girl, masterpiece, artist:ciloranko",
        "negative": "lowres",
        "characters": [],
        "size": "Portrait",
    }
    fake = FakeModel(
        [ModelResponse(parts=[TextPart(content=json.dumps(spec_args, ensure_ascii=False))])]
    )
    deps = AgentDeps(user_id="t", scene="private")

    result = await pure_planner_agent.run("画一个女孩", deps=deps, model=fake)

    assert isinstance(result.output, DrawSpec)
    assert result.output.positive == "1girl, masterpiece, artist:ciloranko"
    assert result.output.negative == "lowres"
    assert result.output.size == "Portrait"
    # prompted JSON 不注册 final_result，但 4 个知识工具仍注册进请求
    names = fake.calls[0]["tool_names"]
    assert OUTPUT_TOOL_NAME not in names
    for t in ("search_character", "search_artist", "random_artist", "search_danbooru"):
        assert t in names
    # 真实 11 段 system prompt 解析成功（10 段 + anti_marker；空段也占位）
    assert fake.calls[0]["system_n"] >= 10
    # prompted JSON 结构化输出不强制工具调用
    assert fake.calls[0]["require_tool"] is False


@pytest.mark.parametrize("family", ["unknown", "v5"])
@pytest.mark.asyncio
async def test_v5_compatible_families_preserve_existing_planner_prompt_bytes(
    family,
    monkeypatch,
    tmp_path,
):
    """Old clients and V5 requests share the existing planner prompt contract."""
    from agent_router import prompts
    from agent_router.agents.pure_planner import pure_planner_agent

    monkeypatch.setenv("CPA_ENABLE_ANTI_MARKER", "false")
    monkeypatch.setattr(prompts, "_data_dir", lambda: tmp_path)
    prompts._load_yaml_cached.cache_clear()
    response = {
        "positive": "1girl",
        "negative": "",
        "characters": [],
        "size": None,
    }
    fake = FakeModel([ModelResponse(parts=[TextPart(content=json.dumps(response))])])

    await pure_planner_agent.run(
        "画一个女孩",
        deps=AgentDeps(user_id="t", image_model_family=family),
        model=fake,
    )

    contents = [part.content for part in fake.calls[0]["system_parts"]]
    payload = json.dumps(contents, ensure_ascii=False, separators=(",", ":")).encode()
    assert sha256(payload).hexdigest() == (
        "ee9f4a187987b1b29786be16f7f2f1bf436cb02c0058ce2d43a220190bb2b944"
    )


@pytest.mark.asyncio
async def test_v45_planner_uses_tag_only_mandate_and_keeps_skill_tools(monkeypatch):
    from agent_router.agents.pure_planner import pure_planner_agent

    monkeypatch.setenv("CPA_ENABLE_ANTI_MARKER", "false")
    response = {
        "positive": "1girl, city, night",
        "negative": "",
        "characters": [],
        "size": None,
    }
    fake = FakeModel([ModelResponse(parts=[TextPart(content=json.dumps(response))])])

    await pure_planner_agent.run(
        "画一个女孩",
        deps=AgentDeps(user_id="t", image_model_family="v45"),
        model=fake,
    )

    system_text = "\n\n".join(part.content for part in fake.calls[0]["system_parts"])
    assert "V4.5 纯 tag 路线" in system_text
    assert "§3 / §4 的句子判据在 V4.5 上不适用" in system_text
    assert "`text:` 块不可用" in system_text
    assert "角色上限为 6" in system_text
    assert "目前 deps 里没有 NAI 模型信息" not in system_text
    assert "read_prompting_skill" in fake.calls[0]["tool_names"]


@pytest.mark.asyncio
async def test_v45_planner_falls_back_when_override_bundle_predates_family_section(
    monkeypatch,
):
    from agent_router.agents.pure_planner import pure_planner_agent
    from agent_router.prompts import load_packaged_prompt_bundle

    monkeypatch.setenv("CPA_ENABLE_ANTI_MARKER", "false")
    packaged = load_packaged_prompt_bundle()
    old_override = replace(
        packaged,
        source="legacy prompts2.yaml",
        planner_sections={
            name: content
            for name, content in packaged.planner_sections.items()
            if name != "skill_mandate_v45"
        },
    )
    response = {
        "positive": "1girl",
        "negative": "",
        "characters": [],
        "size": None,
    }
    fake = FakeModel([ModelResponse(parts=[TextPart(content=json.dumps(response))])])

    await pure_planner_agent.run(
        "画一个女孩",
        deps=AgentDeps(
            user_id="t",
            image_model_family="v45",
            prompt_bundle=old_override,
        ),
        model=fake,
    )

    system_text = "\n\n".join(part.content for part in fake.calls[0]["system_parts"])
    assert "V4.5 纯 tag 路线" in system_text
    assert "目前 deps 里没有 NAI 模型信息" not in system_text


@pytest.mark.asyncio
async def test_pure_planner_tool_then_text_json():
    from agent_router.agents.pure_planner import pure_planner_agent
    from agent_router.schemas import DrawSpec

    # 第一轮调真实工具 random_artist（无 server 时读本地库，缺则返回 []，循环继续）；
    # 第二轮用文本 JSON 收尾。
    fake = FakeModel(
        [
            ModelResponse(
                parts=[
                    ToolCallPart(tool_name="random_artist", args={"count": 1}, tool_call_id="c1")
                ]
            ),
            ModelResponse(
                parts=[
                    TextPart(
                        content=json.dumps(
                            {"positive": "art", "negative": "", "characters": [], "size": None},
                            ensure_ascii=False,
                        )
                    )
                ]
            ),
        ]
    )
    deps = AgentDeps(user_id="t", scene="private")

    result = await pure_planner_agent.run("随机画一张", deps=deps, model=fake)

    assert isinstance(result.output, DrawSpec)
    assert result.output.positive == "art"
    # 工具往返了一轮后才收尾
    assert len(fake.calls) == 2
    # 第二轮请求里应包含上一轮 random_artist 的工具返回（ModelRequest 携带 ToolReturnPart）
    from agent_router.llm.messages import ModelRequest, ToolReturnPart

    second_call_msgs = []  # noqa: F841  (结构性校验通过 result.all_messages 更稳)
    tool_returns = [
        p
        for m in result.all_messages()
        if isinstance(m, ModelRequest)
        for p in m.parts
        if isinstance(p, ToolReturnPart) and p.tool_name == "random_artist"
    ]
    assert len(tool_returns) == 1


@pytest.mark.asyncio
async def test_lite_chat_run_with_fake(tmp_data_dir):
    """run_lite_chat accepts the request-scoped model used by both transports."""
    from agent_router.agents import lite_chat as lc
    from agent_router.schemas import LiteResponse

    # 模块导入不应要求 Bot 的可选 config.py 或立即创建上游 client。
    assert lc.lite_chat_agent._default_model is None

    lite_args = {"reply_text": "在画了喵~", "should_draw": True, "refined_resources": ""}
    fake = FakeModel(
        [
            ModelResponse(
                parts=[ToolCallPart(tool_name=OUTPUT_TOOL_NAME, args=lite_args, tool_call_id="c1")]
            )
        ]
    )
    deps = AgentDeps(user_id="t", scene="private")
    result, messages, sys_parts = await lc.run_lite_chat(
        user_text="画个女孩",
        candidates="",
        history=[],
        deps=deps,
        model=fake,
    )
    assert isinstance(result, LiteResponse)
    assert result.should_draw is True
    assert result.reply_text == "在画了喵~"


@pytest.mark.asyncio
async def test_lite_chat_failure_log_redacts_provider_body(tmp_data_dir, caplog):
    from agent_router.agents import lite_chat as lc
    from agent_router.llm.exceptions import ModelHTTPError

    secret = "provider-response-secret"

    class FailingModel(Model):
        model_name = "failing"

        async def request(
            self,
            messages,
            *,
            system_parts,
            tools,
            require_tool,
            model_settings=None,
        ):
            del messages, system_parts, tools, require_tool, model_settings
            raise ModelHTTPError(503, secret, body=secret)

    caplog.set_level(logging.WARNING, logger=lc.__name__)
    result, _messages, _sys_parts = await lc.run_lite_chat(
        user_text="画个女孩",
        candidates="",
        history=[],
        deps=AgentDeps(user_id="t", scene="private"),
        model=FailingModel(),
    )

    logs = "\n".join(caplog.messages)
    assert result.should_draw is True
    assert "error_type=ModelHTTPError" in logs
    assert "provider_status=503" in logs
    assert secret not in logs
    assert "model error" not in logs.lower()
