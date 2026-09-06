"""Native-provider streaming for the harness relay: Anthropic Messages and Gemini.

The client speaks one dialect, OpenAI ``chat.completion.chunk``.  A slot or
choice configured with the ``anthropic`` or ``gemini`` protocol is served by
translating in both directions here: the OpenAI-shaped turn becomes the
provider's request, and the provider's stream becomes OpenAI chunks.  Nothing
provider-specific reaches the client except the ``X-Llm-Provider`` header.

Vendor switches: ``reasoning_effort`` is mapped to each provider's thinking
control; anything else the client wants to send natively goes in the namespaced
``extra_body.anthropic`` / ``extra_body.gemini`` objects, merged over the
translated body with the relay-owned keys excluded.  The OpenAI-gateway thinking
matrix keys the client computes for compatible gateways are ignored on native
slots because they are not part of either provider's wire format.
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Mapping, Sequence
from typing import Any

from .chat_request import split_data_url
from .models.google import _to_gemini_schema as to_gemini_schema
from .stream import (
    STREAM_ACCEPT,
    LlmStreamUnsupportedError,
    NativeStreamError,
    UpstreamRequest,
    build_chat_body,
)

logger = logging.getLogger(__name__)

ANTHROPIC_VERSION = "2023-06-01"
# Anthropic requires max_tokens; the buffered client and the host adapter use 4096.
ANTHROPIC_DEFAULT_MAX_TOKENS = 4096
# OpenAI ``reasoning_effort`` levels as thinking budgets (tokens). ``none`` turns
# thinking off; a missing effort leaves the provider's default in place.
THINKING_BUDGETS = {
    "minimal": 1024,
    "low": 2048,
    "medium": 8192,
    "high": 16384,
    "xhigh": 32768,
}
ANTHROPIC_RESERVED_KEYS = frozenset(
    {"model", "messages", "stream", "system", "tools", "tool_choice"}
)
GEMINI_RESERVED_KEYS = frozenset({"contents", "systemInstruction", "tools", "toolConfig"})
_ANTHROPIC_TOOL_CHOICE = {"auto": "auto", "required": "any", "none": "none"}
_GEMINI_TOOL_MODE = {"auto": "AUTO", "required": "ANY", "none": "NONE"}
_ANTHROPIC_STOP_REASONS = {
    "end_turn": "stop",
    "stop_sequence": "stop",
    "pause_turn": "stop",
    "max_tokens": "length",
    "tool_use": "tool_calls",
    "refusal": "content_filter",
}
_ANTHROPIC_TRANSIENT_ERRORS = frozenset({"overloaded_error", "api_error", "rate_limit_error"})
_GEMINI_BLOCK_REASONS = frozenset(
    {"SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY"}
)
# Same list the sidecar Agent and the cloud host send: the harness drives NSFW
# image prompts, and Gemini's default filters (including the jailbreak one that
# thinking trips on) would otherwise cut the stream with an empty candidate.
GEMINI_SAFETY_OFF: tuple[dict[str, str], ...] = (
    {"category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "OFF"},
    {"category": "HARM_CATEGORY_HARASSMENT", "threshold": "OFF"},
    {"category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "OFF"},
    {"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "OFF"},
    {"category": "HARM_CATEGORY_CIVIC_INTEGRITY", "threshold": "OFF"},
    {"category": "HARM_CATEGORY_JAILBREAK", "threshold": "OFF"},
)


# ---------------------------------------------------------------------------
# Shared conversion helpers
# ---------------------------------------------------------------------------


def _text_of(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            str(part.get("text") or "")
            for part in content
            if isinstance(part, Mapping) and part.get("type") == "text"
        )
    return ""


def _json_object(arguments: Any) -> dict[str, Any]:
    if isinstance(arguments, Mapping):
        return dict(arguments)
    if not isinstance(arguments, str) or not arguments.strip():
        return {}
    try:
        parsed = json.loads(arguments)
    except ValueError:
        return {}
    return parsed if isinstance(parsed, dict) else {"value": parsed}


def _merge_adjacent(messages: list[dict[str, Any]], key: str) -> list[dict[str, Any]]:
    """Both providers want strict user/assistant alternation: fold same-role neighbours."""

    merged: list[dict[str, Any]] = []
    for message in messages:
        if merged and merged[-1]["role"] == message["role"]:
            merged[-1][key].extend(message[key])
        else:
            merged.append({"role": message["role"], key: list(message[key])})
    while merged and merged[0]["role"] != "user":
        # A window that starts with the model's own turn has no question to answer.
        merged.pop(0)
    return merged


def _merge_namespaced(
    body: dict[str, Any],
    fields: Mapping[str, Any],
    namespace: str,
    host_extra_body: Mapping[str, Any] | None,
    *,
    reserved: frozenset[str],
    deep_keys: tuple[str, ...] = (),
) -> None:
    extra = fields.get("extra_body")
    client_native = extra.get(namespace) if isinstance(extra, Mapping) else None
    for source in (client_native, host_extra_body):
        if not isinstance(source, Mapping):
            continue
        for key, value in source.items():
            if key in reserved:
                continue
            current = body.get(key)
            if key in deep_keys and isinstance(value, Mapping) and isinstance(current, dict):
                body[key] = {**current, **value}
            else:
                body[key] = value


def _tool_functions(fields: Mapping[str, Any]) -> list[dict[str, Any]]:
    tools = fields.get("tools") or []
    functions: list[dict[str, Any]] = []
    for tool in tools:
        if not isinstance(tool, Mapping):
            continue
        function = tool.get("function")
        if isinstance(function, Mapping) and function.get("name"):
            functions.append(dict(function))
    return functions


class _ChunkFactory:
    """Builds ``chat.completion.chunk`` objects with the stream's id/model once known."""

    def __init__(self) -> None:
        self.id = ""
        self.model = ""
        self.created = int(time.time())

    def delta(self, delta: Mapping[str, Any]) -> dict[str, Any]:
        return self._chunk([{"index": 0, "delta": dict(delta), "finish_reason": None}])

    def finish(self, reason: str) -> dict[str, Any]:
        return self._chunk([{"index": 0, "delta": {}, "finish_reason": reason}])

    def usage(self, prompt: int, completion: int, total: int | None = None) -> dict[str, Any]:
        chunk = self._chunk([])
        chunk["usage"] = {
            "prompt_tokens": prompt,
            "completion_tokens": completion,
            "total_tokens": total if total is not None else prompt + completion,
        }
        return chunk

    def _chunk(self, choices: list[dict[str, Any]]) -> dict[str, Any]:
        return {
            "id": self.id,
            "object": "chat.completion.chunk",
            "created": self.created,
            "model": self.model,
            "choices": choices,
        }


# ---------------------------------------------------------------------------
# Anthropic Messages API
# ---------------------------------------------------------------------------


def _anthropic_blocks(content: Any) -> list[dict[str, Any]]:
    if isinstance(content, str):
        return [{"type": "text", "text": content}] if content.strip() else []
    blocks: list[dict[str, Any]] = []
    if isinstance(content, list):
        for part in content:
            if not isinstance(part, Mapping):
                continue
            if part.get("type") == "text":
                text = str(part.get("text") or "")
                if text.strip():
                    blocks.append({"type": "text", "text": text})
            elif part.get("type") == "image_url":
                image = part.get("image_url") or {}
                mime, data = split_data_url(str(image.get("url") or ""))
                blocks.append(
                    {
                        "type": "image",
                        "source": {"type": "base64", "media_type": mime, "data": data},
                    }
                )
    return blocks


def anthropic_messages(
    messages: Sequence[Mapping[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """OpenAI-shaped messages -> (system blocks, Anthropic messages)."""

    system: list[dict[str, Any]] = []
    wire: list[dict[str, Any]] = []
    for message in messages:
        role = message.get("role")
        content = message.get("content")
        if role == "system":
            text = _text_of(content)
            if text.strip():
                system.append({"type": "text", "text": text})
        elif role == "user":
            blocks = _anthropic_blocks(content)
            if blocks:
                wire.append({"role": "user", "content": blocks})
        elif role == "assistant":
            blocks = _anthropic_blocks(content)
            for call in message.get("tool_calls") or []:
                function = call.get("function") or {}
                blocks.append(
                    {
                        "type": "tool_use",
                        "id": str(call.get("id") or ""),
                        "name": str(function.get("name") or ""),
                        "input": _json_object(function.get("arguments")),
                    }
                )
            if blocks:
                wire.append({"role": "assistant", "content": blocks})
        elif role == "tool":
            result: dict[str, Any] = {
                "type": "tool_result",
                "tool_use_id": str(message.get("tool_call_id") or ""),
            }
            blocks = _anthropic_blocks(content)
            if len(blocks) == 1 and blocks[0]["type"] == "text":
                result["content"] = blocks[0]["text"]
            elif blocks:
                result["content"] = blocks
            wire.append({"role": "user", "content": [result]})
    return system, _merge_adjacent(wire, "content")


def _anthropic_thinking(effort: Any) -> dict[str, Any] | None:
    if not isinstance(effort, str) or effort in ("", "none"):
        return None
    budget = THINKING_BUDGETS.get(effort)
    if budget is None:
        return None
    return {"type": "enabled", "budget_tokens": budget}


def build_anthropic_request(
    *,
    model: str,
    base_url: str,
    api_key: str,
    fields: Mapping[str, Any],
    host_extra_body: Mapping[str, Any] | None = None,
) -> UpstreamRequest:
    system, messages = anthropic_messages(fields.get("messages") or [])
    body: dict[str, Any] = {"model": model, "messages": messages, "stream": True}
    if system:
        body["system"] = system
    functions = _tool_functions(fields)
    if functions:
        body["tools"] = [
            {
                "name": function["name"],
                "description": str(function.get("description") or ""),
                "input_schema": function.get("parameters") or {"type": "object", "properties": {}},
            }
            for function in functions
        ]
        choice = _ANTHROPIC_TOOL_CHOICE.get(str(fields.get("tool_choice") or "auto"), "auto")
        body["tool_choice"] = {"type": choice}
    max_tokens = fields.get("max_tokens")
    if not isinstance(max_tokens, int) or isinstance(max_tokens, bool) or max_tokens < 1:
        max_tokens = ANTHROPIC_DEFAULT_MAX_TOKENS
    thinking = _anthropic_thinking(fields.get("reasoning_effort"))
    if thinking is not None:
        body["thinking"] = thinking
        # Anthropic requires max_tokens > budget_tokens and forbids a custom
        # temperature while thinking is enabled.
        max_tokens = max(max_tokens, thinking["budget_tokens"] + ANTHROPIC_DEFAULT_MAX_TOKENS)
    elif fields.get("temperature") is not None:
        body["temperature"] = fields["temperature"]
    body["max_tokens"] = max_tokens
    _merge_namespaced(body, fields, "anthropic", host_extra_body, reserved=ANTHROPIC_RESERVED_KEYS)
    headers = {
        "x-api-key": api_key,
        "anthropic-version": ANTHROPIC_VERSION,
        "Content-Type": "application/json",
        "Accept": STREAM_ACCEPT,
    }
    return UpstreamRequest(
        url=f"{base_url.rstrip('/')}/v1/messages",
        headers=headers,
        body=body,
        translator=AnthropicTranslator(),
    )


class AnthropicTranslator:
    """Anthropic stream events (dispatched by ``type``) -> OpenAI chunks."""

    def __init__(self) -> None:
        self._chunks = _ChunkFactory()
        self._tool_indexes: dict[int, int] = {}
        self._next_tool = 0
        self._prompt_tokens = 0
        self._completion_tokens = 0
        self._finish_reason: str | None = None
        self._finished = False

    def feed(self, data: str) -> list[dict[str, Any]]:
        try:
            payload = json.loads(data)
        except ValueError:
            return []
        if not isinstance(payload, Mapping):
            return []
        return self._handle(payload)

    def feed_json(self, payload: Mapping[str, Any]) -> list[dict[str, Any]]:
        return self._handle(payload)

    def finish(self) -> list[dict[str, Any]]:
        if self._finished:
            return []
        self._finished = True
        return [
            self._chunks.finish(self._finish_reason or "stop"),
            self._chunks.usage(self._prompt_tokens, self._completion_tokens),
        ]

    # -- event handlers -----------------------------------------------------

    def _handle(self, payload: Mapping[str, Any]) -> list[dict[str, Any]]:
        kind = payload.get("type")
        if kind == "message_start":
            message = payload.get("message") or {}
            self._chunks.id = str(message.get("id") or "")
            self._chunks.model = str(message.get("model") or "")
            self._read_usage(message.get("usage"))
            return []
        if kind == "content_block_start":
            return self._block_start(payload)
        if kind == "content_block_delta":
            return self._block_delta(payload)
        if kind == "message_delta":
            delta = payload.get("delta") or {}
            stop = delta.get("stop_reason") if isinstance(delta, Mapping) else None
            if isinstance(stop, str) and stop:
                self._finish_reason = _ANTHROPIC_STOP_REASONS.get(stop, "stop")
            self._read_usage(payload.get("usage"))
            return []
        if kind == "message_stop":
            return self.finish()
        if kind == "message":
            return self._whole_message(payload)
        if kind == "error":
            error = payload.get("error") or {}
            error_type = str(error.get("type") or "api_error")
            message = str(error.get("message") or "")
            raise NativeStreamError(
                f"Anthropic stream error: {error_type}: {message}".rstrip(": "),
                retryable=error_type in _ANTHROPIC_TRANSIENT_ERRORS,
            )
        # ping, content_block_stop and unknown events carry nothing for the client.
        return []

    def _read_usage(self, usage: Any) -> None:
        if not isinstance(usage, Mapping):
            return
        prompt = 0
        for key in ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"):
            value = usage.get(key)
            if isinstance(value, int) and not isinstance(value, bool):
                prompt += value
        if prompt:
            self._prompt_tokens = prompt
        output = usage.get("output_tokens")
        if isinstance(output, int) and not isinstance(output, bool) and output > 1:
            self._completion_tokens = output

    def _block_start(self, payload: Mapping[str, Any]) -> list[dict[str, Any]]:
        block = payload.get("content_block") or {}
        if not isinstance(block, Mapping) or block.get("type") != "tool_use":
            return []
        index = payload.get("index", 0)
        tool_index = self._next_tool
        self._next_tool += 1
        self._tool_indexes[index if isinstance(index, int) else 0] = tool_index
        call: dict[str, Any] = {
            "index": tool_index,
            "id": str(block.get("id") or f"call_{tool_index}"),
            "type": "function",
            "function": {"name": str(block.get("name") or ""), "arguments": ""},
        }
        initial = block.get("input")
        if isinstance(initial, Mapping) and initial:
            # Non-streaming gateways deliver the whole input in the start event.
            call["function"]["arguments"] = json.dumps(initial, ensure_ascii=False)
        return [self._chunks.delta({"tool_calls": [call]})]

    def _block_delta(self, payload: Mapping[str, Any]) -> list[dict[str, Any]]:
        delta = payload.get("delta") or {}
        if not isinstance(delta, Mapping):
            return []
        kind = delta.get("type")
        if kind == "text_delta":
            text = str(delta.get("text") or "")
            return [self._chunks.delta({"content": text})] if text else []
        if kind == "thinking_delta":
            thought = str(delta.get("thinking") or "")
            return [self._chunks.delta({"reasoning_content": thought})] if thought else []
        if kind == "input_json_delta":
            partial = str(delta.get("partial_json") or "")
            index = payload.get("index", 0)
            tool_index = self._tool_indexes.get(index if isinstance(index, int) else 0)
            if tool_index is None or not partial:
                return []
            return [
                self._chunks.delta(
                    {"tool_calls": [{"index": tool_index, "function": {"arguments": partial}}]}
                )
            ]
        return []

    def _whole_message(self, payload: Mapping[str, Any]) -> list[dict[str, Any]]:
        """A gateway that ignored ``stream`` answers with one complete message."""

        self._chunks.id = str(payload.get("id") or "")
        self._chunks.model = str(payload.get("model") or "")
        out: list[dict[str, Any]] = []
        for block in payload.get("content") or []:
            if not isinstance(block, Mapping):
                continue
            kind = block.get("type")
            if kind == "text":
                text = str(block.get("text") or "")
                if text:
                    out.append(self._chunks.delta({"content": text}))
            elif kind == "thinking":
                thought = str(block.get("thinking") or block.get("text") or "")
                if thought:
                    out.append(self._chunks.delta({"reasoning_content": thought}))
            elif kind == "tool_use":
                tool_index = self._next_tool
                self._next_tool += 1
                arguments = block.get("input")
                out.append(
                    self._chunks.delta(
                        {
                            "tool_calls": [
                                {
                                    "index": tool_index,
                                    "id": str(block.get("id") or f"call_{tool_index}"),
                                    "type": "function",
                                    "function": {
                                        "name": str(block.get("name") or ""),
                                        "arguments": json.dumps(
                                            arguments if isinstance(arguments, Mapping) else {},
                                            ensure_ascii=False,
                                        ),
                                    },
                                }
                            ]
                        }
                    )
                )
        stop = payload.get("stop_reason")
        if isinstance(stop, str) and stop:
            self._finish_reason = _ANTHROPIC_STOP_REASONS.get(stop, "stop")
        self._read_usage(payload.get("usage"))
        return out


# ---------------------------------------------------------------------------
# Gemini generateContent
# ---------------------------------------------------------------------------


def _gemini_parts(content: Any) -> list[dict[str, Any]]:
    if isinstance(content, str):
        return [{"text": content}] if content else []
    parts: list[dict[str, Any]] = []
    if isinstance(content, list):
        for part in content:
            if not isinstance(part, Mapping):
                continue
            if part.get("type") == "text":
                text = str(part.get("text") or "")
                if text:
                    parts.append({"text": text})
            elif part.get("type") == "image_url":
                image = part.get("image_url") or {}
                mime, data = split_data_url(str(image.get("url") or ""))
                parts.append({"inlineData": {"mimeType": mime, "data": data}})
    return parts


def gemini_contents(
    messages: Sequence[Mapping[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """OpenAI-shaped messages -> (system parts, Gemini contents).

    Gemini addresses a tool result by function *name*, not by call id, so the
    names are recovered from the assistant turn that issued the calls.
    """

    system: list[dict[str, Any]] = []
    contents: list[dict[str, Any]] = []
    names: dict[str, str] = {}
    for message in messages:
        role = message.get("role")
        content = message.get("content")
        if role == "system":
            text = _text_of(content)
            if text.strip():
                system.append({"text": text})
        elif role == "user":
            parts = _gemini_parts(content)
            if parts:
                contents.append({"role": "user", "parts": parts})
        elif role == "assistant":
            parts = _gemini_parts(content)
            for call in message.get("tool_calls") or []:
                function = call.get("function") or {}
                name = str(function.get("name") or "")
                names[str(call.get("id") or "")] = name
                parts.append(
                    {
                        "functionCall": {
                            "name": name,
                            "args": _json_object(function.get("arguments")),
                        }
                    }
                )
            if parts:
                contents.append({"role": "model", "parts": parts})
        elif role == "tool":
            call_id = str(message.get("tool_call_id") or "")
            parts = _gemini_parts(content)
            text = "".join(str(part["text"]) for part in parts if "text" in part)
            images = [part for part in parts if "inlineData" in part]
            response: list[dict[str, Any]] = [
                {
                    "functionResponse": {
                        "name": names.get(call_id) or call_id,
                        "response": {"result": text},
                    }
                }
            ]
            contents.append({"role": "user", "parts": response + images})
    return system, _merge_adjacent(contents, "parts")


def _gemini_thinking(effort: Any) -> dict[str, Any]:
    if not isinstance(effort, str) or not effort:
        return {"includeThoughts": True}
    if effort == "none":
        return {"thinkingBudget": 0}
    budget = THINKING_BUDGETS.get(effort)
    if budget is None:
        return {"includeThoughts": True}
    return {"includeThoughts": True, "thinkingBudget": budget}


def build_gemini_request(
    *,
    model: str,
    base_url: str,
    api_key: str,
    fields: Mapping[str, Any],
    host_extra_body: Mapping[str, Any] | None = None,
    safety_settings: list[dict[str, str]] | None = None,
) -> UpstreamRequest:
    system, contents = gemini_contents(fields.get("messages") or [])
    body: dict[str, Any] = {"contents": contents}
    if system:
        body["systemInstruction"] = {"parts": system}
    functions = _tool_functions(fields)
    if functions:
        body["tools"] = [
            {
                "functionDeclarations": [
                    {
                        "name": function["name"],
                        "description": str(function.get("description") or ""),
                        "parameters": to_gemini_schema(
                            function.get("parameters") or {"type": "object", "properties": {}}
                        ),
                    }
                    for function in functions
                ]
            }
        ]
        mode = _GEMINI_TOOL_MODE.get(str(fields.get("tool_choice") or "auto"), "AUTO")
        body["toolConfig"] = {"functionCallingConfig": {"mode": mode}}
    generation: dict[str, Any] = {}
    if fields.get("temperature") is not None:
        generation["temperature"] = fields["temperature"]
    max_tokens = fields.get("max_tokens")
    if isinstance(max_tokens, int) and not isinstance(max_tokens, bool) and max_tokens > 0:
        generation["maxOutputTokens"] = max_tokens
    generation["thinkingConfig"] = _gemini_thinking(fields.get("reasoning_effort"))
    body["generationConfig"] = generation
    safety = list(GEMINI_SAFETY_OFF) if safety_settings is None else list(safety_settings)
    if safety:
        body["safetySettings"] = safety
    _merge_namespaced(
        body,
        fields,
        "gemini",
        host_extra_body,
        reserved=GEMINI_RESERVED_KEYS,
        deep_keys=("generationConfig",),
    )
    base = base_url.rstrip("/")
    if "/v1" not in base:
        # Same rule as the buffered client: a bare host gets the public API version.
        base = f"{base}/v1beta"
    headers = {
        "x-goog-api-key": api_key,
        "Content-Type": "application/json",
        "Accept": STREAM_ACCEPT,
    }
    return UpstreamRequest(
        url=f"{base}/models/{model}:streamGenerateContent?alt=sse",
        headers=headers,
        body=body,
        translator=GeminiTranslator(),
    )


class GeminiTranslator:
    """Gemini ``GenerateContentResponse`` chunks -> OpenAI chunks."""

    def __init__(self) -> None:
        self._chunks = _ChunkFactory()
        self._next_tool = 0
        self._emitted_output = False
        self._finish_reason: str | None = None
        self._usage: Mapping[str, Any] | None = None
        self._finished = False

    def feed(self, data: str) -> list[dict[str, Any]]:
        try:
            payload = json.loads(data)
        except ValueError:
            return []
        if not isinstance(payload, Mapping):
            return []
        return self._handle(payload)

    def feed_json(self, payload: Mapping[str, Any]) -> list[dict[str, Any]]:
        return self._handle(payload)

    def finish(self) -> list[dict[str, Any]]:
        if self._finished:
            return []
        self._finished = True
        usage = self._usage or {}
        prompt = _int(usage.get("promptTokenCount"))
        completion = _int(usage.get("candidatesTokenCount")) + _int(usage.get("thoughtsTokenCount"))
        total = _int(usage.get("totalTokenCount")) or prompt + completion
        return [
            self._chunks.finish(self._finish_reason or "stop"),
            self._chunks.usage(prompt, completion, total),
        ]

    def _handle(self, payload: Mapping[str, Any]) -> list[dict[str, Any]]:
        if payload.get("responseId"):
            self._chunks.id = str(payload["responseId"])
        if payload.get("modelVersion"):
            self._chunks.model = str(payload["modelVersion"])
        usage = payload.get("usageMetadata")
        if isinstance(usage, Mapping):
            self._usage = usage

        out: list[dict[str, Any]] = []
        candidates = payload.get("candidates") or []
        candidate = candidates[0] if candidates and isinstance(candidates[0], Mapping) else {}
        content = candidate.get("content") or {}
        parts = content.get("parts") if isinstance(content, Mapping) else None
        for part in parts or []:
            if not isinstance(part, Mapping):
                continue
            if "functionCall" in part:
                call = part.get("functionCall") or {}
                index = self._next_tool
                self._next_tool += 1
                args = call.get("args") if isinstance(call, Mapping) else None
                out.append(
                    self._chunks.delta(
                        {
                            "tool_calls": [
                                {
                                    "index": index,
                                    "id": str(call.get("id") or f"call_{index}"),
                                    "type": "function",
                                    "function": {
                                        "name": str(call.get("name") or ""),
                                        "arguments": json.dumps(
                                            args if isinstance(args, Mapping) else {},
                                            ensure_ascii=False,
                                        ),
                                    },
                                }
                            ]
                        }
                    )
                )
                self._emitted_output = True
            elif "text" in part:
                text = str(part.get("text") or "")
                if not text:
                    continue
                if part.get("thought"):
                    out.append(self._chunks.delta({"reasoning_content": text}))
                else:
                    out.append(self._chunks.delta({"content": text}))
                    self._emitted_output = True

        finish = candidate.get("finishReason")
        if isinstance(finish, str) and finish:
            if finish == "STOP":
                self._finish_reason = "tool_calls" if self._next_tool else "stop"
            elif finish == "MAX_TOKENS":
                self._finish_reason = "length"
            elif finish in _GEMINI_BLOCK_REASONS:
                self._finish_reason = "content_filter"
                if not self._emitted_output:
                    raise NativeStreamError(f"Gemini blocked the response: {finish}")
            else:
                self._finish_reason = "stop"

        feedback = payload.get("promptFeedback")
        block_reason = feedback.get("blockReason") if isinstance(feedback, Mapping) else None
        if block_reason and not candidates:
            raise NativeStreamError(f"Gemini blocked the prompt: {block_reason}")
        return out


def _int(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


# ---------------------------------------------------------------------------
# Entry point for both hosts
# ---------------------------------------------------------------------------


def build_upstream_request(
    provider: str,
    *,
    model: str,
    base_url: str,
    api_key: str,
    fields: Mapping[str, Any],
    host_extra_body: Mapping[str, Any] | None = None,
    safety_settings: list[dict[str, str]] | None = None,
) -> UpstreamRequest:
    """Turn one validated harness turn into the provider request for ``provider``.

    ``openai`` relays verbatim; ``anthropic`` and ``gemini`` translate.  Any other
    protocol raises :class:`LlmStreamUnsupportedError` before a byte is sent.
    """

    if provider == "openai":
        headers = {"Content-Type": "application/json", "Accept": STREAM_ACCEPT}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        return UpstreamRequest(
            url=f"{base_url.rstrip('/')}/chat/completions",
            headers=headers,
            body=build_chat_body(model, fields, host_extra_body=host_extra_body),
            translator=None,
        )
    if provider == "anthropic":
        return build_anthropic_request(
            model=model,
            base_url=base_url,
            api_key=api_key,
            fields=fields,
            host_extra_body=host_extra_body,
        )
    if provider == "gemini":
        return build_gemini_request(
            model=model,
            base_url=base_url,
            api_key=api_key,
            fields=fields,
            host_extra_body=host_extra_body,
            safety_settings=safety_settings,
        )
    raise LlmStreamUnsupportedError(provider)


__all__ = [
    "ANTHROPIC_VERSION",
    "GEMINI_SAFETY_OFF",
    "THINKING_BUDGETS",
    "AnthropicTranslator",
    "GeminiTranslator",
    "anthropic_messages",
    "build_anthropic_request",
    "build_gemini_request",
    "build_upstream_request",
    "gemini_contents",
]
