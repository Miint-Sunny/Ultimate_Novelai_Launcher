"""Provider entry point used by the generation executor's dispatch."""

from __future__ import annotations

from sidecar.config import Settings
from sidecar.infrastructure import HttpClientPool
from sidecar.nai.models import GenerationParams
from sidecar.security import OutboundPolicy

from .client import ComfyUIClient, ComfyUIError, ProgressCallback
from .workflows import load_workflow_template, patch_workflow


def comfy_outbound_policy(settings: Settings) -> OutboundPolicy:
    """The only address space this channel may reach; public is not an option."""

    if settings.comfy_network_scope == "trusted-lan":
        return OutboundPolicy(
            "trusted-lan",
            trusted_networks=settings.comfy_trusted_networks,
        )
    return OutboundPolicy("loopback")


async def generate_comfy_image(
    *,
    settings: Settings,
    tags: str,
    negative: str,
    params: GenerationParams,
    http: HttpClientPool,
    on_progress: ProgressCallback | None = None,
) -> bytes:
    if not settings.comfy_configured:
        raise ComfyUIError(
            "ComfyUI endpoint is not configured",
            code="comfy_not_configured",
        )
    workflow = load_workflow_template(params.model, user_dir=settings.comfy_workflows_dir)
    patched = patch_workflow(workflow, tags=tags, negative=negative, params=params)
    client = ComfyUIClient(
        base_url=settings.comfy_base_url,
        policy=comfy_outbound_policy(settings),
        http=http,
    )
    return await client.generate(patched, on_progress=on_progress)


__all__ = ["comfy_outbound_policy", "generate_comfy_image"]
