"""Provider 契约与注册表。

结果沿用 workshop 既有的 dict 形状（`_workshop_process_task` 消费）：
`{"success": bool, "image_base64": str, "mime_type": str, "error": str, "elapsed": float}`。
视频后端将来在此基础上加 `video_base64`/`video_url` 字段——先把接缝立起来。
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Protocol

WorkshopProviderResult = dict[str, Any]


@dataclass(frozen=True)
class WorkshopProviderRequest:
    """一次 workshop 生成请求的 provider 视角快照。"""

    model: str
    prompt: str
    aspect_ratio: str = "auto"
    images: list[str] | None = None


class WorkshopProvider(Protocol):
    """任务型 provider 的最小契约。"""

    name: str

    def model_ids(self) -> tuple[str, ...]:
        """本 provider 认领的 model_id 列表（注册表按此路由）。"""
        ...

    async def run(self, request: WorkshopProviderRequest) -> WorkshopProviderResult:
        """执行一次生成。永不抛出——失败以 {"success": False, "error": ...} 返回。"""
        ...


class FunctionWorkshopProvider:
    """把一个 async 函数包装成 provider（宿主内既有实现的最小迁移路径）。"""

    def __init__(
        self,
        *,
        name: str,
        models: tuple[str, ...],
        run: Callable[[WorkshopProviderRequest], Awaitable[WorkshopProviderResult]],
    ) -> None:
        if not models:
            raise ValueError("provider must claim at least one model id")
        self.name = name
        self._models = models
        self._run = run

    def model_ids(self) -> tuple[str, ...]:
        return self._models

    async def run(self, request: WorkshopProviderRequest) -> WorkshopProviderResult:
        try:
            return await self._run(request)
        except Exception as exc:  # noqa: BLE001 - provider 边界必须失败封闭
            return {"success": False, "error": f"provider {self.name} failed: {exc}"}


class WorkshopProviderRegistry:
    """model_id → provider 的封闭映射；重复认领是配置错误，立即失败。"""

    def __init__(self) -> None:
        self._by_model: dict[str, WorkshopProvider] = {}
        self._providers: list[WorkshopProvider] = []

    def register(self, provider: WorkshopProvider) -> None:
        for model_id in provider.model_ids():
            existing = self._by_model.get(model_id)
            if existing is not None:
                raise ValueError(
                    f"model {model_id!r} already claimed by provider {existing.name!r}"
                )
            self._by_model[model_id] = provider
        self._providers.append(provider)

    def resolve(self, model_id: str) -> WorkshopProvider | None:
        return self._by_model.get(model_id)

    def providers(self) -> tuple[WorkshopProvider, ...]:
        return tuple(self._providers)
