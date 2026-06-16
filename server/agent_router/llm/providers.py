"""
自研 LLM 框架 —— Provider 连接配置（替代 pydantic_ai.providers.*）。

Provider 只承载「连到哪、用什么 key、走哪个 httpx client」，HTTP 细节在对应 Model 里。
保持构造签名与 pydantic_ai 近似，方便 model_provider.py 平移：
    OpenAIProvider(base_url=, api_key=, http_client=None)
    GoogleProvider(api_key=, base_url=, http_client=None)
    AnthropicProvider(base_url=, api_key=)
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import httpx


@dataclass
class OpenAIProvider:
    """OpenAI 兼容网关连接配置。http_client 非空时所有请求走它（NAI 适配 transport 用）。"""
    base_url: str
    api_key: str = ""
    http_client: Optional[httpx.AsyncClient] = None


@dataclass
class GoogleProvider:
    """Gemini / Vertex 连接配置。http_client 非空时走它（Vertex Express 代理/重写 transport 用）。"""
    api_key: str = ""
    base_url: str = ""
    http_client: Optional[httpx.AsyncClient] = None


@dataclass
class AnthropicProvider:
    """Anthropic /v1/messages 连接配置（当前无自定义 transport 需求）。"""
    base_url: str
    api_key: str = ""
    http_client: Optional[httpx.AsyncClient] = None


__all__ = ["OpenAIProvider", "GoogleProvider", "AnthropicProvider"]
