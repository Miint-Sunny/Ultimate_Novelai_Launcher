"""
PydanticAI Model 工厂（合并 agent + 单一 model 选择架构）。

配置来源（优先级从高到低）:
    1. 环境变量 CPA_* （仅作 dev 期临时覆盖）
    2. server/config.py 的 MODEL_REGISTRY + MODEL_CHOICES + ACTIVE_MODEL（生产配置）

架构说明：
    tier（assist/create）已彻底移除。现在只有一组可切换的 model（MODEL_CHOICES），
    每次请求带一个 model_key（空 = 用全局 ACTIVE_MODEL）。合并 chat_agent 一站式
    完成所有事，所以一个 model_key 对应一个 Model + 一套 settings。

API:
    get_model(model_key)                  - 按 model_key 取 PydanticAI Model 实例
    get_model_settings(model_key)         - 取该 model 的 ModelSettings（含工具调用兼容设置）
    get_output_type_for_model(key, T)     - OpenAI 网关走 PromptedOutput，Gemini 走原生
    uses_prompted_output_for_model(key)   - 是否走 PromptedOutput
    get_active_channel_info()             - /health 用：列出 registry + choices
    list_model_keys()                     - 列出所有 MODEL_CHOICES key
"""
from __future__ import annotations

import os
from typing import Optional, Tuple

from .llm.models import Model, OpenAIModel, GoogleModel, AnthropicModel
from .llm.providers import OpenAIProvider, GoogleProvider, AnthropicProvider
from .llm.output import PromptedOutput


# ============================================================
# 配置读取
# ============================================================

def _load_registry_and_choices() -> Tuple[dict, dict, str, str]:
    """从 server/config.py 加载 (MODEL_REGISTRY, MODEL_CHOICES, AI_PROTOCOL, ACTIVE_MODEL)。"""
    try:
        from config import MODEL_REGISTRY, MODEL_CHOICES, AI_PROTOCOL, ACTIVE_MODEL  # type: ignore
        return MODEL_REGISTRY, MODEL_CHOICES, AI_PROTOCOL, ACTIVE_MODEL
    except ImportError:
        pass

    # Fallback：用环境变量构造最小配置
    base_url = os.environ.get("CPA_BASE_URL", "http://127.0.0.1:8317/v1")
    api_key = os.environ.get("CPA_API_KEY", "")
    model = os.environ.get("CPA_FALLBACK_MODEL", "claude-sonnet-4-6")
    fallback_registry = {
        model: {
            "base_url": base_url, "api_key": api_key, "proxy": "",
            "supports_tools": True, "supports_vision": True,
        }
    }
    fallback_choices = {"default": {"label": "default", "model": model, "aliases": []}}
    return fallback_registry, fallback_choices, "openai", "default"


# ============================================================
# 协议适配
# ============================================================

def _normalize_base_url(url: str, protocol: str) -> str:
    """协议自适应:
        openai    要求 /v1 路径；若配置写的是 /v1beta，自动改 /v1
        gemini    要求 /v1beta 路径；若配置写的是 /v1，自动改 /v1beta
        anthropic 不带版本后缀（AnthropicProvider 内部拼 /v1/messages）；
                  若配置写了 /v1 或 /v1beta 自动剥掉，避免拼成 /v1/v1/messages
    """
    if protocol == "openai":
        if url.endswith("/v1beta"):
            return url[: -len("/v1beta")] + "/v1"
        return url
    if protocol == "gemini":
        if url.endswith("/v1") and not url.endswith("/v1beta"):
            return url[: -len("/v1")] + "/v1beta"
        return url
    if protocol == "anthropic":
        if url.endswith("/v1beta"):
            return url[: -len("/v1beta")]
        if url.endswith("/v1"):
            return url[: -len("/v1")]
        return url
    return url


# ============================================================
# model_key 解析
# ============================================================

def _normalize_model_key(model_key: str | None) -> str:
    """
    把请求里的 model 标识规范成 MODEL_CHOICES 的 key。
    - 空 → 全局 ACTIVE_MODEL
    - 已是 choice key → 原样
    - 别名 / registry key / label → 用 config.resolve_model 匹配
    - 匹配不到 → 兜底用 ACTIVE_MODEL
    """
    _, choices, _, active = _load_registry_and_choices()
    if not model_key:
        return active
    if model_key in choices:
        return model_key
    try:
        from config import resolve_model  # type: ignore
        key, _ch = resolve_model(model_key)
        return key
    except Exception:
        return active


def _resolve_model_meta(model_key: str | None) -> tuple[str, dict, str] | None:
    """model_key → (real_model_name, registry_meta, default_protocol)，解析不到返回 None。"""
    registry, choices, default_protocol, _active = _load_registry_and_choices()
    key = _normalize_model_key(model_key)
    choice = choices.get(key)
    if not choice:
        return None
    registry_key = choice.get("model")
    meta = registry.get(registry_key) or {}
    if not meta:
        return None
    real_model = meta.get("model_name") or registry_key
    return real_model, meta, default_protocol


# ============================================================
# 主要 API
# ============================================================

def get_model(model_key: str = "") -> Model:
    """
    按 model_key 取 PydanticAI Model 实例（空 model_key = 用全局 ACTIVE_MODEL）。

    示例:
        m = get_model("claude46")      # 指定 choice
        m = get_model()                # 用 ACTIVE_MODEL
    """
    registry, choices, default_protocol, _active = _load_registry_and_choices()
    key = _normalize_model_key(model_key)
    if key not in choices:
        raise ValueError(f"未知 model: {key}（可选: {list(choices.keys())}）")
    registry_key = choices[key].get("model")
    if registry_key not in registry:
        raise ValueError(
            f"模型 '{registry_key}' 未在 MODEL_REGISTRY 中登记（被 MODEL_CHOICES[{key!r}] 引用）"
        )
    meta = registry[registry_key]

    model_protocol = meta.get("protocol") or default_protocol
    base_url = _normalize_base_url(meta["base_url"], model_protocol)
    api_key = meta.get("api_key", "")
    real_model = meta.get("model_name") or registry_key

    if model_protocol == "openai":
        # NAI text API 必须挂适配 transport：非流式响应缺 message.content + tools 不兼容
        from .novelai_provider import is_novelai_text_url, build_novelai_http_client
        if is_novelai_text_url(base_url):
            http_client = build_novelai_http_client(proxy_url=meta.get("proxy") or None)
            provider = OpenAIProvider(base_url=base_url, api_key=api_key, http_client=http_client)
        else:
            provider = OpenAIProvider(base_url=base_url, api_key=api_key)
        return OpenAIModel(real_model, provider=provider, supports_vision=meta.get("supports_vision", True))

    if model_protocol == "gemini":
        # Vertex Express 路径修正（raw-httpx 下 URL 已天然正确，transport 仅用于带 proxy）
        from .vertex_provider import is_vertex_express_url, build_vertex_http_client
        http_client = None
        if is_vertex_express_url(base_url):
            http_client = build_vertex_http_client(proxy_url=meta.get("proxy") or None)

        if http_client is not None:
            provider = GoogleProvider(
                api_key=api_key, base_url=base_url, http_client=http_client
            )
        else:
            provider = GoogleProvider(api_key=api_key, base_url=base_url)
        return GoogleModel(real_model, provider=provider)

    if model_protocol == "anthropic":
        provider = AnthropicProvider(base_url=base_url, api_key=api_key)
        return AnthropicModel(real_model, provider=provider)

    raise ValueError(
        f"模型 '{registry_key}' 的 protocol={model_protocol!r} 不支持（仅: openai / gemini / anthropic）"
    )


# ============================================================
# ModelSettings（调用方在 agent.run 时传 model_settings=...）
# ============================================================
#
# tier 移除后不再有 _TIER_MODEL_SETTINGS——per-model 的参数（如 vertex 的 temperature=0.3）
# 全部下沉到 MODEL_REGISTRY[model]["model_settings"]。
# 合并 agent 总是调工具 + 出结构化输出，所以工具调用兼容设置（gemini 关 thinking、
# openai 关 parallel_tool_calls）总是应用，不再按 role 区分。

_TRUTHY = {"1", "true", "yes", "on"}
_FALSY = {"0", "false", "no", "off"}


def _env_bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    value = value.strip().lower()
    if value in _TRUTHY:
        return True
    if value in _FALSY:
        return False
    return default


# Vertex/Gemini REST calls this field safetySettings[]; PydanticAI exposes it
# through GoogleModelSettings.google_safety_settings.
# 全套关闭——包括 JAILBREAK / CIVIC_INTEGRITY：thinking=True 后 Gemini 内部推理会被
# JAILBREAK filter 命中（典型 finish_reason='SAFETY' + parts=[] 现象），全关才稳。
_GOOGLE_SAFETY_SETTINGS_OFF: list[dict[str, str]] = [
    {"category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "OFF"},
    {"category": "HARM_CATEGORY_HARASSMENT", "threshold": "OFF"},
    {"category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "OFF"},
    {"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "OFF"},
    {"category": "HARM_CATEGORY_CIVIC_INTEGRITY", "threshold": "OFF"},
]

_GOOGLE_JAILBREAK_SAFETY_SETTING_OFF: dict[str, str] = {
    "category": "HARM_CATEGORY_JAILBREAK",
    "threshold": "OFF",
}


def _model_uses_google(model_key: str | None) -> bool:
    resolved = _resolve_model_meta(model_key)
    if resolved is None:
        return False
    _, meta, default_protocol = resolved
    return (meta.get("protocol") or default_protocol) == "gemini"


def _model_uses_openai(model_key: str | None) -> bool:
    resolved = _resolve_model_meta(model_key)
    if resolved is None:
        return False
    _, meta, default_protocol = resolved
    return (meta.get("protocol") or default_protocol) == "openai"


def _model_uses_anthropic(model_key: str | None) -> bool:
    resolved = _resolve_model_meta(model_key)
    if resolved is None:
        return False
    _, meta, default_protocol = resolved
    return (meta.get("protocol") or default_protocol) == "anthropic"


def _extra_body_for_model(model_key: str | None) -> dict | None:
    resolved = _resolve_model_meta(model_key)
    if resolved is None:
        return None
    _, meta, _ = resolved
    extra_body = meta.get("extra_body")
    return dict(extra_body) if isinstance(extra_body, dict) else None


def _model_settings_from_registry(model_key: str | None) -> dict | None:
    resolved = _resolve_model_meta(model_key)
    if resolved is None:
        return None
    _, meta, _ = resolved
    model_settings = meta.get("model_settings")
    return dict(model_settings) if isinstance(model_settings, dict) else None


def _should_disable_google_safety_filters() -> bool:
    return _env_bool("CPA_DISABLE_GOOGLE_SAFETY_FILTERS", True)


def _google_safety_settings_for_model(model_key: str | None) -> list[dict[str, str]]:
    """
    返回该 Gemini model 的完整 safety_settings 列表（全 OFF）。

    HARM_CATEGORY_JAILBREAK 现在默认对所有 Gemini 模型都加 OFF——
    thinking=True 后 Gemini 内部推理可能因为我们的 NSFW 解禁声明被 JAILBREAK filter 捕获
    （典型现象 finish_reason='SAFETY' + parts=[]）。
    env CPA_GOOGLE_SAFETY_EXCLUDE_JAILBREAK=true 时退化为不加（少数模型不支持该 category）。
    """
    settings = list(_GOOGLE_SAFETY_SETTINGS_OFF)
    if _env_bool("CPA_GOOGLE_SAFETY_EXCLUDE_JAILBREAK", False):
        return settings
    settings.append(dict(_GOOGLE_JAILBREAK_SAFETY_SETTING_OFF))
    return settings


def get_model_settings(model_key: str = "") -> Optional[dict]:
    """
    返回该 model 的 ModelSettings 字典（可为空 dict 或 None）。
    传给 agent.run(..., model_settings=...)。
    """
    settings: dict = {}
    registry_settings = _model_settings_from_registry(model_key)
    if registry_settings:
        settings.update(registry_settings)

    if _should_disable_google_safety_filters() and _model_uses_google(model_key):
        settings["google_safety_settings"] = _google_safety_settings_for_model(model_key)

    # 主模型（pure_planner）调工具 + 出结构化输出：
    #   - Gemini：自动思考（thinking=True → include_thoughts=True，由模型自己决定 budget）
    #     注意：JAILBREAK / CIVIC_INTEGRITY 等 safety category 已默认关，正常应该不再 SAFETY 截断；
    #     若再遇到，先检查 anti-marker / safety 设置是否生效。
    #   - OpenAI 关掉 parallel_tool_calls，避免网关并行工具调用的不稳定
    if _model_uses_google(model_key):
        settings.setdefault("thinking", True)
    if _model_uses_openai(model_key):
        settings.setdefault("parallel_tool_calls", False)

    extra_body = _extra_body_for_model(model_key)
    if extra_body:
        existing = settings.get("extra_body")
        if isinstance(existing, dict):
            settings["extra_body"] = {**extra_body, **existing}
        else:
            settings["extra_body"] = extra_body

    return settings if settings else None


def get_prefilter_model() -> Model:
    """
    取 PrefilterAgent 用的固定小模型（来自 config.PREFILTER_MODEL）。

    PREFILTER_MODEL 直接指向 MODEL_REGISTRY 的 key，绕过 MODEL_CHOICES——
    prefilter 是工程组件不是用户选项，独立于主 agent 的 model 选择。
    """
    registry, _choices, default_protocol, _active = _load_registry_and_choices()
    try:
        from config import PREFILTER_MODEL  # type: ignore
    except ImportError:
        PREFILTER_MODEL = "gemini-3.1-flash-lite@vertex"

    registry_key = str(PREFILTER_MODEL)
    if registry_key not in registry:
        raise ValueError(
            f"PREFILTER_MODEL '{registry_key}' 未在 MODEL_REGISTRY 中登记"
        )
    meta = registry[registry_key]
    model_protocol = meta.get("protocol") or default_protocol
    base_url = _normalize_base_url(meta["base_url"], model_protocol)
    api_key = meta.get("api_key", "")
    real_model = meta.get("model_name") or registry_key

    if model_protocol == "openai":
        from .novelai_provider import is_novelai_text_url, build_novelai_http_client
        if is_novelai_text_url(base_url):
            http_client = build_novelai_http_client(proxy_url=meta.get("proxy") or None)
            provider = OpenAIProvider(base_url=base_url, api_key=api_key, http_client=http_client)
        else:
            provider = OpenAIProvider(base_url=base_url, api_key=api_key)
        return OpenAIModel(real_model, provider=provider, supports_vision=meta.get("supports_vision", True))
    if model_protocol == "gemini":
        from .vertex_provider import is_vertex_express_url, build_vertex_http_client
        http_client = None
        if is_vertex_express_url(base_url):
            http_client = build_vertex_http_client(proxy_url=meta.get("proxy") or None)
        if http_client is not None:
            provider = GoogleProvider(api_key=api_key, base_url=base_url, http_client=http_client)
        else:
            provider = GoogleProvider(api_key=api_key, base_url=base_url)
        return GoogleModel(real_model, provider=provider)
    if model_protocol == "anthropic":
        provider = AnthropicProvider(base_url=base_url, api_key=api_key)
        return AnthropicModel(real_model, provider=provider)
    raise ValueError(f"prefilter model protocol={model_protocol!r} 不支持")


def get_prefilter_model_settings() -> Optional[dict]:
    """PrefilterAgent 的 ModelSettings：从 registry 取 + extra_body/google_safety + 低温度。"""
    try:
        from config import PREFILTER_MODEL  # type: ignore
    except ImportError:
        PREFILTER_MODEL = "gemini-3.1-flash-lite@vertex"

    registry, _choices, default_protocol, _active = _load_registry_and_choices()
    meta = registry.get(str(PREFILTER_MODEL)) or {}
    settings: dict = {}
    registry_settings = meta.get("model_settings")
    if isinstance(registry_settings, dict):
        settings.update(registry_settings)
    # 低温度让筛选结果稳定
    settings.setdefault("temperature", 0.1)
    if _should_disable_google_safety_filters() and (meta.get("protocol") or default_protocol) == "gemini":
        settings["google_safety_settings"] = list(_GOOGLE_SAFETY_SETTINGS_OFF)
        settings.setdefault("thinking", False)
    extra_body = meta.get("extra_body")
    if isinstance(extra_body, dict):
        existing = settings.get("extra_body")
        if isinstance(existing, dict):
            settings["extra_body"] = {**extra_body, **existing}
        else:
            settings["extra_body"] = dict(extra_body)
    # prefilter 是快速筛选——强制关 thinking（DeepSeek/OpenAI 兼容）省延迟
    if isinstance(settings.get("extra_body"), dict):
        eb = dict(settings["extra_body"])
        if isinstance(eb.get("thinking"), dict):
            eb["thinking"] = {"type": "disabled"}
            settings["extra_body"] = eb
    return settings or None


def get_output_type_for_model(model_key: str, output_type):
    """
    OpenAI-compatible gateways often implement tool calls imperfectly when the
    final structured output is represented as PydanticAI's synthetic final_result
    tool. Use prompted JSON output for those gateways, while keeping Gemini on
    the default tool/native path that is known to work well.
    """
    if _model_uses_openai(model_key):
        return PromptedOutput(output_type)
    return output_type


def uses_prompted_output_for_model(model_key: str) -> bool:
    return _model_uses_openai(model_key)


# ============================================================
# 健康检查 / info 支持
# ============================================================

def list_model_keys() -> list[str]:
    """列出所有 MODEL_CHOICES key（/health 遍历探测用）。"""
    _, choices, _, _ = _load_registry_and_choices()
    return list(choices.keys())


def resolve_choice_to_model_name(model_key: str) -> Optional[str]:
    """给 /health 用：把 model_key 解析回实际模型名。"""
    resolved = _resolve_model_meta(model_key)
    if resolved is None:
        return None
    real_model, _meta, _ = resolved
    return real_model


def get_active_channel_info() -> dict:
    """暴露给 /api/agent/health 的信息：MODEL_REGISTRY + MODEL_CHOICES 摘要。"""
    registry, choices, default_protocol, active = _load_registry_and_choices()
    return {
        "default_protocol": default_protocol,
        "active_model": active,
        "models": {
            name: {
                "label": meta.get("label", ""),
                "protocol": meta.get("protocol") or default_protocol,
                "model_name": meta.get("model_name") or name,
                "base_url": _normalize_base_url(
                    meta.get("base_url", ""),
                    meta.get("protocol") or default_protocol,
                ),
                "supports_tools": meta.get("supports_tools", True),
                "supports_vision": meta.get("supports_vision", True),
                "extra_body": meta.get("extra_body") if isinstance(meta.get("extra_body"), dict) else {},
            }
            for name, meta in registry.items()
        },
        "choices": {
            key: {
                "label": ch.get("label", key),
                "model": ch.get("model"),
            }
            for key, ch in choices.items()
        },
    }
