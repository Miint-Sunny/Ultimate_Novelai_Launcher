"""家族 B provider 接缝：注册表路由与 Modal 通道的失败封闭行为。"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "server"))

from workshop_providers import (  # noqa: E402
    FunctionWorkshopProvider,
    ModalComfyProvider,
    WorkshopProviderRegistry,
    WorkshopProviderRequest,
)


def _request(model: str = "modal-anime-xl") -> WorkshopProviderRequest:
    return WorkshopProviderRequest(model=model, prompt="1girl", aspect_ratio="1:1")


class _FakeResponse:
    def __init__(self, status: int, body: Any) -> None:
        self.status = status
        self._body = body

    def json(self) -> Any:
        if isinstance(self._body, bytes):
            return json.loads(self._body)
        return self._body


class _FakePoster:
    def __init__(self, response: _FakeResponse | Exception) -> None:
        self.response = response
        self.calls: list[dict[str, Any]] = []

    async def post_json(self, url: str, *, headers, payload, timeout) -> _FakeResponse:
        self.calls.append({"url": url, "headers": dict(headers), "payload": dict(payload), "timeout": timeout})
        if isinstance(self.response, Exception):
            raise self.response
        return self.response


def _provider(
    poster: _FakePoster,
    *,
    endpoint: str = "https://ws--unl-comfy.modal.run",
    token_id: str = "wk-id",
    token_secret: str = "ws-secret",
) -> ModalComfyProvider:
    return ModalComfyProvider(
        name="modal_comfy",
        models=("modal-anime-xl",),
        endpoint=endpoint,
        token_id=token_id,
        token_secret=token_secret,
        http=poster,
    )


def test_registry_routes_by_model_and_rejects_duplicate_claims() -> None:
    async def ok(_request: WorkshopProviderRequest) -> dict:
        return {"success": True}

    registry = WorkshopProviderRegistry()
    big_gpt = FunctionWorkshopProvider(name="big_gpt", models=("gpt-image", "gpt-image-4k"), run=ok)
    registry.register(big_gpt)

    assert registry.resolve("gpt-image") is big_gpt
    assert registry.resolve("gpt-image-4k") is big_gpt
    # 未认领的模型不路由——宿主据此返回「模型已停用」。
    assert registry.resolve("unknown-model") is None

    duplicate = FunctionWorkshopProvider(name="other", models=("gpt-image",), run=ok)
    with pytest.raises(ValueError, match="already claimed"):
        registry.register(duplicate)


@pytest.mark.asyncio
async def test_function_provider_converts_exceptions_into_failed_results() -> None:
    async def boom(_request: WorkshopProviderRequest) -> dict:
        raise RuntimeError("upstream exploded")

    provider = FunctionWorkshopProvider(name="big_gpt", models=("gpt-image",), run=boom)
    result = await provider.run(_request("gpt-image"))
    assert result["success"] is False
    assert "upstream exploded" in result["error"]


@pytest.mark.asyncio
async def test_modal_provider_fails_closed_when_unconfigured() -> None:
    poster = _FakePoster(_FakeResponse(200, {"success": True, "image_base64": "x"}))
    for kwargs in (
        {"endpoint": ""},
        {"token_id": ""},
        {"token_secret": ""},
    ):
        provider = _provider(poster, **kwargs)
        result = await provider.run(_request())
        assert result["success"] is False
        assert "未配置" in result["error"]
    # 配置不全时绝不发出请求。
    assert poster.calls == []


@pytest.mark.asyncio
async def test_modal_provider_sends_proxy_auth_and_maps_success() -> None:
    poster = _FakePoster(_FakeResponse(200, {
        "success": True,
        "image_base64": "aGVsbG8=",
        "mime_type": "image/png",
        "elapsed": 4.2,
    }))
    provider = _provider(poster)
    result = await provider.run(_request())

    assert result == {
        "success": True,
        "image_base64": "aGVsbG8=",
        "mime_type": "image/png",
        "elapsed": 4.2,
    }
    call = poster.calls[0]
    assert call["headers"] == {"Modal-Key": "wk-id", "Modal-Secret": "ws-secret"}
    assert call["payload"]["model"] == "modal-anime-xl"
    assert call["payload"]["prompt"] == "1girl"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("response", "expected"),
    [
        (_FakeResponse(503, {}), "HTTP 503"),
        (_FakeResponse(200, b"not-json{"), "无效 JSON"),
        (_FakeResponse(200, {"success": False, "error": "workflow not provisioned"}), "workflow not provisioned"),
        (_FakeResponse(200, {"success": True}), "未返回图像数据"),
    ],
)
async def test_modal_provider_maps_failures_without_leaking_bodies(response, expected) -> None:
    provider = _provider(_FakePoster(response))
    result = await provider.run(_request())
    assert result["success"] is False
    assert expected in result["error"]


@pytest.mark.asyncio
async def test_modal_provider_wraps_transport_errors() -> None:
    provider = _provider(_FakePoster(ConnectionError("policy rejected")))
    result = await provider.run(_request())
    assert result["success"] is False
    assert "Modal 请求失败" in result["error"]
