"""Modal 通道：调用运营者自部署的 Modal App（见 deploy/modal/）。

大陆终端用户不直连 modal.run —— 只有私域 server 需要能访问它。端点用 Modal
的 proxy-auth（Modal-Key / Modal-Secret 头）鉴权；密钥缺失时失败封闭。
契约与 deploy/modal/comfy_app.py 对齐：单次阻塞 POST，返回
`{"success", "image_base64", "mime_type", "elapsed", "error"}`。
"""

from __future__ import annotations

from time import monotonic
from typing import Any, Protocol

from .base import WorkshopProviderRequest, WorkshopProviderResult

# 视频/大图生成慢；Modal 侧 fastapi_endpoint 同步返回，超时给足（秒）。
_DEFAULT_TIMEOUT_S = 900.0


class _JsonPoster(Protocol):
    """与 cloud_backend.outbound.SafeJsonHttpClient.post_json 对齐的最小面。"""

    async def post_json(
        self,
        url: str,
        *,
        headers: dict[str, str],
        payload: dict[str, Any],
        timeout: float,
    ) -> Any:  # HopResponse: .status / .json()
        ...


class ModalComfyProvider:
    """把一组 model_id 路由到一个 Modal App 端点。

    一个部署可以承载多个工作流（payload 里带 model），也可以为不同模型部署
    多个 App、注册多个本类实例。
    """

    def __init__(
        self,
        *,
        name: str,
        models: tuple[str, ...],
        endpoint: str,
        token_id: str,
        token_secret: str,
        http: _JsonPoster,
        timeout_s: float = _DEFAULT_TIMEOUT_S,
    ) -> None:
        if not models:
            raise ValueError("ModalComfyProvider must claim at least one model id")
        self.name = name
        self._models = models
        self._endpoint = endpoint.strip().rstrip("/")
        self._token_id = token_id.strip()
        self._token_secret = token_secret.strip()
        self._http = http
        self._timeout_s = timeout_s

    def model_ids(self) -> tuple[str, ...]:
        return self._models

    @property
    def configured(self) -> bool:
        return bool(self._endpoint and self._token_id and self._token_secret)

    async def run(self, request: WorkshopProviderRequest) -> WorkshopProviderResult:
        if not self.configured:
            # 失败封闭：配置不全绝不半推半就地发请求。
            return {"success": False, "error": "Modal 通道未配置（endpoint / token）"}

        started = monotonic()
        try:
            response = await self._http.post_json(
                self._endpoint,
                headers={
                    # Modal proxy-auth token 对（workspace 级签发，不是用户凭据）。
                    "Modal-Key": self._token_id,
                    "Modal-Secret": self._token_secret,
                },
                payload={
                    "model": request.model,
                    "prompt": request.prompt,
                    "aspect_ratio": request.aspect_ratio,
                    "images": request.images or [],
                },
                timeout=self._timeout_s,
            )
        except Exception as exc:  # noqa: BLE001 - provider 边界失败封闭
            return {"success": False, "error": f"Modal 请求失败: {exc}"}

        if response.status != 200:
            # 不透传响应体（可能包含上游细节）；状态码足够定位。
            return {"success": False, "error": f"Modal 端点返回 HTTP {response.status}"}

        try:
            body = response.json()
        except Exception:  # noqa: BLE001
            return {"success": False, "error": "Modal 端点返回了无效 JSON"}

        if not isinstance(body, dict) or not body.get("success"):
            error = body.get("error") if isinstance(body, dict) else None
            return {"success": False, "error": str(error or "Modal 生成失败")}

        image_base64 = body.get("image_base64")
        if not isinstance(image_base64, str) or not image_base64:
            return {"success": False, "error": "Modal 端点未返回图像数据"}

        elapsed_raw = body.get("elapsed")
        if isinstance(elapsed_raw, (int, float)):
            elapsed = float(elapsed_raw)
        else:
            elapsed = monotonic() - started
        return {
            "success": True,
            "image_base64": image_base64,
            "mime_type": str(body.get("mime_type") or "image/png"),
            "elapsed": elapsed,
        }
