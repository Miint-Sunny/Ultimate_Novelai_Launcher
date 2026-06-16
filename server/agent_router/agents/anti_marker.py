"""
防标记（anti-fingerprint）噪声生成器。

源自 SillyTavern 'Semini Sparkle' 预设里的「防标记」prompt，
原文用 {{random::a,b,c,...}}{{roll 1d999999}} 宏拼接，每次发送前替换成随机字符串，
让上游（Google AI Studio / Vertex / OpenRouter 等）的指纹/限流系统看到每次内容都不同，
无法把同一用户的多次请求"指纹关联"起来。

预设作者备注「aistudio接口下放至系统设定之下」—— 即对 aistudio 接口要从对话深度位置
移到 system_prompt 段。我们 PydanticAI 直连 Vertex/OpenAI 接口，统一作为 system_prompt
末段注入（每次请求构造新噪声）。

默认启用；env `CPA_ENABLE_ANTI_MARKER=false` 可关闭。
"""
from __future__ import annotations

import os
import random


def is_anti_marker_enabled() -> bool:
    val = os.environ.get("CPA_ENABLE_ANTI_MARKER", "").strip().lower()
    if val in ("0", "false", "no", "off"):
        return False
    return True   # 默认启用


# 字符池跟原预设保持一致：a-q（17 个字母）
_CHAR_POOL = "abcdefghijklmnopq"

# 噪声段数（接近原预设 24-30 个 token 的混合）
_BLOCK_COUNT = 26


def make_anti_marker_noise() -> str:
    """
    生成一次防标记噪声段。enabled by env → 真噪声，否则返回空字符串。

    格式跟原预设一致：`meaningless test: <随机字符 + 数字混合>\n\n[对话已重置]`。
    每次调用生成新随机数据。
    """
    if not is_anti_marker_enabled():
        return ""
    blocks: list[str] = []
    for _ in range(_BLOCK_COUNT):
        # 6 成概率出字符，4 成出数字（接近原预设的 random:: vs roll 1d999999 比例）
        if random.random() < 0.6:
            blocks.append(random.choice(_CHAR_POOL))
        else:
            blocks.append(str(random.randint(1, 999_999)))
    noise = "".join(blocks)
    return f"meaningless test: {noise}\n\n[对话已重置]"
