"""
自研 LLM 框架 —— 消息类型（替代 pydantic_ai.messages）。

设计目标：**同名同属性**地复刻 PydanticAI 1.x 用到的那一小撮消息类型，
让上层（router.py / history_adapter.py / tools）只需把
    from pydantic_ai.messages import ModelRequest, ...
改成
    from ..llm.messages import ModelRequest, ...
而不必改任何属性访问逻辑。

复刻范围（仅本项目实际触达的部分）：
    BinaryContent          —— 多模态图片字节（router 构造、history_adapter 读写）
    SystemPromptPart       —— role:system（system_prompt 函数产物）
    UserPromptPart         —— role:user，content 为 str 或 list[str | BinaryContent]
    ToolReturnPart         —— 工具返回（router._extract_used_resources 读 .tool_name/.content）
    TextPart               —— 助手文本
    ThinkingPart           —— 助手思考（provider thinking，不入历史）
    ToolCallPart           —— 助手工具调用（router 调试序列化读 .tool_name）
    ModelRequest/ModelResponse —— 一轮请求/响应（.parts 列表）
    ToolDefinition         —— 工具 JSON schema 描述（发给 provider 用）

属性兼容性约束（来自现有代码的真实访问点，改动时勿删）：
    - BinaryContent.data / .media_type            （router._debug_serialize_part / history_adapter）
    - SystemPromptPart.content                     （router._debug_serialize_model_messages）
    - UserPromptPart.content（str | list）          （history_adapter.from_model_messages）
    - TextPart.content                             （history_adapter / router）
    - ToolCallPart.tool_name（+ getattr content）   （router._debug_serialize_model_messages 兜底分支）
    - ToolReturnPart.tool_name / .content           （router._extract_used_resources：content 为 list[结构化项]）
    - ModelRequest.parts / ModelResponse.parts      （随处 isinstance + 遍历）
"""
from __future__ import annotations

import base64 as _base64
from dataclasses import dataclass, field
from typing import Any, Union


# ============================================================
# 多模态附件
# ============================================================

@dataclass
class BinaryContent:
    """
    二进制附件（目前只用于图片）。等价 pydantic_ai.BinaryContent。

    现有代码构造方式：BinaryContent(data=<bytes>, media_type="image/png")
    读取方式：part.data / part.media_type
    """
    data: bytes
    media_type: str = "image/png"

    @property
    def base64(self) -> str:
        """裸 base64（不含 data URI 前缀）。"""
        return _base64.b64encode(self.data or b"").decode("ascii")

    def as_data_uri(self) -> str:
        """OpenAI image_url 形式需要的 data URI。"""
        return f"data:{self.media_type};base64,{self.base64}"

    @property
    def is_image(self) -> bool:
        return (self.media_type or "").startswith("image/")


# ============================================================
# 请求侧 Part（role:system / role:user / role:tool）
# ============================================================

@dataclass
class SystemPromptPart:
    """一条 system 段。多个 SystemPromptPart 会被各家 provider 合并成 system 指令。"""
    content: str


@dataclass
class UserPromptPart:
    """
    一条 user 消息。content 可为：
        - str
        - list[str | BinaryContent]   （图文混排，属于同一条 user 消息）
    """
    content: Union[str, list]


@dataclass
class ToolReturnPart:
    """
    一次工具调用的返回（作为下一轮 role:tool 消息发回模型）。

    content 保留**原始 Python 返回值**（通常是 list[Character|Artist|dict]），
    既给 provider 层 JSON 序列化，也给 router._extract_used_resources 直接读结构化项。
    """
    tool_name: str
    content: Any
    tool_call_id: str = ""


@dataclass
class RetryPromptPart:
    """
    重试提示。output_validator / tool 抛 ModelRetry 时，把 .content 作为一条
    回灌消息发回模型，要求其修正。等价 pydantic_ai.messages.RetryPromptPart。

    - tool_name 非空：该重试针对某次工具调用（作为 role:tool 的错误返回）。
    - tool_name 为空：泛重试指令（作为 role:user 追加）。
    """
    content: str
    tool_name: str = ""
    tool_call_id: str = ""


# ============================================================
# 响应侧 Part（role:assistant）
# ============================================================

@dataclass
class TextPart:
    """助手输出的纯文本。"""
    content: str


@dataclass
class ThinkingPart:
    """
    助手的思考/推理段（Gemini includeThoughts、DeepSeek reasoning、Anthropic thinking）。
    仅用于调试可见性，不写入对话历史、不参与 reply_text。
    """
    content: str


@dataclass
class ToolCallPart:
    """
    助手发起的一次工具调用。

    content 字段恒为 None，仅为兼容 router._debug_serialize_model_messages 里
    `getattr(p, "content", None)` 的兜底分支（它对未知 part 统一读 content/tool_name）。
    """
    tool_name: str
    args: Union[dict, str] = field(default_factory=dict)
    tool_call_id: str = ""
    content: Any = None


# 类型别名（供 isinstance / 注解）
RequestPart = Union[SystemPromptPart, UserPromptPart, ToolReturnPart, RetryPromptPart]
ResponsePart = Union[TextPart, ThinkingPart, ToolCallPart]


# ============================================================
# 一轮消息（ModelRequest = 发给模型；ModelResponse = 模型产出）
# ============================================================

@dataclass
class ModelRequest:
    """发给模型的一轮（含 system / user / tool-return parts）。"""
    parts: list = field(default_factory=list)


@dataclass
class ModelResponse:
    """模型产出的一轮（含 text / thinking / tool-call parts）。"""
    parts: list = field(default_factory=list)


ModelMessage = Union[ModelRequest, ModelResponse]


# ============================================================
# 工具定义（发给 provider 的 function schema）
# ============================================================

@dataclass
class ToolDefinition:
    """
    一个可调用工具的描述，转成各家 provider 的 function-calling schema。

    name                     工具名（模型按它发起调用）
    description              工具说明（取自 Python 函数 docstring，逐字不截断）
    parameters_json_schema   入参 JSON Schema（object 形态，必填项由 required 列表给出）
    strict                   是否走 OpenAI strict function calling（True 时 OpenAI provider 会
                             转成 additionalProperties:false + required=全字段 + 可选字段 nullable）。
                             仅影响 OpenAI 协议；Gemini/Anthropic 忽略此标志。
    """
    name: str
    description: str
    parameters_json_schema: dict = field(default_factory=lambda: {"type": "object", "properties": {}})
    strict: bool = False


__all__ = [
    "BinaryContent",
    "SystemPromptPart",
    "UserPromptPart",
    "ToolReturnPart",
    "RetryPromptPart",
    "TextPart",
    "ThinkingPart",
    "ToolCallPart",
    "RequestPart",
    "ResponsePart",
    "ModelRequest",
    "ModelResponse",
    "ModelMessage",
    "ToolDefinition",
]
