"""
Web 后端独立配置（去敏模板）

仅供 novelai_web_ui/server 使用的配置项，
与 Bot 端 config/settings.py 解耦。

⚠️ 这是脱敏后的示例配置：所有密钥 / Token / Cookie / 内网 IP 均已替换为占位符。
   真实部署时复制为 config.py 并填入你自己的值，切勿把真实密钥提交到仓库。
"""

from pathlib import Path

# Bot端数据目录（通过环境变量配置，默认相对路径）
import os
BOT_DATA_DIR = Path(os.environ.get("BOT_DATA_DIR", str(Path(__file__).parent.parent.parent / "data")))

# NovelAI Token 列表（支持多 Token 并发）
NOVELAI_TOKENS = [
    "REPLACE_WITH_NOVELAI_TOKEN"
]

# 专用于 Vibe 编码 / 超分 的纯点数 Token
# 配置后，所有 /api/vibe/encode 与 /api/upscale 请求强制走该 Token，
# 主 Token 池（NOVELAI_TOKENS）只负责生图。
# 适用场景：手上有无生图订阅但还剩 Anlas 的账号，让它专吃编码/超分类操作。
# 留空则保持原行为（编码/超分继续从主池选）。
# 注意：该 Token 不参与 TokenManager 的余额追踪和熔断；调用失败不会回退到主池。
NOVELAI_ANLAS_ONLY_TOKEN = ""

# Token 连续错误自动禁用阈值
# Set to 0 to disable token auto-disable after consecutive errors.
TOKEN_MAX_CONSECUTIVE_ERRORS = 0

# 代理设置（留空则不使用代理）
PROXY_URL = "socks5://127.0.0.1:1080"
# Image generation proxy. Empty means direct connection while keeping PROXY_URL for other features.
IMAGE_GENERATION_PROXY_URL = "socks5://127.0.0.1:1080"

# Danbooru 代理设置（标签补全/验证/Wiki查询，留空则不使用代理）
DANBOORU_PROXY_URL = "socks5://127.0.0.1:1080"

# WD Tagger 代理设置（留空则不使用代理）
WD_TAGGER_PROXY = "socks5://127.0.0.1:1080"
# 反推后端：pixai-labs/pixai-tagger-demo（EVA02-large，词表 ~13.5k）
WD_TAGGER_SPACE_URL = "https://pixai-labs-pixai-tagger-demo.hf.space"
# socks5://127.0.0.1:1080
# ==================== 服务端核心 AI 配置 ====================
# 控制接口: /api/translate/en2zh
# 作用: 后端处理 Web 端的英文标签翻译、纯中文转标签、联想补全请求。
# 当前模型: deepseek-v4-flash（推理模型）
# 思考链开/关取舍：
#   开: 单次延迟 ~2s, 覆盖率 +7.8pp, 命名错误多一些
#   关: 单次延迟 ~0.5s（快 4 倍）, 覆盖率略低, 命名错误反而更少
# 当前选择关思考——延迟优先，质量缺口靠 DanbooruSearch / Wiki 后处理兜底。
TRANSLATE_EN2ZH_BASE_URL = "https://api.deepseek.com"
TRANSLATE_EN2ZH_API_KEY = "REPLACE_WITH_DEEPSEEK_KEY"
TRANSLATE_EN2ZH_MODEL = "deepseek-v4-flash"
TRANSLATE_EN2ZH_PROXY = ""  # 直连，不走代理
TRANSLATE_EN2ZH_EXTRA_PAYLOAD = {"thinking": {"type": "disabled"}}  # 关思考链以降延迟

# 推理模型 max_tokens 兜底：思考链开启时会先消耗 token，前端历史调用传的 50/200/500 会被吃光。
# 关思考时此 floor 几乎无副作用（OFF 模式实测 completion ≈ 3 token，远低于 floor）。
TRANSLATE_EN2ZH_MIN_MAX_TOKENS = 2000

# ==================== AI 模型配置（两层）====================
# 这是新架构下 AI 模型的**唯一权威配置点**。
# 被 novelai_web_ui/server/agent_router/model_provider.py 读取，喂给 PydanticAI。
#
# 设计哲学：把"模型有哪些 / 来自哪个渠道"和"用户能切换哪些 model"完全解耦。
#   - MODEL_REGISTRY：列出所有可用模型，每个模型绑死一个渠道（base_url / api_key / proxy）
#   - MODEL_CHOICES：用户可切换的 model 候选（label + 别名 + 指向 MODEL_REGISTRY 的 key）
#   - AI_PROTOCOL：整体协议选 openai 或 gemini，不能混用
#
# 修改后重启 server 生效（uvicorn --reload 自动重载）。
#
# Bot 端 config/settings.py 的 GEMINI_* 是另一套（视频改写等旧功能用），与本文件的
# MODEL_CHOICES 无关；其中大部分是死代码，下次清理可删。


# ------------------------------------------------------------
# 默认协议
# ------------------------------------------------------------
# 当 MODEL_REGISTRY 里的模型没显式声明 protocol 时，用这个全局默认。
# "openai" - OpenAI 兼容（大多数 CLI Proxy / 国产中转）
# "gemini" - Gemini 原生 /v1beta:generateContent（Vertex / 官方 Google AI Studio 等）
AI_PROTOCOL = "openai"


# ------------------------------------------------------------
# 第一层：模型库 (MODEL_REGISTRY)
# ------------------------------------------------------------
# 列出所有可用模型，每个 key 是"逻辑模型名"（在 MODEL_CHOICES 里被引用），
# value 是该模型的具体渠道信息。允许 mix openai + gemini 协议。
#
# 字段:
#   label            - UI 展示用的中文名（可选）
#   base_url         - LLM 服务的根 URL
#                      OpenAI 协议: 形如 http://host:port/v1
#                      Gemini 协议: 形如 .../v1beta 或 .../v1beta1/publishers/google
#   api_key          - 认证密钥
#   proxy            - 出网代理（空 = 直连）
#   protocol         - 该模型走什么协议（"openai" / "gemini"），可选，缺省走 AI_PROTOCOL
#   model_name       - LLM 实际请求时发的 model 字段值（可选，缺省用 dict key）
#                      用于：同一真实模型名在多渠道并存时，给 key 加后缀区分但模型名保真
#                      例: key="gemini-3.5-flash@vertex"  model_name="gemini-3.5-flash"
#   supports_tools   - 是否支持 function calling
#   supports_vision  - 是否支持多模态（false 时图片会被剥离）
#   model_settings   - 透传给 PydanticAI agent.run 的模型参数（如 max_tokens / top_p）
MODEL_REGISTRY: dict[str, dict] = {
    # ===== 本地 CLI Proxy（8317）=====
    # 协议：openai 兼容
    "gemini-3.1-flash-lite": {
        "label": "Gemini 3.1 Flash Lite (最快, 本地代理)",
        "base_url": "http://YOUR_PROXY_HOST:8317/v1beta",
        "api_key": "REPLACE_WITH_API_KEY",
        "proxy": "",
        "supports_tools": True,
        "supports_vision": True,
    },
    "gemini-3.5-flash-yw": {
        "label": "Gemini 3.5 Flash 云雾 (本地代理)",
        "base_url": "http://YOUR_PROXY_HOST:8317/v1beta",
        "api_key": "REPLACE_WITH_API_KEY",
        "proxy": "",
        "supports_tools": True,
        "supports_vision": True,
    },
    "gemini-3.1-pro-preview": {
        "label": "Gemini 3.1 Pro Preview (本地代理)",
        "base_url": "http://YOUR_PROXY_HOST:8317/v1beta",
        "api_key": "REPLACE_WITH_API_KEY",
        "proxy": "",
        "supports_tools": True,
        "supports_vision": True,
    },
    "gpt-5.4-mini": {
        "label": "gpt-5.4-mini",
        "protocol": "openai",
        "base_url": "http://YOUR_PROXY_HOST:8317/v1",
        "api_key": "REPLACE_WITH_API_KEY",
        "proxy": "",
        "supports_tools": True,
        "supports_vision": True,
    },
    "claude-sonnet-4-6": {
        "label": "Claude Sonnet 4.6 (本地代理, OpenAI 兼容)",
        "protocol": "openai",
        "base_url": "http://YOUR_PROXY_HOST:8317/v1",
        "api_key": "REPLACE_WITH_API_KEY",
        "proxy": "",
        "supports_tools": True,
        "supports_vision": True,
    },
    "claude-sonnet-4-6@anthropic": {
        # 走 Anthropic 原生 Messages API（/v1/messages），提示词遵循度比 OpenAI 兼容路径高。
        # base_url 不带版本后缀——AnthropicProvider 内部会拼 /v1/messages。
        "label": "Claude Sonnet 4.6 (本地代理, Anthropic 原生)",
        "protocol": "anthropic",
        "model_name": "claude-sonnet-4-6",
        "base_url": "http://YOUR_PROXY_HOST:8317",
        "api_key": "REPLACE_WITH_API_KEY",
        "proxy": "",
        "supports_tools": True,
        "supports_vision": True,
    },
    "grok-4.2-fast": {
        "label": "Grok 4.2 Fast (本地代理, OpenAI 兼容)",
        "protocol": "openai",
        "base_url": "http://YOUR_PROXY_HOST:8317/v1",
        "api_key": "REPLACE_WITH_API_KEY",
        "proxy": "",
        "supports_tools": True,
        "supports_vision": True,
    },
    "mimo-v2.5": {
        "label": "Mimo v2.5 (本地代理, OpenAI 兼容)",
        "protocol": "openai",
        "base_url": "http://YOUR_PROXY_HOST:8317/v1",
        "api_key": "REPLACE_WITH_API_KEY",
        "proxy": "",
        "supports_tools": True,
        "supports_vision": True,
    },
    "deepseek-v4-flash@local": {
        "label": "DeepSeek v4 Flash (本地代理, OpenAI 兼容)",
        "protocol": "openai",
        "model_name": "deepseek-v4-flash",
        "base_url": "http://YOUR_PROXY_HOST:8317/v1",
        "api_key": "REPLACE_WITH_API_KEY",
        "proxy": "",
        "extra_body": {"thinking": {"type": "enabled"}},
        "supports_tools": True,
        "supports_vision": False,
    },
    "deepseek-v4-pro-yw": {
        "label": "DeepSeek v4 Pro 云雾 (本地代理, OpenAI 兼容)",
        "protocol": "openai",
        "model_name": "deepseek-v4-pro",
        "base_url": "http://YOUR_PROXY_HOST:8317/v1",
        "api_key": "REPLACE_WITH_API_KEY",
        "proxy": "",
        "extra_body": {"thinking": {"type": "disabled"}},
        "model_settings": {"max_tokens": 4096},
        "supports_tools": True,
        "supports_vision": False,
    },

    # ===== Vertex Express Mode =====
    # 路径修正由 agent_router/vertex_provider.py 的自定义 httpx transport 处理:
    # google-genai SDK 会在 base_url 后强制拼 /v1beta，transport 在请求前剥掉它，
    # 使最终 URL 落在 /v1beta1/publishers/google/models/{model}:generateContent。
    # 认证用 x-goog-api-key header（SDK 默认行为，Vertex Express 接受）。
    "gemini-3.1-flash-lite@vertex": {
        "label": "Gemini 3.1 Flash Lite (Vertex Express) - 最快",
        "protocol": "gemini",
        "model_name": "gemini-3.1-flash-lite",
        "base_url": "https://aiplatform.googleapis.com/v1beta1/publishers/google",
        "api_key": "REPLACE_WITH_YOUR_VERTEX_API_KEY",
        "proxy": PROXY_URL,
        "supports_tools": True,
        "supports_vision": True,
    },
    "gemini-3.5-flash@vertex": {
        "label": "Gemini 3.5 Flash (Vertex Express)",
        "protocol": "gemini",
        "model_name": "gemini-3.5-flash",
        "base_url": "https://aiplatform.googleapis.com/v1beta1/publishers/google",
        "api_key": "REPLACE_WITH_YOUR_VERTEX_API_KEY",
        "proxy": PROXY_URL,
        # 低温度提升人格 + schema 遵循度（原 assist tier 的 temperature=0.3，tier 移除后下沉到此 model）
        "model_settings": {"temperature": 0.3, "thinking": False},
        "supports_tools": True,
        "supports_vision": True,
    },
    "gemini-3.1-pro-preview@vertex": {
        "label": "Gemini 3.1 Pro Preview (Vertex Express)",
        "protocol": "gemini",
        "model_name": "gemini-3.1-pro-preview",
        "base_url": "https://aiplatform.googleapis.com/v1beta1/publishers/google",
        "api_key": "REPLACE_WITH_YOUR_VERTEX_API_KEY",
        "proxy": PROXY_URL,
        "supports_tools": True,
        "supports_vision": True,
    },

    # ===== DeepSeek 备用渠道 =====
    # 协议：openai 兼容（DeepSeek 官方）
    "deepseek-v4-flash": {
        "label": "DeepSeek v4 Flash",
        "base_url": "https://api.deepseek.com/beta",
        "api_key": "REPLACE_WITH_DEEPSEEK_KEY",
        "proxy": "",
        "extra_body": {"thinking": {"type": "disabled"}},
        "model_settings": {"max_tokens": 4096},
        "supports_tools": True,
        "supports_vision": False,  # DeepSeek 暂不支持图，遇图自动剥离
    },
    "deepseek-v4-pro": {
        # DeepSeek 文档明确说 thinking + tool calling 支持共存，但 PydanticAI 默认
        # 会传 tool_choice="required"（因为想强制调用工具产出 final_result），而
        # DeepSeek thinking 模式只接受 tool_choice="auto"——所以必须用 extra_body
        # 显式锁成 "auto" 覆盖 PydanticAI 的默认选择。
        # 这样 thinking enabled 时模型自己决定何时调 search_* 工具，不强制。
        # prefilter（lite_chat）用同一 model 时不受影响——get_prefilter_model_settings()
        # 末尾会强制把 extra_body.thinking 覆盖为 disabled，tool_choice 字段无副作用。
        "label": "DeepSeek v4 Pro",
        "base_url": "https://api.deepseek.com/beta",
        "api_key": "REPLACE_WITH_DEEPSEEK_KEY",
        "proxy": "",
        "extra_body": {
            "thinking": {"type": "disabled"},
            "tool_choice": "auto",
        },
        "model_settings": {"max_tokens": 4096},
        "supports_tools": True,
        "supports_vision": False,
    },

    # ===== NovelAI 文本 API（OpenAI 兼容 /oa/v1）=====
    # 端点：https://text.novelai.net/oa/v1/chat/completions
    # 认证：复用图像生成的 pst- token（NAI 同一份 token 同时打通文本/图像/订阅查询）
    # 已知限制（实测）：
    #   1. 非流式响应不返回 message.content（只有 token_ids），openai SDK 直接 AttributeError。
    #      必须走 stream=True，由 NAI 适配层把 chunks 拼成标准 ChatCompletion。
    #   2. 不返回 OpenAI 标准 tool_calls 字段，工具调用以 <function=...> 自然语言形式出现在
    #      content 里，PydanticAI 解析不了。故 supports_tools=False，禁用 agent 工具流程。
    "glm-4-6": {
        "label": "GLM-4.6（NAI 文本 API）",
        "protocol": "openai",
        "base_url": "https://text.novelai.net/oa/v1",
        "api_key": NOVELAI_TOKENS[0] if NOVELAI_TOKENS else "",
        "proxy": PROXY_URL,
        "model_settings": {"max_tokens": 4096},
        "supports_tools": False,
        "supports_vision": False,
    },
}


# ------------------------------------------------------------
# Prefilter 专用模型
# ------------------------------------------------------------
# 每轮主 chat agent 之前跑一次 PrefilterAgent，做"预匹配资料合并去重+语义筛选"。
# 固定用一个轻量小模型（成本/延迟低），不参与 MODEL_CHOICES 用户切换。
# 必须是 MODEL_REGISTRY 里登记的 key。
PREFILTER_MODEL = os.environ.get("CPA_PREFILTER_MODEL", "deepseek-v4-flash")


# ------------------------------------------------------------
# 第二层：模型候选 (MODEL_CHOICES)
# ------------------------------------------------------------
# 合并 agent 后不再有 assist/create 模式（tier 已彻底移除）。只剩一组可切换的 model：
# 用户通过「切换模型 <名称>」在这组里选，bot 端按会话记住选择，server 端按所选 model 出图。
#
# 每个 key 是用户可见的"选择项"，映射到 MODEL_REGISTRY 里的一个 model：
#   label   - 中文展示名
#   model   - MODEL_REGISTRY 的 key
#   aliases - 切换命令可识别的别名
MODEL_CHOICES: dict[str, dict] = {
    "deepseek": {
        # 走 DeepSeek 官方 API（api.deepseek.com/beta），thinking 已 disabled
        "label": "DeepSeek v4 Pro（官方）",
        "model": "deepseek-v4-pro",
        "aliases": [
            "ds", "deepseek-v4-pro", "deepseek_pro", "dspro", "dsp",
            "ds官方", "官方ds", "deepseek官方",
            # 兼容旧别名（云雾时代）
            "ds云雾", "deepseek云雾", "云雾deepseek", "ywds",
            "yunwudeepseek", "deepseek-v4-pro-yw", "deepseek_yw",
        ],
    },
    "gemini": {
        "label": "Gemini（3.5 Flash Vertex）",
        "model": "gemini-3.5-flash@vertex",
        "aliases": [
            "gem", "gemini35", "flash", "3.5vertex", "35vertex", "vertex",
            "vx", "gemini35vertex", "vertex35",
        ],
    },
    "chatgpt": {
        "label": "ChatGPT（gpt-5.4-mini）",
        "model": "gpt-5.4-mini",
        "aliases": [
            "gpt", "gpt5", "gpt-5", "gpt54", "gpt-5.4", "gpt5.4",
            "gpt-5.4-mini", "5.4mini", "mini",
        ],
    },
    "claude": {
        # 走 Anthropic 原生协议（拆分 + critical_reminders 上线后再测，预期遵循度回升）
        "label": "Claude Sonnet 4.6（本地代理, 原生协议）",
        "model": "claude-sonnet-4-6@anthropic",
        "aliases": [
            "claude46", "claude4.6", "sonnet", "sonnet46", "sonnet4.6",
            "claude-sonnet-4-6", "claude-sonnet-4.6", "cs46", "cs4.6",
        ],
    },
    "glm46": {
        "label": "GLM-4.6（NAI 文本 API）",
        "model": "glm-4-6",
        "aliases": [
            "glm", "glm4", "glm46", "glm-4-6", "glm4.6",
            "naichat", "nai-glm", "智谱", "智谱4.6",
        ],
    },
}
# 全局默认选中的 model（bot 会话未单独指定时用它；Web 端默认也用它）
ACTIVE_MODEL = os.environ.get("CPA_ACTIVE_MODEL", "deepseek")
if ACTIVE_MODEL not in MODEL_CHOICES:
    ACTIVE_MODEL = next(iter(MODEL_CHOICES))


def _resolve_model_key(target=None, current: str | None = None) -> str:
    """把用户输入（key / label / 别名 / 序号 / 空=轮换）解析成 MODEL_CHOICES 的 key。"""
    keys = list(MODEL_CHOICES.keys())
    if not keys:
        raise ValueError("MODEL_CHOICES is empty")
    if target is None or str(target).strip() == "":
        active = current or ACTIVE_MODEL
        try:
            idx = keys.index(active)
        except ValueError:
            idx = -1
        return keys[(idx + 1) % len(keys)]
    if isinstance(target, int):
        return keys[target % len(keys)]
    value = str(target).strip().lower().replace(" ", "").replace("-", "")
    for key, ch in MODEL_CHOICES.items():
        candidates = [key, ch.get("label", ""), ch.get("model", ""), *(ch.get("aliases") or [])]
        for item in candidates:
            normalized = str(item).strip().lower().replace(" ", "").replace("-", "")
            if value == normalized:
                return key
    raise ValueError(f"unknown model: {target}")


def resolve_model(target=None, current: str | None = None) -> tuple[str, dict]:
    """解析目标 model（不改全局状态）。返回 (key, choice dict)。"""
    key = _resolve_model_key(target, current=current)
    ch = MODEL_CHOICES[key]
    model = ch["model"]
    if model not in MODEL_REGISTRY:
        raise ValueError(f"model not registered: {model}")
    return key, dict(ch)


def switch_model(target=None) -> tuple[str, dict]:
    """切换全局默认 model。返回 (key, choice dict)。"""
    global ACTIVE_MODEL
    key, ch = resolve_model(target)
    ACTIVE_MODEL = key
    return key, dict(ch)


def get_model_status() -> dict:
    return {
        "active": ACTIVE_MODEL,
        "active_choice": dict(MODEL_CHOICES.get(ACTIVE_MODEL) or {}),
        "choices": {key: dict(value) for key, value in MODEL_CHOICES.items()},
    }


# ------------------------------------------------------------
# 兼容：旧 PUBLIC_AI_CHANNELS 派生变量（保留方便旧代码 import；新代码不应使用）
# ------------------------------------------------------------
PUBLIC_AI_CHANNELS = [
    {
        "name": "default-from-registry",
        "label": "（自动从 MODEL_REGISTRY 生成，仅作旧代码兼容）",
        "base_url": next(iter(MODEL_REGISTRY.values()))["base_url"] if MODEL_REGISTRY else "",
        "api_key": next(iter(MODEL_REGISTRY.values()))["api_key"] if MODEL_REGISTRY else "",
        "proxy": next(iter(MODEL_REGISTRY.values()))["proxy"] if MODEL_REGISTRY else "",
    }
]
PUBLIC_AI_ACTIVE_CHANNEL = 0
_active = PUBLIC_AI_CHANNELS[0]
PUBLIC_AI_BASE_URL = _active["base_url"]
PUBLIC_AI_API_KEY = _active["api_key"]
PUBLIC_AI_PROXY = _active["proxy"]

# ============ Genspark 图像工坊配置 ============
GENSPARK_API_BASE = "http://YOUR_API_HOST:7055/v1"
GENSPARK_API_KEY = "REPLACE_WITH_API_KEY"
GENSPARK_STYLE = "auto"
GENSPARK_COOKIE = ""

# 模型到 Genspark fal-ai model 的映射（已停用，工坊全部切换到大GPT）
GENSPARK_MODEL_MAP = {
    "banana": {"model": "nano-banana-pro", "image_size": "2k"},
    "banana-4k": {"model": "nano-banana-pro", "image_size": "4k"},
    "nano-banana": {"model": "fal-ai/nano-banana", "image_size": "2k"},
    "doubao": {"model": "fal-ai/bytedance/seedream/v5/lite", "image_size": "3k"},
    "qianwen": {"model": "fal-ai/z-image/turbo", "image_size": "auto"},
    "gpt-image": {"model": "fal-ai/gpt-image-1.5", "image_size": "auto"},
}

# ============ 大GPT 图像工坊配置（OpenAI 兼容 /chat/completions + image_generation 工具） ============
# 与 Bot 端 BIG_GPT_* 同源；Web 端独立可调。
BIG_GPT_BASE_URL = "http://YOUR_PROXY_HOST:8317/v1"
BIG_GPT_API_KEY = "REPLACE_WITH_API_KEY"
BIG_GPT_MODEL = "gpt-image-2-custom"
BIG_GPT_QUALITY = "high"           # low / medium / high
BIG_GPT_MODERATION = "low"         # low / auto
BIG_GPT_BACKGROUND = "auto"        # auto / transparent / opaque
BIG_GPT_TIMEOUT = 300              # 秒

# 比例 → 分辨率映射（与 Bot 端 _BIG_GPT_RATIO_TABLE 一致）
# 满足：16px 倍数 / 长边 ≤ 3840 / 长短比 ≤ 3:1 / 像素 ∈ [65万, 829万]
BIG_GPT_RATIO_TABLE = {
    "1:1":  {"2k": "2048x2048", "4k": "2880x2880"},
    "3:2":  {"2k": "2304x1536", "4k": "3456x2304"},
    "2:3":  {"2k": "1536x2304", "4k": "2304x3456"},
    "4:3":  {"2k": "2048x1536", "4k": "3264x2448"},
    "3:4":  {"2k": "1536x2048", "4k": "2448x3264"},
    "5:4":  {"2k": "2000x1600", "4k": "3200x2560"},
    "4:5":  {"2k": "1600x2000", "4k": "2560x3200"},
    "16:9": {"2k": "2048x1152", "4k": "3840x2160"},
    "9:16": {"2k": "1152x2048", "4k": "2160x3840"},
    "21:9": {"2k": "2016x864",  "4k": "3696x1584"},
    "9:21": {"2k": "864x2016",  "4k": "1584x3696"},
}

# ==================== Boost 通道（免费试用号顶峰）====================
# 当付费号全部 in_use 时，新任务会立即派给 trial 号（reCAPTCHA V3 by Capsolver）
# 留空 CAPSOLVER_CLIENT_KEY 即完全禁用 boost，恢复纯付费排队行为。
#
# 单次 captcha 费用 $0.001（Capsolver 普通 V3 Proxyless，实测最稳最快），
# 生图本身 trial 号自带 30 张/号免费配额。
# Boost worker 永不接 PR（director_reference）、超大尺寸（>1M 像素）、超步数（>28），这些必走付费。
# Vibe (reference_image_multiple) 是前端集中编码后的 vector，免费可接。

CAPSOLVER_CLIENT_KEY = ""
CAPSOLVER_HOST = "https://api.capsolver.com"
NAI_RECAPTCHA_TOKEN_API_URL = os.environ.get("NAI_RECAPTCHA_TOKEN_API_URL", "http://YOUR_API_HOST:7022/novelai-token")
NAI_RECAPTCHA_TOKEN_API_KEY = os.environ.get("NAI_RECAPTCHA_TOKEN_API_KEY", "REPLACE_WITH_API_KEY")
NAI_RECAPTCHA_TOKEN_API_TIMEOUT = float(os.environ.get("NAI_RECAPTCHA_TOKEN_API_TIMEOUT", "10"))
NAI_RECAPTCHA_TOKEN_API_ACCOUNT_TIMEOUT = float(os.environ.get("NAI_RECAPTCHA_TOKEN_API_ACCOUNT_TIMEOUT", "180"))
NAI_RECAPTCHA_TOKEN_API_FALLBACK_CAPSOLVER = os.environ.get(
    "NAI_RECAPTCHA_TOKEN_API_FALLBACK_CAPSOLVER", "1"
) != "0"
NAI_BOOST_ACCOUNTS_FILE = str(Path(__file__).parent.parent.parent / "nai_accounts.json")
# 运行时状态（trial_image_left / warmed_at_ips / novelai_token / novelai_token_exp），
# 与 accounts.json 拆开避免 git 推送冲突。本文件 .gitignore，仅本机持久化。
NAI_BOOST_STATE_FILE = str(Path(__file__).parent.parent.parent / "nai_accounts_state.json")
NAI_BOOST_COOLDOWN_PER_ACCOUNT_SEC = 600          # 单账号失败后冷却（秒）
NAI_BOOST_GLOBAL_COOLDOWN_SEC = 1800               # 触发全局冷却的时长（秒，默认 30 分钟）
# 403 / captcha-rejected 的滑动窗口熔断：最近 NAI_BOOST_403_WINDOW 次 boost 任务里
# 失败 ≥ NAI_BOOST_403_THRESHOLD 次 → 整个 boost 通道全局冷却。
# 旧版"连续"语义经常永远触发不了（任意一次成功清零）；窗口能反映"稳态失败率"。
NAI_BOOST_403_WINDOW = 50                          # 滑动窗口大小
NAI_BOOST_403_THRESHOLD = 20                       # 窗口内失败次数阈值
NAI_BOOST_TOKEN_REFRESH_AHEAD_SEC = 86400         # token 临到期多少秒前主动续期（默认 1 天）
NAI_BOOST_ACTIVE_ACCOUNTS = int(os.environ.get("NAI_BOOST_ACTIVE_ACCOUNTS", "4"))  # 同时激活的 trial 账号上限；0=按实际 boost 并发动态启用
NAI_BOOST_QUOTA_REFRESH_SEC = int(os.environ.get("NAI_BOOST_QUOTA_REFRESH_SEC", "21600"))  # 全量刷新所有 trial 账号余额的间隔（秒，默认 6h）；捕获 NAI 端 trial reset / 外部消耗

# ==================== 计费分摊 ====================

BILLING_TOTAL_COST = 170.0           # 每月总成本（元）
BILLING_ANLAS_THRESHOLD = 2000       # Anlas 超额阈值
BILLING_ANLAS_SURCHARGE = 5.0        # 超额附加费（元）
BILLING_FREE_THRESHOLD = 200         # 免费阈值（张）
BILLING_TIER_WEIGHTS = [0, 1, 3, 6]  # 免费/一阶/二阶/三阶 权重
BILLING_CYCLE_DAY = 27               # 每月结算分界日


# ==================== Anima（cnb ComfyUI 二次元出图后端）====================
# 用户切到 MODEL_CHOICES["anima"] 渠道后：ChatResponse.image_backend = "anima"，
# Bot 端按此路由到 server 的 anima provider（M3 实现）；本块给 M2/M3 用。
#
# 仓库：soralight-2026/amina （fork 自 sora124/amina，已精简为 bot 用最小集，
#     单 anima_base_api.json 工作流，三个 LFS 模型，无任何自定义节点）
# 镜像：docker.cnb.cool/soralight-2026/amina:latest （已 build 就绪）
# workspace URL 形式：https://<business_id>-8188.cnb.run （ComfyUI on L40，~16s/张）

# 账户池（与 bot 端 default2 共用同一个 token；千问视频已停用不冲突）
ANIMA_CNB_ACCOUNTS: list[dict] = [
    {
        "name": "anima-default1",
        "api_base": "https://api.cnb.cool",
        "repo": "soralight-2026/amina",
        "branch": "main",
        "token": "REPLACE_WITH_YOUR_CNB_TOKEN",
    },
]

# 持久化 store：每账户当前 workspace URL / sn / business_id / create_time。
# server 重启后从这里恢复，避免重复启停 workspace。
ANIMA_ACCOUNT_STORE = Path(__file__).parent / "data" / "anima_accounts.json"

# ComfyUI API 格式 workflow JSON（节点 id 契约：11/12 正反向、28 尺寸、19 KSampler、46 SaveImage）。
ANIMA_PAYLOAD_PATH = Path(__file__).parent / "data" / "anima_base_api.json"

# LLM 输出 DrawSpec 字段为空时的兜底默认。
ANIMA_DEFAULT_PROMPT = (
    "masterpiece, best quality, amazing quality, very aesthetic, absurdres, 1girl, solo"
)
ANIMA_DEFAULT_NEGATIVE_PROMPT = "worst quality, low quality, blurry, jpeg artifacts"
ANIMA_DEFAULT_WIDTH = 832
ANIMA_DEFAULT_HEIGHT = 1216

# cnb workspace API 调用超时 / 轮询参数（与 bot 端 QIANWEN_VIDEO_* 对齐）。
ANIMA_CNB_REQUEST_TIMEOUT = 60                # CNB API 单次请求超时(s)
ANIMA_CNB_DETAIL_POLL_INTERVAL = 5            # workspace 列表轮询间隔(s)
ANIMA_CNB_READY_TIMEOUT = 1200                # workspace 启动 + ComfyUI 就绪总超时(s)

# 队列调度 + 巡检（M2 通用池用）。
ANIMA_PATROL_INTERVAL_SECONDS = 60            # 巡检循环间隔(s)
ANIMA_IDLE_SHUTDOWN_SECONDS = 1800            # 账户空闲超 N 秒自动关 workspace 省 cnb 配额（30 分钟）
ANIMA_ACCOUNT_MAX_RUNNING_SECONDS = 3600      # workspace 单次连跑超 N 秒强制重启
ANIMA_LOCAL_ACTIVE_STALE_SECONDS = 180        # 本地占用标记 stale 阈值
ANIMA_SCALE_QUEUE_PER_ACCOUNT = 2             # 动态扩容：每 N 个等待任务追加 1 个账户

# 出图任务（M3 用）。
ANIMA_POLL_INTERVAL = 3                       # 出图轮询 /history 间隔(s)
ANIMA_RUNNING_TIMEOUT_SECONDS = 300           # 单张图 running 阶段超时(s)
