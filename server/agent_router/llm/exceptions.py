"""
自研 LLM 框架 —— 异常层（替代 pydantic_ai.ModelRetry / pydantic_ai.exceptions.*）。

**关键兼容契约**：上层 router.py 用「字符串子串匹配」来分类异常，必须保持以下不变量：

1. 瞬时错误识别（router._is_transient_error）：检查 `getattr(e, "status_code", None)`
   是否 ∈ {408,425,429,500,502,503,504}。→ ModelHTTPError 必须带 .status_code 属性。

2. 空输出识别（router._is_empty_model_output_error）：在异常链里找子串
   "exceeded maximum output retries" 或 "please return text or include your response in a tool call"
   （小写匹配）。→ UnexpectedModelBehavior 在「模型反复不给有效输出」时抛出的消息
   必须包含这两个子串之一（这里两个都含，最稳）。

3. Google 内容拦截识别（provider_errors.is_google_prohibited_content_error）：在异常链
   （__cause__/__context__）里找 "PROHIBITED_CONTENT"。→ GoogleModel 触发拦截时抛的异常
   文本必须带这个子串（见 llm/models/google.py）。
"""

from __future__ import annotations


class LLMError(Exception):
    """本框架所有异常的基类。"""


class ModelRetry(LLMError):
    """
    工具或 output_validator 抛出，触发 agent 重试（把 .message 回灌给模型）。
    等价 pydantic_ai.ModelRetry。
    """

    def __init__(self, message: str) -> None:
        self.message = message
        super().__init__(message)


class ModelHTTPError(LLMError):
    """
    上游 HTTP 非 2xx。**必须**带 .status_code，供 router._is_transient_error 判定瞬时重试。
    等价 pydantic_ai.exceptions.ModelHTTPError。
    """

    def __init__(self, status_code: int, message: str = "", *, body: str = "") -> None:
        self.status_code = status_code
        self.body = body
        detail = message or body or ""
        super().__init__(f"status_code: {status_code}, model error: {detail}")


class ModelProtocolError(LLMError):
    """A successful provider response that violates its wire contract."""

    def __init__(self, provider: str, message: str) -> None:
        self.provider = provider
        super().__init__(f"{provider} response protocol error: {message}")


# 反复空输出时统一抛这条消息——同时含 router 匹配的两个子串。
EMPTY_OUTPUT_MESSAGE = (
    "Exceeded maximum output retries; the model returned neither a usable final "
    "output nor a tool call. Please return text or include your response in a tool call."
)


class UnexpectedModelBehavior(LLMError):
    """
    模型行为异常（结构化输出多次解析失败 / 反复既无文本又无工具调用 / 重试预算耗尽）。
    等价 pydantic_ai.exceptions.UnexpectedModelBehavior。

    在「空输出/重试耗尽」场景请用 EMPTY_OUTPUT_MESSAGE 作为消息，保证 router 的子串匹配命中。
    """


class ToolCallError(LLMError):
    """工具执行抛了非 ModelRetry 的异常时包装上抛（带工具名，便于定位）。"""

    def __init__(self, tool_name: str, message: str) -> None:
        self.tool_name = tool_name
        super().__init__(f"tool {tool_name!r} failed: {message}")


__all__ = [
    "LLMError",
    "ModelRetry",
    "ModelHTTPError",
    "ModelProtocolError",
    "UnexpectedModelBehavior",
    "EMPTY_OUTPUT_MESSAGE",
    "ToolCallError",
]
