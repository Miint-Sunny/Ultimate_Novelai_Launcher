"""Canonical V5 diffusion upscale API (coexists with the legacy compat /upscale)."""

from __future__ import annotations

import base64

from fastapi import APIRouter, Request

from backend_core.errors import DependencyUnavailableError, InvalidArgumentError
from sidecar.config import Settings
from sidecar.nai.client import NovelAIError, png_dimensions, upscale_image_v5
from sidecar.runtime import AppRuntime

from ..dependencies import authorize_request, resolve_runtime
from ..problems import ProblemDetailsRoute
from .models import V5UpscaleRequest, V5UpscaleResponse


def create_upscale_router(runtime: AppRuntime | None = None) -> APIRouter:
    router = APIRouter(
        prefix="/upscale",
        tags=["v1-upscale"],
        route_class=ProblemDetailsRoute,
    )

    @router.post("/v5", response_model=V5UpscaleResponse)
    async def upscale_v5(body: V5UpscaleRequest, request: Request) -> V5UpscaleResponse:
        """V5 扩散超分:固定 2×,multipart 直传源图,响应带回实际输出尺寸。

        计费按源图像素查表 1-4(前端算价);失败语义见 client.upscale_image_v5
        ——只有服务端明确不认新格式才回退传统 schema,计费类错误原样上抛。
        """
        current = resolve_runtime(request, runtime)
        current.assert_ready()
        await authorize_request(current, request)
        http_pool = getattr(current, "http", None)
        if http_pool is None:
            raise DependencyUnavailableError(
                "HTTP client pool is not configured",
                code="http_pool_unavailable",
            )
        settings = _current_settings(current)

        try:
            if settings.mock_generation:
                image_bytes = _mock_upscale_result(body.image)
            else:
                image_bytes = await upscale_image_v5(
                    settings=settings,
                    image=body.image,
                    model=body.model,
                    declared_blur_sigma=body.declared_blur_sigma,
                    http=http_pool,
                )
        except NovelAIError as exc:
            if exc.status_code == 0:
                raise InvalidArgumentError(
                    str(exc), code="invalid_upscale_request"
                ) from exc
            # 上游明确失败(含计费类):不重试不换格式,把状态带给前端。
            raise DependencyUnavailableError(
                str(exc),
                code="upscale_upstream_failed",
                retryable=False,
                details={"upstream_status": exc.status_code},
            ) from exc

        dimensions = png_dimensions(image_bytes)
        if dimensions is None:
            raise DependencyUnavailableError(
                "NovelAI returned a payload that is not a PNG",
                code="upscale_upstream_failed",
                retryable=False,
            )
        width, height = dimensions
        return V5UpscaleResponse(
            image=base64.b64encode(image_bytes).decode("ascii"),
            width=width,
            height=height,
            model=body.model,
            declared_blur_sigma=body.declared_blur_sigma,
        )

    return router


def _current_settings(runtime: AppRuntime) -> Settings:
    value = getattr(runtime.settings, "current", runtime.settings)
    if not isinstance(value, Settings):
        raise DependencyUnavailableError(
            "settings store is not configured",
            code="settings_store_unavailable",
        )
    return value


def _mock_upscale_result(image_b64: str) -> bytes:
    """mock_generation 模式:不解码不放大,原样返回源图,保持响应形状可校验。"""
    try:
        return base64.b64decode(image_b64, validate=True)
    except Exception as exc:
        raise NovelAIError("V5 upscale image is not valid base64") from exc


router = create_upscale_router()

__all__ = ["create_upscale_router", "router"]
