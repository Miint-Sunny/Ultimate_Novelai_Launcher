"""
自研 LLM 框架 —— 输出策略层（替代 pydantic_ai.output.PromptedOutput
+ 内部 final_result 工具合成 + schema 生成）。

三种输出策略（由 Agent 在构造时按 output_type 解析）：

    output_type = str
        -> StrOutput：最终助手文本即结果，不挂 final_result 工具、不注 schema。

    output_type = <BaseModel 子类>
        -> NativeStructuredOutput：合成一个名为 "final_result" 的工具，参数 schema =
           该模型的内联 JSON schema。模型调用 final_result(...) 即收尾，解析其 args 校验成实例。
           （pydantic_ai 默认 ToolOutput 行为；OpenAI/Gemini/Anthropic 统一走这条。）

    output_type = PromptedOutput(<BaseModel 子类>)
        -> PromptedJsonOutput：不挂工具，把 schema 指令注入 system，要求模型只回一个 JSON 对象；
           从自由文本里抠出 JSON 校验成实例。（OpenAI 兼容网关 final_result 工具实现不稳时用。）

schema 生成关键契约：
    - **绝不出现 $defs / $ref**（Gemini CLI 代理会 400）。本模块负责解引用 + 摊平；
      provider 侧（google.py）再做 Gemini 专属清洗（anyOf->nullable、去 additionalProperties 等）。
    - Field(description=...) 文本**逐字保留**进 schema 的 "description"——它是发给模型的指令内容。
    - required 由 pydantic 默认值精确决定，不擅自增删。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel, ValidationError

from .messages import ToolDefinition

OUTPUT_TOOL_NAME = "final_result"


# ============================================================
# PromptedOutput marker（等价 pydantic_ai.output.PromptedOutput）
# ============================================================


@dataclass
class PromptedOutput:
    """
    标记：让 Agent 用「prompt 注入 JSON schema + 文本里解析 JSON」而非 final_result 工具。
    用法：Agent(model, output_type=PromptedOutput(MyModel))。
    """

    output_type: type


# ============================================================
# 内联 JSON schema 生成（解引用 + 去 $defs/$ref，保留 description）
# ============================================================


def build_inlined_json_schema(model_cls: type[BaseModel]) -> dict:
    """
    由 pydantic 模型生成「无 $defs / $ref」的内联 JSON schema。

    pydantic 对嵌套 BaseModel 会产出 $defs + $ref；本函数把所有 $ref 原地展开、删 $defs，
    顶层 $schema / title 一并去掉（field 级 description / title 保留）。
    本项目的 output 模型本就刻意扁平（list[dict] / Optional[dict]），这里主要是 future-proof。
    """
    raw = model_cls.model_json_schema()
    defs: dict = raw.get("$defs", {}) or {}

    def deref(node: Any) -> Any:
        if isinstance(node, dict):
            if "$ref" in node:
                ref = str(node["$ref"])
                name = ref.split("/")[-1]
                target = defs.get(name, {})
                merged = deref(dict(target))
                if isinstance(merged, dict):
                    for k, v in node.items():
                        if k != "$ref":
                            merged[k] = deref(v)
                    return merged
                return merged
            return {k: deref(v) for k, v in node.items() if k != "$defs"}
        if isinstance(node, list):
            return [deref(x) for x in node]
        return node

    schema = deref(dict(raw))
    if isinstance(schema, dict):
        schema.pop("$defs", None)
        schema.pop("$schema", None)
        schema.pop("title", None)
    return schema


# ============================================================
# 从自由文本里抠出 JSON 对象
# ============================================================


def extract_json_object(text: str) -> str:
    """
    从模型自由文本里提取最外层 JSON 对象字符串。

    处理：```json 代码块围栏、JSON 前后的散文、思维链。
    策略：先剥代码围栏；再从第一个 '{' 起做花括号配平（跳过字符串内/转义），取到匹配的 '}'。
    抠不到则原样返回（交给上层 json.loads 报错触发重试）。
    """
    if not text:
        return ""
    s = text.strip()

    # 剥 ``` / ```json 代码围栏
    if "```" in s:
        fence_start = s.find("```")
        after = s[fence_start + 3 :]
        if after[:4].lower() == "json":
            after = after[4:]
        elif after[:1] == "\n":
            after = after[1:]
        fence_end = after.find("```")
        if fence_end >= 0:
            inner = after[:fence_end].strip()
            if inner:
                s = inner

    start = s.find("{")
    if start < 0:
        return s

    depth = 0
    in_str = False
    escape = False
    for i in range(start, len(s)):
        ch = s[i]
        if in_str:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return s[start : i + 1]
    return s[start:]


# ============================================================
# 输出策略
# ============================================================


class OutputStrategy:
    """输出策略基类。

    Agent.run 据此决定是否挂 final_result 工具、注入 schema 指令，以及如何解析终态。
    """

    #: 最终结果是否来自助手文本。StrOutput / PromptedJsonOutput=True；
    #: NativeStructuredOutput=False。
    wants_text_output: bool = True

    def output_tool(self) -> ToolDefinition | None:
        """需要合成的 final_result 工具（仅 native 返回非 None）。"""
        return None

    def system_instruction(self) -> str | None:
        """需要追加到 system 的 schema 指令（仅 prompted 返回非 None）。"""
        return None

    def parse_text(self, text: str) -> Any:
        """从助手文本解析终态结果（StrOutput / PromptedJsonOutput 用）。"""
        raise NotImplementedError

    def parse_tool_args(self, args: dict) -> Any:
        """从 final_result 工具入参解析终态结果（NativeStructuredOutput 用）。"""
        raise NotImplementedError


class StrOutput(OutputStrategy):
    """output_type=str：助手文本原样作为结果。"""

    wants_text_output = True

    def parse_text(self, text: str) -> str:
        return text or ""


class NativeStructuredOutput(OutputStrategy):
    """output_type=BaseModel：用 final_result 工具收尾，解析其入参。"""

    wants_text_output = False

    def __init__(self, model_cls: type[BaseModel]) -> None:
        self.model_cls = model_cls
        self._schema = build_inlined_json_schema(model_cls)

    def output_tool(self) -> ToolDefinition:
        return ToolDefinition(
            name=OUTPUT_TOOL_NAME,
            description=(
                "提交最终结构化结果。当你已收集到足够信息、准备好给出最终答案时，"
                "调用本工具并把结果作为参数填入（参数必须严格匹配 schema）。"
            ),
            parameters_json_schema=self._schema,
        )

    def parse_tool_args(self, args: dict) -> BaseModel:
        return self.model_cls.model_validate(args)


class PromptedJsonOutput(OutputStrategy):
    """output_type=PromptedOutput(BaseModel)：注入 schema 指令，文本里解析 JSON。"""

    wants_text_output = True

    def __init__(self, model_cls: type[BaseModel]) -> None:
        self.model_cls = model_cls
        self._schema = build_inlined_json_schema(model_cls)

    def system_instruction(self) -> str:
        schema_json = json.dumps(self._schema, ensure_ascii=False, indent=2)
        return (
            "【输出格式 - 强制】\n"
            "你必须**只输出一个 JSON 对象**，严格匹配下面的 JSON Schema；"
            "禁止输出任何额外文字、解释、Markdown 代码围栏或思维链——回复体就是裸 JSON。\n"
            "JSON Schema:\n"
            f"{schema_json}"
        )

    def parse_text(self, text: str) -> BaseModel:
        raw = extract_json_object(text)
        data = json.loads(raw)
        return self.model_cls.model_validate(data)


def resolve_output_strategy(output_type: Any) -> OutputStrategy:
    """把 Agent 的 output_type 解析成具体策略。"""
    if output_type is None or output_type is str:
        return StrOutput()
    if isinstance(output_type, PromptedOutput):
        return PromptedJsonOutput(output_type.output_type)
    if isinstance(output_type, type) and issubclass(output_type, BaseModel):
        return NativeStructuredOutput(output_type)
    raise TypeError(
        f"不支持的 output_type: {output_type!r}"
        "（仅 str / BaseModel 子类 / PromptedOutput(BaseModel)）"
    )


__all__ = [
    "PromptedOutput",
    "OUTPUT_TOOL_NAME",
    "build_inlined_json_schema",
    "extract_json_object",
    "OutputStrategy",
    "StrOutput",
    "NativeStructuredOutput",
    "PromptedJsonOutput",
    "resolve_output_strategy",
    "ValidationError",
]
