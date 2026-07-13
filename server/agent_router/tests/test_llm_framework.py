"""
自研 llm 框架单测 —— 用 FakeModel 驱动 Agent.run，验证核心行为契约。

覆盖：
    - StrOutput（health 探针式）
    - NativeStructuredOutput（final_result 工具收尾）+ 工具往返
    - ModelRetry（output_validator 触发重试后成功）
    - 反复空输出 -> UnexpectedModelBehavior（含 router 匹配的两个子串）
    - system_prompt 顺序 / system_prompt_parts
    - all_messages 带 history 时省略 SystemPromptPart、无 history 时并入首条
    - ToolReturnPart.content 保留原始结构化返回值
    - 无 $ref schema 生成 / Gemini schema 清洗 / OpenAI strict 转换
    - PromptedJsonOutput 解析 / extract_json_object 健壮性 / 工具入参 schema
"""

from __future__ import annotations

import json
from typing import cast

import pytest
from pydantic import BaseModel, Field

from agent_router.llm import (
    Agent,
    BinaryContent,
    ModelRequest,
    ModelResponse,
    ModelRetry,
    PromptedOutput,
    RunContext,
    SystemPromptPart,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
    UnexpectedModelBehavior,
    UserPromptPart,
)
from agent_router.llm.models.base import Model
from agent_router.llm.models.google import _to_gemini_schema
from agent_router.llm.models.openai import _to_openai_strict
from agent_router.llm.output import (
    OUTPUT_TOOL_NAME,
    build_inlined_json_schema,
    extract_json_object,
)
from agent_router.llm.result import Usage
from agent_router.llm.tools import build_param_schema, build_registered_tool

# ============================================================
# FakeModel
# ============================================================


class FakeModel(Model):
    """按脚本逐条返回 ModelResponse，记录每次请求入参。"""

    def __init__(self, responses: list[ModelResponse]) -> None:
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
        resp = self._responses.pop(0)
        return resp, Usage(input_tokens=3, output_tokens=5, total_tokens=8, requests=1)


class Sample(BaseModel):
    positive: str = Field(..., description="全局正向 tag")
    negative: str = Field("", description="全局反向 tag")
    characters: list[dict[str, str]] = Field(default_factory=list, description="分角色")
    size: str | None = Field(None, description="尺寸")


# ============================================================
# StrOutput
# ============================================================


@pytest.mark.asyncio
async def test_str_output():
    model = FakeModel([ModelResponse(parts=[TextPart(content="pong")])])
    agent = Agent(model, output_type=str)
    result = await agent.run("ping")
    assert result.output == "pong"
    assert result.usage.input_tokens == 3


# ============================================================
# Native 结构化输出 + 工具往返
# ============================================================


@pytest.mark.asyncio
async def test_native_with_tool_roundtrip():
    model = FakeModel(
        [
            # 第一轮：调用用户工具
            ModelResponse(
                parts=[ToolCallPart(tool_name="lookup", args={"q": "x"}, tool_call_id="c1")]
            ),
            # 第二轮：调用 final_result 收尾
            ModelResponse(
                parts=[
                    ToolCallPart(
                        tool_name=OUTPUT_TOOL_NAME,
                        args={"positive": "1girl", "negative": "", "characters": [], "size": None},
                        tool_call_id="c2",
                    )
                ]
            ),
        ]
    )
    agent: Agent = Agent(model, output_type=Sample, retries=3)

    captured = {}

    @agent.tool
    async def lookup(ctx: RunContext, q: str) -> list[dict]:
        """查点东西"""
        captured["q"] = q
        return [{"name": "n1", "tags": "t1"}]

    result = await agent.run("hi")
    assert isinstance(result.output, Sample)
    assert result.output.positive == "1girl"
    assert captured["q"] == "x"
    # 两轮请求
    assert len(model.calls) == 2
    # require_tool=True（native）
    assert model.calls[0]["require_tool"] is True
    # 工具返回原始结构化值挂在 ToolReturnPart.content
    tool_returns = [
        p
        for m in result.all_messages()
        if isinstance(m, ModelRequest)
        for p in m.parts
        if isinstance(p, ToolReturnPart) and p.tool_name == "lookup"
    ]
    assert tool_returns and tool_returns[0].content == [{"name": "n1", "tags": "t1"}]


# ============================================================
# ModelRetry（validator 触发）
# ============================================================


@pytest.mark.asyncio
async def test_output_validator_model_retry():
    model = FakeModel(
        [
            ModelResponse(
                parts=[
                    ToolCallPart(
                        tool_name=OUTPUT_TOOL_NAME, args={"positive": "bad"}, tool_call_id="c1"
                    )
                ]
            ),
            ModelResponse(
                parts=[
                    ToolCallPart(
                        tool_name=OUTPUT_TOOL_NAME, args={"positive": "good"}, tool_call_id="c2"
                    )
                ]
            ),
        ]
    )
    agent: Agent = Agent(model, output_type=Sample, retries=3)

    @agent.output_validator
    async def must_be_good(ctx: RunContext, out: Sample) -> Sample:
        if out.positive != "good":
            raise ModelRetry("positive 必须是 good")
        return out

    result = await agent.run("hi")
    assert result.output.positive == "good"
    assert len(model.calls) == 2


# ============================================================
# 反复空输出 -> UnexpectedModelBehavior（含 router 匹配子串）
# ============================================================


@pytest.mark.asyncio
async def test_empty_output_raises_with_router_substrings():
    # native 却只回文本，从不调用 final_result
    model = FakeModel([ModelResponse(parts=[TextPart(content="我不调工具")]) for _ in range(6)])
    agent: Agent = Agent(model, output_type=Sample, retries=2)
    with pytest.raises(UnexpectedModelBehavior) as ei:
        await agent.run("hi")
    msg = str(ei.value).lower()
    assert "exceeded maximum output retries" in msg
    assert "please return text or include your response in a tool call" in msg


# ============================================================
# system_prompt 顺序 + system_prompt_parts
# ============================================================


@pytest.mark.asyncio
async def test_system_prompt_order_and_parts():
    model = FakeModel([ModelResponse(parts=[TextPart(content="ok")])])
    agent = Agent(model, output_type=str)

    @agent.system_prompt
    async def a(ctx: RunContext) -> str:
        return "AAA"

    @agent.system_prompt
    async def b(ctx: RunContext) -> str:
        return "BBB"

    parts = await agent.system_prompt_parts(deps=None)
    assert [p.content for p in parts] == ["AAA", "BBB"]

    await agent.run("hi")
    # 无 history -> system 段并入首条 ModelRequest 的 parts，且顺序保持
    sys_in_first = [p.content for p in model.calls[0]["system_parts"]]
    assert sys_in_first == ["AAA", "BBB"]


# ============================================================
# all_messages：history 时省略 system，无 history 时并入
# ============================================================


@pytest.mark.asyncio
async def test_all_messages_system_omission_with_history():
    model = FakeModel([ModelResponse(parts=[TextPart(content="ok")])])
    agent = Agent(model, output_type=str)

    @agent.system_prompt
    async def sp(ctx: RunContext) -> str:
        return "SYS"

    history = [
        ModelRequest(parts=[UserPromptPart(content="prev-user")]),
        ModelResponse(parts=[TextPart(content="prev-assistant")]),
    ]
    result = await agent.run("hi", message_history=history)
    msgs = result.all_messages()
    # 带 history：任何消息里都不应出现 SystemPromptPart
    has_system = any(
        isinstance(m, ModelRequest) and any(isinstance(p, SystemPromptPart) for p in m.parts)
        for m in msgs
    )
    assert has_system is False
    # 但 system 仍通过 system_parts 传给了 provider
    assert [p.content for p in model.calls[0]["system_parts"]] == ["SYS"]
    # new_messages 只含本轮（user + assistant）
    assert len(result.new_messages()) == 2


@pytest.mark.asyncio
async def test_all_messages_system_inlined_without_history():
    model = FakeModel([ModelResponse(parts=[TextPart(content="ok")])])
    agent = Agent(model, output_type=str)

    @agent.system_prompt
    async def sp(ctx: RunContext) -> str:
        return "SYS"

    result = await agent.run("hi")
    first = result.all_messages()[0]
    assert isinstance(first, ModelRequest)
    assert any(isinstance(p, SystemPromptPart) and p.content == "SYS" for p in first.parts)


# ============================================================
# schema 生成 / 清洗
# ============================================================


def test_build_inlined_json_schema_no_ref():
    schema = build_inlined_json_schema(Sample)
    blob = json.dumps(schema)
    assert "$ref" not in blob and "$defs" not in blob
    assert schema["required"] == ["positive"]
    # 描述逐字保留
    assert schema["properties"]["positive"]["description"] == "全局正向 tag"


def test_gemini_schema_cleaning():
    schema = build_inlined_json_schema(Sample)
    g = _to_gemini_schema(schema)
    blob = json.dumps(g)
    assert "additionalProperties" not in blob
    assert "anyOf" not in blob
    # size 由 Optional -> nullable
    assert g["properties"]["size"].get("nullable") is True


def test_openai_strict_transform():
    schema, names, required, defaults = build_param_schema(_sample_tool_fn)
    strict = _to_openai_strict(schema)
    assert strict["additionalProperties"] is False
    # strict 下所有字段进 required
    assert set(strict["required"]) == set(strict["properties"].keys())


# ============================================================
# 工具入参 schema
# ============================================================


def _sample_tool_fn(  # noqa: ANN001
    ctx, query: str | None = None, limit: int = 30, must: str = cast(str, ...)
):
    """sample"""
    return []


def test_build_param_schema():
    def fn(ctx, query: str | None = None, limit: int = 30, must=None, *, kw: str = "x"):
        """doc"""
        return []

    # 用真实签名：must 无默认 -> required
    def fn2(ctx, must: str, query: str | None = None, limit: int = 30):
        """doc2"""
        return []

    schema, names, required, defaults = build_param_schema(fn2)
    assert names == ["must", "query", "limit"]
    assert required == ["must"]
    assert defaults == {"query": None, "limit": 30}
    assert schema["properties"]["limit"]["type"] == "integer"
    assert schema["properties"]["query"]["type"] == "string"


@pytest.mark.asyncio
async def test_tool_invoke_defaults():
    tool = build_registered_tool(_echo_tool, strict=True)
    rc = RunContext(deps=None)
    # 不传 limit -> 用默认 30
    out = await tool.invoke(rc, {"query": "hello"})
    assert out == {"query": "hello", "limit": 30}


async def _echo_tool(ctx, query: str, limit: int = 30):
    """echo"""
    return {"query": query, "limit": limit}


@pytest.mark.asyncio
async def test_tool_invoke_coerces_stringified_array():
    tool = build_registered_tool(_list_tool, strict=True)
    rc = RunContext(deps=None)
    assert await tool.invoke(rc, {"ids": '["A1", "B2"]'}) == ["A1", "B2"]
    assert await tool.invoke(rc, {"ids": "A1, B2"}) == ["A1", "B2"]


async def _list_tool(ctx, ids: list[str]):
    """list"""
    return ids


# ============================================================
# PromptedJsonOutput / extract_json_object
# ============================================================


@pytest.mark.asyncio
async def test_prompted_json_output():
    payload = {"positive": "p", "negative": "", "characters": [], "size": None}
    fenced = "这是结果喵：\n```json\n" + json.dumps(payload) + "\n```\n（以上）"
    model = FakeModel([ModelResponse(parts=[TextPart(content=fenced)])])
    agent = Agent(model, output_type=PromptedOutput(Sample), retries=2)
    result = await agent.run("hi")
    assert isinstance(result.output, Sample)
    assert result.output.positive == "p"
    # prompted -> 不要求强制工具调用
    assert model.calls[0]["require_tool"] is False


def test_extract_json_object():
    assert json.loads(extract_json_object('前言 {"a": 1} 后语')) == {"a": 1}
    assert json.loads(extract_json_object('```json\n{"a": {"b": 2}}\n```')) == {"a": {"b": 2}}
    assert json.loads(extract_json_object('{"s": "}not end"}')) == {"s": "}not end"}


# ============================================================
# BinaryContent 标量/列表归一
# ============================================================


@pytest.mark.asyncio
async def test_binary_content_in_user_message():
    model = FakeModel([ModelResponse(parts=[TextPart(content="ok")])])
    agent = Agent(model, output_type=str)
    img = BinaryContent(data=b"\x89PNG", media_type="image/png")
    await agent.run(["看图", img])
    # 用户输入作为单条 UserPromptPart.content（list）传入
    first_req = model.calls[0]["messages"][0]
    up = [p for p in first_req.parts if isinstance(p, UserPromptPart)][0]
    assert isinstance(up.content, list)
    assert any(isinstance(x, BinaryContent) for x in up.content)


# ============================================================
# 回归：native final_result 解析失败的重试携带 tool_call_id（回应挂起 tool_use）
# ============================================================


@pytest.mark.asyncio
async def test_native_parse_error_retry_carries_tool_call_id():
    from agent_router.llm.messages import RetryPromptPart

    # attempt1: final_result 缺必填 positive -> 校验失败 -> 重试；attempt2: 合法
    model = FakeModel(
        [
            ModelResponse(
                parts=[
                    ToolCallPart(
                        tool_name=OUTPUT_TOOL_NAME, args={"negative": "x"}, tool_call_id="c1"
                    )
                ]
            ),
            ModelResponse(
                parts=[
                    ToolCallPart(
                        tool_name=OUTPUT_TOOL_NAME, args={"positive": "ok"}, tool_call_id="c2"
                    )
                ]
            ),
        ]
    )
    agent = Agent(model, output_type=Sample, retries=3)
    result = await agent.run("hi")
    assert result.output.positive == "ok"
    retry_parts = [
        p
        for m in result.all_messages()
        if isinstance(m, ModelRequest)
        for p in m.parts
        if isinstance(p, RetryPromptPart)
    ]
    # 重试必须作为对 final_result(c1) 的 tool_result 回应（带 tool_name + tool_call_id）
    assert retry_parts
    assert retry_parts[0].tool_name == OUTPUT_TOOL_NAME
    assert retry_parts[0].tool_call_id == "c1"


@pytest.mark.asyncio
async def test_validator_retry_carries_tool_call_id():
    from agent_router.llm.messages import RetryPromptPart

    model = FakeModel(
        [
            ModelResponse(
                parts=[
                    ToolCallPart(
                        tool_name=OUTPUT_TOOL_NAME, args={"positive": "bad"}, tool_call_id="c1"
                    )
                ]
            ),
            ModelResponse(
                parts=[
                    ToolCallPart(
                        tool_name=OUTPUT_TOOL_NAME, args={"positive": "good"}, tool_call_id="c2"
                    )
                ]
            ),
        ]
    )
    agent = Agent(model, output_type=Sample, retries=3)

    @agent.output_validator
    async def must_good(ctx, out):
        if out.positive != "good":
            raise ModelRetry("要 good")
        return out

    result = await agent.run("hi")
    assert result.output.positive == "good"
    retry_parts = [
        p
        for m in result.all_messages()
        if isinstance(m, ModelRequest)
        for p in m.parts
        if isinstance(p, RetryPromptPart)
    ]
    assert retry_parts and retry_parts[0].tool_call_id == "c1"


# ============================================================
# 回归：工具抛 ModelRetry 消耗 retries 预算（不无界重投到 _MAX_ITERATIONS）
# ============================================================


@pytest.mark.asyncio
async def test_tool_model_retry_consumes_budget():
    model = FakeModel(
        [
            ModelResponse(
                parts=[ToolCallPart(tool_name="always_retry", args={}, tool_call_id=f"c{i}")]
            )
            for i in range(12)
        ]
    )
    agent = Agent(model, output_type=Sample, retries=2)

    @agent.tool
    async def always_retry(ctx):
        """总是要求重试"""
        raise ModelRetry("再来一次")

    with pytest.raises(UnexpectedModelBehavior):
        await agent.run("hi")
    # retries=2 -> 初始 + 2 次重试后放弃，共 3 次模型调用；绝不应跑到 _MAX_ITERATIONS(16)
    assert len(model.calls) <= 4
