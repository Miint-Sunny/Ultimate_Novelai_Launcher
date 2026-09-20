"""负向角色提示词必须与正向逐个对应,否则 NovelAI 整单 400。

原话:"V4 positive and negative character prompts must have the same length."
宿主原来只给**写了负向**的角色追加一条,于是三个角色里只有第二个写了负向时
正向 3 条、负向 1 条:要么整单失败,要么那条负向按下标错配到第一个角色头上
——后者更糟,因为它不报错。

规则很简单:**每个进载荷的角色都发一条负向,没写的发空串**。空串与"整个列表为空"
在真链路上等价——同种子对照,两种形状的结果图逐像素完全相同(平均差 0.0000、最大差 0),
所以不留特例,三条发送路径(桌面前端 / 宿主 / Plana 上游)同一条规则。

上游一律 fake,不打真接口。
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / "server"
NAI_BEARER = "unit-test-bearer"


@pytest.fixture(scope="module")
def legacy_app() -> ModuleType:
    previous_config = sys.modules.get("config")
    sys.path.insert(0, str(SERVER))
    config_spec = importlib.util.spec_from_file_location("config", SERVER / "config.example.py")
    assert config_spec and config_spec.loader
    config = importlib.util.module_from_spec(config_spec)
    sys.modules["config"] = config
    config_spec.loader.exec_module(config)
    config.JOB_CAPABILITY_SECRET = bytes(range(32))

    app_spec = importlib.util.spec_from_file_location("legacy_char_neg_app", SERVER / "app.py")
    assert app_spec and app_spec.loader
    module = importlib.util.module_from_spec(app_spec)
    sys.modules["legacy_char_neg_app"] = module
    app_spec.loader.exec_module(module)
    yield module

    sys.modules.pop("legacy_char_neg_app", None)
    if previous_config is None:
        sys.modules.pop("config", None)
    else:
        sys.modules["config"] = previous_config


class _Captured(Exception):
    """Raised by the fake NovelAI session once the payload has been recorded."""


def _capture_nai_payload(legacy_app: ModuleType, monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    captured: dict[str, Any] = {}

    class _Stream:
        def __init__(self, json: Any) -> None:
            self._json = json

        async def __aenter__(self) -> Any:
            captured["json"] = self._json
            raise _Captured()

        async def __aexit__(self, *_: object) -> bool:
            return False

    class _Client:
        def stream(self, method: str, url: str, **kwargs: Any) -> _Stream:
            captured["method"] = method
            captured["url"] = url
            return _Stream(kwargs.get("json"))

    monkeypatch.setattr(legacy_app, "_get_nai_session", lambda: _Client())
    return captured


async def _payload(
    legacy_app: ModuleType, monkeypatch: pytest.MonkeyPatch, characters: list[dict[str, Any]]
) -> dict[str, Any]:
    captured = _capture_nai_payload(legacy_app, monkeypatch)
    params = {
        "input_text1": "2girls",
        "input_text2": "lowres",
        "model": "nai-diffusion-5-full",
        "width": 832,
        "height": 1216,
        "steps": 23,
        "scale": 5,
        "sampler": "k_euler_ancestral",
        "character_prompts": characters,
    }
    with pytest.raises(_Captured):
        await legacy_app.generate_novelai_image_stream(params, token=NAI_BEARER)
    return captured["json"]


def _character(prompt: str, uc: str | None = None, x: float = 0.5) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "enabled": True,
        "prompt": prompt,
        "center": {"x": x, "y": 0.5},
    }
    if uc is not None:
        entry["uc"] = uc
    return entry


def _captions(payload: dict[str, Any]) -> tuple[list[Any], list[Any]]:
    parameters = payload["parameters"]
    return (
        parameters["v4_prompt"]["caption"]["char_captions"],
        parameters["v4_negative_prompt"]["caption"]["char_captions"],
    )


@pytest.mark.asyncio
async def test_partial_negatives_are_padded_to_the_same_length(
    legacy_app: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    payload = await _payload(
        legacy_app,
        monkeypatch,
        [
            _character("1girl, red dress", x=0.25),
            _character("1girl, blue dress", uc="blurry", x=0.5),
            _character("1girl, green dress", x=0.75),
        ],
    )
    positive, negative = _captions(payload)

    assert len(positive) == 3
    # 这条是整个修复的核心:不等长会被 NovelAI 整单拒掉。
    assert len(negative) == len(positive)
    # 补位是空串,而且**下标对得上**——写了负向的是第二个,不是第一个。
    assert [entry["char_caption"] for entry in negative] == ["", "blurry", ""]
    # 每条负向的坐标跟着它自己的角色走,不是都挂在第一个身上。
    assert [entry["centers"] for entry in negative] == [
        [{"x": 0.25, "y": 0.5}],
        [{"x": 0.5, "y": 0.5}],
        [{"x": 0.75, "y": 0.5}],
    ]


@pytest.mark.asyncio
async def test_nobody_wrote_a_negative_still_sends_equal_length_blanks(
    legacy_app: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    payload = await _payload(
        legacy_app,
        monkeypatch,
        [_character("1girl, red dress", x=0.25), _character("1girl, blue dress", x=0.75)],
    )
    positive, negative = _captions(payload)

    assert len(positive) == 2
    # 等长照旧成立;空串与空列表真链路等价(同种子逐像素相同),所以不留特例。
    assert [entry["char_caption"] for entry in negative] == ["", ""]


@pytest.mark.asyncio
async def test_explicit_empty_strings_behave_like_unset(
    legacy_app: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    payload = await _payload(
        legacy_app,
        monkeypatch,
        [_character("1girl, red dress", uc=""), _character("1girl, blue dress", uc="")],
    )
    positive, negative = _captions(payload)

    assert len(negative) == len(positive) == 2
    assert [entry["char_caption"] for entry in negative] == ["", ""]


@pytest.mark.asyncio
async def test_disabled_and_blank_characters_drop_from_both_lists(
    legacy_app: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    payload = await _payload(
        legacy_app,
        monkeypatch,
        [
            _character("1girl, red dress", uc="blurry", x=0.25),
            {"enabled": False, "prompt": "1girl, ignored", "uc": "ignored-uc"},
            {"enabled": True, "prompt": "", "uc": "also-ignored"},
            _character("1girl, blue dress", x=0.75),
        ],
    )
    positive, negative = _captions(payload)

    # 停用的和正向为空的两条都不进载荷,两侧同时少掉,长度仍然相等。
    assert len(positive) == 2
    assert len(negative) == 2
    assert [entry["char_caption"] for entry in negative] == ["blurry", ""]


@pytest.mark.asyncio
async def test_web_params_path_feeds_the_same_builder(
    legacy_app: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    """bot / web 参数转换那条路也要等长——它最终汇进同一个构造处。"""
    stream_params = legacy_app.convert_web_params_to_stream(
        {
            "positivePrompt": "2girls",
            "negativePrompt": "lowres",
            "model": "v5-full",
            "width": 832,
            "height": 1216,
            "steps": 23,
            "scale": 5,
            "sampler": "k_euler_ancestral",
            "characterPrompts": [
                {"enabled": True, "positive": "1girl, red dress", "negative": ""},
                {"enabled": True, "positive": "1girl, blue dress", "negative": "blurry"},
            ],
        }
    )

    captured = _capture_nai_payload(legacy_app, monkeypatch)
    with pytest.raises(_Captured):
        await legacy_app.generate_novelai_image_stream(stream_params, token=NAI_BEARER)
    positive, negative = _captions(captured["json"])

    assert len(negative) == len(positive) == 2
    assert [entry["char_caption"] for entry in negative] == ["", "blurry"]
