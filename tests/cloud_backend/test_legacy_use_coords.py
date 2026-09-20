"""Host ``use_coords`` follows the client or the character coordinates (board #12).

官方模型里 ``use_coords`` 是整张图一个的全局二选一(AI's Choice / Custom),默认 false。
宿主以前在 ``generate_novelai_image_stream`` 的两处硬写 True,客户端说「交给 AI」也会
被拧回坐标模式。下面四条回归对应题面 (a)–(d),外加直接调流式生成函数的兜底推导。
NovelAI 用假 session 截住载荷,不打真接口。
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
# A bearer for the fake session; nothing here ever reaches NovelAI.
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

    app_spec = importlib.util.spec_from_file_location("legacy_use_coords_app", SERVER / "app.py")
    assert app_spec and app_spec.loader
    module = importlib.util.module_from_spec(app_spec)
    sys.modules["legacy_use_coords_app"] = module
    app_spec.loader.exec_module(module)
    yield module

    sys.modules.pop("legacy_use_coords_app", None)
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


async def _payload_parameters(
    legacy_app: ModuleType, monkeypatch: pytest.MonkeyPatch, params: dict[str, Any]
) -> dict[str, Any]:
    captured = _capture_nai_payload(legacy_app, monkeypatch)
    with pytest.raises(_Captured):
        await legacy_app.generate_novelai_image_stream(params, token=NAI_BEARER)
    assert captured["url"].endswith("/ai/generate-image-stream")
    return captured["json"]["parameters"]


def _web_params(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "positivePrompt": "1girl",
        "negativePrompt": "lowres",
        "model": "v4.5-full",
        "width": 832,
        "height": 1216,
        "steps": 28,
        "scale": 5,
        "sampler": "k_euler_ancestral",
    }
    base.update(overrides)
    return base


AUTO_CHARACTERS = [
    {"positive": "girl A", "negative": "", "enabled": True},
    {"positive": "girl B", "negative": "", "enabled": True},
]


def _assert_both_sites(parameters: dict[str, Any], expected: bool) -> None:
    assert parameters["use_coords"] is expected
    assert parameters["v4_prompt"]["use_coords"] is expected
    assert parameters["v4_prompt"]["use_order"] is True
    # 与客户端和官方载荷一致:负向侧只有 caption + legacy_uc,没有自己的开关。
    assert "use_coords" not in parameters["v4_negative_prompt"]


async def test_a_client_false_with_auto_characters_stays_false(
    legacy_app: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    params = legacy_app.convert_web_params_to_stream(
        _web_params(useCoords=False, characterPrompts=AUTO_CHARACTERS)
    )
    assert params["use_coords"] is False

    parameters = await _payload_parameters(legacy_app, monkeypatch, params)

    _assert_both_sites(parameters, False)
    assert len(parameters["v4_prompt"]["caption"]["char_captions"]) == 2


async def test_b_client_true_is_honoured(
    legacy_app: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    params = legacy_app.convert_web_params_to_stream(
        _web_params(useCoords=True, characterPrompts=AUTO_CHARACTERS)
    )
    assert params["use_coords"] is True

    parameters = await _payload_parameters(legacy_app, monkeypatch, params)

    _assert_both_sites(parameters, True)


async def test_c_positioned_characters_turn_coords_on_without_a_client_flag(
    legacy_app: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    characters = [
        {
            "positive": "girl A",
            "negative": "bad hands",
            "enabled": True,
            "center": {"x": 0.2, "y": 0.8},
        },
        {"positive": "girl B", "negative": "", "enabled": True, "position": "B2"},
        {"positive": "girl C", "negative": "", "enabled": True},
    ]
    params = legacy_app.convert_web_params_to_stream(_web_params(characterPrompts=characters))

    assert params["use_coords"] is True
    centers = [cp["center"] for cp in params["character_prompts"]]
    # 显式 center 原样、旧网格照旧映射、自动的仍用兜底布局:坐标取值没变。
    assert centers[0] == {"x": 0.2, "y": 0.8}
    assert centers[1] == {"x": 0.3, "y": 0.3}
    assert centers[2] == {"x": 0.5, "y": 0.3}

    parameters = await _payload_parameters(legacy_app, monkeypatch, params)

    _assert_both_sites(parameters, True)
    negative = parameters["v4_negative_prompt"]["caption"]["char_captions"]
    # 负向与正向**逐个对应**,没写的补空串:NovelAI 对不等长整单 400,而且不等长时
    # 剩下那条还会按下标错配。这里三个角色只有第一个写了负向,所以是一条 + 两条空串,
    # 每条的 centers 跟着自己的角色。详见 test_legacy_character_negatives.py。
    assert negative == [
        {"char_caption": "bad hands", "centers": [{"x": 0.2, "y": 0.8}]},
        {"char_caption": "", "centers": [{"x": 0.3, "y": 0.3}]},
        {"char_caption": "", "centers": [{"x": 0.5, "y": 0.3}]},
    ]


async def test_d_auto_characters_without_a_client_flag_stay_off(
    legacy_app: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    params = legacy_app.convert_web_params_to_stream(_web_params(characterPrompts=AUTO_CHARACTERS))

    # 自动布局的兜底坐标照发(NAI 在 use_coords:false 时忽略它们),但开关是关的。
    assert params["use_coords"] is False
    assert params["character_prompts"][0]["center"] == {"x": 0.3, "y": 0.5}

    parameters = await _payload_parameters(legacy_app, monkeypatch, params)

    _assert_both_sites(parameters, False)


async def test_direct_stream_params_derive_from_centers_unless_the_client_decided(
    legacy_app: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Raw Bot callers hand stream params straight in: no flag, no centers -> off.
    plain = await _payload_parameters(
        legacy_app,
        monkeypatch,
        {"input_text1": "1girl", "character_prompts": [{"prompt": "a", "uc": "", "enabled": True}]},
    )
    _assert_both_sites(plain, False)
    assert plain["v4_prompt"]["caption"]["char_captions"][0]["centers"] == [{"x": 0.5, "y": 0.5}]

    placed = await _payload_parameters(
        legacy_app,
        monkeypatch,
        {
            "input_text1": "1girl",
            "character_prompts": [
                {"prompt": "a", "uc": "", "enabled": True, "center": {"x": 0.1, "y": 0.9}}
            ],
        },
    )
    _assert_both_sites(placed, True)

    nested_flag = await _payload_parameters(
        legacy_app, monkeypatch, {"input_text1": "1girl", "v4_prompt": {"use_coords": True}}
    )
    _assert_both_sites(nested_flag, True)

    client_wins = await _payload_parameters(
        legacy_app,
        monkeypatch,
        {
            "input_text1": "1girl",
            "use_coords": False,
            "character_prompts": [
                {"prompt": "a", "uc": "", "enabled": True, "center": {"x": 0.1, "y": 0.9}}
            ],
        },
    )
    _assert_both_sites(client_wins, False)
