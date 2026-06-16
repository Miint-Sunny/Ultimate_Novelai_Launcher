"""
自研 LLM 框架 —— Gemini / Vertex 适配器（替代 pydantic_ai.models.google.GoogleModel）。

POST {base_url}/models/{model}:generateContent（走 provider.http_client，没有则共享默认 client）。
base_url 形如 https://aiplatform.googleapis.com/v1beta1/publishers/google（Vertex Express），
我们自己拼 /models/{model}:generateContent —— 路径天然正确，不再需要 google-genai SDK 多拼 /v1beta，
故 vertex_provider 的 URL 重写在 raw-httpx 下成空操作（仍复用它只为带 proxy 的 client）。

ModelSettings 消费：
    temperature            -> generationConfig.temperature
    max_tokens             -> generationConfig.maxOutputTokens
    thinking (bool)        -> generationConfig.thinkingConfig.includeThoughts
    google_safety_settings -> safetySettings[]

require_tool -> toolConfig.functionCallingConfig.mode = ANY / AUTO。

**PROHIBITED_CONTENT 契约**：上游拦截时抛的异常文本必须含 "PROHIBITED_CONTENT"，
供 provider_errors.is_google_prohibited_content_error 命中 -> router 跳过重试 + 友好降级。
"""
from __future__ import annotations

import json
from typing import Any, Optional

import httpx

from ..messages import (
    ModelMessage, ModelRequest, ModelResponse,
    SystemPromptPart, UserPromptPart, ToolReturnPart, RetryPromptPart,
    TextPart, ThinkingPart, ToolCallPart, ToolDefinition, BinaryContent,
)
from ..exceptions import LLMError, ModelHTTPError, UnexpectedModelBehavior
from ..result import Usage
from .base import Model, get_default_http_client


class GeminiBlockedError(LLMError):
    """Gemini 安全系统拦截。消息含 reason 文本（PROHIBITED_CONTENT 等）。"""


# ============================================================
# schema -> Gemini（OpenAPI 3.0 子集）
# ============================================================

_GEMINI_DROP_KEYS = {"$ref", "$defs", "$schema", "title", "additionalProperties", "default"}


def _to_gemini_schema(schema: Any) -> Any:
    """把标准 JSON schema 清洗成 Gemini 接受的 OpenAPI 3.0 子集（无 $ref/anyOf/additionalProperties）。"""
    if isinstance(schema, list):
        return [_to_gemini_schema(x) for x in schema]
    if not isinstance(schema, dict):
        return schema

    # anyOf:[T, null] -> T + nullable
    if "anyOf" in schema:
        variants = [v for v in schema["anyOf"] if not (isinstance(v, dict) and v.get("type") == "null")]
        has_null = any(isinstance(v, dict) and v.get("type") == "null" for v in schema["anyOf"])
        base = _to_gemini_schema(variants[0]) if variants else {"type": "string"}
        if isinstance(base, dict):
            if has_null:
                base["nullable"] = True
            for k, v in schema.items():
                if k in ("anyOf",) or k in _GEMINI_DROP_KEYS:
                    continue
                if k not in base:
                    base[k] = _to_gemini_schema(v)
        return base

    out: dict = {}
    for k, v in schema.items():
        if k in _GEMINI_DROP_KEYS:
            continue
        if k == "type" and isinstance(v, list):
            # ["string","null"] -> "string" + nullable
            non_null = [t for t in v if t != "null"]
            out["type"] = non_null[0] if non_null else "string"
            if "null" in v:
                out["nullable"] = True
        elif k in ("properties",):
            out[k] = {pk: _to_gemini_schema(pv) for pk, pv in (v or {}).items()}
        elif k in ("items",):
            out[k] = _to_gemini_schema(v)
        else:
            out[k] = _to_gemini_schema(v)
    return out


# ============================================================
# GoogleModel
# ============================================================

class GoogleModel(Model):
    def __init__(self, model_name: str, provider) -> None:
        self.model_name = model_name
        self.provider = provider

    @property
    def _client(self) -> httpx.AsyncClient:
        return self.provider.http_client or get_default_http_client()

    # ---------- 组装 ----------

    def _user_parts(self, content: Any) -> list[dict]:
        if isinstance(content, str):
            return [{"text": content}] if content else []
        if isinstance(content, BinaryContent):
            content = [content]
        parts: list[dict] = []
        if isinstance(content, list):
            for item in content:
                if isinstance(item, BinaryContent):
                    parts.append({"inlineData": {"mimeType": item.media_type, "data": item.base64}})
                elif item is not None and str(item):
                    parts.append({"text": str(item)})
        else:
            parts.append({"text": str(content)})
        return parts

    def _build_contents(
        self, messages: list[ModelMessage], system_parts: list[SystemPromptPart]
    ) -> tuple[list[dict], list[dict]]:
        system_texts: list[dict] = [{"text": sp.content} for sp in system_parts if sp.content]
        contents: list[dict] = []

        for msg in messages:
            if isinstance(msg, ModelRequest):
                user_parts: list[dict] = []
                for part in msg.parts:
                    if isinstance(part, SystemPromptPart):
                        if part.content:
                            system_texts.append({"text": part.content})
                    elif isinstance(part, UserPromptPart):
                        user_parts.extend(self._user_parts(part.content))
                    elif isinstance(part, ToolReturnPart):
                        user_parts.append({
                            "functionResponse": {
                                "name": part.tool_name,
                                "response": {"result": _jsonable(part.content)},
                            }
                        })
                    elif isinstance(part, RetryPromptPart):
                        if part.tool_name:
                            user_parts.append({
                                "functionResponse": {
                                    "name": part.tool_name,
                                    "response": {"error": part.content},
                                }
                            })
                        else:
                            user_parts.append({"text": part.content})
                if user_parts:
                    contents.append({"role": "user", "parts": user_parts})
            elif isinstance(msg, ModelResponse):
                model_parts: list[dict] = []
                for part in msg.parts:
                    if isinstance(part, TextPart):
                        if part.content:
                            model_parts.append({"text": part.content})
                    elif isinstance(part, ToolCallPart):
                        args = part.args if isinstance(part.args, dict) else _try_json(part.args)
                        model_parts.append({"functionCall": {"name": part.tool_name, "args": args}})
                    # ThinkingPart 不回灌
                if model_parts:
                    contents.append({"role": "model", "parts": model_parts})

        return contents, system_texts

    def _build_body(
        self,
        messages: list[ModelMessage],
        system_parts: list[SystemPromptPart],
        tools: list[ToolDefinition],
        require_tool: bool,
        settings: dict,
    ) -> dict:
        contents, system_texts = self._build_contents(messages, system_parts)
        body: dict = {"contents": _ensure_user_first(_merge_same_role(contents))}
        if system_texts:
            body["systemInstruction"] = {"parts": system_texts}

        if tools:
            body["tools"] = [{
                "functionDeclarations": [
                    {
                        "name": t.name,
                        "description": t.description,
                        "parameters": _to_gemini_schema(
                            t.parameters_json_schema or {"type": "object", "properties": {}}
                        ),
                    }
                    for t in tools
                ]
            }]
            body["toolConfig"] = {
                "functionCallingConfig": {"mode": "ANY" if require_tool else "AUTO"}
            }

        gen: dict = {}
        if "temperature" in settings:
            gen["temperature"] = settings["temperature"]
        if "max_tokens" in settings:
            gen["maxOutputTokens"] = settings["max_tokens"]
        if settings.get("thinking"):
            gen["thinkingConfig"] = {"includeThoughts": True}
        if gen:
            body["generationConfig"] = gen

        safety = settings.get("google_safety_settings")
        if isinstance(safety, list) and safety:
            body["safetySettings"] = safety
        return body

    # ---------- 请求 ----------

    async def request(
        self,
        messages: list[ModelMessage],
        *,
        system_parts: list[SystemPromptPart],
        tools: list[ToolDefinition],
        require_tool: bool,
        model_settings: Optional[dict] = None,
    ) -> tuple[ModelResponse, Usage]:
        settings = dict(model_settings or {})
        body = self._build_body(messages, system_parts, tools, require_tool, settings)

        base = self.provider.base_url.rstrip("/")
        url = f"{base}/models/{self.model_name}:generateContent"
        headers = {"content-type": "application/json"}
        if self.provider.api_key:
            headers["x-goog-api-key"] = self.provider.api_key

        resp = await self._client.post(url, headers=headers, json=body)
        if resp.status_code >= 400:
            text = _safe_text(resp)
            # 部分网关把 PROHIBITED_CONTENT 直接放进 4xx body
            if "PROHIBITED_CONTENT" in text.upper():
                raise GeminiBlockedError(f"Gemini blocked (HTTP {resp.status_code}): PROHIBITED_CONTENT; {text}")
            raise ModelHTTPError(resp.status_code, text, body=text)

        data = resp.json()
        return _parse_gemini_response(data)


# ============================================================
# 响应解析
# ============================================================

def _parse_gemini_response(data: dict) -> tuple[ModelResponse, Usage]:
    usage = _parse_usage(data.get("usageMetadata"))

    feedback = data.get("promptFeedback") or {}
    block_reason = str(feedback.get("blockReason") or "")
    candidates = data.get("candidates") or []
    finish_reason = str((candidates[0] if candidates else {}).get("finishReason") or "")

    parts: list = []
    if candidates:
        content = candidates[0].get("content") or {}
        for p in content.get("parts") or []:
            if "functionCall" in p:
                fc = p["functionCall"] or {}
                parts.append(ToolCallPart(tool_name=fc.get("name") or "", args=fc.get("args") or {}))
            elif "text" in p:
                if p.get("thought"):
                    parts.append(ThinkingPart(content=str(p.get("text") or "")))
                elif str(p.get("text") or "").strip():
                    parts.append(TextPart(content=str(p["text"])))

    if not parts:
        reason_blob = f"blockReason={block_reason or 'none'}, finishReason={finish_reason or 'none'}"
        if "PROHIBITED" in (block_reason + finish_reason).upper():
            raise GeminiBlockedError(f"Gemini blocked: PROHIBITED_CONTENT ({reason_blob})")
        if block_reason or finish_reason in ("SAFETY", "RECITATION", "BLOCKLIST"):
            raise GeminiBlockedError(f"Gemini blocked / empty output ({reason_blob})")
        # 既无 parts 又无明确拦截：交给 Agent 的空输出重试逻辑
    return ModelResponse(parts=parts), usage


def _parse_usage(raw: Any) -> Usage:
    if not isinstance(raw, dict):
        return Usage(requests=1)
    return Usage(
        input_tokens=int(raw.get("promptTokenCount") or 0),
        output_tokens=int(raw.get("candidatesTokenCount") or 0),
        total_tokens=int(raw.get("totalTokenCount") or 0),
        requests=1,
    )


# ============================================================
# helpers
# ============================================================

def _merge_same_role(contents: list[dict]) -> list[dict]:
    """合并相邻同 role 的 content（Gemini 要求 user/model 交替）。"""
    merged: list[dict] = []
    for c in contents:
        if merged and merged[-1].get("role") == c.get("role"):
            merged[-1]["parts"].extend(c.get("parts") or [])
        else:
            merged.append({"role": c.get("role"), "parts": list(c.get("parts") or [])})
    return merged


def _ensure_user_first(contents: list[dict]) -> list[dict]:
    """
    Vertex/Gemini 要求 contents[0].role == 'user'。
    长对话经 token 滑窗裁剪后，保留窗口可能以 model 轮开头——丢弃开头这些孤立 model 轮
    （它们没有对应的前序 user 提问，本就不可用），保证首条为 user。
    """
    while contents and contents[0].get("role") != "user":
        contents.pop(0)
    return contents


def _jsonable(value: Any) -> Any:
    if isinstance(value, list):
        return [_jsonable(x) for x in value]
    if hasattr(value, "model_dump"):
        return value.model_dump()
    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}
    return value


def _try_json(s: Any) -> dict:
    if isinstance(s, dict):
        return s
    try:
        return json.loads(s)
    except Exception:
        return {}


def _safe_text(resp: httpx.Response) -> str:
    try:
        return resp.text
    except Exception:
        return ""


__all__ = ["GoogleModel", "GeminiBlockedError"]
