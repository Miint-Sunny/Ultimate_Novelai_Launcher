"""
自研 LLM 框架（替代 pydantic_ai）。

设计：把 pydantic_ai 用到的那一小撮 API 在本包内同名复刻，让上层改动最小化——
    from pydantic_ai import Agent, RunContext, ModelRetry, BinaryContent
    from pydantic_ai.output import PromptedOutput
    from pydantic_ai.messages import ModelRequest, ...
分别替换成
    from .llm import Agent, RunContext, ModelRetry, BinaryContent
    from .llm.output import PromptedOutput          # 或 from .llm import PromptedOutput
    from .llm.messages import ModelRequest, ...

子模块：
    messages   消息/Part/BinaryContent/ToolDefinition
    exceptions ModelRetry / ModelHTTPError / UnexpectedModelBehavior
    context    RunContext
    output     PromptedOutput + schema 生成 + 输出策略
    tools      工具 schema 生成 + 调用 + 序列化
    result     RunResult / Usage
    agent      Agent（编排核心）
    providers  OpenAIProvider / GoogleProvider / AnthropicProvider（连接配置）
    models/    Model 基类 + openai / google / anthropic 适配器
"""

from __future__ import annotations

from .agent import Agent
from .context import RunContext
from .exceptions import (
    EMPTY_OUTPUT_MESSAGE,
    LLMError,
    ModelHTTPError,
    ModelProtocolError,
    ModelRetry,
    UnexpectedModelBehavior,
)
from .messages import (
    BinaryContent,
    ModelMessage,
    ModelRequest,
    ModelResponse,
    RetryPromptPart,
    SystemPromptPart,
    TextPart,
    ThinkingPart,
    ToolCallPart,
    ToolDefinition,
    ToolReturnPart,
    UserPromptPart,
)
from .output import PromptedOutput
from .result import RunResult, Usage

__all__ = [
    "Agent",
    "RunContext",
    "ModelRetry",
    "ModelHTTPError",
    "ModelProtocolError",
    "UnexpectedModelBehavior",
    "EMPTY_OUTPUT_MESSAGE",
    "LLMError",
    "PromptedOutput",
    "RunResult",
    "Usage",
    "BinaryContent",
    "ModelMessage",
    "ModelRequest",
    "ModelResponse",
    "SystemPromptPart",
    "UserPromptPart",
    "ToolReturnPart",
    "RetryPromptPart",
    "TextPart",
    "ThinkingPart",
    "ToolCallPart",
    "ToolDefinition",
]
