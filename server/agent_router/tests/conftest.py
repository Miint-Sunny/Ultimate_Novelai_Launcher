"""
pytest 公共 fixture & 路径配置。

让测试可以从仓库根目录直接跑：
    cd <repo> && pytest novelai_web_ui/server/agent_router/tests
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# 把 server 目录加入 sys.path，这样 `from agent_router...` 与 `from config import ...` 都能 import
_THIS_DIR = Path(__file__).resolve().parent
_SERVER_DIR = _THIS_DIR.parents[1]
_PROJECT_ROOT = _SERVER_DIR.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))
if str(_SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(_SERVER_DIR))


# 测试用合并预设模板（chat 行为段 + planner 知识段，单文件 prompts.yaml）
def _merged_yaml(persona_text: str) -> str:
    return (
        "chat:\n"
        f"  persona: |\n    {persona_text}\n"
        "  workflow: |\n"
        "    工作流测试段\n"
        "  tools_hint: |\n"
        "    工具提示测试段\n"
        "  reply_rules: |\n"
        "    回复规则测试段\n"
        "\n"
        "planner:\n"
        "  system_prompts:\n"
        "    - role: user\n"
        '      content: "{random_string}"\n'
        "    - role: system\n"
        "      content: 你是绘图助手\n"
    )


@pytest.fixture
def tmp_data_dir(tmp_path, monkeypatch):
    """
    给测试一个干净的 data 目录，含合并后的单文件预设 prompts.yaml。
    tier 已移除，loader 只读这一份 prompts.yaml。
    通过 monkeypatch 让 prompts._data_dir() 返回该目录。

    （prompts_assist.yaml / prompts_create.yaml 是合并前的两套预设，已并入 prompts.yaml；
      prompts_web.yaml / prompts_assist_claude.yaml 更早下线，loader 不再加载）
    """
    data_dir = tmp_path / "data"
    data_dir.mkdir()

    (data_dir / "prompts.yaml").write_text(
        _merged_yaml("测试合并猫娘"),
        encoding="utf-8",
    )

    # 让 prompts._data_dir() 指向这里
    from agent_router import prompts as p

    monkeypatch.setattr(p, "_data_dir", lambda: data_dir)
    # 清除 lru_cache，避免不同测试串扰（被缓存的是 _load_yaml_cached，不是 _load_yaml）
    p._load_yaml_cached.cache_clear()

    return data_dir
