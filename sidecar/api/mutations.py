from __future__ import annotations

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from backend_core.errors import RuntimeNotReadyError
from sidecar.runtime import AppRuntime

from .problems import app_error_problem, problem_response

_MUTATION_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


class MutationGateMiddleware:
    """Admit state changes atomically with runtime drain/restore."""

    def __init__(self, app: ASGIApp, *, runtime: AppRuntime) -> None:
        self.app = app
        self.runtime = runtime

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        request = Request(scope, receive=receive)
        if request.method not in _MUTATION_METHODS or _is_drain_controller(request):
            await self.app(scope, receive, send)
            return
        try:
            async with self.runtime.mutations.admit():
                await self.app(scope, receive, send)
        except RuntimeNotReadyError as exc:
            if request.url.path == "/api/v1" or request.url.path.startswith("/api/v1/"):
                response = problem_response(app_error_problem(exc, request))
            else:
                response = JSONResponse(
                    status_code=503,
                    content={"detail": exc.message, "code": exc.code_value, "retryable": True},
                    headers={"Cache-Control": "no-store"},
                )
            await response(scope, receive, send)


def _is_drain_controller(request: Request) -> bool:
    path = request.url.path
    if path == "/api/v1/system/drain" and request.method == "POST":
        return True
    return (
        request.method == "POST"
        and path.startswith("/api/v1/backups/")
        and path.endswith("/restore")
    )


__all__ = ["MutationGateMiddleware"]
