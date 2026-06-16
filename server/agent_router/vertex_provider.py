"""
Vertex Express Mode 自定义 Provider 适配层。

背景
====
PydanticAI 1.x 通过 google-genai SDK 2.6 调 Gemini API。SDK 强制在 base_url 后
拼接 `/v1beta/models/{model}:generateContent`，但 Vertex Express 的真实路径是
`/v1beta1/publishers/google/models/{model}:generateContent`，**不带额外的 /v1beta**。

如果我们配 base_url = `https://aiplatform.googleapis.com/v1beta1/publishers/google`，
SDK 拼出来的 URL 是:
    https://aiplatform.googleapis.com/v1beta1/publishers/google/v1beta/models/{model}:generateContent
                                                              ^^^^^^^^ 多余
导致 404。

我们的修法
==========
写一个 httpx 自定义 transport（不动 google-genai SDK 内部），在请求发出前把多余的
`/v1beta/` 段移除。auth 头（x-goog-api-key）SDK 已经设好了，Vertex Express 接受
（curl 验证过）。

用法
====
    from .vertex_provider import build_vertex_http_client, is_vertex_express_url

    if is_vertex_express_url(base_url):
        http_client = build_vertex_http_client(proxy_url=proxy)
        provider = GoogleProvider(api_key=key, base_url=base_url, http_client=http_client)
    else:
        provider = GoogleProvider(api_key=key, base_url=base_url)
"""
from __future__ import annotations

from typing import Optional
import httpx


# Vertex Express 的固定 host
_VERTEX_HOST = "aiplatform.googleapis.com"
# google-genai SDK 多拼的那一段（会被剥掉）
_REDUNDANT_PATH_SEGMENT = "/publishers/google/v1beta/"
_CORRECTED_PATH_SEGMENT = "/publishers/google/"


def is_vertex_express_url(base_url: str) -> bool:
    """判断给定 base_url 是不是 Vertex Express 风格（需要 URL 重写）。"""
    if not base_url:
        return False
    return _VERTEX_HOST in base_url and "/publishers/google" in base_url


class _VertexURLRewriteTransport(httpx.AsyncHTTPTransport):
    """
    自定义 httpx Transport：发送请求前剥掉 google-genai SDK 强制拼的 `/v1beta` 段。

    继承 AsyncHTTPTransport 并 override handle_async_request：
    - 拿到 SDK 已经构造好的 Request
    - 检查 URL 是否含 `/publishers/google/v1beta/`
    - 是则替换成 `/publishers/google/`
    - 转给父类正常发送
    """

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        url_str = str(request.url)
        if _REDUNDANT_PATH_SEGMENT in url_str:
            corrected = url_str.replace(_REDUNDANT_PATH_SEGMENT, _CORRECTED_PATH_SEGMENT)
            # httpx 的 Request.url 是 mutable attribute，可以直接赋值
            request.url = httpx.URL(corrected)
        return await super().handle_async_request(request)


def build_vertex_http_client(
    proxy_url: Optional[str] = None,
    timeout: float = 120.0,
) -> httpx.AsyncClient:
    """
    构造一个带 Vertex URL 重写 transport 的 httpx.AsyncClient，
    用于传给 PydanticAI 的 GoogleProvider(http_client=...)。

    Args:
        proxy_url: 出网代理（socks5:// 或 http://），空 = 直连
        timeout: 请求超时（秒）

    Returns:
        httpx.AsyncClient 实例，调用方负责生命周期管理（agent_router 内部全局共享一个即可）
    """
    transport_kwargs: dict = {}
    if proxy_url:
        # httpx 0.27+ 支持 proxy 参数；老版本需要 mounts 字典
        try:
            transport_kwargs["proxy"] = proxy_url
        except TypeError:
            pass
    transport = _VertexURLRewriteTransport(**transport_kwargs)
    return httpx.AsyncClient(transport=transport, timeout=httpx.Timeout(timeout))
