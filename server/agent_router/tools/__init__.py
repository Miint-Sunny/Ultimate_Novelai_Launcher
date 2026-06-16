"""
@agent.tool 注册集合。

只剩 1 个 tool 注册器:
    knowledge.py → register_knowledge_tools(agent)  # 知识库搜索 4 个工具
                   （search_character / search_artist / random_artist / search_danbooru）

已删除:
    delegate.py / register_delegate_tools — chat 与 planner 合并为单 agent 后，
        绘图参数由 chat_agent 直接写进 draw_specs，不再需要 delegate_to_planner 委派。
    translate_tag — 模型自己能做中英翻译，外部工具反而拖慢且依赖本机翻译服务。
    delegate_to_vision — vision_agent 移除后不再需要。
"""
from .knowledge import register_knowledge_tools

__all__ = [
    "register_knowledge_tools",
]
