"""Host inpaint strength reaches NovelAI in the shape the server actually reads.

真链路实测(2026-09-20,V5 Full,同图同蒙版同 seed):infill 请求里平铺的 ``strength``
与 ``inpaintImg2ImgStrength`` 改成 0.2 或 0.95 出图逐像素相同;只有嵌套的
``img2img: {strength, color_correct}`` 才让蒙版区随强度变化。宿主的两条 infill 路径
(bot 参数转换、流式生成)都要发这个形状。NovelAI 用假 session 截住载荷,不打真接口。
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

    app_spec = importlib.util.spec_from_file_location("legacy_inpaint_app", SERVER / "app.py")
    assert app_spec and app_spec.loader
    module = importlib.util.module_from_spec(app_spec)
    sys.modules["legacy_inpaint_app"] = module
    app_spec.loader.exec_module(module)
    yield module

    sys.modules.pop("legacy_inpaint_app", None)
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
    legacy_app: ModuleType, monkeypatch: pytest.MonkeyPatch, params: dict[str, Any]
) -> dict[str, Any]:
    captured = _capture_nai_payload(legacy_app, monkeypatch)
    with pytest.raises(_Captured):
        await legacy_app.generate_novelai_image_stream(params, token=NAI_BEARER)
    return captured["json"]


def _web_params(strength: float | None) -> dict[str, Any]:
    inpaint: dict[str, Any] = {"imageBase64": "aW1hZ2U=", "maskBase64": "bWFzaw=="}
    if strength is not None:
        inpaint["strength"] = strength
    return {
        "positivePrompt": "1girl",
        "negativePrompt": "lowres",
        "model": "v4.5-full",
        "width": 832,
        "height": 1216,
        "steps": 28,
        "scale": 5,
        "sampler": "k_euler_ancestral",
        "inpaint": inpaint,
    }


def test_bot_conversion_sends_the_nested_strength_the_server_reads(legacy_app: ModuleType) -> None:
    params = legacy_app.convert_web_params_to_stream(_web_params(0.4))

    assert params["action"] == "infill"
    assert params["model"].endswith("-inpainting")
    assert params["mask"] == "bWFzaw=="
    assert params["inpaintImg2ImgStrength"] == 0.4
    assert params["img2img"] == {"strength": 0.4, "color_correct": True}
    # The flat field stays for the historical shape; the server ignores it.
    assert params["strength"] == 0.4


def test_full_strength_sends_no_nested_object(legacy_app: ModuleType) -> None:
    params = legacy_app.convert_web_params_to_stream(_web_params(1))

    assert params["inpaintImg2ImgStrength"] == 1.0
    assert "img2img" not in params


def test_missing_strength_keeps_the_historical_default(legacy_app: ModuleType) -> None:
    params = legacy_app.convert_web_params_to_stream(_web_params(None))

    assert params["strength"] == 0.7
    assert params["inpaintImg2ImgStrength"] == 0.7
    assert params["img2img"] == {"strength": 0.7, "color_correct": True}


@pytest.mark.parametrize(
    ("raw", "expected", "nested"),
    [(1.5, 1.0, False), (-0.2, 0.0, True), ("0.25", 0.25, True), ("junk", 0.7, True)],
)
def test_strength_is_clamped_and_coerced(
    legacy_app: ModuleType, raw: Any, expected: float, nested: bool
) -> None:
    parameters: dict[str, Any] = {"img2img": {"strength": 0.9, "color_correct": True}}

    legacy_app._apply_inpaint_strength(parameters, raw)

    assert parameters["inpaintImg2ImgStrength"] == expected
    if nested:
        assert parameters["img2img"] == {"strength": expected, "color_correct": True}
    else:
        assert "img2img" not in parameters


async def test_stream_path_carries_the_nested_strength(
    legacy_app: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    params = legacy_app.convert_web_params_to_stream(_web_params(0.35))

    payload = await _payload(legacy_app, monkeypatch, params)

    assert payload["action"] == "infill"
    parameters = payload["parameters"]
    assert parameters["mask"] == "bWFzaw=="
    assert parameters["add_original_image"] is True
    assert parameters["inpaintImg2ImgStrength"] == 0.35
    assert parameters["img2img"] == {"strength": 0.35, "color_correct": True}


async def test_stream_path_at_full_strength_drops_the_nested_object(
    legacy_app: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    params = legacy_app.convert_web_params_to_stream(_web_params(1))

    payload = await _payload(legacy_app, monkeypatch, params)

    assert payload["parameters"]["inpaintImg2ImgStrength"] == 1.0
    assert "img2img" not in payload["parameters"]
