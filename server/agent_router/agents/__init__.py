"""
Agent 实例集合（底层框架已由 pydantic_ai 换成自研 ..llm）。

当前活跃 agent —— 均按需从各自子模块直接 import（不在此 re-export，避免导入本包即触发建模型）：
    lite_chat.py    → lite_chat_agent / run_lite_chat   前置 Lite：回复 + 意图判断 + 资料筛选三合一
    pure_planner.py → pure_planner_agent                 单职责绘图 planner，产 DrawSpec

已删除（死代码，生产 /chat、/web 流程不经过）：
    chat.py      → 旧合并 chat_agent / chat_agent_prompted（流程已改 lite + planner 两阶段）
    prefilter.py → 旧前置筛选 agent（被 lite_chat 取代）
    draw_planner / vision / web_prompt agent —— 更早下线
"""
__all__: list[str] = []
