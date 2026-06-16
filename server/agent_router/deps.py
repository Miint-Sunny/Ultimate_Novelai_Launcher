"""
AgentDeps —— PydanticAI 运行时依赖注入容器。

通过 `Agent(..., deps_type=AgentDeps)` 注册后，所有 @agent.tool 的 RunContext[AgentDeps]
都能拿到这里的字段。用于：
    - 把 user_id / scene / user_key 传给工具，避免全局变量
    - 共享 httpx.AsyncClient 连接池
    - 给 SSE 编组器一个事件 emit 回调
    - 缓存 prompts / 配置等只读资源
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional, Callable, Awaitable, Any
import httpx

from .schemas import Scene, SseEvent


# SSE 事件发射器类型：调用方传入一个 async 回调
SseEmitter = Callable[[SseEvent], Awaitable[None]]


@dataclass
class AgentDeps:
    """所有 agent 共享的运行时上下文"""

    # === 调用方身份 ===
    user_id: str
    user_key: str = ""                     # 历史 key，如 qq_p_123 / web_anon_xxx
    platform: str = "qq"
    scene: Scene = "private"
    group_id: Optional[str] = None
    session_id: str = ""                   # Bot/Web 授权 session，调本机带授权 API 时透传

    # === 选用的 model（MODEL_CHOICES 的 key；空 = 全局 ACTIVE_MODEL）===
    selected_model: str = ""

    # === 当前 model 的 prompt 预设名（MODEL_CHOICES[key].prompt_preset；空 = 默认 prompts.yaml）===
    # 由 router.chat 在 deps 构造时按 req.model 注入；agent 的 @system_prompt 函数读取
    # 后传给 prompts.load_*_section(name, preset=...) 切换到对应 yaml 文件。
    prompt_preset: str = ""

    # === 内部服务 ===
    http_client: httpx.AsyncClient = field(default=None)  # type: ignore[assignment]
    internal_base_url: str = "http://127.0.0.1:8765"     # 本机 server 自身，调 /api/cr 等

    # === SSE（chat_agent 在 Web 端 SSE 入口下使用，Bot 端一次性返回不用） ===
    sse_emitter: Optional[SseEmitter] = None

    # === Web 端开关 ===
    use_codex: bool = False
    knowledge_sources: list[str] = field(default_factory=list)
    web_artists: list[dict[str, Any]] = field(default_factory=list)
    web_ocs: list[dict[str, Any]] = field(default_factory=list)
    web_current_prompt_context: str = ""

    # === 标记是否已触发降级 ===
    degraded: bool = False

    # 注：合并 agent 后已移除 pending_draw_specs / selected_resource_memories。
    # 绘图参数就是 chat_agent 本轮直接产出的 output.draw_specs，不再有委派沉淀。

    # === 调试上下文 ===
    # 记录本轮各模型实际收到的输入。只用于 HTTP debug 返回，不参与模型上下文。
    debug_context: bool = False
    debug_contexts: list[dict[str, Any]] = field(default_factory=list)

    async def emit(self, event: SseEvent) -> None:
        """SSE 事件便捷发射（非 SSE 上下文下静默忽略）"""
        if self.sse_emitter is not None:
            try:
                await self.sse_emitter(event)
            except Exception:
                # SSE 通道断开不应中断 agent 主流程
                pass
