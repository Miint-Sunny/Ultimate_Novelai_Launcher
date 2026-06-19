from __future__ import annotations

import io
import json
import logging
import random
import zipfile
import base64
from typing import Any

import httpx

from ..config import Settings
from .models import GenerationParams

logger = logging.getLogger(__name__)

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36"
)
SUBSCRIPTION_URL = "https://api.novelai.net/user/subscription"


class NovelAIError(Exception):
    def __init__(self, message: str, status_code: int = 0, response_body: str = ""):
        super().__init__(message)
        self.status_code = status_code
        self.response_body = response_body


def _sanitize_for_log(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: ("***" if key.lower() in {"authorization", "token"} else _sanitize_for_log(item))
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_sanitize_for_log(item) for item in value]
    if isinstance(value, str) and len(value) > 500:
        return f"<{len(value)} chars>"
    return value


def build_official_payload(tags: str, negative: str, params: GenerationParams) -> dict[str, Any]:
    seed = params.seed if params.seed is not None else random.randint(0, 2**32 - 1)
    parameters = {
        "params_version": 3,
        "width": params.width,
        "height": params.height,
        "steps": params.steps,
        "scale": params.scale,
        "seed": seed,
        "sampler": params.sampler,
        "noise_schedule": params.noise_schedule,
        "negative_prompt": negative,
        "cfg_rescale": params.cfg_rescale,
        "sm": False,
        "sm_dyn": False,
        "n_samples": 1,
        "ucPreset": 0,
        "qualityToggle": False,
        "dynamic_thresholding": False,
        "controlnet_strength": 1,
        "legacy": False,
        "add_original_image": True,
        "legacy_v3_extend": False,
        "skip_cfg_above_sigma": None,
        "use_coords": False,
        "characterPrompts": [],
        "v4_prompt": {
            "caption": {
                "base_caption": tags,
                "char_captions": [],
            },
            "use_coords": False,
            "use_order": True,
        },
        "v4_negative_prompt": {
            "caption": {
                "base_caption": negative,
                "char_captions": [],
            },
        },
        "reference_image_multiple": [],
        "reference_information_extracted_multiple": [],
        "reference_strength_multiple": [],
    }
    return {
        "input": tags,
        "model": params.model,
        "action": "generate",
        "parameters": parameters,
    }


async def generate_image(
    *,
    settings: Settings,
    tags: str,
    negative: str,
    params: GenerationParams,
) -> bytes:
    payload = build_official_payload(tags, negative, params)
    return await generate_image_from_payload(settings=settings, payload=payload)


async def generate_image_from_payload(*, settings: Settings, payload: dict[str, Any]) -> bytes:
    if not settings.nai_token:
        raise NovelAIError("NAI token is not configured")

    logger.info(
        "NovelAI request: %s",
        json.dumps(_sanitize_for_log(payload), ensure_ascii=False),
    )
    response = await _post_nai_json(
        settings=settings,
        path="/ai/generate-image",
        payload=payload,
        accept="application/zip",
        read_timeout=180.0,
    )
    return await _extract_image_from_zip(response.content)


async def encode_vibe(
    *,
    settings: Settings,
    image: str,
    information_extracted: float,
    model: str,
) -> str:
    if not settings.nai_token:
        raise NovelAIError("NAI token is not configured")

    response = await _post_nai_json(
        settings=settings,
        path="/ai/encode-vibe",
        payload={
            "image": image,
            "information_extracted": information_extracted,
            "model": model,
        },
        accept="*/*",
        read_timeout=120.0,
    )
    return base64.b64encode(response.content).decode("ascii")


async def upscale_image(
    *,
    settings: Settings,
    image: str,
    width: int,
    height: int,
    scale: int | float,
) -> bytes:
    if not settings.nai_token:
        raise NovelAIError("NAI token is not configured")

    response = await _post_nai_json(
        settings=settings,
        path="/ai/upscale",
        payload={
            "image": image,
            "width": width,
            "height": height,
            "scale": scale,
        },
        accept="application/zip",
        read_timeout=180.0,
    )
    return await _extract_image_from_zip(response.content)


def parse_anlas_subscription(data: dict[str, Any]) -> dict[str, Any]:
    steps = data.get("trainingStepsLeft")
    if not isinstance(steps, dict):
        steps = {}

    fixed = int(steps.get("fixedTrainingStepsLeft") or 0)
    purchased = int(steps.get("purchasedTrainingSteps") or 0)
    tier = data.get("tier")
    active = data.get("active", True)
    return {
        "fixedTrainingStepsLeft": fixed,
        "purchasedTrainingSteps": purchased,
        "isOpus": tier == 3 and active is not False,
    }


async def fetch_anlas(settings: Settings) -> dict[str, Any]:
    if not settings.nai_token:
        raise NovelAIError("NAI token is not configured")

    headers = {
        "Authorization": f"Bearer {settings.nai_token}",
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
        "Origin": "https://novelai.net",
        "Referer": "https://novelai.net",
    }
    async with httpx.AsyncClient(
        headers={key: value for key, value in headers.items() if key != "Authorization"},
        timeout=httpx.Timeout(10.0, read=20.0),
    ) as client:
        response = await client.get(
            SUBSCRIPTION_URL,
            headers={"Authorization": headers["Authorization"]},
        )

    if response.status_code != 200:
        message = f"NovelAI subscription request failed with HTTP {response.status_code}"
        try:
            body = response.json()
            message = body.get("message") or body.get("error") or message
        except Exception:
            body = response.text[:500]
        raise NovelAIError(message, response.status_code, str(body))

    try:
        data = response.json()
    except Exception as exc:
        raise NovelAIError("NovelAI subscription response was not valid JSON") from exc
    if not isinstance(data, dict):
        raise NovelAIError("NovelAI subscription response was not an object")
    return parse_anlas_subscription(data)


async def _post_nai_json(
    *,
    settings: Settings,
    path: str,
    payload: dict[str, Any],
    accept: str,
    read_timeout: float,
) -> httpx.Response:
    headers = {
        "Authorization": f"Bearer {settings.nai_token}",
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
        "Accept": accept,
        "Origin": "https://novelai.net",
        "Referer": "https://novelai.net",
    }
    timeout = httpx.Timeout(20.0, read=read_timeout)
    async with httpx.AsyncClient(
        base_url=settings.nai_base_url,
        headers={key: value for key, value in headers.items() if key != "Authorization"},
        timeout=timeout,
    ) as client:
        response = await client.post(
            path,
            json=payload,
            headers={"Authorization": headers["Authorization"]},
        )

    if response.status_code not in {200, 201}:
        message = f"NovelAI request failed with HTTP {response.status_code}"
        try:
            body = response.json()
            message = body.get("message") or body.get("error") or message
        except Exception:
            body = response.text[:500]
        raise NovelAIError(message, response.status_code, str(body))
    return response


async def _extract_image_from_zip(payload: bytes) -> bytes:
    try:
        with zipfile.ZipFile(io.BytesIO(payload), "r") as archive:
            names = archive.namelist()
            if not names:
                raise NovelAIError("NovelAI returned an empty zip")
            return archive.read(names[0])
    except zipfile.BadZipFile as exc:
        raise NovelAIError("NovelAI response was not a valid zip") from exc
