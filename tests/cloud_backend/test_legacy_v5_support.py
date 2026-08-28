"""V5 支持在 legacy 云端主机上的计费与载荷形状。

单独成文件而不是并进 test_legacy_server_integration.py：这里全是纯函数断言，
不需要那份文件的 ASGI / SQLite / 配对夹具，跑起来是毫秒级的。

为什么值得测：V5 的两条差异都属于「不抛异常、只是数字或形状悄悄错了」——
计费漏乘 1.5 会让主机每张 V5 少收三分之一；载荷形状错了 NAI 也照样出图，
只是角色站错位置。两者都不会有任何报错把它们暴露出来。
"""

from __future__ import annotations

import importlib.util
import math
import sys
from pathlib import Path
from types import ModuleType

import pytest

ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / "server"


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

    app_spec = importlib.util.spec_from_file_location("legacy_v5_app", SERVER / "app.py")
    assert app_spec and app_spec.loader
    module = importlib.util.module_from_spec(app_spec)
    sys.modules["legacy_v5_app"] = module
    app_spec.loader.exec_module(module)
    yield module

    sys.modules.pop("legacy_v5_app", None)
    if previous_config is None:
        sys.modules.pop("config", None)
    else:
        sys.modules["config"] = previous_config


NORMAL = {"width": 832, "height": 1216, "steps": 28}


def test_v5_family_detection(legacy_app: ModuleType) -> None:
    for model in (
        "nai-diffusion-5-full",
        "nai-diffusion-5-curated",
        "nai-diffusion-5-full-inpainting",
        "custom",
    ):
        assert legacy_app._is_v5_model(model), model
    for model in ("nai-diffusion-4-5-full", "nai-diffusion-3", "stable-diffusion-xl"):
        assert not legacy_app._is_v5_model(model), model


def test_v5_costs_one_and_a_half_times_v45(legacy_app: ModuleType) -> None:
    # 实测锚点：2026-08-28 用真实账号在 832×1216 / 28 步生成一张 V5 Full，
    # 余额掉了 30 Anlas。同规格 V4.5 是 20。
    #
    # 这里用大于免费阈值的尺寸，好让免费判定不把价盖成 0。
    big = {"width": 1216, "height": 1216, "steps": 28}
    v45 = legacy_app.calculate_anlas_cost(model="nai-diffusion-4-5-full", **big)
    v5 = legacy_app.calculate_anlas_cost(model="nai-diffusion-5-full", **big)

    # 逐字复现官方的双重取整：基数先 ceil，乘 1.5 后再 ceil 一次。
    # 写成 ceil(base * 1.5) 而不是 ceil(公式 * 1.5)，两者在不少尺寸上差 1 点。
    base = max(math.ceil(5.773e-7 * big["width"] * big["height"] * (big["steps"] + 5)), 2)
    assert v45 == base
    assert v5 == max(math.ceil(base * 1.5), 2)


def test_v5_free_tier_flips_when_opus_bar_is_empty(legacy_app: ModuleType) -> None:
    # 体力条耗尽后 NAI 不报错、不返回 402，就是照生成、照扣 Anlas。主机若还按
    # 「免费」记账，钱是从宿主账号里悄悄走的。
    free = legacy_app.calculate_anlas_cost(model="nai-diffusion-5-full", **NORMAL)
    assert free == 0

    charged = legacy_app.calculate_anlas_cost(
        model="nai-diffusion-5-full", opus_usage_exhausted=True, **NORMAL
    )
    assert charged > 0


def test_opus_bar_does_not_affect_pre_v5_models(legacy_app: ModuleType) -> None:
    # 4.5 及以下对 Opus 仍是无限，体力条与它们无关。
    assert (
        legacy_app.calculate_anlas_cost(
            model="nai-diffusion-4-5-full", opus_usage_exhausted=True, **NORMAL
        )
        == 0
    )


def test_per_image_cost_is_capped(legacy_app: ModuleType) -> None:
    assert (
        legacy_app.calculate_anlas_cost(model="nai-diffusion-5-full", width=1920, height=1088, steps=50)
        <= legacy_app._MAX_ANLAS_PER_IMAGE
    )


def test_v5_stream_params_carry_the_v5_envelope(legacy_app: ModuleType) -> None:
    params = legacy_app.convert_web_params_to_stream(
        {
            "model": "v5-full",
            "positivePrompt": "1girl",
            "negativePrompt": "bad anatomy",
            "ucPreset": "light",
            "qualityToggle": True,
            "noiseSchedule": "exponential",
            "varietyPlus": True,
            "transparentBackground": True,
        }
    )

    assert params["model"] == "nai-diffusion-5-full"
    assert params["v5_uc_preset_id"] == "light"
    assert params["v5_quality_preset_id"] == "standard"
    assert params["straight_alpha"] is True
    assert params["tag_hint_transparent_background"] is True
    # V5 隐藏噪声调度并强制 karras；用户选的 exponential 不该被透传出去
    assert params["noise_schedule"] == "karras"
    # V5 没有 Variety+，即便前端传了 varietyPlus 也不能发 skip_cfg_above_sigma
    assert params["skip_cfg_above_sigma"] is None


def test_v45_stream_params_are_untouched_by_the_v5_branch(legacy_app: ModuleType) -> None:
    params = legacy_app.convert_web_params_to_stream(
        {
            "model": "v4.5-full",
            "ucPreset": "light",
            "noiseSchedule": "exponential",
            "varietyPlus": True,
        }
    )

    assert params["model"] == "nai-diffusion-4-5-full"
    assert "v5_uc_preset_id" not in params
    assert "straight_alpha" not in params
    assert params["noise_schedule"] == "exponential"
    assert params["skip_cfg_above_sigma"] == 58
    assert params["uc_preset"] == 1  # light 在 4.5-full 的数字枚举里是 1


def test_v5_drops_vibe_and_precise_reference(legacy_app: ModuleType) -> None:
    # 两者在 V5 上「暂缺」——官方说仍在训练。老客户端可能仍带着 4.5 的引用过来，
    # 主机要挡住，否则等于把 V5 不认识的字段原样转发上去。
    payload = {
        "model": "v5-full",
        "vibeReferences": [{"encodedVibe": "abc", "strength": 0.6}],
        "preciseReferences": [{"imageBase64": "x", "strength": 1, "informationExtracted": 1}],
    }
    params = legacy_app.convert_web_params_to_stream(payload)
    assert "reference_image_multiple" not in params
    assert "director_reference_images" not in params

    # 同样的引用在 4.5 上必须照常发出，证明上面挡的是模型而不是功能。
    v45 = legacy_app.convert_web_params_to_stream({**payload, "model": "v4.5-full"})
    assert v45["reference_image_multiple"] == ["abc"]
    assert v45["director_reference_images"] == ["x"]


def test_v5_curated_inpaint_borrows_the_45_curated_model(legacy_app: ModuleType) -> None:
    # V5 Curated 自己的重绘模型「还在训练中」，官方客户端就是这么顶替的。
    # 这也解释了为什么 V5 Curated 的重绘点得下去、却看着有点不对。
    params = legacy_app.convert_web_params_to_stream(
        {
            "model": "v5-curated",
            "inpaint": {"imageBase64": "img", "maskBase64": "mask", "strength": 0.7},
        }
    )
    assert params["model"] == "nai-diffusion-4-5-curated-inpainting"

    # V5 Full 有自己的重绘模型，走常规后缀派生。
    full = legacy_app.convert_web_params_to_stream(
        {
            "model": "v5-full",
            "inpaint": {"imageBase64": "img", "maskBase64": "mask", "strength": 0.7},
        }
    )
    assert full["model"] == "nai-diffusion-5-full-inpainting"
