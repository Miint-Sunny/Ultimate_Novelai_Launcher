from __future__ import annotations

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.datastructures import Headers
from starlette.types import ASGIApp, Receive, Scope, Send

from sidecar.security import AuthManager, SecurityError

from .dependencies import map_security_error
from .problems import app_error_problem, problem_response


class SidecarAuthMiddleware:
    """Authenticate private routes without buffering or consuming request bodies."""

    def __init__(self, app: ASGIApp, *, manager: AuthManager) -> None:
        self.app = app
        self.manager = manager

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or _is_public(scope):
            await self.app(scope, receive, send)
            return
        path = str(scope.get("path", ""))
        request = Request(scope, receive=receive)
        try:
            headers = Headers(scope=scope)
            if path == "/api/v1" or path.startswith("/api/v1/"):
                self.manager.require_bearer(headers)
            else:
                self.manager.require(headers)
        except SecurityError as exc:
            if path == "/api/v1" or path.startswith("/api/v1/"):
                mapped = map_security_error(exc)
                if mapped is None:  # pragma: no cover - every SecurityError has status/code
                    raise
                response = problem_response(app_error_problem(mapped, request))
            else:
                response = JSONResponse(
                    status_code=exc.status,
                    content={
                        "detail": "unauthorized sidecar request",
                        "code": exc.code,
                    },
                    headers={"Cache-Control": "no-store"},
                )
            await response(scope, receive, send)
            return
        await self.app(scope, receive, send)


def _is_public(scope: Scope) -> bool:
    method = str(scope.get("method", "GET")).upper()
    path = str(scope.get("path", ""))
    return (
        method == "OPTIONS"
        or path == "/livez"
        or (method == "POST" and path == "/api/v1/auth/pair/exchange")
    )


__all__ = ["SidecarAuthMiddleware"]
