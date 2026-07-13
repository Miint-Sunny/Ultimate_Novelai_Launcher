"""Problem Details translation for the HTTP adapter."""

from __future__ import annotations

import logging
import uuid
from collections.abc import Callable, Coroutine, Mapping
from typing import Any

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from fastapi.routing import APIRoute
from starlette.datastructures import Headers, MutableHeaders
from starlette.exceptions import HTTPException
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from backend_core.errors import (
    AppError,
    AuthenticationRequiredError,
    CapacityExceededError,
    ConflictError,
    DependencyUnavailableError,
    InvalidArgumentError,
    PermissionDeniedError,
    ResourceExpiredError,
    ResourceNotFoundError,
    RuntimeNotReadyError,
)
from sidecar.security.body_limit import BODY_LIMIT_ERROR_STATE_KEY
from sidecar.security.errors import RequestBodyTooLargeError

from .models import ProblemDetails, ProblemFieldError

logger = logging.getLogger(__name__)
PROBLEM_MEDIA_TYPE = "application/problem+json"


_DOMAIN_STATUS: tuple[tuple[type[AppError], int, str], ...] = (
    (InvalidArgumentError, 400, "Invalid request"),
    (AuthenticationRequiredError, 401, "Authentication required"),
    (PermissionDeniedError, 403, "Permission denied"),
    (ResourceNotFoundError, 404, "Resource not found"),
    (ResourceExpiredError, 410, "Resource expired"),
    (ConflictError, 409, "Conflict"),
    (CapacityExceededError, 429, "Capacity exceeded"),
    (RuntimeNotReadyError, 503, "Service not ready"),
    (DependencyUnavailableError, 503, "Dependency unavailable"),
)


def problem_response(
    problem: ProblemDetails,
    *,
    headers: Mapping[str, str] | None = None,
) -> JSONResponse:
    return JSONResponse(
        status_code=problem.status,
        content=problem.model_dump(mode="json"),
        media_type=PROBLEM_MEDIA_TYPE,
        headers=dict(headers or {}),
    )


def app_error_problem(exc: AppError, request: Request) -> ProblemDetails:
    status, title = 500, "Internal server error"
    for error_type, mapped_status, mapped_title in _DOMAIN_STATUS:
        if isinstance(exc, error_type):
            status, title = mapped_status, mapped_title
            break
    if exc.code_value == "insufficient_storage":
        status, title = 507, "Insufficient storage"
    elif exc.code_value == "queue_full":
        status, title = 503, "Generation queue unavailable"
    return ProblemDetails(
        type=f"urn:ultimate-novelai:problem:{exc.code_value}",
        title=title,
        status=status,
        detail=(
            exc.message if status < 500 or status in {503, 507} else "an internal error occurred"
        ),
        request_id=request_id_for(request),
        instance=request.url.path,
        code=exc.code_value,
        retryable=exc.retryable or status in {429, 503},
        context=exc.details if status < 500 or status in {503, 507} else {},
    )


def validation_problem(exc: RequestValidationError, request: Request) -> ProblemDetails:
    raw_errors = exc.errors()
    errors = [
        ProblemFieldError(
            location=".".join(str(part) for part in item.get("loc", ())),
            message=str(item.get("msg", "invalid value")),
            code=str(item.get("type", "validation_error")),
        )
        for item in raw_errors
    ]
    malformed_json = any(str(item.get("type", "")) == "json_invalid" for item in raw_errors)
    if malformed_json:
        return ProblemDetails(
            type="urn:ultimate-novelai:problem:invalid_request_body",
            title="Invalid request body",
            status=400,
            detail="request body contains malformed JSON",
            request_id=request_id_for(request),
            instance=request.url.path,
            code="invalid_request_body",
            errors=errors,
        )
    return ProblemDetails(
        type="urn:ultimate-novelai:problem:validation_error",
        title="Request validation failed",
        status=422,
        detail="one or more request values are invalid",
        request_id=request_id_for(request),
        instance=request.url.path,
        code="validation_error",
        errors=errors,
    )


def body_limit_problem(exc: RequestBodyTooLargeError, request: Request) -> ProblemDetails:
    return ProblemDetails(
        type=f"urn:ultimate-novelai:problem:{exc.code}",
        title="Request body too large",
        status=exc.status,
        detail=exc.message,
        request_id=request_id_for(request),
        instance=request.url.path,
        code=exc.code,
        retryable=exc.retryable,
        context=exc.details,
    )


class ProblemDetailsRoute(APIRoute):
    """Scope v1 exception translation to v1 routes.

    The existing unversioned API keeps its historical error bodies until callers
    migrate, while every registered v1 endpoint consistently emits Problem Details.
    """

    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        original = super().get_route_handler()

        async def handler(request: Request) -> Response:
            try:
                return await original(request)
            except RequestValidationError as exc:
                return problem_response(validation_problem(exc, request))
            except AppError as exc:
                return problem_response(app_error_problem(exc, request))
            except HTTPException as exc:
                body_limit_error = getattr(request.state, BODY_LIMIT_ERROR_STATE_KEY, None)
                if isinstance(body_limit_error, RequestBodyTooLargeError):
                    return problem_response(body_limit_problem(body_limit_error, request))
                detail = exc.detail if isinstance(exc.detail, str) else "request failed"
                problem = ProblemDetails(
                    title=_http_title(exc.status_code),
                    status=exc.status_code,
                    detail=detail,
                    request_id=request_id_for(request),
                    instance=request.url.path,
                    code="http_error",
                )
                return problem_response(problem, headers=exc.headers)
            except Exception:
                logger.exception("unhandled v1 API error", extra={"path": request.url.path})
                return problem_response(
                    ProblemDetails(
                        type="urn:ultimate-novelai:problem:internal_error",
                        title="Internal server error",
                        status=500,
                        detail="an internal error occurred",
                        request_id=request_id_for(request),
                        instance=request.url.path,
                        code="internal_error",
                    )
                )

        return handler


class V1ProblemDetailsMiddleware:
    """Normalize routing-level v1 404/405 responses without changing v0."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        path = str(scope.get("path", ""))
        if not (path == "/api/v1" or path.startswith("/api/v1/")):
            await self.app(scope, receive, send)
            return

        replaced = False

        async def normalize(message: Message) -> None:
            nonlocal replaced
            if replaced:
                return
            if message["type"] != "http.response.start":
                await send(message)
                return
            status = int(message["status"])
            original_headers = Headers(raw=message.get("headers", []))
            if status not in {404, 405} or original_headers.get("content-type", "").startswith(
                PROBLEM_MEDIA_TYPE
            ):
                await send(message)
                return
            replaced = True
            code = "route_not_found" if status == 404 else "method_not_allowed"
            headers = {
                key: value
                for key, value in original_headers.items()
                if key.lower() not in {"content-length", "content-type"}
            }
            request = Request(scope, receive=receive)
            response = problem_response(
                ProblemDetails(
                    type=f"urn:ultimate-novelai:problem:{code}",
                    title=_http_title(status),
                    status=status,
                    detail=(
                        "the requested v1 route does not exist"
                        if status == 404
                        else "the requested method is not allowed for this v1 route"
                    ),
                    request_id=request_id_for(request),
                    instance=path,
                    code=code,
                ),
                headers=headers,
            )
            await response(scope, receive, send)

        await self.app(scope, receive, normalize)


class RequestIdMiddleware:
    """Assign one untrusted-input-independent correlation id to every response."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        request_id = uuid.uuid4().hex
        scope.setdefault("state", {})["request_id"] = request_id

        async def add_request_id(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                headers["X-Request-ID"] = request_id
            await send(message)

        await self.app(scope, receive, add_request_id)


def request_id_for(request: Request) -> str:
    value = getattr(request.state, "request_id", None)
    if isinstance(value, str) and value:
        return value
    request_id = uuid.uuid4().hex
    request.state.request_id = request_id
    return request_id


def _http_title(status_code: int) -> str:
    return {
        400: "Bad request",
        401: "Authentication required",
        403: "Permission denied",
        404: "Resource not found",
        405: "Method not allowed",
        409: "Conflict",
        413: "Request body too large",
        422: "Request validation failed",
        429: "Too many requests",
        503: "Service unavailable",
        507: "Insufficient storage",
    }.get(status_code, "Request failed" if status_code < 500 else "Internal server error")
