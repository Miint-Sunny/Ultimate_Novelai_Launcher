"""Dependency resolution shared by versioned HTTP routers."""

from __future__ import annotations

import inspect

from fastapi import Request

from backend_core.errors import (
    AppError,
    AuthenticationRequiredError,
    CapacityExceededError,
    ConflictError,
    DependencyUnavailableError,
    InvalidArgumentError,
    PermissionDeniedError,
    ResourceExpiredError,
)
from backend_core.protocols import JobService
from sidecar.runtime import AppRuntime


def resolve_runtime(request: Request, bound: AppRuntime | None = None) -> AppRuntime:
    runtime = bound or getattr(request.app.state, "runtime", None)
    if not isinstance(runtime, AppRuntime):
        raise DependencyUnavailableError(
            "application runtime is not configured",
            code="runtime_unavailable",
        )
    return runtime


async def authorize_request(runtime: AppRuntime, request: Request) -> str | None:
    authenticator = runtime.security
    if authenticator is None:
        return None
    try:
        require_bearer = getattr(authenticator, "require_bearer", None)
        result = (
            require_bearer(request.headers)
            if callable(require_bearer)
            else authenticator.require(request.headers)
        )
        if inspect.isawaitable(result):
            result = await result
        return str(result)
    except AppError:
        raise
    except Exception as exc:
        mapped = map_security_error(exc)
        if mapped is None:
            raise
        raise mapped from exc


async def require_jobs(
    request: Request,
    bound: AppRuntime | None = None,
    *,
    authorize: bool = True,
) -> JobService:
    runtime = resolve_runtime(request, bound)
    runtime.assert_ready()
    if authorize:
        await authorize_request(runtime, request)
    if runtime.jobs is None:
        raise DependencyUnavailableError(
            "generation job service is not configured",
            code="job_service_unavailable",
        )
    return runtime.jobs


def map_security_error(exc: Exception) -> AppError | None:
    status = getattr(exc, "status", None)
    code = getattr(exc, "code", None)
    if not isinstance(status, int) or not isinstance(code, str):
        return None
    error_type: type[AppError]
    if status == 401:
        error_type = AuthenticationRequiredError
    elif status == 403:
        error_type = PermissionDeniedError
    elif status == 410:
        error_type = ResourceExpiredError
    elif status == 409:
        error_type = ConflictError
    elif status == 429:
        error_type = CapacityExceededError
    elif status >= 500:
        error_type = DependencyUnavailableError
    else:
        error_type = InvalidArgumentError
    return error_type(
        str(exc) or "request authorization failed",
        code=code,
        details=getattr(exc, "details", None),
        retryable=bool(getattr(exc, "retryable", False)),
    )
