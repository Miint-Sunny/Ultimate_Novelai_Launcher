"""
PydanticAI 统一 Agent 路由组（/api/agent/*）

将 Bot 端与 Web 端 AI 对话/绘图规划逻辑统一收敛到此模块。

公共入口（lazy import）:
    from agent_router.router import router
    app.include_router(router)

为什么不在 __init__.py 直接 re-export router:
    router.py 加载会触发 PydanticAI Agent 实例创建（需要 OpenAI / CLI Proxy 配置）。
    把它放到子模块按需 import，便于单测时只加载 schemas / prompts / history_adapter
    等纯净模块，而不强制要求 pydantic-ai 可用。

内部结构:
    schemas.py           - 所有 pydantic 模型
    deps.py              - AgentDeps 运行时上下文
    prompts.py           - 加载 data/prompts_*.{json,yaml}
    model_provider.py    - CLI Proxy OpenAI 兼容 Model 工厂
    history_adapter.py   - JSON ↔ ModelMessage 互转
    sse.py               - SSE 事件编组
    agents/              - 4 个 agent
    tools/               - @agent.tool 注册
    router.py            - FastAPI endpoints
"""

# 不在此处导入 router；调用方使用 `from agent_router.router import router`
__all__: list[str] = []
