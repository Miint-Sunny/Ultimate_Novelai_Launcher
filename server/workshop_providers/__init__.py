"""Workshop 任务型出图/出视频 provider 接缝（家族 B：请求/响应与提交-轮询式后端）。

`server/app.py` 的 `_workshop_process_task` 通过这里的注册表按 model_id 分发；
配额 reserve/capture/refund、持久化状态机、取消与重启恢复全部由宿主继承，
provider 只需实现「拿请求、还结果」的最小契约。
"""

from .base import (
    FunctionWorkshopProvider,
    WorkshopProviderRegistry,
    WorkshopProviderRequest,
    WorkshopProviderResult,
)
from .modal_comfy import ModalComfyProvider

__all__ = [
    "FunctionWorkshopProvider",
    "ModalComfyProvider",
    "WorkshopProviderRegistry",
    "WorkshopProviderRequest",
    "WorkshopProviderResult",
]
