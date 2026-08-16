"""Family-A provider: a protocol client for a local/LAN ComfyUI instance.

Every HTTP request goes through the lifecycle-owned ``HttpClientPool`` under an
``OutboundPolicy`` limited to loopback or an explicit trusted LAN; the public
internet is never a valid destination for this channel.
"""

from .client import ComfyUIClient, ComfyUIError
from .service import generate_comfy_image
from .workflows import load_workflow_template, patch_workflow

__all__ = [
    "ComfyUIClient",
    "ComfyUIError",
    "generate_comfy_image",
    "load_workflow_template",
    "patch_workflow",
]
