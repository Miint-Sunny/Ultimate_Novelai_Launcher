from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import secrets
import zipfile
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping, Sequence
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from typing import Any, NamedTuple
from urllib.parse import urljoin

import httpx
import msgpack

from ..config import Settings
from ..infrastructure import (
    HttpClientPool,
    request_with_policy,
    streaming_request_with_policy,
)
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

# NovelAI answers a burst with HTTP 429 before doing any billable work. The
# reference clients wait 2.5 s and resend the *identical* request exactly once;
# a second 429 is final. This never switches the wire format: that would be a
# different request NovelAI could bill on its own.
RATE_LIMIT_STATUS = 429
RATE_LIMIT_BACKOFF_SECONDS = 2.5


async def _rate_limit_sleep(seconds: float) -> None:
    await asyncio.sleep(seconds)


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


# --- multipart + msgpack stream path (coexists with the JSON+ZIP path above) ---
#
# The official web client posts binary-carrier generations to
# /ai/generate-image-stream as multipart/form-data: the JSON payload rides in a
# part named "request" and binary images travel as their own parts, so they stop
# paying the ~33% base64 tax and the full-request memory copy. The framing of
# the msgpack response is a 4-byte big-endian length prefix per message
# (mirrored from the host implementation in server/app.py, which captured the
# part naming and ordering from a live session).

# A sane upper bound for one stream frame. Real frames are preview or final
# PNGs (single-digit MiB); the cap exists so a corrupt length prefix cannot
# turn the reader into an unbounded buffer.
_MAX_STREAM_FRAME_BYTES = 64 * 1024 * 1024
# The web client labels every binary part image/png; NovelAI does not police
# the value (the host sends encoded vibe vectors under the same label).
_STREAM_BINARY_CONTENT_TYPE = "image/png"


class NovelAIStreamError(NovelAIError):
    """Failure of the multipart stream path.

    ``retry_safe`` marks failures that happened before any msgpack frame
    arrived. Under those conditions NovelAI cannot have started billed work,
    so retrying once through the JSON+ZIP endpoint is safe. Once a frame has
    been seen the stream is terminal: a retry could double-charge the account.
    """

    def __init__(
        self,
        message: str,
        *,
        status_code: int = 0,
        response_body: str = "",
        retry_safe: bool = False,
    ) -> None:
        super().__init__(message, status_code, response_body)
        self.retry_safe = retry_safe


class _StreamBinaryPart(NamedTuple):
    name: str
    data: bytes


def _prepare_stream_payload(
    payload: Mapping[str, Any],
) -> tuple[dict[str, Any], list[_StreamBinaryPart]] | None:
    """Split base64 binary fields out of an official payload for the stream path.

    Each extracted field's JSON value is replaced by its multipart part name
    (``image``, ``mask``, ``ref_multiple_{i}``), matching how the host
    implementation references vibe parts. Returns None when the payload has no
    usable binary data, in which case the caller stays on the JSON+ZIP path
    with byte-identical behavior.
    """
    parameters = payload.get("parameters")
    if not isinstance(parameters, Mapping):
        return None
    parts: list[_StreamBinaryPart] = []
    new_parameters = dict(parameters)
    for field in ("image", "mask"):
        value = new_parameters.get(field)
        if isinstance(value, str) and value:
            try:
                raw = base64.b64decode(value, validate=True)
            except Exception:
                # Not valid base64: keep the JSON path so NovelAI itself
                # reports the malformed field instead of a decode wrapper.
                return None
            if raw:
                parts.append(_StreamBinaryPart(field, raw))
                new_parameters[field] = field
    references = new_parameters.get("reference_image_multiple")
    if isinstance(references, list):
        new_references: list[Any] = []
        references_changed = False
        for index, item in enumerate(references):
            part_name = f"ref_multiple_{index}"
            raw = b""
            if isinstance(item, str) and item:
                try:
                    raw = base64.b64decode(item, validate=True)
                except Exception:
                    raw = b""
            if raw:
                parts.append(_StreamBinaryPart(part_name, raw))
                new_references.append(part_name)
                references_changed = True
            else:
                # Host precedent: an entry that does not decode stays in the
                # JSON for the server to judge.
                new_references.append(item)
        if references_changed:
            new_parameters["reference_image_multiple"] = new_references
    if not parts:
        return None
    new_parameters["stream"] = "msgpack"
    new_payload = dict(payload)
    new_payload["parameters"] = new_parameters
    return new_payload, parts


def _build_stream_multipart_body(
    payload: Mapping[str, Any],
    parts: Sequence[_StreamBinaryPart],
) -> tuple[bytes, str]:
    """Assemble the multipart body in the captured order: binary parts first,
    the JSON ``request`` part last."""
    boundary = "----WebKitFormBoundary" + secrets.token_hex(8)
    chunks: list[bytes] = []
    for part in parts:
        chunks.append(
            (
                f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="{part.name}"; filename="blob"\r\n'
                f"Content-Type: {_STREAM_BINARY_CONTENT_TYPE}\r\n\r\n"
            ).encode()
        )
        chunks.append(part.data)
        chunks.append(b"\r\n")
    chunks.append(
        (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="request"; filename="blob"\r\n'
            f"Content-Type: application/json\r\n\r\n"
            f"{json.dumps(payload, ensure_ascii=False, separators=(',', ':'))}\r\n"
        ).encode()
    )
    chunks.append(f"--{boundary}--\r\n".encode())
    return b"".join(chunks), boundary


async def _iter_stream_messages(
    chunks: AsyncIterator[bytes],
) -> AsyncIterator[dict[str, Any]]:
    buffer = b""
    async for chunk in chunks:
        buffer += chunk
        while len(buffer) >= 4:
            frame_length = int.from_bytes(buffer[:4], "big")
            if frame_length > _MAX_STREAM_FRAME_BYTES:
                raise NovelAIStreamError(
                    f"msgpack stream frame length {frame_length} exceeds "
                    f"{_MAX_STREAM_FRAME_BYTES} bytes"
                )
            if len(buffer) < 4 + frame_length:
                break
            frame = buffer[4 : 4 + frame_length]
            buffer = buffer[4 + frame_length :]
            try:
                message = msgpack.unpackb(frame, raw=False)
            except Exception as exc:
                # One undecodable frame does not condemn the stream; the host
                # implementation logs and continues, and so does this reader.
                logger.warning("skipping undecodable msgpack stream frame: %s", exc)
                continue
            if isinstance(message, dict):
                yield message


def _streaming_runtime_request(
    *,
    http: HttpClientPool | None,
    client: httpx.AsyncClient | None,
    policy: OutboundPolicy,
    method: str,
    url: str,
    headers: dict[str, str],
    content: bytes,
    timeout: httpx.Timeout,
) -> AbstractAsyncContextManager[httpx.Response]:
    if http is not None and client is not None:
        raise ValueError("pass either http or client, not both")
    if http is not None:
        return http.streaming_request(
            policy,
            method,
            url,
            long_running=True,
            headers=headers,
            content=content,
            timeout=timeout,
        )
    if client is not None:
        return streaming_request_with_policy(
            client,
            policy,
            method,
            url,
            headers=headers,
            content=content,
            timeout=timeout,
        )

    # Compatibility for direct library callers; mirrors _request_with_runtime_client.
    @asynccontextmanager
    async def _owned() -> AsyncIterator[httpx.Response]:
        async with httpx.AsyncClient(follow_redirects=False) as owned_client:
            async with streaming_request_with_policy(
                owned_client,
                policy,
                method,
                url,
                headers=headers,
                content=content,
                timeout=timeout,
            ) as response:
                yield response

    return _owned()


async def _generate_via_stream(
    *,
    settings: Settings,
    stream_payload: Mapping[str, Any],
    parts: Sequence[_StreamBinaryPart],
    http: HttpClientPool | None,
    client: httpx.AsyncClient | None,
    outbound_policy: OutboundPolicy | None,
    on_progress: Callable[[float], Awaitable[None]] | None,
) -> bytes:
    body, boundary = _build_stream_multipart_body(stream_payload, parts)
    headers = {
        "Authorization": f"Bearer {settings.nai_token}",
        "User-Agent": USER_AGENT,
        "Content-Type": f"multipart/form-data; boundary={boundary}",
        "Accept": "*/*",
        "Origin": "https://novelai.net",
        "Referer": "https://novelai.net",
    }
    base_url = settings.nai_base_url.rstrip("/") + "/"
    url = urljoin(base_url, "ai/generate-image-stream")
    policy = outbound_policy or OutboundPolicy("public")

    steps_value = stream_payload.get("parameters", {}).get("steps")
    total_steps = steps_value if isinstance(steps_value, int) and steps_value > 0 else 0

    frames_seen = 0
    last_image: bytes | None = None
    rate_limit_retried = False
    try:
        while True:
            retry_rate_limit = False
            async with _streaming_runtime_request(
                http=http,
                client=client,
                policy=policy,
                method="POST",
                url=url,
                headers=headers,
                content=body,
                timeout=httpx.Timeout(20.0, read=180.0),
            ) as response:
                if response.status_code == RATE_LIMIT_STATUS and not rate_limit_retried:
                    # Nothing billable happened yet: resend the identical stream
                    # request once after the backoff (connection closed first).
                    await response.aread()
                    rate_limit_retried = True
                    retry_rate_limit = True
                elif response.status_code != 200:
                    body_text = (await response.aread())[:500].decode("utf-8", errors="replace")
                    raise NovelAIStreamError(
                        "NovelAI stream request failed with HTTP "
                        f"{response.status_code} {body_text}",
                        status_code=response.status_code,
                        response_body=body_text,
                        retry_safe=True,
                    )
                else:
                    async for message in _iter_stream_messages(response.aiter_bytes()):
                        frames_seen += 1
                        # Business errors ride inside an HTTP 200 stream. They must
                        # surface as a distinct failure (server/app.py learned the
                        # hard way that a bare ``except`` around the frame loop
                        # swallows them) and must never trigger the JSON+ZIP retry:
                        # a received frame means NovelAI engaged, so a retry could
                        # double-charge.
                        if "code" in message and message.get("code") != 200:
                            error_code = message.get("code")
                            error_message = message.get("message", "未知错误")
                            raise NovelAIStreamError(
                                "NovelAI stream returned business error "
                                f"{error_code}: {error_message}",
                                status_code=(
                                    error_code
                                    if isinstance(error_code, int) and 100 <= error_code <= 599
                                    else 0
                                ),
                                response_body=str(error_message),
                                retry_safe=False,
                            )
                        image_data = message.get("image")
                        if not (isinstance(image_data, bytes) and image_data):
                            continue
                        last_image = image_data
                        if on_progress is not None:
                            step_ix = message.get("step_ix")
                            if isinstance(step_ix, int) and total_steps:
                                # Frames are 0-based; the UI-visible fraction is
                                # advisory only, clamped so a misbehaving upstream
                                # cannot push it out of [0, 1].
                                await on_progress(min(1.0, (step_ix + 1) / total_steps))
                            elif not isinstance(step_ix, int):
                                await on_progress(1.0)
            if retry_rate_limit:
                logger.warning(
                    "NovelAI rate limited the stream request; "
                    "retrying the same request once after %.1fs",
                    RATE_LIMIT_BACKOFF_SECONDS,
                )
                await _rate_limit_sleep(RATE_LIMIT_BACKOFF_SECONDS)
                continue
            break
    except NovelAIStreamError as exc:
        # Uniform retry rule: only a failure with zero decoded frames may fall
        # back. One completed frame means NovelAI engaged with the request, so
        # a JSON+ZIP retry could double-charge the account. A rate limit that
        # survived its one same-format retry is final as well: switching
        # transport would only be a third request into the same limiter.
        exc.retry_safe = frames_seen == 0 and exc.status_code != RATE_LIMIT_STATUS
        raise
    except httpx.TimeoutException as exc:
        raise NovelAIStreamError(
            f"NovelAI stream timed out after {frames_seen} frame(s)",
            retry_safe=frames_seen == 0,
        ) from exc
    except httpx.TransportError as exc:
        raise NovelAIStreamError(
            f"NovelAI stream transport failed: {exc}",
            retry_safe=frames_seen == 0,
        ) from exc

    if last_image is None:
        raise NovelAIStreamError(
            "NovelAI stream ended without an image",
            retry_safe=frames_seen == 0,
        )
    return last_image


async def generate_image_from_payload_stream(
    *,
    settings: Settings,
    payload: dict[str, Any],
    http: HttpClientPool | None = None,
    client: httpx.AsyncClient | None = None,
    outbound_policy: OutboundPolicy | None = None,
    on_progress: Callable[[float], Awaitable[None]] | None = None,
) -> bytes:
    """Generate via multipart + msgpack stream when the payload carries binary data.

    Payloads with an i2i ``image``, infill ``mask``, or ``reference_image_multiple``
    entries skip the base64-in-JSON encoding entirely: binaries travel as
    multipart parts and preview frames stream back through ``on_progress``
    (a float in [0, 1], advisory, exactly like the ComfyUI path). Text-only
    payloads and every failure marked retry-safe fall back to the proven
    JSON+ZIP path, so the existing route stays the default and the safety net.
    Failures after the first stream frame raise NovelAIStreamError without a
    retry. Cancellation is plain asyncio cancellation, like the JSON path.
    """
    if not settings.nai_token:
        raise NovelAIError("NAI token is not configured")

    prepared = _prepare_stream_payload(payload)
    if prepared is None:
        return await generate_image_from_payload(
            settings=settings,
            payload=payload,
            http=http,
            client=client,
            outbound_policy=outbound_policy,
        )
    stream_payload, parts = prepared
    logger.info(
        "NovelAI stream request: %s",
        ", ".join(f"{part.name}={len(part.data)}B" for part in parts),
    )
    try:
        return await _generate_via_stream(
            settings=settings,
            stream_payload=stream_payload,
            parts=parts,
            http=http,
            client=client,
            outbound_policy=outbound_policy,
            on_progress=on_progress,
        )
    except NovelAIStreamError as exc:
        if not exc.retry_safe:
            raise
        logger.warning(
            "NovelAI multipart stream failed before any frame (%s); "
            "retrying through the JSON+ZIP path",
            exc,
        )
        return await generate_image_from_payload(
            settings=settings,
            payload=payload,
            http=http,
            client=client,
            outbound_policy=outbound_policy,
        )


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


# --- V5 扩散超分(与传统超分并存,不是替代) ---
#
# V5 上线后 /ai/upscale 换代:multipart(image part + request part)发 image 主机,
# 载荷是 {image, model, declared_blur_sigma},固定 2×,无输入尺寸白名单,扩散
# 级耗时(参考实现按 300s 设读超时)。传统 {image, width, height, scale} schema
# 仍活着,两者各认各的形状(Aaalice nai_image_enhancement_api_service.dart 与
# Plana nai_client.dart 两份独立实现,结论一致)。

# 只有这两个模型支持 standalone upscaling;其余服务端直接报
# "doesn't support standalone upscaling"。两份参考实现都硬编码 curated。
V5_UPSCALE_MODELS = frozenset({"nai-diffusion-5-full", "nai-diffusion-5-curated"})
V5_UPSCALE_DEFAULT_MODEL = "nai-diffusion-5-curated"
# V5 扩散超分这一路确定在 image. 主机(两份参考一致)。做成显式参数而非读
# settings.nai_base_url:「传统 schema 该发哪个主机」尚待实测,别把两路的
# 歧义耦在一起。
V5_UPSCALE_DEFAULT_BASE_URL = "https://image.novelai.net"

# 回退白名单,照抄 Aaalice 一个字不放宽:只有服务端明确不认新格式
# (400/404/405/422)才回退旧 schema。401/402/429/5xx 是鉴权/额度/限流/服务端
# 错误,换传输格式重发等于重复扣费。
_V5_UPSCALE_LEGACY_FALLBACK_STATUSES = frozenset({400, 404, 405, 422})


def png_dimensions(data: bytes) -> tuple[int, int] | None:
    """读 PNG IHDR 的宽高;不是 PNG 或头损坏返回 None。"""
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    if data[12:16] != b"IHDR":
        return None
    width = int.from_bytes(data[16:20], "big")
    height = int.from_bytes(data[20:24], "big")
    if width <= 0 or height <= 0:
        return None
    return width, height


async def upscale_image_v5(
    *,
    settings: Settings,
    image: str,
    model: str = V5_UPSCALE_DEFAULT_MODEL,
    declared_blur_sigma: float = 0.0,
    base_url: str = V5_UPSCALE_DEFAULT_BASE_URL,
    http: HttpClientPool | None = None,
    client: httpx.AsyncClient | None = None,
    outbound_policy: OutboundPolicy | None = None,
) -> bytes:
    """V5 扩散超分:multipart 直传源图,固定 2×,zip → PNG。

    源图不再付 base64 的 33% 膨胀:PNG 字节走独立 part,request part 的
    ``"image": "image"`` 指向 part 名,与生成路径的 multipart 约定一致
    (body 装配复用 _build_stream_multipart_body)。计费按源图像素查表
    1-4,是 Anlas 还是 V5 体力条未证实(回执标注)。失败语义:仅当服务端
    明确不认新格式(400/404/405/422)回退传统 schema,其余错误原样上抛,
    绝不换格式重发。
    """
    if not settings.nai_token:
        raise NovelAIError("NAI token is not configured")
    if model not in V5_UPSCALE_MODELS:
        # 服务端对其他模型直接拒绝;本地拦下省一次往返,也避免把注定
        # 失败的请求发到计费端点。
        raise NovelAIError(
            f"model {model} doesn't support standalone upscaling",
        )
    try:
        raw_image = base64.b64decode(image, validate=True)
    except Exception as exc:
        raise NovelAIError("V5 upscale image is not valid base64") from exc

    payload = {
        "image": "image",
        "model": model,
        "declared_blur_sigma": declared_blur_sigma,
    }
    parts = [_StreamBinaryPart("image", raw_image)]
    body, boundary = _build_stream_multipart_body(payload, parts)
    headers = {
        "Authorization": f"Bearer {settings.nai_token}",
        "User-Agent": USER_AGENT,
        "Content-Type": f"multipart/form-data; boundary={boundary}",
        "Accept": "application/x-zip-compressed",
        "Origin": "https://novelai.net",
        "Referer": "https://novelai.net",
    }
    url = urljoin(base_url.rstrip("/") + "/", "ai/upscale")

    async def send() -> httpx.Response:
        return await _request_with_runtime_client(
            http=http,
            client=client,
            outbound_policy=outbound_policy,
            method="POST",
            url=url,
            headers=headers,
            content=body,
            timeout=httpx.Timeout(30.0, read=300.0),
            long_running=True,
        )

    response = await send()
    if response.status_code == RATE_LIMIT_STATUS:
        # Same multipart request again after the backoff; the legacy schema is
        # a different request and stays off the table for a rate limit.
        logger.warning(
            "NovelAI rate limited the V5 upscale; retrying the same request once after %.1fs",
            RATE_LIMIT_BACKOFF_SECONDS,
        )
        await _rate_limit_sleep(RATE_LIMIT_BACKOFF_SECONDS)
        response = await send()

    if response.status_code in _V5_UPSCALE_LEGACY_FALLBACK_STATUSES:
        logger.warning(
            "V5 upscale rejected with HTTP %s (server does not recognize the "
            "new format); falling back to the legacy upscale schema",
            response.status_code,
        )
        return await _upscale_image_v5_legacy_fallback(
            settings=settings,
            image=image,
            http=http,
            client=client,
            outbound_policy=outbound_policy,
        )

    if response.status_code != 200:
        message = f"NovelAI V5 upscale failed with HTTP {response.status_code}"
        try:
            error_body = response.json()
            message = error_body.get("message") or error_body.get("error") or message
        except Exception:
            error_body = response.text[:500]
        raise NovelAIError(message, response.status_code, str(error_body))

    return await _extract_image_from_zip(response.content)


async def _upscale_image_v5_legacy_fallback(
    *,
    settings: Settings,
    image: str,
    http: HttpClientPool | None,
    client: httpx.AsyncClient | None,
    outbound_policy: OutboundPolicy | None,
) -> bytes:
    """新格式被拒后的旧 schema 回退:{image, width, height, scale} JSON。

    复用既有 upscale_image():主机歧义(传统 schema 归属 api. 还是 image.)
    留在它现在所在的那一处,实测结论回来只动一个默认值。宽高从源图 PNG
    头取(Aaalice 同款本地解码),scale 固定 2 —— V5 扩散超分本身就是 2×,
    旧端点的 2× 档是最接近的等价物。
    """
    try:
        raw_image = base64.b64decode(image, validate=True)
    except Exception as exc:
        raise NovelAIError("V5 upscale image is not valid base64") from exc
    dimensions = png_dimensions(raw_image)
    if dimensions is None:
        raise NovelAIError(
            "V5 upscale legacy fallback requires a PNG source image (could not read dimensions)",
        )
    width, height = dimensions
    return await upscale_image(
        settings=settings,
        image=image,
        width=width,
        height=height,
        scale=2,
        http=http,
        client=client,
        outbound_policy=outbound_policy,
    )


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
    url = urljoin(base_url, path.lstrip("/"))

    async def send() -> httpx.Response:
        return await _request_with_runtime_client(
            http=http,
            client=client,
            outbound_policy=outbound_policy,
            method="POST",
            url=url,
            headers=headers,
            json=payload,
            timeout=timeout,
            long_running=True,
        )

    response = await send()
    if response.status_code == RATE_LIMIT_STATUS:
        logger.warning(
            "NovelAI rate limited %s; retrying the same request once after %.1fs",
            path,
            RATE_LIMIT_BACKOFF_SECONDS,
        )
        await _rate_limit_sleep(RATE_LIMIT_BACKOFF_SECONDS)
        response = await send()

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
    content: bytes | str | None = None,
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
            content=content,
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
            content=content,
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
            content=content,
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
