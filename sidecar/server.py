from __future__ import annotations

import logging
import os
import uuid
import json
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

from . import APP_VERSION
from .config import Settings, load_settings
from .credentials import delete_stored_token, set_stored_token
from .db import (
    create_generation,
    get_generation,
    init_db,
    list_history,
    lookup_tag_translations,
    mark_error,
    mark_success,
    upsert_tag_translations,
)
from .library import init_library
from .library_routes import register_library_routes
from .local_settings import write_local_settings
from .llm.client import LLMConversionError, LLMNotConfiguredError, chat_completion, convert_natural_to_tags
from .nai.client import NovelAIError, encode_vibe, fetch_anlas, generate_image, generate_image_from_payload, upscale_image
from .nai.models import GenerateRequest, GenerationParams, ResolvedPrompt
from .storage import image_path, write_mock_image

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)


class TokenRequest(BaseModel):
    token: str = Field(min_length=1)


class SettingsUpdateRequest(BaseModel):
    nai_base_url: str | None = None
    llm_base_url: str | None = None
    llm_model: str | None = None


class VibeEncodeRequest(BaseModel):
    image: str = Field(min_length=1)
    information_extracted: float = 0.5
    model: str = "nai-diffusion-4-5-full"


class UpscaleRequest(BaseModel):
    image: str = Field(min_length=1)
    width: int
    height: int
    scale: int | float = 4


class AgentGeneratePromptRequest(BaseModel):
    input: str = Field(min_length=1)
    params: GenerationParams = Field(default_factory=GenerationParams)
    negative: str = ""


class AgentWebGeneratePromptRequest(BaseModel):
    user_request: str = Field(min_length=1)
    current_negative: str = ""


class ChatMessage(BaseModel):
    role: str = Field(min_length=1)
    content: str = Field(min_length=1)


class ChatCompletionRequest(BaseModel):
    messages: list[ChatMessage] = Field(min_length=1)
    temperature: float = 0.3
    max_tokens: int = 1000


class TagTranslationLookupRequest(BaseModel):
    tags: list[str] = Field(default_factory=list)


class TagTranslationEntry(BaseModel):
    tag: str = Field(min_length=1)
    zh: str = Field(min_length=1)
    source: str = "ai"


class TagTranslationSubmitRequest(BaseModel):
    entries: list[TagTranslationEntry] = Field(default_factory=list)


def create_app(settings: Settings | None = None) -> FastAPI:
    resolved_settings = settings or load_settings()

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        init_db(resolved_settings)
        init_library(resolved_settings)
        logger.info("Ultimate Novelai launcher sidecar ready at data_dir=%s", resolved_settings.data_dir)
        yield

    app = FastAPI(title="Ultimate Novelai launcher Sidecar", version=APP_VERSION, lifespan=lifespan)
    app.state.settings = resolved_settings

    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://127.0.0.1:1420",
            "http://localhost:1420",
            "http://127.0.0.1:5173",
            "http://localhost:5173",
            "tauri://localhost",
            "https://tauri.localhost",
        ],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/health")
    def health() -> dict[str, Any]:
        return {
            "ok": True,
            "version": APP_VERSION,
            "nai_configured": resolved_settings.nai_configured,
            "llm_configured": resolved_settings.llm_configured,
            "data_dir": str(resolved_settings.data_dir),
        }

    @app.get("/settings")
    def get_settings() -> dict[str, Any]:
        return _settings_payload(resolved_settings)

    @app.post("/settings")
    def update_settings(req: SettingsUpdateRequest) -> dict[str, Any]:
        nonlocal resolved_settings
        updates = req.model_dump(exclude_none=True)
        write_local_settings(resolved_settings.data_dir, updates)
        if settings is None:
            resolved_settings = load_settings()
            app.state.settings = resolved_settings
        return _settings_payload(resolved_settings)

    @app.get("/auth/token/status")
    def token_status() -> dict[str, Any]:
        return _token_status(resolved_settings)

    @app.post("/auth/token")
    def set_token(req: TokenRequest) -> dict[str, Any]:
        nonlocal resolved_settings
        set_stored_token(resolved_settings.data_dir, req.token)
        if settings is None:
            resolved_settings = load_settings()
            app.state.settings = resolved_settings
        return _token_status(resolved_settings)

    @app.delete("/auth/token")
    def delete_token() -> dict[str, Any]:
        nonlocal resolved_settings
        delete_stored_token(resolved_settings.data_dir)
        if settings is None:
            resolved_settings = load_settings()
            app.state.settings = resolved_settings
        return _token_status(resolved_settings)

    @app.get("/history")
    def history(limit: int = 100) -> dict[str, Any]:
        safe_limit = min(max(limit, 1), 100)
        return {"items": [record.to_api() for record in list_history(resolved_settings, safe_limit)]}

    @app.get("/images/{image_id}")
    def image(image_id: str) -> FileResponse:
        record = get_generation(resolved_settings, image_id)
        if not record or record.status != "success" or not record.image_path:
            raise HTTPException(status_code=404, detail="image not found")
        path = Path(record.image_path)
        expected_path = image_path(resolved_settings, image_id)
        if path != expected_path or not path.exists():
            raise HTTPException(status_code=404, detail="image not found")
        return FileResponse(path, media_type="image/png")

    @app.post("/generate")
    async def generate(req: GenerateRequest) -> dict[str, Any]:
        try:
            resolved = await _resolve_prompt(resolved_settings, req)
        except LLMNotConfiguredError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except LLMConversionError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

        if not resolved.tags:
            raise HTTPException(status_code=400, detail="prompt tags are empty")

        generation_id = uuid.uuid4().hex
        record = create_generation(
            resolved_settings,
            generation_id=generation_id,
            user_input=req.input,
            mode=req.mode,
            tags=resolved.tags,
            negative=resolved.negative,
            params=resolved.params.model_dump(),
        )

        try:
            if resolved_settings.mock_generation:
                path = write_mock_image(resolved_settings, generation_id)
            elif req.legacy_payload:
                payload = await generate_image_from_payload(
                    settings=resolved_settings,
                    payload=req.legacy_payload,
                )
                path = image_path(resolved_settings, generation_id)
                path.write_bytes(payload)
            else:
                payload = await generate_image(
                    settings=resolved_settings,
                    tags=resolved.tags,
                    negative=resolved.negative,
                    params=resolved.params,
                )
                path = image_path(resolved_settings, generation_id)
                path.write_bytes(payload)
            record = mark_success(resolved_settings, generation_id, path)
        except NovelAIError as exc:
            record = mark_error(resolved_settings, generation_id, str(exc))
            raise HTTPException(
                status_code=400 if exc.status_code == 0 else 502,
                detail={"message": str(exc), "record": record.to_api()},
            ) from exc
        except Exception as exc:
            record = mark_error(resolved_settings, generation_id, "generation failed")
            logger.exception("generation failed")
            raise HTTPException(
                status_code=500,
                detail={"message": "generation failed", "record": record.to_api()},
            ) from exc

        api_record = record.to_api()
        return {
            "image_id": api_record["image_id"],
            "image_url": api_record["image_url"],
            "image_path": api_record["image_path"],
            "input": api_record["input"],
            "tags": api_record["tags"],
            "negative": api_record["negative"],
            "params": api_record["params"],
            "created_at": api_record["created_at"],
        }

    @app.get("/generation/tasks")
    def generation_tasks() -> dict[str, Any]:
        return {"items": []}

    @app.post("/generation/tasks/{task_id}/cancel")
    def cancel_generation_task(task_id: str) -> dict[str, Any]:
        return {"ok": False, "task_id": task_id, "message": "no active local task runner is configured"}

    @app.post("/vibe/encode")
    async def vibe_encode(req: VibeEncodeRequest) -> dict[str, Any]:
        if resolved_settings.mock_generation:
            return {"encoding": "mock-vibe-encoding"}
        try:
            encoding = await encode_vibe(
                settings=resolved_settings,
                image=req.image,
                information_extracted=req.information_extracted,
                model=req.model,
            )
            return {"encoding": encoding}
        except NovelAIError as exc:
            raise HTTPException(status_code=400 if exc.status_code == 0 else 502, detail=str(exc)) from exc

    @app.post("/upscale")
    async def upscale(req: UpscaleRequest) -> Response:
        try:
            if resolved_settings.mock_generation:
                payload = image_path(resolved_settings, "__mock__")
                if payload.exists():
                    return Response(payload.read_bytes(), media_type="image/png")
                return Response(write_mock_image(resolved_settings, "__mock__").read_bytes(), media_type="image/png")
            image = await upscale_image(
                settings=resolved_settings,
                image=req.image,
                width=req.width,
                height=req.height,
                scale=req.scale,
            )
            return Response(image, media_type="image/png")
        except NovelAIError as exc:
            raise HTTPException(status_code=400 if exc.status_code == 0 else 502, detail=str(exc)) from exc

    @app.post("/agent/generate-prompt")
    async def agent_generate_prompt(req: AgentGeneratePromptRequest) -> dict[str, Any]:
        try:
            result = await convert_natural_to_tags(
                settings=resolved_settings,
                user_input=req.input,
                fallback_params=req.params,
                fallback_negative=req.negative,
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

    @app.post("/api/agent/web/generate-prompt")
    async def legacy_agent_web_generate_prompt(req: AgentWebGeneratePromptRequest) -> StreamingResponse:
        return StreamingResponse(
            _legacy_agent_sse(resolved_settings, req),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.post("/api/translate/en2zh")
    async def legacy_translate_en2zh(req: ChatCompletionRequest) -> dict[str, Any]:
        return await _chat_completion_response(resolved_settings, req)

    @app.post("/api/translate/proxy")
    async def legacy_translate_proxy(req: ChatCompletionRequest) -> dict[str, Any]:
        return await _chat_completion_response(resolved_settings, req)

    @app.get("/tags/search")
    def tags_search(q: str = "", limit: int = 20) -> dict[str, Any]:
        return {"items": [], "query": q, "limit": min(max(limit, 1), 100)}

    @app.post("/api/tags/translations/lookup")
    def tag_translation_lookup(req: TagTranslationLookupRequest) -> dict[str, str]:
        return lookup_tag_translations(resolved_settings, req.tags)

    @app.post("/api/tags/translations/submit")
    def tag_translation_submit(req: TagTranslationSubmitRequest) -> dict[str, Any]:
        count = upsert_tag_translations(
            resolved_settings,
            [entry.model_dump() for entry in req.entries],
        )
        return {"ok": True, "count": count}

    @app.post("/metadata/import")
    async def metadata_import() -> dict[str, Any]:
        return {"metadata": None, "warnings": ["metadata import adapter is not configured yet"]}

    register_library_routes(app, resolved_settings)

    @app.get("/api/anlas")
    async def legacy_anlas() -> dict[str, Any]:
        if not resolved_settings.nai_configured:
            return {
                "fixedTrainingStepsLeft": 0,
                "purchasedTrainingSteps": 0,
                "isOpus": False,
                "configured": False,
            }
        if resolved_settings.mock_generation and not resolved_settings.nai_token:
            return {
                "fixedTrainingStepsLeft": 0,
                "purchasedTrainingSteps": 0,
                "isOpus": False,
                "configured": True,
            }
        try:
            return {**await fetch_anlas(resolved_settings), "configured": True}
        except NovelAIError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

    @app.get("/api/data/{filename}")
    def legacy_data_file(filename: str) -> Any:
        return _legacy_data_payload(resolved_settings, filename)

    @app.get("/api/nai-status")
    def legacy_nai_status() -> dict[str, Any]:
        return {"ok": True, "status": "unknown", "configured": False}

    @app.post("/api/online/heartbeat")
    def legacy_online_heartbeat() -> dict[str, Any]:
        return {"ok": True, "online": 1, "configured": False}

    @app.get("/api/online/count")
    def legacy_online_count() -> dict[str, Any]:
        return {"count": 1, "configured": False}

    return app


async def _resolve_prompt(settings: Settings, req: GenerateRequest) -> ResolvedPrompt:
    negative = req.negative or ""
    if req.mode == "tags":
        return ResolvedPrompt(
            tags=(req.tags or req.input).strip(),
            negative=negative,
            params=req.params,
        )

    return await convert_natural_to_tags(
        settings=settings,
        user_input=req.input,
        fallback_params=req.params,
        fallback_negative=negative,
    )


async def _chat_completion_response(settings: Settings, req: ChatCompletionRequest) -> dict[str, Any]:
    try:
        return await chat_completion(
            settings=settings,
            messages=[message.model_dump() for message in req.messages],
            temperature=req.temperature,
            max_tokens=req.max_tokens,
        )
    except LLMNotConfiguredError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except LLMConversionError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


async def _legacy_agent_sse(settings: Settings, req: AgentWebGeneratePromptRequest):
    try:
        result = await convert_natural_to_tags(
            settings=settings,
            user_input=req.user_request,
            fallback_params=GenerationParams(),
            fallback_negative=req.current_negative,
        )
        yield _sse(
            "final",
            {
                "thinking": "",
                "positive": result.tags,
                "negative": result.negative,
                "characters": [],
            },
        )
    except (LLMNotConfiguredError, LLMConversionError) as exc:
        yield _sse("error", {"message": str(exc)})
    except Exception:
        logger.exception("legacy agent stream failed")
        yield _sse("error", {"message": "agent generation failed"})


def _sse(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _legacy_data_payload(settings: Settings, filename: str) -> Any:
    if "/" in filename or "\\" in filename:
        raise HTTPException(status_code=400, detail="invalid data filename")

    data_paths = [
        settings.data_dir / "data" / filename,
        Path(__file__).resolve().parent.parent / "server" / "data" / filename,
    ]
    for path in data_paths:
        if path.is_file():
            try:
                return json.loads(path.read_text(encoding="utf-8"))
            except json.JSONDecodeError as exc:
                raise HTTPException(status_code=500, detail=f"invalid JSON data file: {filename}") from exc

    if filename == "role_tag_mapping.json":
        return {}
    if filename in {"NAI_NSFW.json", "NAI_Common.json", "oc_data.json"}:
        return []
    return {"filename": filename, "items": [], "configured": False}


def _token_status(settings: Settings) -> dict[str, Any]:
    env_configured = bool(os.environ.get("NAI_TOKEN", "").strip())
    return {
        "configured": bool(settings.nai_token),
        "source": "environment" if env_configured else ("credential-store" if settings.nai_token else "none"),
        "mock_generation": settings.mock_generation,
    }


def _settings_payload(settings: Settings) -> dict[str, Any]:
    return {
        "version": APP_VERSION,
        "data_dir": str(settings.data_dir),
        "nai_base_url": settings.nai_base_url,
        "nai_configured": settings.nai_configured,
        "llm_base_url": settings.llm_base_url,
        "llm_model": settings.llm_model,
        "llm_configured": settings.llm_configured,
        "token": _token_status(settings),
    }


app = create_app()


if __name__ == "__main__":
    runtime_settings = load_settings()
    uvicorn.run(
        "sidecar.server:app",
        host=runtime_settings.host,
        port=runtime_settings.port,
        reload=False,
    )
