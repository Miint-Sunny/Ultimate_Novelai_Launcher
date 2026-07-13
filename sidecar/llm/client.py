from __future__ import annotations

import json
import re
from collections.abc import Callable
from typing import Any

import httpx

from ..config import LLM_DEFAULT_BASES, LlmSlot, Settings
from ..infrastructure import HttpClientPool, request_with_policy
from ..nai.models import GenerationParams, ResolvedPrompt
from ..security import OutboundPolicy, OutboundPolicyError
from .prompts import SYSTEM_PROMPT

_NOT_CONFIGURED_MSG = (
    "LLM is not configured; set a provider / base URL / model / API key in settings, "
    "or use tags mode"
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


async def _call_openai(
    slot: LlmSlot,
    messages: list[dict[str, str]],
    temperature: float,
    max_tokens: int,
    *,
    http: HttpClientPool | None = None,
    client: httpx.AsyncClient | None = None,
    outbound_policy: OutboundPolicy,
) -> str:
    payload = {
        "model": slot.model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    headers = {"Authorization": f"Bearer {slot.api_key}", "Content-Type": "application/json"}
    resp = await _post_json(
        http=http,
        client=client,
        outbound_policy=outbound_policy,
        url=f"{slot.base_url.rstrip('/')}/chat/completions",
        payload=payload,
        headers=headers,
    )
    if resp.status_code >= 400:
        raise LLMConversionError(f"OpenAI-compatible request failed: HTTP {resp.status_code}")
    return _openai_text(resp.json())


async def _call_anthropic(
    slot: LlmSlot,
    messages: list[dict[str, str]],
    temperature: float,
    max_tokens: int,
    *,
    http: HttpClientPool | None = None,
    client: httpx.AsyncClient | None = None,
    outbound_policy: OutboundPolicy,
) -> str:
    system, convo = _split_system(messages)
    payload: dict = {
        "model": slot.model,
        "max_tokens": max_tokens,
        "messages": convo,
        "temperature": temperature,
    }
    if system:
        payload["system"] = system
    headers = {
        "x-api-key": slot.api_key,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
    }
    resp = await _post_json(
        http=http,
        client=client,
        outbound_policy=outbound_policy,
        url=f"{slot.base_url.rstrip('/')}/v1/messages",
        payload=payload,
        headers=headers,
    )
    if resp.status_code >= 400:
        raise LLMConversionError(f"Anthropic request failed: HTTP {resp.status_code}")
    blocks = resp.json().get("content") or []
    text = "".join(
        b.get("text", "") for b in blocks if isinstance(b, dict) and b.get("type") == "text"
    ).strip()
    if not text:
        raise LLMConversionError("Anthropic response was empty")
    return text


async def _call_gemini(
    slot: LlmSlot,
    messages: list[dict[str, str]],
    temperature: float,
    max_tokens: int,
    *,
    http: HttpClientPool | None = None,
    client: httpx.AsyncClient | None = None,
    outbound_policy: OutboundPolicy,
) -> str:
    system, convo = _split_system(messages)
    contents = [
        {
            "role": ("model" if m["role"] == "assistant" else "user"),
            "parts": [{"text": m["content"]}],
        }
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
    resp = await _post_json(
        http=http,
        client=client,
        outbound_policy=outbound_policy,
        url=url,
        payload=payload,
        headers=headers,
    )
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


async def _call_slot(
    slot: LlmSlot,
    messages: list[dict[str, str]],
    temperature: float,
    max_tokens: int,
    *,
    http: HttpClientPool | None = None,
    client: httpx.AsyncClient | None = None,
    outbound_policy: OutboundPolicy,
) -> str:
    if slot.provider == "anthropic":
        return await _call_anthropic(
            slot,
            messages,
            temperature,
            max_tokens,
            http=http,
            client=client,
            outbound_policy=outbound_policy,
        )
    if slot.provider == "gemini":
        return await _call_gemini(
            slot,
            messages,
            temperature,
            max_tokens,
            http=http,
            client=client,
            outbound_policy=outbound_policy,
        )
    return await _call_openai(
        slot,
        messages,
        temperature,
        max_tokens,
        http=http,
        client=client,
        outbound_policy=outbound_policy,
    )


async def _post_json(
    *,
    http: HttpClientPool | None,
    client: httpx.AsyncClient | None,
    outbound_policy: OutboundPolicy,
    url: str,
    payload: dict[str, Any],
    headers: dict[str, str],
) -> httpx.Response:
    if http is not None and client is not None:
        raise ValueError("pass either http or client, not both")
    if http is not None:
        return await http.request(
            outbound_policy,
            "POST",
            url,
            headers=headers,
            json=payload,
            timeout=60.0,
        )
    if client is not None:
        return await request_with_policy(
            client,
            outbound_policy,
            "POST",
            url,
            headers=headers,
            json=payload,
            timeout=60.0,
        )

    # Compatibility for direct callers outside the composed sidecar runtime.
    async with httpx.AsyncClient(follow_redirects=False) as owned_client:
        return await request_with_policy(
            owned_client,
            outbound_policy,
            "POST",
            url,
            headers=headers,
            json=payload,
            timeout=60.0,
        )


def _slot_scope_pairs(settings: Settings) -> list[tuple[LlmSlot, str, tuple[str, ...]]]:
    slots = settings.llm_slots()
    scopes: list[str] = []
    trusted_networks: list[tuple[str, ...]] = []
    candidates = (
        (
            settings.llm_provider,
            settings.llm_base_url,
            settings.llm_api_key,
            settings.llm_model,
            settings.llm_network_scope,
            settings.llm_trusted_networks,
        ),
        (
            settings.llm_backup_provider,
            settings.llm_backup_base_url,
            settings.llm_backup_api_key,
            settings.llm_backup_model,
            settings.llm_backup_network_scope,
            settings.llm_backup_trusted_networks,
        ),
    )
    for provider, base_url, api_key, model, scope, networks in candidates:
        normalized_provider = (provider or "openai").strip().lower()
        resolved_base = (base_url or "").strip().rstrip("/") or LLM_DEFAULT_BASES.get(
            normalized_provider,
            "",
        )
        if api_key.strip() and model.strip() and resolved_base:
            scopes.append(scope or "public")
            trusted_networks.append(networks)
    if len(scopes) != len(slots):
        scopes = ["public"] * len(slots)
        trusted_networks = [()] * len(slots)
    return list(zip(slots, scopes, trusted_networks, strict=True))


async def llm_chat_text(
    *,
    settings: Settings,
    messages: list[dict[str, str]],
    temperature: float = 0.3,
    max_tokens: int = 1000,
    http: HttpClientPool | None = None,
    client: httpx.AsyncClient | None = None,
    policy_factory: Callable[[str], OutboundPolicy] | None = None,
) -> str:
    """Call the primary LLM, falling back to the backup on any failure. Returns text."""
    slot_scopes = _slot_scope_pairs(settings)
    if not slot_scopes:
        raise LLMNotConfiguredError(_NOT_CONFIGURED_MSG)
    last_err: Exception | None = None
    for slot, network_scope, trusted_networks in slot_scopes:
        policy = (
            policy_factory(network_scope)
            if policy_factory is not None
            else OutboundPolicy(network_scope, trusted_networks=trusted_networks)
        )
        try:
            return await _call_slot(
                slot,
                messages,
                temperature,
                max_tokens,
                http=http,
                client=client,
                outbound_policy=policy,
            )
        except OutboundPolicyError:
            # Endpoint policy is local validation, not an upstream outage. It
            # must fail closed instead of silently trying another credential.
            raise
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
    http: HttpClientPool | None = None,
    client: httpx.AsyncClient | None = None,
    policy_factory: Callable[[str], OutboundPolicy] | None = None,
) -> dict:
    """Provider-agnostic chat call, returned in OpenAI shape for existing callers/the frontend."""
    text = await llm_chat_text(
        settings=settings,
        messages=messages,
        temperature=temperature,
        max_tokens=max_tokens,
        http=http,
        client=client,
        policy_factory=policy_factory,
    )
    return {"choices": [{"message": {"role": "assistant", "content": text}}]}


async def convert_natural_to_tags(
    *,
    settings: Settings,
    user_input: str,
    fallback_params: GenerationParams,
    fallback_negative: str,
    http: HttpClientPool | None = None,
    client: httpx.AsyncClient | None = None,
    policy_factory: Callable[[str], OutboundPolicy] | None = None,
) -> ResolvedPrompt:
    content = await llm_chat_text(
        settings=settings,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_input},
        ],
        temperature=0.2,
        max_tokens=2000,
        http=http,
        client=client,
        policy_factory=policy_factory,
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
