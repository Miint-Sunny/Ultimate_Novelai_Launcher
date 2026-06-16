from __future__ import annotations

import json
import re

import httpx

from ..config import Settings
from ..nai.models import GenerationParams, ResolvedPrompt
from .prompts import SYSTEM_PROMPT


class LLMNotConfiguredError(Exception):
    pass


class LLMConversionError(Exception):
    pass


def require_llm(settings: Settings) -> None:
    if not settings.llm_configured:
        raise LLMNotConfiguredError("LLM is not configured; use tags mode or set LLM_BASE_URL, LLM_API_KEY, and LLM_MODEL")


async def chat_completion(
    *,
    settings: Settings,
    messages: list[dict[str, str]],
    temperature: float = 0.3,
    max_tokens: int = 1000,
) -> dict:
    require_llm(settings)
    payload = {
        "model": settings.llm_model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    headers = {
        "Authorization": f"Bearer {settings.llm_api_key}",
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(base_url=settings.llm_base_url, timeout=60.0) as client:
        response = await client.post("/chat/completions", json=payload, headers=headers)
    if response.status_code >= 400:
        raise LLMConversionError(f"LLM request failed with HTTP {response.status_code}")
    try:
        return response.json()
    except ValueError as exc:
        raise LLMConversionError("LLM response was not valid JSON") from exc


async def convert_natural_to_tags(
    *,
    settings: Settings,
    user_input: str,
    fallback_params: GenerationParams,
    fallback_negative: str,
) -> ResolvedPrompt:
    require_llm(settings)
    payload = {
        "model": settings.llm_model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_input},
        ],
        "temperature": 0.2,
    }
    headers = {
        "Authorization": f"Bearer {settings.llm_api_key}",
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(base_url=settings.llm_base_url, timeout=60.0) as client:
        response = await client.post("/chat/completions", json=payload, headers=headers)
    if response.status_code >= 400:
        raise LLMConversionError(f"LLM request failed with HTTP {response.status_code}")

    content = _extract_content(response.json())
    raw = _extract_json_object(content)
    try:
        parsed = json.loads(raw)
        params_data = {**fallback_params.model_dump(), **(parsed.get("params") or {})}
        return ResolvedPrompt(
            tags=str(parsed.get("tags") or "").strip(),
            negative=str(parsed.get("negative") or fallback_negative or "").strip(),
            params=GenerationParams(**params_data),
        )
    except Exception as exc:
        raise LLMConversionError("LLM response did not match the expected JSON schema") from exc


def _extract_content(data: dict) -> str:
    choices = data.get("choices") or []
    if not choices:
        raise LLMConversionError("LLM response had no choices")
    message = choices[0].get("message") or {}
    content = message.get("content")
    if not isinstance(content, str) or not content.strip():
        raise LLMConversionError("LLM response content was empty")
    return content.strip()


def _extract_json_object(content: str) -> str:
    if content.startswith("{") and content.endswith("}"):
        return content
    match = re.search(r"\{[\s\S]*\}", content)
    if not match:
        raise LLMConversionError("LLM response did not contain a JSON object")
    return match.group(0)
