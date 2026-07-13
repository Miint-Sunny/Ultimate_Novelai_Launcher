"""
history_adapter.py 测试 —— round-trip 与图片裁剪策略。

底层已由 pydantic_ai 换成自研 agent_router.llm，本测试不再依赖 pydantic-ai。
"""

from __future__ import annotations

import pytest  # noqa: F401  (保留以兼容可能的 fixture/mark 用法)


def _make_text_msg(role: str, text: str) -> dict:
    return {"role": role, "content": text}


def _make_image_msg(role: str, text: str, b64_data: str, is_generated: bool = False) -> dict:
    msg = {
        "role": role,
        "content": [
            {"text": text},
            {"inline_data": {"mime_type": "image/png", "data": b64_data}},
        ],
    }
    if is_generated:
        msg["_is_generated_image"] = True
    return msg


def test_pure_text_round_trip():
    from agent_router.history_adapter import from_model_messages, to_model_messages

    history = [
        _make_text_msg("user", "你好"),
        _make_text_msg("assistant", "你好喵~"),
        _make_text_msg("user", "画一张芙兰朵露"),
    ]
    msgs = to_model_messages(history, trim=False)
    assert len(msgs) == 3

    back = from_model_messages(msgs)
    # role 应该被正确还原
    assert [m["role"] for m in back] == ["user", "assistant", "user"]
    # content 应该是字符串（纯文本）
    assert back[0]["content"] == "你好"
    assert back[1]["content"] == "你好喵~"
    assert back[2]["content"] == "画一张芙兰朵露"


def test_user_image_max_3_strategy():
    from agent_router.history_adapter import trim_history_images

    # 模拟 base64
    b64 = "iVBORw0KGgo="  # 极短的占位

    history = [_make_image_msg("user", f"用户图{i}", b64) for i in range(5)]
    trimmed = trim_history_images(history)

    # 5 条都还在（条目数量不变）
    assert len(trimmed) == 5

    # 最新 3 条保留图片，最早 2 条剥离图片
    def has_image(entry):
        c = entry.get("content")
        return isinstance(c, list) and any(isinstance(x, dict) and "inline_data" in x for x in c)

    images_kept = [has_image(e) for e in trimmed]
    # 旧的不留，新的 3 张留
    assert images_kept == [False, False, True, True, True]


def test_generated_image_body_is_not_kept():
    from agent_router.history_adapter import trim_history_images

    b64 = "iVBORw0KGgo="
    history = [
        _make_image_msg("assistant", "old gen 1", b64, is_generated=True),
        _make_text_msg("user", "再来一张"),
        _make_image_msg("assistant", "old gen 2", b64, is_generated=True),
        _make_text_msg("user", "继续"),
        _make_image_msg("assistant", "newest gen", b64, is_generated=True),
    ]
    trimmed = trim_history_images(history)

    def has_image(entry):
        c = entry.get("content")
        return isinstance(c, list) and any(isinstance(x, dict) and "inline_data" in x for x in c)

    # 生成图不再保留图片本体，只保留文字参数
    img_flags = [has_image(e) for e in trimmed]
    assert img_flags == [False, False, False, False, False]
    assert trimmed[-1]["content"] == [{"text": "newest gen"}]


def test_text_and_image_in_user_msg():
    from agent_router.history_adapter import from_model_messages, to_model_messages

    b64 = "iVBORw0KGgo="
    history = [
        _make_image_msg("user", "看这张图", b64),
    ]
    msgs = to_model_messages(history, trim=False)
    assert len(msgs) == 1

    # 反向转回
    back = from_model_messages(msgs)
    assert len(back) == 1
    assert back[0]["role"] == "user"
    # 应该是 list[{text}, {inline_data}]
    assert isinstance(back[0]["content"], list)
    has_text = any("text" in x for x in back[0]["content"] if isinstance(x, dict))
    has_img = any("inline_data" in x for x in back[0]["content"] if isinstance(x, dict))
    assert has_text and has_img


def test_from_model_messages_strips_runtime_environment_info():
    from agent_router.history_adapter import from_model_messages
    from agent_router.llm.messages import ModelRequest, UserPromptPart

    messages = [
        ModelRequest(
            parts=[
                UserPromptPart(
                    content=[
                        "-↓用户消息内容↓-\n画若叶睦",
                        "[环境信息]\n[预查询资源]\n## search_character 结果\nleaf_(pokemon)",
                    ]
                )
            ]
        )
    ]

    back = from_model_messages(messages)

    assert len(back) == 1
    assert "画若叶睦" in back[0]["content"]
    assert "[环境信息]" not in back[0]["content"]
    assert "[预查询资源]" not in back[0]["content"]
    assert "leaf_(pokemon)" not in back[0]["content"]


def test_to_model_messages_strips_legacy_runtime_environment_info():
    from agent_router.history_adapter import from_model_messages, to_model_messages

    history = [
        {
            "role": "user",
            "content": [
                {"text": "-↓用户消息内容↓-\n画若叶睦\n[环境信息]\n[预查询资源]\nleaf_(pokemon)"},
            ],
        }
    ]

    messages = to_model_messages(history, trim=False)
    back = from_model_messages(messages)

    assert len(back) == 1
    assert "画若叶睦" in back[0]["content"]
    assert "[环境信息]" not in back[0]["content"]
    assert "leaf_(pokemon)" not in back[0]["content"]


def test_append_to_history_accepts_filtered_resource_memory():
    import asyncio

    from agent_router.history_adapter import (
        append_to_history,
        clear_history,
        from_model_messages,
        load_history_for_agent,
        to_model_messages,
    )

    async def run():
        user_key = "qq_g_filtered_memory"
        await clear_history(user_key, persistent=False)

        new_messages = to_model_messages(
            [{"role": "user", "content": "继续这个角色"}],
            trim=False,
        )
        await append_to_history(
            user_key,
            new_messages,
            persistent=False,
            extra_entries=[
                {
                    "role": "assistant",
                    "content": "[chat_agent 筛选资料记忆]\n角色: wakaba_mutsumi (bang_dream!)",
                }
            ],
        )

        loaded = await load_history_for_agent(user_key, persistent=False)
        back = from_model_messages(loaded)
        joined = "\n".join(str(m.get("content", "")) for m in back)

        assert "继续这个角色" in joined
        assert "wakaba_mutsumi" in joined
        assert "[预查询资源]" not in joined

    asyncio.run(run())


def test_filtered_resource_memory_is_single_slot():
    import asyncio

    from agent_router.history_adapter import (
        append_to_history,
        clear_history,
        from_model_messages,
        load_history_for_agent,
        to_model_messages,
    )

    async def run():
        user_key = "qq_g_filtered_memory_single"
        await clear_history(user_key, persistent=False)

        await append_to_history(
            user_key,
            to_model_messages([{"role": "user", "content": "画 A"}], trim=False),
            persistent=False,
            extra_entries=[
                {
                    "role": "assistant",
                    "content": "[chat_agent 筛选资料记忆]\n角色: old_character",
                }
            ],
        )
        await append_to_history(
            user_key,
            to_model_messages([{"role": "user", "content": "画 B"}], trim=False),
            persistent=False,
            extra_entries=[
                {
                    "role": "assistant",
                    "content": "[chat_agent 筛选资料记忆]\n角色: new_character",
                }
            ],
        )

        loaded = await load_history_for_agent(user_key, persistent=False)
        joined = "\n".join(str(m.get("content", "")) for m in from_model_messages(loaded))

        assert "new_character" in joined
        assert "old_character" not in joined

    asyncio.run(run())


def test_filtered_resource_memory_expires_without_relay():
    import asyncio

    from agent_router.history_adapter import (
        append_to_history,
        clear_history,
        from_model_messages,
        load_history_for_agent,
        to_model_messages,
    )

    async def run():
        user_key = "qq_g_filtered_memory_expire"
        await clear_history(user_key, persistent=False)

        await append_to_history(
            user_key,
            to_model_messages([{"role": "user", "content": "画 A"}], trim=False),
            persistent=False,
            extra_entries=[
                {
                    "role": "assistant",
                    "content": "[chat_agent 筛选资料记忆]\n角色: old_character",
                }
            ],
        )
        await append_to_history(
            user_key,
            to_model_messages([{"role": "user", "content": "换话题"}], trim=False),
            persistent=False,
        )

        loaded = await load_history_for_agent(user_key, persistent=False)
        joined = "\n".join(str(m.get("content", "")) for m in from_model_messages(loaded))

        assert "换话题" in joined
        assert "old_character" not in joined

    asyncio.run(run())


def test_private_history_uses_sliding_window(tmp_path, monkeypatch):
    import asyncio

    from agent_router import history_adapter as h
    from agent_router.history_adapter import (
        append_to_history,
        from_model_messages,
        load_history_for_agent,
        to_model_messages,
    )

    history_file = tmp_path / "user_chat_history.json"
    monkeypatch.setattr(h, "_history_file_path", lambda: history_file)
    monkeypatch.setattr(h, "HISTORY_BUDGET_TOKENS", 8)

    async def run():
        user_key = "qq_p_sliding"
        msgs = to_model_messages(
            [
                {"role": "user", "content": "第一条很长很长"},
                {"role": "assistant", "content": "第二条也很长"},
                {"role": "user", "content": "最新"},
            ],
            trim=False,
        )
        await append_to_history(user_key, msgs, persistent=True)

        loaded = await load_history_for_agent(user_key, persistent=True)
        back = from_model_messages(loaded)
        joined = "\n".join(str(m.get("content", "")) for m in back)

        assert "最新" in joined
        assert "第一条很长很长" not in joined
        assert "早期对话摘要" not in joined

    asyncio.run(run())


def test_group_memory_history_round_trip():
    import asyncio

    from agent_router.history_adapter import (
        append_to_history,
        clear_history,
        from_model_messages,
        load_history_for_agent,
        to_model_messages,
    )

    async def run():
        user_key = "qq_g_999"
        await clear_history(user_key, persistent=False)

        new_messages = to_model_messages(
            [
                _make_text_msg("user", "第一轮"),
                _make_text_msg("assistant", "记住了"),
            ],
            trim=False,
        )
        await append_to_history(user_key, new_messages, persistent=False)

        loaded = await load_history_for_agent(user_key, persistent=False)
        back = from_model_messages(loaded)
        assert [m["role"] for m in back] == ["user", "assistant"]
        assert back[0]["content"] == "第一轮"
        assert back[1]["content"] == "记住了"

        assert await clear_history(user_key, persistent=False) is True
        assert await load_history_for_agent(user_key, persistent=False) == []

    asyncio.run(run())
