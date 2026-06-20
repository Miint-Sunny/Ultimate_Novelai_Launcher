from __future__ import annotations

import json
import re

import httpx

from ..config import LlmSlot, Settings
from ..nai.models import GenerationParams, ResolvedPrompt
from .prompts import SYSTEM_PROMPT

_NOT_CONFIGURED_MSG = (
    "LLM is not configured; set a provider / base URL / model / API key in settings, or use tags mode"
)


class LLMNotConfiguredError(Exception):
    pass


class LLMConversionError(Exception):
    pass


def require_llm(settings: Settings) -> None:
    if not settings.llm_slots():
        raise LLMNotConfiguredError(_NOT_CONFIGURED_MSG)


# ---------------------------------------------------------------------------
# Provider adapters — each formats the request/response for one wire protocol
# and returns plain text. Messages are OpenAI-style [{role, content}].
# ---------------------------------------------------------------------------


def _split_system(messages: list[dict[str, str]]) -> tuple[str, list[dict[str, str]]]:
    system_parts: list[str] = []
    convo: list[dict[str, str]] = []
    for m in messages:
        role = m.get("role")
        content = m.get("content", "") or ""
        if role == "system":
            if content:
                system_parts.append(content)
        else:
            convo.append({"role": role or "user", "content": content})
    return "\n\n".join(system_parts), convo


def _openai_text(data: dict) -> str:
    choices = data.get("choices") or []
    if not choices:
        raise LLMConversionError("LLM response had no choices")
    content = (choices[0].get("message") or {}).get("content")
    if isinstance(content, list):
        content = "".join(p.get("text", "") for p in content if isinstance(p, dict))
    if not isinstance(content, str) or not content.strip():
        raise LLMConversionError("LLM response content was empty")
    return content.strip()


async def _call_openai(slot: LlmSlot, messages: list[dict[str, str]], temperature: float, max_tokens: int) -> str:
    payload = {
        "model": slot.model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    headers = {"Authorization": f"Bearer {slot.api_key}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(f"{slot.base_url}/chat/completions", json=payload, headers=headers)
    if resp.status_code >= 400:
        raise LLMConversionError(f"OpenAI-compatible request failed: HTTP {resp.status_code}")
    return _openai_text(resp.json())


async def _call_anthropic(slot: LlmSlot, messages: list[dict[str, str]], temperature: float, max_tokens: int) -> str:
    system, convo = _split_system(messages)
    payload: dict = {"model": slot.model, "max_tokens": max_tokens, "messages": convo, "temperature": temperature}
    if system:
        payload["system"] = system
    headers = {
        "x-api-key": slot.api_key,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(f"{slot.base_url}/v1/messages", json=payload, headers=headers)
    if resp.status_code >= 400:
        raise LLMConversionError(f"Anthropic request failed: HTTP {resp.status_code}")
    blocks = resp.json().get("content") or []
    text = "".join(b.get("text", "") for b in blocks if isinstance(b, dict) and b.get("type") == "text").strip()
    if not text:
        raise LLMConversionError("Anthropic response was empty")
    return text


async def _call_gemini(slot: LlmSlot, messages: list[dict[str, str]], temperature: float, max_tokens: int) -> str:
    system, convo = _split_system(messages)
    contents = [
        {"role": ("model" if m["role"] == "assistant" else "user"), "parts": [{"text": m["content"]}]}
        for m in convo
    ]
    payload: dict = {
        "contents": contents,
        "generationConfig": {"temperature": temperature, "maxOutputTokens": max_tokens},
    }
    if system:
        payload["systemInstruction"] = {"parts": [{"text": system}]}
    base = slot.base_url.rstrip("/")
    if "/v1beta" not in base and "/v1" not in base:
        base = f"{base}/v1beta"
    url = f"{base}/models/{slot.model}:generateContent"
    headers = {"x-goog-api-key": slot.api_key, "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(url, json=payload, headers=headers)
    if resp.status_code >= 400:
        raise LLMConversionError(f"Gemini request failed: HTTP {resp.status_code}")
    candidates = resp.json().get("candidates") or []
    if not candidates:
        raise LLMConversionError("Gemini response had no candidates")
    parts = ((candidates[0].get("content") or {}).get("parts")) or []
    text = "".join(p.get("text", "") for p in parts if isinstance(p, dict)).strip()
    if not text:
        raise LLMConversionError("Gemini response was empty")
    return text


async def _call_slot(slot: LlmSlot, messages: list[dict[str, str]], temperature: float, max_tokens: int) -> str:
    if slot.provider == "anthropic":
        return await _call_anthropic(slot, messages, temperature, max_tokens)
    if slot.provider == "gemini":
        return await _call_gemini(slot, messages, temperature, max_tokens)
    return await _call_openai(slot, messages, temperature, max_tokens)


async def llm_chat_text(
    *,
    settings: Settings,
    messages: list[dict[str, str]],
    temperature: float = 0.3,
    max_tokens: int = 1000,
) -> str:
    """Call the primary LLM, falling back to the backup on any failure. Returns text."""
    slots = settings.llm_slots()
    if not slots:
        raise LLMNotConfiguredError(_NOT_CONFIGURED_MSG)
    last_err: Exception | None = None
    for slot in slots:
        try:
            return await _call_slot(slot, messages, temperature, max_tokens)
        except Exception as exc:
            last_err = exc
            continue
    raise LLMConversionError(f"All LLM endpoints failed: {last_err}")


async def chat_completion(
    *,
    settings: Settings,
    messages: list[dict[str, str]],
    temperature: float = 0.3,
    max_tokens: int = 1000,
) -> dict:
    """Provider-agnostic chat call, returned in OpenAI shape for existing callers/the frontend."""
    text = await llm_chat_text(settings=settings, messages=messages, temperature=temperature, max_tokens=max_tokens)
    return {"choices": [{"message": {"role": "assistant", "content": text}}]}


async def convert_natural_to_tags(
    *,
    settings: Settings,
    user_input: str,
    fallback_params: GenerationParams,
    fallback_negative: str,
) -> ResolvedPrompt:
    content = await llm_chat_text(
        settings=settings,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_input},
        ],
        temperature=0.2,
        max_tokens=2000,
    )
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
