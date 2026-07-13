"""
NovelAI 文本 API (text.novelai.net/oa/v1) 适配层。

背景
====
NAI 暴露的 /oa/v1/chat/completions 是 OpenAI 兼容**形式上**，但有两个偏差让 PydanticAI 直接走
OpenAIProvider 时炸：

1. **非流式响应缺 message.content** —— 响应 object 是 "chat.completion.chunk"，choices[0] 只有
   text="" 和 token_ids=[...]，没有 OpenAI SDK 期待的 message.content；SDK 解析出 None 后
   后续访问触发 AttributeError。
   实测：xialong-v1 / glm-4-6 都有此问题。
2. **OpenAI 工具协议不兼容** —— 给 tools 字段不报错但被静默忽略；glm-4-6 会在 content 文本里
   吐 <function= name>\n<arg=value>\n</function> 这种类 XML 文本，tool_calls 字段始终 null。

适配策略
========
做一个 httpx 自定义 Transport，专门挂给 NAI text 的 OpenAIProvider：
  - 拦截 POST /chat/completions
  - 剥掉 tools / tool_choice / response_format（避免上游静默丢弃后行为不可预期）
  - 强制 stream=true 发出去
  - 读完 SSE 拼接所有 delta.content
  - 伪造一个标准 ChatCompletion JSON 响应（object=chat.completion + message.content=...）
    回给 SDK
  - 如果客户端原本就请求 stream=true，原样透传（流式本身正常）

工具调用
========
NAI 不支持 OpenAI 风格 tool_calls，所以本层直接剥工具字段；上层 agent 应当通过
MODEL_REGISTRY[*]["supports_tools"]=False 配合避免给该模型注册任何工具。本层剥工具
是双保险。

用法
====
    from .novelai_provider import is_novelai_text_url, build_novelai_http_client

    if is_novelai_text_url(base_url):
        http_client = build_novelai_http_client(proxy_url=proxy)
        provider = OpenAIProvider(base_url=base_url, api_key=key, http_client=http_client)
    else:
        provider = OpenAIProvider(base_url=base_url, api_key=key)
"""

from __future__ import annotations

import json
import time

import httpx

_NOVELAI_TEXT_HOST = "text.novelai.net"


def is_novelai_text_url(base_url: str) -> bool:
    """判断给定 base_url 是否指向 NAI 文本 API（需要适配）。"""
    if not base_url:
        return False
    return _NOVELAI_TEXT_HOST in base_url


def _flatten_content(content) -> str:
    """
    把 message.content 规范成纯字符串。

    NAI 后端是 Go 写的，OAIChatMessage.content 字段类型是 string，不接受数组。
    但新版 OpenAI SDK / PydanticAI 默认把 content 编成数组形式：
        [{"type": "text", "text": "..."}, {"type": "image_url", "image_url": {...}}]
    上游会报：cannot unmarshal array into Go struct field ... of type string

    策略：
        - 已是 str → 原样
        - None → 空串
        - list → 抽出所有 type=text 的 text 拼接；非 text 段（图片等）丢弃
        - dict → 同 list 单元素处理
    """
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            piece = _flatten_content(item)
            if piece:
                parts.append(piece)
        return "".join(parts)
    if isinstance(content, dict):
        if content.get("type") == "text":
            return str(content.get("text", ""))
        # image_url / input_audio 等非文本段：NAI 不支持，丢弃
        return ""
    return str(content)


def _normalize_messages(messages: list[dict]) -> list[dict]:
    """
    把 messages 规范成 NAI 接受的 OpenAI 老协议：
        - content 拍平成 string
        - role=tool 的消息整条丢弃（NAI 不支持工具协议）
        - 剥掉 tool_calls / function_call / name 等工具相关字段
    """
    out: list[dict] = []
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        role = msg.get("role")
        if role == "tool":
            continue
        new_msg = {"role": role, "content": _flatten_content(msg.get("content"))}
        out.append(new_msg)
    return out


class _NovelAIAdapterTransport(httpx.AsyncHTTPTransport):
    """
    httpx Transport：拦截 NAI text 的 /chat/completions 请求，做协议适配。

    流程：
      1. 解析原 JSON body
      2. 剥 tools / tool_choice / response_format
      3. 强制 stream=true（NAI 非流式没 message.content）
      4. 读 SSE，拼接 delta.content
      5. 伪造标准 ChatCompletion 响应返回
      6. 如果客户端本来就请求 stream=true，原样转发不改造响应
    """

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        # 只拦截 chat.completions 的 POST
        if request.method != "POST" or "/chat/completions" not in str(request.url):
            return await super().handle_async_request(request)

        # 解析请求 body
        try:
            body = json.loads(request.content.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return await super().handle_async_request(request)

        # NAI 不支持 OpenAI tools 协议，剥掉避免上游静默丢弃后未定义行为
        body.pop("tools", None)
        body.pop("tool_choice", None)
        # response_format 也不支持，剥掉
        body.pop("response_format", None)

        # NAI 后端（Go）要求 messages[].content 是 string，不接受新协议的数组形式；
        # PydanticAI 默认把 content 编成 [{type:text, text:...}]，必须拍平。
        if isinstance(body.get("messages"), list):
            body["messages"] = _normalize_messages(body["messages"])

        client_wants_stream = bool(body.get("stream"))
        body["stream"] = True

        # 重建请求
        new_content = json.dumps(body).encode("utf-8")
        new_headers = dict(request.headers)
        new_headers["content-length"] = str(len(new_content))
        new_headers["accept"] = "text/event-stream"
        new_request = httpx.Request(
            method=request.method,
            url=request.url,
            headers=new_headers,
            content=new_content,
        )

        if client_wants_stream:
            # 客户端要流式 → 透传上游流式响应
            return await super().handle_async_request(new_request)

        # 客户端要非流式 → 我们读完 SSE 后伪造非流式响应
        upstream = await super().handle_async_request(new_request)

        # 上游错误直接透传（status_code != 200 也不要假冒成功）
        if upstream.status_code >= 400:
            await upstream.aread()
            return upstream

        content_parts: list[str] = []
        finish_reason = "stop"
        completion_id: str | None = None
        created: int | None = None
        model_name = body.get("model", "unknown")
        usage: dict | None = None

        try:
            async for raw_line in upstream.aiter_lines():
                line = raw_line.strip()
                if not line or not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    chunk = json.loads(data)
                except json.JSONDecodeError:
                    continue
                if completion_id is None:
                    completion_id = chunk.get("id")
                if created is None:
                    created = chunk.get("created")
                for ch in chunk.get("choices") or []:
                    delta = ch.get("delta") or {}
                    delta_content = delta.get("content")
                    if delta_content:
                        content_parts.append(delta_content)
                    fr = ch.get("finish_reason")
                    if fr:
                        finish_reason = fr
                if chunk.get("usage"):
                    usage = chunk["usage"]
        finally:
            await upstream.aclose()

        fake_completion: dict = {
            "id": completion_id or "chatcmpl-novelai-adapter",
            "object": "chat.completion",
            "created": created or int(time.time()),
            "model": model_name,
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": "".join(content_parts),
                    },
                    "finish_reason": finish_reason,
                }
            ],
        }
        if usage:
            fake_completion["usage"] = usage

        fake_body = json.dumps(fake_completion).encode("utf-8")
        return httpx.Response(
            status_code=200,
            headers={"content-type": "application/json"},
            content=fake_body,
            request=new_request,
        )


def build_novelai_http_client(
    proxy_url: str | None = None,
    timeout: float = 120.0,
) -> httpx.AsyncClient:
    """
    构造带 NAI 适配 transport 的 AsyncClient，传给 OpenAIProvider(http_client=...)。

    Args:
        proxy_url: 出网代理（socks5:// 或 http://），空 = 直连
        timeout: 请求超时（秒，长上下文会到 30s+，所以默认 120）

    Returns:
        httpx.AsyncClient 实例，调用方负责生命周期；agent_router 内部全局共享一个即可。
    """
    transport_kwargs: dict = {}
    if proxy_url:
        try:
            transport_kwargs["proxy"] = proxy_url
        except TypeError:
            pass
    transport = _NovelAIAdapterTransport(**transport_kwargs)
    return httpx.AsyncClient(transport=transport, timeout=httpx.Timeout(timeout))
