"""
Agent 路由组的所有 pydantic 模型。

按用途分四类：
    1. Agent I/O（送给 PydanticAI Agent / Agent 产出）
    2. HTTP Request / Response（endpoint 的入参出参）
    3. Tool I/O（@agent.tool 装饰函数的入参出参）
    4. SSE 事件 envelope

约定:
    - 所有字段名遵循 snake_case
    - 时间戳一律 float UNIX timestamp
    - 图片均用 base64（不含 data URI 前缀）
"""
from __future__ import annotations

from typing import Optional, Literal, Any
from pydantic import BaseModel, Field


# ============================================================
# Tier / 模型档位
# ============================================================

# tier（assist/create）已彻底移除：合并 agent + 单一 model 选择架构。
# 请求带一个 model（MODEL_CHOICES 的 key/别名；空 = 全局 ACTIVE_MODEL）。
Scene = Literal["group", "private", "web"]


# ============================================================
# 1. Agent I/O —— PydanticAI Agent 的 input / output_type
# ============================================================

# 说明:
# 在 Agent output_type / tool return type 里出现的字段一律用 inline dict，
# 不嵌套 BaseModel。原因：Gemini 系列模型通过 CLI Proxy 透传时不接受 schema 里的
# $defs / $ref 引用（PydanticAI 给嵌套 BaseModel 自动生成的形式），会报：
#   Invalid JSON payload received. Unknown name "$defs"
#   Unknown name "$ref" at properties[..].items
#
# 因此：
#   - 暴露给 LLM 的字段（DrawSpec.characters / ChatOutput.draw_specs 等）用 list[dict]
#   - 但 DrawCharacter 这个 BaseModel 仍然保留，作为 Python 内部类型给单测和反向兼容用


# 实现说明（不写进 docstring，避免污染发给模型的 schema description）：
# characters 历史上用 list[dict[str,str]]，因为 pydantic-ai 给嵌套 BaseModel 生成的 schema
# 带 defs/ref 引用，Gemini CLI 代理会 400。自研框架的 llm.output.build_inlined_json_schema
# 会把这些引用就地内联展开（产出不含 defs/ref），故现在可安全地用具名模型 DrawCharacter：
# 既给 Gemini/Vertex 一个带 properties 的合法 object schema（规避"无 properties 的 OBJECT"被 Vertex 拒），
# model_dump() 后的 dict 形态（name/positive/negative）又与旧版 list[dict] 完全一致。
class DrawCharacter(BaseModel):
    """单角色分区 prompt（字段 name / positive / negative）。"""
    name: str = Field(..., description="角色名（中文或英文）")
    positive: str = Field(..., description="该角色的正向 tag")
    negative: str = Field("", description="该角色的反向 tag（可选）")


class DrawSpec(BaseModel):
    """
    绘图规格 —— 合并 chat_agent 直接产出（写进 ChatOutput.draw_specs）。

    流向：
      Bot 端：chat_agent → ChatOutput.draw_specs[i] → enqueue_image_generation 提交到 NovelAI 队列
      Web 端：chat_agent → ChatOutput → 转换为 AgentResult → 前端 Workshop 渲染 prompt
    （draw_planner_agent / web_prompt_agent 已下线，统一走合并 chat_agent）

    简化版：不再含 cr / vibes / seed 等字段。
    """
    positive: str = Field(
        ...,
        description=(
            "全局正向 tag（英文逗号分隔）。\n"
            "**严格约束（违反会导致画面退化）**：\n"
            "1. 对于 chat_agent 已查到的 source=roleTag 预训练角色（如 plana_(blue_archive) / "
            "flandre_scarlet / hatsune_miku 等带括号的标准 Danbooru 角色 tag），**禁止追加发色 / 瞳色 / "
            "发型 / 招牌服装 / 招牌饰品**。例如：plana_(blue_archive) 已经包含'白发 + 蓝眼 + 光环 + 白裙'，"
            "再写 white hair, blue eyes, halo, white dress 是错的——模型已经学过这角色外貌，硬塞反而干扰。\n"
            "2. 用户明确要换装 / cos / 改造时才可加额外服装 tag。"
        ),
    )
    negative: str = Field("", description="全局反向 tag（英文逗号分隔，可留空字符串）")
    characters: list[DrawCharacter] = Field(
        default_factory=list,
        description=(
            "多角色场景的分区 tag 列表。每个元素是一个对象，含 "
            "name(角色名 str)、positive(该角色的正向 tag str)、negative(该角色的反向 tag str，可选)。"
            "示例: [{\"name\": \"芙兰\", \"positive\": \"flandre_scarlet, blonde_hair\", \"negative\": \"\"}]。"
            "**单角色场景必须留空数组 []**，禁止传整数 / 字符串 / 单纯的角色名列表。"
        ),
    )
    size: Optional[str] = Field(None, description="Portrait / Landscape / Square / Cinemascope")


class ChatOutput(BaseModel):
    """chat_agent 主编排者产出"""
    reply_text: str = Field(
        ...,
        description=(
            "发给用户的**猫娘语气**文本回复（**必须严格遵循 system prompt 里 [persona] / [reply_rules] 段**）。"
            "无论 assist 还是 create 模式都保留猫娘标签——自称'本喵'、称用户'主人'、句末用'喵~/喵！/喵。'按情绪选。"
            "区别仅在表达密度：assist 模式精简（点到为止、限字）；create 模式可放开聊、带情绪。"
            "**严禁**写成中性客服腔；**严禁**在此字段写 JSON / 英文 tag / 绘图参数。"
        ),
    )
    # draw_spec 用 dict（不嵌 DrawSpec BaseModel）避免 Gemini 不接受 $defs/$ref。
    # 改为单数 + Optional：消除外层 list[dict] 包装，characters 嵌套深度从 2 层降到 1 层，
    # 显著减少 Gemini structured output 模式下 "characters 总是填 []" 的逃避主义。
    # 每轮只产 1 张图（绝大多数场景天然如此；多张需求让用户分多轮发）。
    draw_spec: Optional[dict] = Field(
        None,
        description=(
            "本轮要画的图（单张，没有则为 null）。字段类型必须严格遵守:\n"
            '  - positive: str（必填，英文 tag 逗号分隔）\n'
            '  - negative: str（英文反向 tag，无可留空字符串）\n'
            '  - characters: list[dict]——角色分区，**何时填看下面**:\n'
            '      • 单角色场景 → []（禁止 1 / "角色名" / ["角色名"]）\n'
            '      • 多角色场景 → [{"name": str, "positive": str, "negative"?: str}, ...] **必填**\n'
            '      • 多角色判定：用户原话提到 2+ 专有角色名 / 用户说"分角色"或"分别"或"分角色提示词" /\n'
            '        预查询资源含 2+ character 候选 / 输入元数据有 char1/char2/[charN+] 字段\n'
            '  - size: str（Portrait / Landscape / Square / Cinemascope）\n'
            "如果不绘图本字段为 null，并设 should_draw=false。"
        ),
    )
    should_draw: bool = Field(False, description="是否触发绘图")
    mood: Optional[str] = Field(None, description="可选：本轮回复的情绪标签")


class LiteResponse(BaseModel):
    """
    Lite agent（Vertex Gemini Flash Lite）的产出：回复 + 意图判断 + 资料筛选三合一。

    全 primitive 字段，零嵌套——保证 lite 模型在 structured output 模式下零负担。
    跟 ChatOutput 的多层嵌套形成鲜明对比，避免"幻想字段死循环 / characters=[] 逃避"。
    """
    reply_text: str = Field(
        ...,
        description=(
            "发给用户的简短回复（≤ 30 字）。保留猫娘表层标签'喵~/本喵/主人'但不演性格。\n"
            "should_draw=True 时：'在画了喵~' / '马上来喵。' / '好喵~' 这类一句话告知，不复述用户要画什么。\n"
            "should_draw=False 时：根据用户原话简短回应（你好/感谢/查询答复）。"
        ),
    )
    should_draw: bool = Field(
        ...,
        description=(
            "是否要触发图片生成。判定规则:\n"
            "- True：用户明确要画图（'画一张'/'再来一张'/'换姿势'/'继续画'/'加 X tag'/'去掉 X tag'）\n"
            "- False：闲聊、问候、感谢、问询（'你好'/'plana 是谁'/'A1 是什么风格'）"
        ),
    )
    refined_resources: str = Field(
        "",
        description=(
            "从输入末尾 [预查询资源] 段筛出真正相关的条目，保持原 '## search_xxx 结果\\n候选行' 格式。\n"
            "- should_draw=True：保留与用户意图相关的候选（删无关变体）\n"
            "- should_draw=False：填空字符串\n"
            "格式示例:\n"
            "## search_artist 结果\n"
            "A1 → artist:ciloranko, ...\n"
            "## search_character 结果（source=roleTag）\n"
            "芙兰 → flandre_scarlet, touhou"
        ),
    )


class AgentResult(BaseModel):
    """
    Web 端前端期望的响应格式 —— 与 novelai_web_ui/src/services/agentService.ts:21 AgentResult 兼容。

    生成路径：
      Web 路由 /api/agent/web/generate-prompt 内部跑 chat_agent（与 Bot 同一套），
      然后由 router._chat_output_to_agent_result 把 ChatOutput 转成本结构供前端消费。
      （旧版独立的 web_prompt_agent 已下线）
    """
    thinking: str = Field("", description="AI 思考过程 / 闲聊文本")
    positive: str = Field("", description="正向 tag")
    negative: str = Field("", description="反向 tag")
    characters: list[dict[str, str]] = Field(
        default_factory=list,
        description=(
            "多角色场景的分区 tag 列表。每个元素是一个对象，含 name、positive、negative。"
            "示例: [{\"name\": \"芙兰\", \"positive\": \"flandre_scarlet\", \"negative\": \"\"}]。"
        ),
    )


# ============================================================
# 2. HTTP Request / Response —— /api/agent/* 入参出参
# ============================================================

class ChatImage(BaseModel):
    """用户消息中携带的图片"""
    base64: str = Field(..., description="图片 base64，不含 data URI 前缀")
    mime_type: str = Field("image/png")
    is_generated: bool = Field(False, description="是否是 AI 生成的图（影响历史裁剪策略）")


class ChatRequest(BaseModel):
    """POST /api/agent/chat —— Bot 端入口"""
    user_id: str = Field(..., description="用户唯一标识（QQ 号等）")
    user_key: Optional[str] = Field(None, description="历史 key，如 qq_p_123；不传则按 platform+scene 拼")
    platform: str = Field("qq", description="qq / discord / ...")
    scene: Scene = Field("private")
    group_id: Optional[str] = Field(None)
    text: str = Field("", description="用户文本")
    images: list[ChatImage] = Field(default_factory=list)
    model: str = Field("", description="选用的 LLM 渠道（MODEL_CHOICES 的 key/别名；空 = 全局默认）")
    # 图片生成模型: 'anima' / 'nai_v45_full' / 'nai_v45_curated' 之一。
    # 'anima' → server 用 prompts_anima.yaml + 出图走 cnb ComfyUI 后端；
    # 其他 / 空 → 用默认预设 + 走 NAI 出图后端。
    # 由 bot 端读 NOVELAI_MODEL_MODE[ctx] 后归一化后传入（与 LLM 渠道正交）。
    image_model: str = Field("", description="图片生成模型 (anima / nai_v45_full / nai_v45_curated)")
    clear_history: bool = Field(False)
    debug_context: bool = Field(False, description="是否返回本轮各模型实际收到的完整上下文")
    # Bot 端 preprocess 阶段如果已经提取到上下文（CR 图、画师串等），可直接传进来
    environment_info: Optional[str] = Field(None, description="额外环境上下文（用于过渡期复用 main.py 的现有 preprocess）")


class ChatResponse(BaseModel):
    """POST /api/agent/chat 一次性返回"""
    reply_text: str
    # 注意：与 ChatOutput.draw_specs 一致用 list[dict]（避免嵌套 BaseModel 触发 $defs/$ref）。
    # 字段语义同 DrawSpec：positive/negative/characters/vibes/seed/size/cr/cr_mode...
    draw_specs: list[dict] = Field(default_factory=list)
    should_draw: bool = False
    history_updated: bool = True
    degraded: bool = Field(False, description="是否触发了降级（如 prison_break 失败）")
    error: Optional[str] = None
    # bot 端按此字段路由到不同图像后端。值由 MODEL_CHOICES[model].image_backend 决定：
    # "novelai"（默认）走原 NAI 出图队列；"anima" 走 cnb workspace + ComfyUI Anima 模型。
    image_backend: str = Field("novelai", description="本轮出图应使用的后端: novelai | anima")
    debug: dict[str, Any] = Field(default_factory=dict, description="调试信息（不会给模型使用）")


class WebPromptRequest(BaseModel):
    """POST /api/agent/web/generate-prompt —— Web Agent SSE 入口"""
    user_request: str = Field(..., description="用户输入")
    model: str = Field("", description="选用的 model（MODEL_CHOICES 的 key/别名；空 = 全局默认）")
    image_b64: Optional[str] = Field(None)
    # Web Agent 不维护服务端会话历史，由前端把要回带的历史扔进来
    history: list[dict] = Field(default_factory=list, description="前端持有的对话历史（[{role, content}]）")
    use_codex: bool = Field(False, description="是否启用法典")
    knowledge_sources: list[str] = Field(
        default_factory=lambda: ["roleTags", "artists", "vibes", "ocs"],
        description="启用的资料源",
    )
    web_artists: list[dict[str, Any]] = Field(
        default_factory=list,
        description="Web 前端当前可见的画师串资料（含浏览器本地 IndexedDB 条目）",
    )
    web_ocs: list[dict[str, Any]] = Field(
        default_factory=list,
        description="Web 前端当前可见的 OC 资料（含浏览器本地 IndexedDB 条目）",
    )
    # 当前画面提示词状态（用户可能想"在此基础上"修改）
    current_positive: str = Field("", description="用户当前的全局正向 tag")
    current_negative: str = Field("", description="用户当前的全局反向 tag")
    current_characters: list[dict] = Field(
        default_factory=list,
        description="用户当前的分角色列表（[{name, positive, negative?}]）",
    )


class PromptsResponse(BaseModel):
    """GET /api/agent/prompts —— 返回合并后的统一预设（tier 已移除）"""
    system_prompts: list[dict]   # [{role, content}, ...]
    prison_break: list[dict]


class HistoryMessage(BaseModel):
    """与现有 history_dict 格式对齐"""
    role: str  # user / assistant
    content: Any  # str 或 list[{text} | {inline_data}]
    is_generated_image: bool = Field(False, alias="_is_generated_image")
    generated_params: Optional[dict] = None

    model_config = {"populate_by_name": True}


class HistoryResponse(BaseModel):
    """GET /api/agent/history/{user_key}"""
    user_key: str
    messages: list[HistoryMessage]
    mode: Optional[str] = None


class HealthTierStatus(BaseModel):
    tier: str  # 格式 "flash:quick" / "pro:generation" 等
    model: str
    ok: bool
    latency_ms: Optional[float] = None
    error: Optional[str] = None


class HealthResponse(BaseModel):
    """GET /api/agent/health"""
    ok: bool
    tiers: list[HealthTierStatus]


# ============================================================
# 3. Tool I/O —— @agent.tool 的入参/出参
# ============================================================

class Character(BaseModel):
    """search_character 返回的角色（含通用预训练角色和 OC 角色，按 source 字段区分）"""
    name: str
    zh_aliases: list[str] = Field(default_factory=list)
    origin_en: Optional[str] = None
    origin_zh: list[str] = Field(default_factory=list)
    tags: str = Field(..., description="可直接放入 positive 的 tag 串")
    source: Literal["cr", "oc", "roleTag"] = "cr"


class Artist(BaseModel):
    """search_artist / random_artist 返回的画师串"""
    id: str
    name: str
    prompt: str = Field(..., description="画师串完整 tag")
    description: Optional[str] = None



class DanbooruTag(BaseModel):
    """
    search_danbooru 返回的模糊匹配结果（按名字找人 / 物 / 作品）。
    前 N 个最热结果会自动附带中文 wiki 摘要（如果该 tag 有 wiki 页）。
    """
    name: str = Field(..., description="tag 标准名（如 ciloranko / flandre_scarlet / touhou）")
    category: Literal["character", "artist", "copyright", "general", "meta", "unknown"] = Field(
        "general",
        description="tag 类别：character=角色, artist=画师, copyright=作品/组合, general=普通, meta=元 tag",
    )
    post_count: int = Field(0, description="Danbooru 上该 tag 的图片数（越多越热门）")
    has_wiki: bool = Field(
        False,
        description="是否查到 Danbooru wiki（仅前 3 热门结果会去查，节省请求）",
    )
    wiki_summary_zh: str = Field(
        "",
        description="中文 wiki 摘要（有 wiki 时填充）—— 告诉你这是谁/什么作品/什么 tag 含义",
    )


class TranslateResult(BaseModel):
    translated: str
    direction: Literal["zh2en", "en2zh"]


# ============================================================
# 4. SSE 事件 envelope —— /api/agent/web/generate-prompt 流式响应
# ============================================================

class SseEvent(BaseModel):
    """统一的 SSE 事件结构。data 字段会被 JSON-encode 后送给前端。"""
    event: Literal[
        "agent_token",       # LLM 流式 token
        "tool_call",         # 工具开始调用
        "tool_result",       # 工具返回结果
        "delegate_start",    # 委派子 agent 开始
        "delegate_end",      # 委派子 agent 结束
        "final",             # 终态 payload（AgentResult / ChatOutput）
        "error",
        "degraded",          # 软降级（prison_break 失败等）
    ]
    data: Any
