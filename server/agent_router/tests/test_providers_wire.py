"""
三家 provider 的 wire-format 纯函数测试（不联网）。

直接调各 Model._build_body，断言请求体结构符合各家 API 约定 + 行为契约：
    - OpenAI：多 system 消息 / 图文 user / assistant tool_calls / role:tool 返回 /
              strict schema（additionalProperties:false + required 全字段）/
              extra_body 覆盖计算出的 tool_choice / temperature·max_tokens·parallel_tool_calls
    - Gemini：systemInstruction / user·model 交替 / inlineData 图 / functionCall·functionResponse /
              functionDeclarations + schema 清洗
              （无 anyOf/additionalProperties，Optional->nullable）/
              toolConfig mode ANY / thinkingConfig / safetySettings
    - Anthropic：system text blocks / tool_use·tool_result / input_schema /
                 tool_choice any / max_tokens
"""

from __future__ import annotations

import json

from agent_router.llm.messages import (
    BinaryContent,
    ModelRequest,
    ModelResponse,
    SystemPromptPart,
    ToolCallPart,
    ToolDefinition,
    ToolReturnPart,
    UserPromptPart,
)
from agent_router.llm.models.anthropic import AnthropicModel
from agent_router.llm.models.google import GoogleModel
from agent_router.llm.models.openai import OpenAIModel
from agent_router.llm.providers import AnthropicProvider, GoogleProvider, OpenAIProvider


def _sample_inputs():
    system_parts = [SystemPromptPart(content="S1"), SystemPromptPart(content="S2")]
    messages = [
        ModelRequest(
            parts=[
                UserPromptPart(
                    content=["看图", BinaryContent(data=b"\x89PNG", media_type="image/png")]
                )
            ]
        ),
        ModelResponse(
            parts=[
                ToolCallPart(tool_name="search_artist", args={"keyword": "x"}, tool_call_id="t1")
            ]
        ),
        ModelRequest(
            parts=[
                ToolReturnPart(
                    tool_name="search_artist",
                    content=[{"id": "A1", "prompt": "p"}],
                    tool_call_id="t1",
                )
            ]
        ),
    ]
    tools = [
        ToolDefinition(
            name="search_artist",
            description="搜画师",
            parameters_json_schema={
                "type": "object",
                "properties": {
                    "keyword": {"type": "string"},
                    "artist_ids": {"type": "array", "items": {"type": "string"}},
                },
                "required": [],
            },
            strict=True,
        ),
        ToolDefinition(
            name="final_result",
            description="提交结果",
            parameters_json_schema={
                "type": "object",
                "properties": {
                    "positive": {"type": "string", "description": "正向"},
                    "size": {"anyOf": [{"type": "string"}, {"type": "null"}]},
                    "characters": {
                        "type": "array",
                        "items": {"type": "object", "additionalProperties": {"type": "string"}},
                    },
                },
                "required": ["positive"],
            },
            strict=False,
        ),
    ]
    return system_parts, messages, tools


# ============================================================
# OpenAI
# ============================================================


def test_openai_wire():
    system_parts, messages, tools = _sample_inputs()
    model = OpenAIModel("deepseek-v4-pro", OpenAIProvider(base_url="http://x/v1", api_key="k"))
    settings = {
        "temperature": 0.3,
        "max_tokens": 4096,
        "parallel_tool_calls": False,
        "extra_body": {"thinking": {"type": "disabled"}, "tool_choice": "auto"},
    }
    body = model._build_body(messages, system_parts, tools, require_tool=True, settings=settings)

    roles = [m["role"] for m in body["messages"]]
    assert roles[:2] == ["system", "system"]
    assert "user" in roles and "assistant" in roles and "tool" in roles

    # 图文 user：content 为 list，含 image_url
    user_msg = next(m for m in body["messages"] if m["role"] == "user")
    assert isinstance(user_msg["content"], list)
    assert any(p.get("type") == "image_url" for p in user_msg["content"])

    # assistant 带 tool_calls
    asst = next(m for m in body["messages"] if m["role"] == "assistant")
    assert asst["tool_calls"][0]["function"]["name"] == "search_artist"

    # role:tool 返回
    tool_msg = next(m for m in body["messages"] if m["role"] == "tool")
    assert tool_msg["tool_call_id"] == "t1"

    # strict 工具：additionalProperties:false + required 含全字段
    fns = {t["function"]["name"]: t["function"] for t in body["tools"]}
    sa = fns["search_artist"]
    assert sa.get("strict") is True
    assert sa["parameters"]["additionalProperties"] is False
    assert set(sa["parameters"]["required"]) == {"keyword", "artist_ids"}
    assert sa["parameters"]["properties"]["artist_ids"]["type"] == "string"
    assert '"type": "array"' not in json.dumps(body["tools"])
    # 非 strict 的 final_result 不强加 additionalProperties:false，但复杂字段仍会标量化
    fr = fns["final_result"]
    assert "strict" not in fr
    assert fr["parameters"].get("required") == ["positive"]

    # extra_body 覆盖计算出的 tool_choice（required -> auto），thinking 并入顶层
    assert body["tool_choice"] == "auto"
    assert body["thinking"] == {"type": "disabled"}
    assert body["temperature"] == 0.3
    assert body["max_tokens"] == 4096
    assert body["parallel_tool_calls"] is False


def test_openai_text_only_model_strips_images():
    system_parts, messages, tools = _sample_inputs()
    model = OpenAIModel(
        "deepseek-v4-flash",
        OpenAIProvider(base_url="http://x/v1", api_key="k"),
        supports_vision=False,
    )
    body = model._build_body(messages, system_parts, tools, require_tool=True, settings={})

    user_msg = next(m for m in body["messages"] if m["role"] == "user")
    assert isinstance(user_msg["content"], str)
    assert "看图" in user_msg["content"]
    assert "[image omitted:" in user_msg["content"]
    assert "image_url" not in json.dumps(body["messages"])


# ============================================================
# Gemini
# ============================================================


def test_gemini_wire():
    system_parts, messages, tools = _sample_inputs()
    model = GoogleModel(
        "gemini-3.5-flash",
        GoogleProvider(api_key="k", base_url="https://h/v1beta1/publishers/google"),
    )
    settings = {
        "temperature": 0.3,
        "max_tokens": 2048,
        "thinking": True,
        "google_safety_settings": [{"category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "OFF"}],
    }
    body = model._build_body(messages, system_parts, tools, require_tool=True, settings=settings)

    assert body["systemInstruction"]["parts"] == [{"text": "S1"}, {"text": "S2"}]

    roles = [c["role"] for c in body["contents"]]
    assert roles == [
        "user",
        "model",
        "user",
    ]  # user(图) / model(functionCall) / user(functionResponse)
    # 图：inlineData
    assert any("inlineData" in p for p in body["contents"][0]["parts"])
    # functionCall
    assert body["contents"][1]["parts"][0]["functionCall"]["name"] == "search_artist"
    # functionResponse
    assert body["contents"][2]["parts"][0]["functionResponse"]["name"] == "search_artist"

    # functionDeclarations + schema 清洗
    decls = body["tools"][0]["functionDeclarations"]
    fr = next(d for d in decls if d["name"] == "final_result")
    blob = json.dumps(fr["parameters"])
    assert "anyOf" not in blob and "additionalProperties" not in blob
    assert fr["parameters"]["properties"]["size"].get("nullable") is True

    assert body["toolConfig"]["functionCallingConfig"]["mode"] == "ANY"
    assert body["generationConfig"]["thinkingConfig"] == {"includeThoughts": True}
    assert body["generationConfig"]["temperature"] == 0.3
    assert body["generationConfig"]["maxOutputTokens"] == 2048
    assert body["safetySettings"][0]["threshold"] == "OFF"


# ============================================================
# Anthropic
# ============================================================


def test_anthropic_wire():
    system_parts, messages, tools = _sample_inputs()
    model = AnthropicModel("claude-sonnet-4-6", AnthropicProvider(base_url="http://h", api_key="k"))
    settings = {"temperature": 0.5, "max_tokens": 4096}
    body = model._build_body(messages, system_parts, tools, require_tool=True, settings=settings)

    assert body["system"] == [{"type": "text", "text": "S1"}, {"type": "text", "text": "S2"}]
    assert body["max_tokens"] == 4096
    assert body["temperature"] == 0.5

    roles = [m["role"] for m in body["messages"]]
    assert roles == ["user", "assistant", "user"]
    # 图：image block
    assert any(b.get("type") == "image" for b in body["messages"][0]["content"])
    # tool_use
    assert body["messages"][1]["content"][0]["type"] == "tool_use"
    assert body["messages"][1]["content"][0]["name"] == "search_artist"
    # tool_result
    assert body["messages"][2]["content"][0]["type"] == "tool_result"
    assert body["messages"][2]["content"][0]["tool_use_id"] == "t1"

    names = [t["name"] for t in body["tools"]]
    assert "search_artist" in names and "final_result" in names
    assert body["tool_choice"] == {"type": "any"}


def test_anthropic_default_max_tokens():
    system_parts, messages, tools = _sample_inputs()
    model = AnthropicModel("claude-sonnet-4-6", AnthropicProvider(base_url="http://h", api_key="k"))
    body = model._build_body(messages, system_parts, [], require_tool=False, settings={})
    assert body["max_tokens"] == 4096  # 未给 -> 默认 4096（Anthropic 必填）


# ============================================================
# 回归：DrawSpec.characters 的 Gemini schema 必须带 properties（修 Vertex 400）
# ============================================================


def test_drawspec_gemini_characters_has_properties():
    from agent_router.llm.models.google import _to_gemini_schema
    from agent_router.llm.output import build_inlined_json_schema
    from agent_router.schemas import DrawSpec

    s = build_inlined_json_schema(DrawSpec)
    blob = json.dumps(s)
    # 内联生成绝不能漏 $ref/$defs（Gemini CLI 代理会 400）
    assert "$ref" not in blob and "$defs" not in blob

    g = _to_gemini_schema(s)
    gblob = json.dumps(g)
    assert "additionalProperties" not in gblob
    assert "anyOf" not in gblob

    items = g["properties"]["characters"]["items"]
    assert items.get("type") == "object"
    # 关键：characters 元素 object 必须有具体 properties（Vertex 拒绝无 properties 的 OBJECT）
    assert set(items.get("properties", {}).keys()) == {"name", "positive", "negative"}
    assert items.get("required") == ["name", "positive"]


# ============================================================
# 回归：native final_result 解析失败后的重试必须以 tool_result 回应 tool_use（修 400）
# ============================================================


def test_anthropic_retry_after_tool_use_renders_tool_result():
    from agent_router.llm.messages import ModelRequest, ModelResponse, RetryPromptPart
    from agent_router.llm.output import OUTPUT_TOOL_NAME

    model = AnthropicModel("c", AnthropicProvider(base_url="http://h", api_key="k"))
    messages = [
        ModelRequest(parts=[UserPromptPart(content="hi")]),
        ModelResponse(
            parts=[ToolCallPart(tool_name=OUTPUT_TOOL_NAME, args={"bad": 1}, tool_call_id="c1")]
        ),
        ModelRequest(
            parts=[
                RetryPromptPart(
                    content="参数错误，请重填", tool_name=OUTPUT_TOOL_NAME, tool_call_id="c1"
                )
            ]
        ),
    ]
    wire, _sys = model._build_messages(messages, [])
    last = wire[-1]
    assert last["role"] == "user"
    assert last["content"][0]["type"] == "tool_result"
    assert last["content"][0]["tool_use_id"] == "c1"
    assert last["content"][0].get("is_error") is True


def test_openai_retry_after_tool_call_renders_tool_role():
    from agent_router.llm.messages import ModelRequest, ModelResponse, RetryPromptPart
    from agent_router.llm.models.openai import OpenAIModel
    from agent_router.llm.output import OUTPUT_TOOL_NAME

    model = OpenAIModel("m", OpenAIProvider(base_url="http://x/v1", api_key="k"))
    messages = [
        ModelRequest(parts=[UserPromptPart(content="hi")]),
        ModelResponse(
            parts=[ToolCallPart(tool_name=OUTPUT_TOOL_NAME, args={"bad": 1}, tool_call_id="c1")]
        ),
        ModelRequest(
            parts=[
                RetryPromptPart(content="参数错误", tool_name=OUTPUT_TOOL_NAME, tool_call_id="c1")
            ]
        ),
    ]
    wire = model._messages_to_wire(messages, [])
    last = wire[-1]
    # 必须是 role:tool 回应 tool_call_id c1，而非 role:user 纯文本
    assert last["role"] == "tool"
    assert last["tool_call_id"] == "c1"


def test_gemini_retry_after_function_call_renders_function_response():
    from agent_router.llm.messages import ModelRequest, ModelResponse, RetryPromptPart
    from agent_router.llm.output import OUTPUT_TOOL_NAME

    model = GoogleModel(
        "g", GoogleProvider(api_key="k", base_url="https://h/v1beta1/publishers/google")
    )
    messages = [
        ModelRequest(parts=[UserPromptPart(content="hi")]),
        ModelResponse(
            parts=[ToolCallPart(tool_name=OUTPUT_TOOL_NAME, args={"bad": 1}, tool_call_id="c1")]
        ),
        ModelRequest(
            parts=[
                RetryPromptPart(content="参数错误", tool_name=OUTPUT_TOOL_NAME, tool_call_id="c1")
            ]
        ),
    ]
    body = model._build_body(messages, [], [], require_tool=True, settings={})
    contents = body["contents"]
    # 末轮必须是 user 携带 functionResponse 回应 final_result，而非纯 text
    assert contents[-1]["role"] == "user"
    assert contents[-1]["parts"][0]["functionResponse"]["name"] == OUTPUT_TOOL_NAME
