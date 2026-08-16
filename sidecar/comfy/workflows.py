"""Workflow templates (ComfyUI API format) and prompt/parameter patching.

Templates are looked up by model id, user files first so operators can drop in
their own workflows without rebuilding the app:

1. ``<data_dir>/comfy-workflows/<model>.json`` — user-provisioned, hot-swappable.
2. ``sidecar/comfy/workflows/<model>.json`` — built-in package resources
   (``importlib.resources``; safe under PyInstaller).

Patching is deliberately conservative. Only the values the launcher UI owns are
written into the graph — positive/negative prompt text, latent dimensions, and
the seed. Steps, CFG, sampler choice and everything else stay with the workflow
author: those were tuned per model and per workflow, and NAI-flavoured defaults
would silently wreck them.
"""

from __future__ import annotations

import copy
import json
import secrets
from importlib import resources
from pathlib import Path
from typing import Any

from sidecar.nai.models import COMFY_WORKFLOW_ID_PATTERN, GenerationParams

from .client import ComfyUIError

# A template is a node graph, not an image payload; anything bigger is a mistake.
_MAX_TEMPLATE_BYTES = 2 * 1024 * 1024


def load_workflow_template(model: str, *, user_dir: Path) -> dict[str, Any]:
    if not COMFY_WORKFLOW_ID_PATTERN.fullmatch(model) or ".." in model:
        raise ComfyUIError(
            f"invalid ComfyUI workflow id: {model[:64]!r}",
            code="comfy_workflow_invalid",
        )
    raw = _read_user_template(user_dir / f"{model}.json")
    if raw is None:
        raw = _read_packaged_template(f"{model}.json")
    if raw is None:
        raise ComfyUIError(
            f"no workflow template is provisioned for {model!r}; "
            f"place an API-format export at {user_dir / (model + '.json')}",
            code="comfy_workflow_missing",
        )
    return _parse_template(model, raw)


def _read_user_template(path: Path) -> bytes | None:
    try:
        if not path.is_file():
            return None
        if path.stat().st_size > _MAX_TEMPLATE_BYTES:
            raise ComfyUIError(
                f"workflow template {path.name} exceeds {_MAX_TEMPLATE_BYTES} bytes",
                code="comfy_workflow_invalid",
            )
        return path.read_bytes()
    except ComfyUIError:
        raise
    except OSError:
        return None


def _read_packaged_template(name: str) -> bytes | None:
    try:
        candidate = resources.files("sidecar.comfy").joinpath("workflows").joinpath(name)
        if not candidate.is_file():
            return None
        return candidate.read_bytes()
    except (OSError, ModuleNotFoundError, AttributeError):
        return None


def _parse_template(model: str, raw: bytes) -> dict[str, Any]:
    if len(raw) > _MAX_TEMPLATE_BYTES:
        raise ComfyUIError(
            f"workflow template for {model!r} exceeds {_MAX_TEMPLATE_BYTES} bytes",
            code="comfy_workflow_invalid",
        )
    try:
        workflow = json.loads(raw)
    except ValueError as exc:
        raise ComfyUIError(
            f"workflow template for {model!r} is not valid JSON",
            code="comfy_workflow_invalid",
        ) from exc
    if not isinstance(workflow, dict) or not workflow:
        raise ComfyUIError(
            f"workflow template for {model!r} must be an API-format node map",
            code="comfy_workflow_invalid",
        )
    for node in workflow.values():
        if not (isinstance(node, dict) and isinstance(node.get("class_type"), str)):
            raise ComfyUIError(
                f"workflow template for {model!r} must be an API-format node map "
                "(UI-format exports need Save (API Format))",
                code="comfy_workflow_invalid",
            )
    return workflow


def patch_workflow(
    workflow: dict[str, Any],
    *,
    tags: str,
    negative: str,
    params: GenerationParams,
) -> dict[str, Any]:
    """Return a deep copy with prompts, dimensions, and seed written in.

    Prompt targets are found by following each sampler's ``positive``/``negative``
    links to nodes carrying a ``text`` input, so no node-title convention is
    required. Graphs whose conditioning does not end in a plain text node keep
    their template text untouched.
    """

    patched = copy.deepcopy(workflow)
    seed = params.seed if params.seed is not None else secrets.randbits(32)

    for node in patched.values():
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        for key in ("seed", "noise_seed"):
            if isinstance(inputs.get(key), int):
                inputs[key] = seed
        # The canonical empty-latent signature; plain image resizers lack
        # batch_size and intentionally stay untouched.
        if all(isinstance(inputs.get(key), int) for key in ("width", "height", "batch_size")):
            inputs["width"] = params.width
            inputs["height"] = params.height
        if "positive" in inputs and "negative" in inputs:
            _patch_linked_text(patched, inputs.get("positive"), tags)
            _patch_linked_text(patched, inputs.get("negative"), negative)
    return patched


def _patch_linked_text(workflow: dict[str, Any], link: Any, text: str) -> None:
    if not (isinstance(link, list) and link and isinstance(link[0], (str, int))):
        return
    target = workflow.get(str(link[0]))
    if not isinstance(target, dict):
        return
    inputs = target.get("inputs")
    if isinstance(inputs, dict) and isinstance(inputs.get("text"), str):
        inputs["text"] = text


__all__ = ["load_workflow_template", "patch_workflow"]
