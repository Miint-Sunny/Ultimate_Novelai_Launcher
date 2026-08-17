"""Historical desktop routes backed by the shared runtime services.

The compatibility surface intentionally keeps its existing paths and response
shapes for one bundled release.  Authentication is enforced by the process-wide
sidecar middleware; route-level dependencies are retained on the historically
protected mutations as defense in depth.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from collections.abc import AsyncIterator, Callable, Coroutine
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.routing import APIRoute

from backend_core.errors import RuntimeNotReadyError
from server.agent_router.schemas import SseEvent
from server.agent_router.sse import SseChannel
from sidecar import APP_VERSION
from sidecar.agent_runtime import (
    AgentRequestValidationError,
    AgentRuntimeUnavailable,
    DesktopAgentAdapter,
    public_agent_error,
)
from sidecar.composition import RuntimeComponents
from sidecar.config import Settings
from sidecar.credentials import (
    CredentialStorageError,
    delete_stored_llm_backup_key,
    delete_stored_llm_key,
    delete_stored_token,
    set_stored_llm_backup_key,
    set_stored_llm_key,
    set_stored_token,
)
from sidecar.db import (
    get_generation,
    lookup_tag_translations,
    upsert_tag_translations,
)
from sidecar.infrastructure import HttpClientPool
from sidecar.llm.client import (
    LLMConversionError,
    LLMNotConfiguredError,
    chat_completion,
    convert_natural_to_tags,
)
from sidecar.nai.client import NovelAIError, encode_vibe, fetch_anlas, upscale_image
from sidecar.nai.models import GenerateRequest
from sidecar.storage import image_path, write_mock_image
from sidecar.tags import register_tag_routes

from .library import register_library_compat_routes
from .models import (
    AgentGeneratePromptRequest,
    AgentWebGeneratePromptRequest,
    ChatCompletionRequest,
    LlmKeyRequest,
    SettingsUpdateRequest,
    TagTranslationLookupRequest,
    TagTranslationSubmitRequest,
    TokenRequest,
    UpscaleRequest,
    VibeEncodeRequest,
)

logger = logging.getLogger(__name__)
_SUNSET = "Wed, 13 Jan 2027 00:00:00 GMT"


class CompatRoute(APIRoute):
    """Mark every historical endpoint with the one-release deprecation contract."""

    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        original = super().get_route_handler()

        async def handler(request: Request) -> Response:
            response = await original(request)
            response.headers.setdefault("Deprecation", "true")
            response.headers.setdefault("Sunset", _SUNSET)
            return response

        return handler


def create_compat_router(components: RuntimeComponents) -> APIRouter:
    """Build the unversioned router with runtime dependencies injected explicitly."""

    router = APIRouter(tags=["v0-compat"], route_class=CompatRoute)

    def current_settings() -> Settings:
        return components.settings.current

    def require_sidecar_auth(request: Request) -> None:
        components.security.require(request.headers)

    auth = Depends(require_sidecar_auth)

    @router.get("/health")
    def health(response: Response) -> dict[str, Any]:
        response.headers["Deprecation"] = "true"
        response.headers["Sunset"] = _SUNSET
        settings = current_settings()
        return {
            "ok": True,
            "version": APP_VERSION,
            "nai_configured": settings.nai_configured,
            "llm_configured": settings.llm_configured,
        }

    @router.get("/settings")
    def get_settings() -> dict[str, Any]:
        return _settings_payload(current_settings())

    @router.post("/settings", dependencies=[auth])
    async def update_settings(req: SettingsUpdateRequest) -> dict[str, Any]:
        updated = await components.settings.update(req.model_dump(exclude_none=True))
        return _settings_payload(updated)

    @router.get("/auth/token/status")
    def token_status() -> dict[str, Any]:
        return _token_status(current_settings())

    @router.post("/auth/token", dependencies=[auth])
    async def set_token(req: TokenRequest) -> dict[str, Any]:
        settings = current_settings()
        try:
            set_stored_token(settings.data_dir, req.token)
        except CredentialStorageError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        updated = await components.settings.reload()
        return _token_status(updated)

    @router.delete("/auth/token", dependencies=[auth])
    async def delete_token() -> dict[str, Any]:
        delete_stored_token(current_settings().data_dir)
        updated = await components.settings.reload()
        return _token_status(updated)

    @router.get("/auth/llm-key/status")
    def llm_key_status() -> dict[str, Any]:
        return _llm_status(current_settings())

    @router.post("/auth/llm-key", dependencies=[auth])
    async def set_llm_key(req: LlmKeyRequest) -> dict[str, Any]:
        settings = current_settings()
        setter = set_stored_llm_backup_key if req.slot == "backup" else set_stored_llm_key
        try:
            setter(settings.data_dir, req.api_key)
        except CredentialStorageError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        updated = await components.settings.reload()
        return _llm_status(updated)

    @router.delete("/auth/llm-key", dependencies=[auth])
    async def delete_llm_key(
        # 必须与 POST 侧同样收窄:裸 str 时任何拼错的值(slot=backupp、Backup)
        # 都会落进 else 分支,把**主**密钥删掉。删错凭据不可撤销,故宁可 422。
        slot: Literal["primary", "backup"] = "primary",
    ) -> dict[str, Any]:
        settings = current_settings()
        remover = delete_stored_llm_backup_key if slot == "backup" else delete_stored_llm_key
        remover(settings.data_dir)
        updated = await components.settings.reload()
        return _llm_status(updated)

    @router.get("/history", dependencies=[auth])
    async def history(limit: int = 100) -> dict[str, Any]:
        safe_limit = min(max(limit, 1), 100)
        jobs = await components.jobs.list_jobs(limit=safe_limit)
        return {"items": [_compat_history_item(job) for job in jobs]}

    @router.get("/images/{image_id}")
    async def image(image_id: str) -> FileResponse:
        asset = await components.assets.get_asset(image_id)
        if asset is not None and asset.status == "available":
            path = components.assets.root.joinpath(*asset.relative_path.split("/"))
            if path.is_file():
                return FileResponse(
                    path,
                    media_type=asset.media_type or "application/octet-stream",
                )
        settings = current_settings()
        # get_generation 是同步 SQLite(每次新建连接 + 4 条 PRAGMA)。在 async
        # 路由里直接调会阻塞事件循环,推到线程池执行。
        record = await asyncio.to_thread(get_generation, settings, image_id)
        if not record or record.status != "success" or not record.image_path:
            raise HTTPException(status_code=404, detail="image not found")
        path = Path(record.image_path)
        expected_path = image_path(settings, image_id)
        if path != expected_path or not path.exists():
            raise HTTPException(status_code=404, detail="image not found")
        return FileResponse(path, media_type="image/png")

    @router.post("/generate", dependencies=[auth])
    async def generate(req: GenerateRequest, request: Request) -> dict[str, Any]:
        created = await components.jobs.create_job(
            req.model_dump(mode="json"),
            idempotency_key=request.headers.get("Idempotency-Key"),
        )
        job = await components.jobs.wait_for_terminal(created.job.id)
        if job.status.value != "succeeded" or job.result is None:
            status = 409 if job.status.value == "cancelled" else 502
            raise HTTPException(
                status_code=status,
                detail={
                    "message": job.error_message or f"generation {job.status.value}",
                    "task_id": job.id,
                    "code": job.error_code,
                },
            )
        return dict(job.result)

    @router.get("/generation/tasks")
    async def generation_tasks() -> dict[str, Any]:
        jobs = await components.jobs.list_jobs(limit=100)
        return {"items": [job.to_dict() for job in jobs]}

    @router.post("/generation/tasks/{task_id}/cancel")
    async def cancel_generation_task(task_id: str) -> dict[str, Any]:
        try:
            job = await components.jobs.cancel_job(task_id)
        except Exception as exc:
            code = str(getattr(exc, "code_value", getattr(exc, "code", "cancel_failed")))
            status = 404 if code == "job_not_found" else 409
            raise HTTPException(
                status_code=status,
                detail={"message": str(exc), "code": code},
            ) from exc
        return {"ok": True, "task_id": job.id, "status": job.status.value}

    @router.post("/vibe/encode", dependencies=[auth])
    async def vibe_encode(req: VibeEncodeRequest) -> dict[str, Any]:
        settings = current_settings()
        if settings.mock_generation:
            return {"encoding": "mock-vibe-encoding"}
        try:
            encoding = await encode_vibe(
                settings=settings,
                image=req.image,
                information_extracted=req.information_extracted,
                model=req.model,
                http=components.http,
            )
            return {"encoding": encoding}
        except NovelAIError as exc:
            status = 400 if exc.status_code == 0 else 502
            raise HTTPException(status_code=status, detail=str(exc)) from exc

    @router.post("/upscale", dependencies=[auth])
    async def upscale(req: UpscaleRequest) -> Response:
        settings = current_settings()
        try:
            if settings.mock_generation:
                payload = image_path(settings, "__mock__")
                if payload.exists():
                    return Response(payload.read_bytes(), media_type="image/png")
                mock = write_mock_image(settings, "__mock__")
                return Response(mock.read_bytes(), media_type="image/png")
            image_payload = await upscale_image(
                settings=settings,
                image=req.image,
                width=req.width,
                height=req.height,
                scale=req.scale,
                http=components.http,
            )
            return Response(image_payload, media_type="image/png")
        except NovelAIError as exc:
            status = 400 if exc.status_code == 0 else 502
            raise HTTPException(status_code=status, detail=str(exc)) from exc

    @router.post("/agent/generate-prompt", dependencies=[auth])
    async def agent_generate_prompt(req: AgentGeneratePromptRequest) -> dict[str, Any]:
        try:
            result = await convert_natural_to_tags(
                settings=current_settings(),
                user_input=req.input,
                fallback_params=req.params,
                fallback_negative=req.negative,
                http=components.http,
            )
        except LLMNotConfiguredError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except LLMConversionError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        return {
            "tags": result.tags,
            "negative": result.negative,
            "params": result.params.model_dump(),
        }

    @router.post("/api/agent/web/generate-prompt", dependencies=[auth])
    async def legacy_agent_web_generate_prompt(
        req: AgentWebGeneratePromptRequest,
        request: Request,
    ) -> StreamingResponse:
        agent = components.agent
        if not isinstance(agent, DesktopAgentAdapter):
            raise HTTPException(
                status_code=503,
                detail={
                    "code": "desktop_agent_unavailable",
                    "message": "the desktop Agent adapter is unavailable",
                },
            )

        channel = SseChannel()
        try:
            prepared = await agent.prepare(req, channel.emit)
        except AgentRuntimeUnavailable as exc:
            raise HTTPException(
                status_code=503,
                detail={"code": exc.code, "message": str(exc)},
            ) from exc
        except AgentRequestValidationError as exc:
            raise HTTPException(
                status_code=422,
                detail={"code": exc.code, "message": str(exc)},
            ) from exc

        request_id = str(getattr(request.state, "request_id", "") or "unknown")

        async def produce() -> None:
            try:
                result = await prepared.run(channel.emit)
                await channel.emit_final(result.model_dump(mode="json"))
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                # Provider bodies can contain request material. Keep logs and the
                # SSE payload limited to a stable classification.
                logger.warning(
                    "desktop Agent request failed request_id=%s error_type=%s",
                    request_id,
                    type(exc).__name__,
                )
                await channel.emit(
                    SseEvent(event="error", data=public_agent_error(exc, request_id))
                )
            finally:
                await channel.close()

        try:
            producer = components.tasks.create_task(
                produce(),
                name=f"desktop-agent-{request_id}",
                paid=True,
            )
        except RuntimeNotReadyError as exc:
            await channel.close()
            raise HTTPException(
                status_code=503,
                detail={
                    "code": exc.code_value,
                    "message": "the sidecar is draining and cannot start an Agent request",
                },
            ) from exc
        channel.bind_producer(producer)
        return StreamingResponse(
            _agent_event_stream(channel, producer),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-store",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    @router.post("/api/translate/en2zh", dependencies=[auth])
    async def legacy_translate_en2zh(req: ChatCompletionRequest) -> dict[str, Any]:
        return await _chat_completion_response(current_settings(), req, components.http)

    @router.post("/api/translate/proxy", dependencies=[auth])
    async def legacy_translate_proxy(req: ChatCompletionRequest) -> dict[str, Any]:
        return await _chat_completion_response(current_settings(), req, components.http)

    @router.post("/api/tags/translations/lookup")
    def tag_translation_lookup(req: TagTranslationLookupRequest) -> dict[str, str]:
        return lookup_tag_translations(current_settings(), req.tags)

    @router.post("/api/tags/translations/submit")
    def tag_translation_submit(req: TagTranslationSubmitRequest) -> dict[str, Any]:
        count = upsert_tag_translations(
            current_settings(),
            [entry.model_dump() for entry in req.entries],
        )
        return {"ok": True, "count": count}

    @router.post("/metadata/import")
    async def metadata_import() -> dict[str, Any]:
        return {
            "metadata": None,
            "warnings": ["metadata import adapter is not configured yet"],
        }

    register_library_compat_routes(router, components.library, auth)
    register_tag_routes(router, current_settings, auth, components.http)

    @router.get("/api/anlas", dependencies=[auth])
    async def legacy_anlas() -> dict[str, Any]:
        settings = current_settings()
        if not settings.nai_configured:
            return {
                "fixedTrainingStepsLeft": 0,
                "purchasedTrainingSteps": 0,
                "isOpus": False,
                "configured": False,
            }
        if settings.mock_generation and not settings.nai_token:
            return {
                "fixedTrainingStepsLeft": 0,
                "purchasedTrainingSteps": 0,
                "isOpus": False,
                "configured": True,
            }
        try:
            return {
                **await fetch_anlas(settings, http=components.http),
                "configured": True,
            }
        except NovelAIError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    @router.get("/api/data/{filename}")
    def legacy_data_file(filename: str) -> Any:
        return _legacy_data_payload(current_settings(), filename)

    @router.get("/api/nai-status")
    def legacy_nai_status() -> dict[str, Any]:
        return {"ok": True, "status": "unknown", "configured": False}

    @router.post("/api/online/heartbeat")
    def legacy_online_heartbeat() -> dict[str, Any]:
        return {"ok": True, "online": 1, "configured": False}

    @router.get("/api/online/count")
    def legacy_online_count() -> dict[str, Any]:
        return {"count": 1, "configured": False}

    return router


def register_compat_routes(app: FastAPI, components: RuntimeComponents) -> None:
    """Mount the compatibility transport on the application composition root."""

    app.include_router(create_compat_router(components))


async def _agent_event_stream(
    channel: SseChannel,
    producer: asyncio.Task[None],
) -> AsyncIterator[str]:
    """Join the Agent producer when Starlette finalizes a disconnected stream."""

    try:
        async for event in channel.iter_sse():
            yield event
    finally:
        if not producer.done():
            producer.cancel()
        await asyncio.gather(producer, return_exceptions=True)


def _compat_history_item(job: Any) -> dict[str, Any]:
    payload = dict(job.payload)
    result = dict(job.result or {})
    status = {
        "succeeded": "success",
        "queued": "pending",
        "running": "pending",
        "cancelling": "pending",
    }.get(job.status.value, "error")
    image_path = result.get("image_path") if status == "success" else None
    return {
        "id": job.id,
        "image_id": job.id,
        "image_url": result.get("image_url") if status == "success" else None,
        "image_path": image_path,
        "input": result.get("input", payload.get("input", "")),
        "mode": result.get("mode", payload.get("mode", "tags")),
        "tags": result.get("tags", payload.get("tags", "")),
        "negative": result.get("negative", payload.get("negative", "")),
        "params": result.get("params", payload.get("params", {})),
        "status": status,
        "error": job.error_message,
        "created_at": job.created_at.isoformat(),
    }


async def _chat_completion_response(
    settings: Settings,
    req: ChatCompletionRequest,
    http: HttpClientPool,
) -> dict[str, Any]:
    try:
        return await chat_completion(
            settings=settings,
            messages=[message.model_dump() for message in req.messages],
            temperature=req.temperature,
            max_tokens=req.max_tokens,
            http=http,
        )
    except LLMNotConfiguredError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except LLMConversionError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


def _legacy_data_payload(settings: Settings, filename: str) -> Any:
    if "/" in filename or "\\" in filename:
        raise HTTPException(status_code=400, detail="invalid data filename")

    data_paths = [
        settings.data_dir / "data" / filename,
        Path(__file__).resolve().parents[3] / "server" / "data" / filename,
    ]
    for path in data_paths:
        if path.is_file():
            try:
                return json.loads(path.read_text(encoding="utf-8"))
            except json.JSONDecodeError as exc:
                raise HTTPException(
                    status_code=500,
                    detail=f"invalid JSON data file: {filename}",
                ) from exc

    if filename == "role_tag_mapping.json":
        return {}
    if filename in {"NAI_NSFW.json", "NAI_Common.json", "oc_data.json"}:
        return []
    return {"filename": filename, "items": [], "configured": False}


def _token_status(settings: Settings) -> dict[str, Any]:
    env_configured = bool(os.environ.get("NAI_TOKEN", "").strip())
    return {
        "configured": bool(settings.nai_token),
        "source": (
            "environment"
            if env_configured
            else ("credential-store" if settings.nai_token else "none")
        ),
        "mock_generation": settings.mock_generation,
    }


def _llm_status(settings: Settings) -> dict[str, Any]:
    return {
        "provider": settings.llm_provider,
        "key_configured": bool(settings.llm_api_key),
        "backup_provider": settings.llm_backup_provider,
        "backup_key_configured": bool(settings.llm_backup_api_key),
        "llm_configured": settings.llm_configured,
    }


def _settings_payload(settings: Settings) -> dict[str, Any]:
    return {
        "version": APP_VERSION,
        "data_dir": str(settings.data_dir),
        "nai_base_url": settings.nai_base_url,
        "nai_configured": settings.nai_configured,
        "llm_provider": settings.llm_provider,
        "llm_base_url": settings.llm_base_url,
        "llm_model": settings.llm_model,
        "llm_network_scope": settings.llm_network_scope,
        "llm_trusted_networks": list(settings.llm_trusted_networks),
        "llm_key_configured": bool(settings.llm_api_key),
        "llm_backup_provider": settings.llm_backup_provider,
        "llm_backup_base_url": settings.llm_backup_base_url,
        "llm_backup_model": settings.llm_backup_model,
        "llm_backup_network_scope": settings.llm_backup_network_scope,
        "llm_backup_trusted_networks": list(settings.llm_backup_trusted_networks),
        "llm_backup_key_configured": bool(settings.llm_backup_api_key),
        "llm_configured": settings.llm_configured,
        "token": _token_status(settings),
    }


__all__ = ["create_compat_router", "register_compat_routes"]
