"""Explicit compatibility aliases for the unversioned (v0) desktop API."""

from __future__ import annotations

from collections.abc import Callable, Coroutine
from typing import Any

from fastapi import APIRouter, Path, Query, Request
from fastapi.responses import JSONResponse, Response
from fastapi.routing import APIRoute

from backend_core.errors import AppError, ResourceNotFoundError
from sidecar.runtime import AppRuntime

from ..dependencies import require_jobs
from ..problems import app_error_problem


class V0CompatRoute(APIRoute):
    """Translate domain errors to the historical JSON error envelope."""

    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        original = super().get_route_handler()

        async def handler(request: Request) -> Response:
            try:
                return await original(request)
            except AppError as exc:
                problem = app_error_problem(exc, request)
                return JSONResponse(
                    status_code=problem.status,
                    content={"detail": problem.detail, "code": problem.code},
                )

        return handler


def create_v0_compat_router(runtime: AppRuntime | None = None) -> APIRouter:
    """Create opt-in legacy aliases backed by the same job service as v1.

    This router is not included by default because ``sidecar.server`` still owns the
    current v0 paths.  A future composition root can replace those handlers without
    copying queue logic into the transport layer.
    """

    router = APIRouter(
        tags=["v0-compat"],
        include_in_schema=False,
        route_class=V0CompatRoute,
    )

    @router.get("/generation/tasks")
    async def generation_tasks(
        request: Request,
        limit: int = Query(default=100, ge=1, le=100),
        offset: int = Query(default=0, ge=0),
    ) -> dict[str, Any]:
        jobs = await require_jobs(request, runtime)
        records = await jobs.list_jobs(limit=limit, offset=offset)
        return {"items": [dict(record.to_dict()) for record in records]}

    @router.post("/generation/tasks/{task_id}/cancel")
    async def cancel_generation_task(
        request: Request,
        task_id: str = Path(min_length=1, max_length=128),
    ) -> dict[str, Any]:
        jobs = await require_jobs(request, runtime)
        record = await jobs.cancel_job(task_id)
        if record is None:
            raise ResourceNotFoundError(
                "generation job was not found",
                code="job_not_found",
                details={"job_id": task_id},
            )
        return {"ok": True, "task_id": task_id, "job": dict(record.to_dict())}

    return router
