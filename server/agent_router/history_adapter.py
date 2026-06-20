"""
对话历史适配器 —— 现有 user_chat_history.json ↔ PydanticAI ModelMessage 互转。

为什么需要这一层:
    - 现有格式（Gemini 风格）: {role, content: str | [{text} | {inline_data}], _is_generated_image?, generated_params?}
    - PydanticAI 原生格式: ModelMessage（ModelRequest / ModelResponse 的并集）
    - 本次重构不迁移文件 schema，只在 agent 进出口加薄薄一层互转

约定:
    - role="user" → ModelRequest(parts=[UserPromptPart])
    - role="assistant" / "model" → ModelResponse(parts=[TextPart])
    - 图片 inline_data 用 BinaryContent 包装进 UserPromptPart.content

裁剪策略:
    - 用户上传图片保留 3 张
    - 生成图片不保留图像本体，只保留文本参数
    - 超出的转纯文本
"""
from __future__ import annotations

from typing import Any, Optional
import base64
import time

from .llm.messages import (
    ModelMessage,
    ModelRequest,
    ModelResponse,
    UserPromptPart,
    TextPart,
    SystemPromptPart,
)

# 自研框架的多模态附件（顶层与 messages 子模块均可导出）
from .llm import BinaryContent


# ============================================================
# 图片张数裁剪（与 nai_agent.py 现有策略一致）
# ============================================================

MAX_USER_IMAGES = 3


# ============================================================
# 上下文 token 预算 / 滑动窗口参数
# ============================================================
# 私聊 / 群聊历史统一使用纯 token 滑窗，丢弃最早的轮次。

HISTORY_BUDGET_TOKENS = 100000     # 私聊/群聊滑动窗口 token 预算
WEB_HISTORY_BUDGET_TOKENS = 100000  # Web 端滑动窗口 token 预算（无持久化）
# 注：按接入的大上下文模型（~1M）放宽。token 为粗估值（中文偏保守），
# 实际真实 token 通常略低于此。想更省成本调小，想更激进（吃满几百 k）调大。

# Group chat history is intentionally process-local. Private chats are persisted
# through user_chat_history.json, while group chats only need short-lived context.
GROUP_MEMORY_INACTIVE_SECONDS = 3600
_GROUP_MEMORY_HISTORY: dict[str, list[dict]] = {}
_GROUP_MEMORY_LAST_ACCESS: dict[str, float] = {}


def _touch_group_history(user_key: str) -> None:
    _GROUP_MEMORY_LAST_ACCESS[user_key] = time.time()


def _cleanup_group_memory() -> None:
    now = time.time()
    stale = [
        key for key, last_access in list(_GROUP_MEMORY_LAST_ACCESS.items())
        if now - last_access > GROUP_MEMORY_INACTIVE_SECONDS
    ]
    for key in stale:
        _GROUP_MEMORY_HISTORY.pop(key, None)
        _GROUP_MEMORY_LAST_ACCESS.pop(key, None)


def _has_image(entry: dict) -> bool:
    content = entry.get("content")
    if not isinstance(content, list):
        return False
    return any(
        isinstance(item, dict) and "inline_data" in item for item in content
    )


def trim_history_images(history: list[dict]) -> list[dict]:
    """
    应用图片张数限制，返回裁剪后的新列表（不改原 list）。

    策略:
        - 生成图片：不保留图片本体，只保留文字参数
        - 用户图片：从最新往旧遍历，保留前 3 张
        - 超出的：保留文字，删除其中的 inline_data 项
    """
    result: list[dict] = []
    user_image_count = 0

    # 从最新往旧遍历
    for entry in reversed(history):
        if not _has_image(entry):
            result.insert(0, entry)
            continue

        is_generated = entry.get("_is_generated_image", False)
        keep_image: bool
        if is_generated:
            keep_image = False
        else:
            keep_image = user_image_count < MAX_USER_IMAGES
            if keep_image:
                user_image_count += 1

        if keep_image:
            result.insert(0, entry)
        else:
            # 剥离 inline_data，只留 text
            new_content = [
                item for item in entry.get("content", [])
                if not (isinstance(item, dict) and "inline_data" in item)
            ]
            if not new_content:
                new_content = "[图片已清理]"
            stripped = {**entry, "content": new_content}
            result.insert(0, stripped)

    return result


# ============================================================
# 现有格式 → ModelMessage
# ============================================================

def _strip_runtime_context_from_text(text: str) -> str:
    """
    历史只保留用户真正说的话。

    [环境信息] 是 Bot 端为本轮 agent 调度附加的预查询/图片元数据上下文，
    不能长期写入或读回历史，否则下一轮会反复污染 chat_agent 注意力。
    """
    if not text:
        return ""
    marker = "[环境信息]"
    if marker in text:
        text = text.split(marker, 1)[0]
    stripped = text.strip()
    if stripped.startswith("[环境信息]"):
        return ""
    return stripped


def _content_to_parts(content: Any) -> list:
    """
    把现有 content 字段转成 PydanticAI Part 列表（适用于 UserPromptPart.content）。

    现有 content 可能是:
        - str
        - list[{text} | {inline_data: {mime_type, data}}]
    """
    if isinstance(content, str):
        text = _strip_runtime_context_from_text(content)
        return [text] if text else []

    if not isinstance(content, list):
        return [str(content)]

    parts: list = []
    for item in content:
        if not isinstance(item, dict):
            parts.append(str(item))
            continue
        if "text" in item:
            text = _strip_runtime_context_from_text(str(item["text"]))
            if text:
                parts.append(text)
        elif "inline_data" in item:
            inline = item["inline_data"]
            raw_b64 = inline.get("data", "")
            mime = inline.get("mime_type", "image/png")
            try:
                data_bytes = base64.b64decode(raw_b64) if raw_b64 else b""
                parts.append(BinaryContent(data=data_bytes, media_type=mime))
            except Exception:
                # base64 解码失败：降级为占位文本
                parts.append("[图片解析失败]")
    return parts


def to_model_messages(history: list[dict], trim: bool = True) -> list[ModelMessage]:
    """
    把现有 history_dict[user_key] 列表转成 ModelMessage 列表。

    Args:
        history: 现有格式的消息列表
        trim: 是否应用图片张数裁剪策略（默认 True）

    Returns:
        PydanticAI ModelMessage 列表，可直接喂给 agent.run(message_history=...)
    """
    if trim:
        history = trim_history_images(history)

    messages: list[ModelMessage] = []
    for entry in history:
        role = entry.get("role", "user")
        parts = _content_to_parts(entry.get("content"))

        if role == "user":
            # PydanticAI 多模态约定：单个 UserPromptPart 的 content 字段持有 list[str|BinaryContent]，
            # 这样图片+文本属于"同一条用户消息"，而不是被拆成多个 UserPromptPart。
            if parts:
                content_value: Any = parts[0] if len(parts) == 1 else parts
                messages.append(ModelRequest(parts=[UserPromptPart(content=content_value)]))
        else:
            # assistant / model：PydanticAI 的 ModelResponse 只接受 text 类 Part
            text_chunks = [p for p in parts if isinstance(p, str)]
            text = "\n".join(text_chunks).strip()
            if text:
                messages.append(ModelResponse(parts=[TextPart(content=text)]))
    return messages


# ============================================================
# ModelMessage → 现有格式
# ============================================================

def from_model_messages(messages: list[ModelMessage]) -> list[dict]:
    """
    把 ModelMessage 列表转回现有 history_dict 格式。

    主要用于：agent.run() 完成后取 result.new_messages()，追加到现有 history。
    """
    out: list[dict] = []
    for msg in messages:
        if isinstance(msg, ModelRequest):
            content_items: list = []
            text_chunks: list[str] = []
            for part in msg.parts:
                if isinstance(part, SystemPromptPart):
                    # 系统提示不写入用户历史
                    continue
                if isinstance(part, UserPromptPart):
                    if isinstance(part.content, str):
                        text_chunks.append(part.content)
                    elif isinstance(part.content, list):
                        for sub in part.content:
                            if isinstance(sub, str):
                                text_chunks.append(sub)
                            elif isinstance(sub, BinaryContent):
                                content_items.append({
                                    "inline_data": {
                                        "mime_type": sub.media_type or "image/png",
                                        "data": base64.b64encode(sub.data).decode("ascii"),
                                    }
                                })
            if text_chunks:
                text = _strip_runtime_context_from_text("\n".join(text_chunks))
                if text:
                    content_items.insert(0, {"text": text})

            if content_items:
                content_value: Any = (
                    content_items[0]["text"]
                    if len(content_items) == 1 and "text" in content_items[0]
                    else content_items
                )
                out.append({"role": "user", "content": content_value})

        elif isinstance(msg, ModelResponse):
            text_chunks = []
            for part in msg.parts:
                # 不同版本 PydanticAI 的 part 可能是 TextPart 或 ToolCallPart 等
                content = getattr(part, "content", None)
                if isinstance(content, str):
                    text_chunks.append(content)
            text = "\n".join(text_chunks).strip()
            if text:
                out.append({"role": "assistant", "content": text})

    return out


# ============================================================
# token 预算 / 滑动窗口
# ============================================================

def _estimate_tokens(text: str) -> int:
    """粗估 token 数（不依赖 tiktoken，对 Gemini/Claude 都够用）。
    中文按 1 字≈1 token，其余字符按 3 字符≈1 token，整体偏保守（宁可早压）。"""
    if not text:
        return 0
    cjk = sum(1 for c in text if "一" <= c <= "鿿")
    return cjk + (len(text) - cjk) // 3


def _entry_text(entry: dict) -> str:
    """从一条历史 dict 里抽出纯文本（忽略图片 inline_data）。"""
    content = entry.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(
            str(item.get("text", ""))
            for item in content
            if isinstance(item, dict) and "text" in item
        )
    return ""


def apply_token_budget(history: list[dict], budget_tokens: int) -> list[dict]:
    """
    纯 token 滑窗：从最新往旧累加，超预算就丢弃更早的轮次（至少保留最新 1 条）。
    """
    if not history:
        return history
    kept: list[dict] = []
    total = 0
    for entry in reversed(history):
        t = _estimate_tokens(_entry_text(entry))
        if kept and total + t > budget_tokens:
            break
        kept.insert(0, entry)
        total += t
    return kept


# ============================================================
# 高层便利方法（router 用）
# ============================================================

async def load_history_for_agent(
    user_key: str,
    *,
    persistent: bool = True,
) -> list[ModelMessage]:
    """
    从 user_chat_history.json 加载并直接转 ModelMessage 列表。

    加载时按 token 预算做滑动窗口裁剪。

    路径：依赖 Bot 端 core.history_manager；server 端通过 sys.path 注入。
    """
    if persistent:
        history_list = await _load_user_history(user_key)
        history_list = apply_token_budget(history_list, HISTORY_BUDGET_TOKENS)
    else:
        _cleanup_group_memory()
        _touch_group_history(user_key)
        history_list = list(_GROUP_MEMORY_HISTORY.get(user_key, []))
        history_list = apply_token_budget(history_list, WEB_HISTORY_BUDGET_TOKENS)
    return to_model_messages(history_list, trim=True)


def _is_selected_resource_memory(entry: dict) -> bool:
    content = entry.get("content")
    if isinstance(content, str):
        return content.strip().startswith("[chat_agent 筛选资料记忆]")
    if isinstance(content, list):
        for item in content:
            if isinstance(item, dict) and str(item.get("text", "")).strip().startswith("[chat_agent 筛选资料记忆]"):
                return True
    return False


async def append_to_history(
    user_key: str,
    new_messages: list[ModelMessage],
    *,
    persistent: bool = True,
    extra_entries: Optional[list[dict]] = None,
) -> None:
    """
    把 agent.run() 产出的新消息追加到现有历史，并持久化（私聊场景）。
    """
    if not new_messages and not extra_entries:
        return
    new_dicts = from_model_messages(new_messages) if new_messages else []
    if extra_entries:
        new_dicts.extend(extra_entries)
    if not new_dicts:
        return
    if persistent:
        existing = await _load_user_history(user_key)
    else:
        _cleanup_group_memory()
        _touch_group_history(user_key)
        existing = list(_GROUP_MEMORY_HISTORY.get(user_key, []))
    existing = [e for e in existing if not _is_selected_resource_memory(e)]
    existing.extend(new_dicts)
    if persistent:
        existing = trim_history_images(apply_token_budget(existing, HISTORY_BUDGET_TOKENS))
        await _save_user_history(user_key, existing)
    else:
        existing = trim_history_images(apply_token_budget(existing, WEB_HISTORY_BUDGET_TOKENS))
        _GROUP_MEMORY_HISTORY[user_key] = existing


# ----- 与 Bot 端 history_manager 解耦的薄包装 -----
# server 进程独立运行，不能直接 import nonebot 插件 core 模块。
# 退而求其次：直接读写 data/user_chat_history.json 文件，schema 与 core/history_manager.py 完全一致。

import json as _json
import asyncio as _asyncio
from pathlib import Path as _Path
import aiofiles as _aiofiles


_HISTORY_LOCK = _asyncio.Lock()


def _history_file_path() -> _Path:
    try:
        from config import BOT_DATA_DIR  # type: ignore
        return _Path(BOT_DATA_DIR) / "user_chat_history.json"
    except Exception:
        return _Path(__file__).resolve().parents[3] / "data" / "user_chat_history.json"


async def _load_user_history(user_key: str) -> list[dict]:
    """私聊：从文件读 + 内存合并；群聊：仅文件（内存语义由 chat_agent 自己控制）"""
    path = _history_file_path()
    if not path.exists():
        return []
    async with _aiofiles.open(path, "r", encoding="utf-8") as f:
        text = await f.read()
    if not text.strip():
        return []
    try:
        full = _json.loads(text)
    except Exception:
        return []
    user_data = full.get(user_key, {})
    return list(user_data.get("history", []))


async def _save_user_history(user_key: str, history: list[dict]) -> None:
    """读-改-写整个 JSON 文件（与 history_manager.save_user_data 行为一致）"""
    path = _history_file_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    async with _HISTORY_LOCK:
        if path.exists():
            async with _aiofiles.open(path, "r", encoding="utf-8") as f:
                text = await f.read()
            try:
                full = _json.loads(text) if text.strip() else {}
            except Exception:
                full = {}
        else:
            full = {}

        user_data = full.get(user_key, {})
        user_data["history"] = history
        full[user_key] = user_data

        async with _aiofiles.open(path, "w", encoding="utf-8") as f:
            await f.write(_json.dumps(full, ensure_ascii=False, indent=2))


async def clear_history(user_key: str, *, persistent: bool = True) -> bool:
    """清空历史但保留 mode / 其它字段"""
    if not persistent:
        existed = user_key in _GROUP_MEMORY_HISTORY
        _GROUP_MEMORY_HISTORY.pop(user_key, None)
        _GROUP_MEMORY_LAST_ACCESS.pop(user_key, None)
        return existed

    path = _history_file_path()
    if not path.exists():
        return False
    async with _HISTORY_LOCK:
        async with _aiofiles.open(path, "r", encoding="utf-8") as f:
            text = await f.read()
        try:
            full = _json.loads(text) if text.strip() else {}
        except Exception:
            return False
        if user_key not in full:
            return False
        full[user_key]["history"] = []
        async with _aiofiles.open(path, "w", encoding="utf-8") as f:
            await f.write(_json.dumps(full, ensure_ascii=False, indent=2))
    return True
