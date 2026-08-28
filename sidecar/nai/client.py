from __future__ import annotations

import base64
import io
import json
import logging
import secrets
import zipfile
from typing import Any
from urllib.parse import urljoin

import httpx

from ..config import Settings
from ..infrastructure import HttpClientPool, request_with_policy
from ..security import OutboundPolicy
from .models import GenerationParams

logger = logging.getLogger(__name__)

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36"
)
# NovelAI moved every /user/* route onto the image host with the V5 release; the old
# api.novelai.net copies now answer HTTP 400 ("update to the image URL") for a valid
# token, so this must stay on image.novelai.net. Kept as an absolute URL rather than
# derived from settings.nai_base_url so a proxy configured for /ai/* only (which does
# not have to serve /user/*) keeps working the way it does today.
SUBSCRIPTION_URL = "https://image.novelai.net/user/subscription"


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


def is_v5_model(model: str) -> bool:
    """Whether ``model`` belongs to the NAI Diffusion V5 family.

    Matches the base ids and their ``-inpainting`` variants. ``custom`` was V5's
    staging key during the beta and still turns up in older metadata, so it is
    treated as V5 rather than falling through to the V4-shaped payload.
    """
    return model.startswith("nai-diffusion-5") or model == "custom"


def build_official_payload(tags: str, negative: str, params: GenerationParams) -> dict[str, Any]:
    seed = params.seed if params.seed is not None else secrets.randbits(32)
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

    if is_v5_model(params.model):
        # V5 keeps the v4_prompt / v4_negative_prompt structure verbatim -- and in
        # fact *requires* it: omitting the object makes NovelAI answer HTTP 500 even
        # with zero characters. What changes is the envelope around it.
        parameters["params_version"] = 4
        # The numeric ucPreset / qualityToggle pair became string preset ids. The
        # values here mirror what the V4 branch above already claims (ucPreset 0 is
        # "heavy"; qualityToggle False is "no quality tags") so this path's semantics
        # are unchanged -- the preset *text* is the caller's to supply either way.
        parameters.pop("ucPreset", None)
        parameters.pop("qualityToggle", None)
        parameters["ucPresetId"] = "heavy"
        parameters["qualityPresetId"] = "none"
        # V5 exposes no noise schedule (the official client force-writes karras and
        # hides the picker) and has no Variety+, so skip_cfg_above_sigma has nothing
        # to delay. Sending sm/sm_dyn true is a 500 on V5; they are already False.
        parameters["noise_schedule"] = "karras"
        parameters.pop("skip_cfg_above_sigma", None)
        # Alpha compositing mode. NovelAI's own client sends this for every model
        # whose capability record has transparency, independently of whether the
        # prompt asked for a transparent background.
        parameters["straight_alpha"] = True
        # Vibe transfer is not available on V5 yet -- not "never": NovelAI has said
        # it is still being trained. Drop the arrays rather than the code path, so
        # re-enabling is a matter of deleting these three lines.
        parameters.pop("reference_image_multiple", None)
        parameters.pop("reference_information_extracted_multiple", None)
        parameters.pop("reference_strength_multiple", None)
        # tag_hint_qt / tag_hint_uc_preset are deliberately not sent. They are
        # pass-through hints the model does not interpret (they exist so the web UI
        # can restore preset state from metadata), and the observed numbering does
        # not match preset list order, so guessing one would only write a wrong hint
        # into the PNG. This path applies no preset text, so it has none to declare.

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
    http: HttpClientPool | None = None,
    client: httpx.AsyncClient | None = None,
    outbound_policy: OutboundPolicy | None = None,
) -> bytes:
    payload = build_official_payload(tags, negative, params)
    return await generate_image_from_payload(
        settings=settings,
        payload=payload,
        http=http,
        client=client,
        outbound_policy=outbound_policy,
    )


async def generate_image_from_payload(
    *,
    settings: Settings,
    payload: dict[str, Any],
    http: HttpClientPool | None = None,
    client: httpx.AsyncClient | None = None,
    outbound_policy: OutboundPolicy | None = None,
) -> bytes:
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
        http=http,
        client=client,
        outbound_policy=outbound_policy,
    )
    return await _extract_image_from_zip(response.content)


async def encode_vibe(
    *,
    settings: Settings,
    image: str,
    information_extracted: float,
    model: str,
    http: HttpClientPool | None = None,
    client: httpx.AsyncClient | None = None,
    outbound_policy: OutboundPolicy | None = None,
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
        http=http,
        client=client,
        outbound_policy=outbound_policy,
    )
    return base64.b64encode(response.content).decode("ascii")


async def upscale_image(
    *,
    settings: Settings,
    image: str,
    width: int,
    height: int,
    scale: int | float,
    http: HttpClientPool | None = None,
    client: httpx.AsyncClient | None = None,
    outbound_policy: OutboundPolicy | None = None,
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
        http=http,
        client=client,
        outbound_policy=outbound_policy,
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
    parsed: dict[str, Any] = {
        "fixedTrainingStepsLeft": fixed,
        "purchasedTrainingSteps": purchased,
        "isOpus": tier == 3 and active is not False,
    }

    # V5 metered Opus's previously unlimited free generations. NovelAI reports the
    # remaining allowance here and nowhere else: an exhausted bar does not fail a
    # request, it silently starts charging Anlas, so a client that does not read
    # this cannot warn anyone before the money goes. Absent below Opus.
    usage = data.get("usage")
    if isinstance(usage, dict):
        percent = usage.get("percent")
        next_percent = usage.get("timeUntilNextPercent")
        parsed["opusUsage"] = {
            # Can exceed 100: NovelAI granted a one-time boost past the cap at
            # launch, and 170 has been observed in the wild.
            "percent": int(percent) if isinstance(percent, (int, float)) else 0,
            "isNegative": bool(usage.get("isNegative")),
            # Seconds until the bar gains its next percent; 0 while refill is
            # paused because the bar is full.
            "timeUntilNextPercent": (
                int(next_percent) if isinstance(next_percent, (int, float)) else 0
            ),
        }

    return parsed


async def fetch_anlas(
    settings: Settings,
    *,
    http: HttpClientPool | None = None,
    client: httpx.AsyncClient | None = None,
    outbound_policy: OutboundPolicy | None = None,
) -> dict[str, Any]:
    if not settings.nai_token:
        raise NovelAIError("NAI token is not configured")

    headers = {
        "Authorization": f"Bearer {settings.nai_token}",
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
        "Origin": "https://novelai.net",
        "Referer": "https://novelai.net",
    }
    response = await _request_with_runtime_client(
        http=http,
        client=client,
        outbound_policy=outbound_policy,
        method="GET",
        url=SUBSCRIPTION_URL,
        headers=headers,
        timeout=httpx.Timeout(10.0, read=20.0),
        long_running=False,
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
    http: HttpClientPool | None = None,
    client: httpx.AsyncClient | None = None,
    outbound_policy: OutboundPolicy | None = None,
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
    base_url = settings.nai_base_url.rstrip("/") + "/"
    response = await _request_with_runtime_client(
        http=http,
        client=client,
        outbound_policy=outbound_policy,
        method="POST",
        url=urljoin(base_url, path.lstrip("/")),
        headers=headers,
        json=payload,
        timeout=timeout,
        long_running=True,
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


async def _request_with_runtime_client(
    *,
    http: HttpClientPool | None,
    client: httpx.AsyncClient | None,
    outbound_policy: OutboundPolicy | None,
    method: str,
    url: str,
    headers: dict[str, str],
    timeout: httpx.Timeout,
    long_running: bool,
    json: Any = None,
) -> httpx.Response:
    if http is not None and client is not None:
        raise ValueError("pass either http or client, not both")
    policy = outbound_policy or OutboundPolicy("public")
    if http is not None:
        return await http.request(
            policy,
            method,
            url,
            long_running=long_running,
            headers=headers,
            json=json,
            timeout=timeout,
        )
    if client is not None:
        return await request_with_policy(
            client,
            policy,
            method,
            url,
            headers=headers,
            json=json,
            timeout=timeout,
        )

    # Compatibility for direct library callers. Runtime routes inject the
    # lifespan-owned pool; this branch deliberately owns and closes its client.
    async with httpx.AsyncClient(follow_redirects=False) as owned_client:
        return await request_with_policy(
            owned_client,
            policy,
            method,
            url,
            headers=headers,
            json=json,
            timeout=timeout,
        )


async def _extract_image_from_zip(payload: bytes) -> bytes:
    try:
        with zipfile.ZipFile(io.BytesIO(payload), "r") as archive:
            names = archive.namelist()
            if not names:
                raise NovelAIError("NovelAI returned an empty zip")
            return archive.read(names[0])
    except zipfile.BadZipFile as exc:
        raise NovelAIError("NovelAI response was not a valid zip") from exc
