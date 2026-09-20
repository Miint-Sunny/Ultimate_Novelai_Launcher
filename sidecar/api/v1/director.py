"""Canonical Director Tools API (NovelAI `/ai/augment-image`)."""

from __future__ import annotations

import base64

from fastapi import APIRouter, Request

from backend_core.errors import DependencyUnavailableError, InvalidArgumentError
from sidecar.config import Settings
from sidecar.nai.client import NovelAIError, augment_image, png_dimensions
from sidecar.runtime import AppRuntime

from ..dependencies import authorize_request, resolve_runtime
from ..problems import ProblemDetailsRoute
from .models import DirectorAugmentRequest, DirectorAugmentResponse


def create_director_router(runtime: AppRuntime | None = None) -> APIRouter:
    router = APIRouter(
        prefix="/director",
        tags=["v1-director"],
        route_class=ProblemDetailsRoute,
    )

    @router.post("/augment", response_model=DirectorAugmentResponse)
    async def augment(
        body: DirectorAugmentRequest, request: Request
    ) -> DirectorAugmentResponse:
        """导演工具:整图一次性处理,结果是一张新图。

        计费未知——官方没公布每个工具的 Anlas 单价,前端按「未知费用」走付费闸,
        不假装免费。失败语义见 client.augment_image:上游明确失败原样上抛,
        不重试、不换传输格式(这是计费端点)。
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
                image_bytes = _mock_augment_result(body.image)
            else:
                image_bytes = await augment_image(
                    settings=settings,
                    image=body.image,
                    req_type=body.req_type,
                    prompt=body.prompt,
                    defry=body.defry,
                    http=http_pool,
                )
        except NovelAIError as exc:
            if exc.status_code == 0:
                # 本地就能判定的坏请求(非 PNG、超尺寸、坏 base64):没发出去,
                # 也就没花钱,按参数错误回给前端。
                raise InvalidArgumentError(
                    str(exc), code="invalid_director_request"
                ) from exc
            raise DependencyUnavailableError(
                str(exc),
                code="director_upstream_failed",
                retryable=False,
                details={"upstream_status": exc.status_code},
            ) from exc

        dimensions = png_dimensions(image_bytes)
        if dimensions is None:
            raise DependencyUnavailableError(
                "NovelAI returned a payload that is not a PNG",
                code="director_upstream_failed",
                retryable=False,
            )
        width, height = dimensions
        return DirectorAugmentResponse(
            image=base64.b64encode(image_bytes).decode("ascii"),
            width=width,
            height=height,
            req_type=body.req_type,
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


def _mock_augment_result(image_b64: str) -> bytes:
    """mock_generation 模式:原样返回源图,保持响应形状可校验,不占额度。"""
    try:
        return base64.b64decode(image_b64, validate=True)
    except Exception as exc:
        raise NovelAIError("director tool image is not valid base64") from exc


router = create_director_router()

__all__ = ["create_director_router", "router"]
