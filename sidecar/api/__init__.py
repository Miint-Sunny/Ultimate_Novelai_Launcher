"""FastAPI composition helpers for versioned and compatibility transports."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, FastAPI
from fastapi.openapi.utils import get_openapi

from sidecar.runtime import AppRuntime

from .mutations import MutationGateMiddleware
from .problems import RequestIdMiddleware, V1ProblemDetailsMiddleware
from .v0 import create_v0_compat_router, create_v0_router
from .v1 import create_v1_router

_V1_PROBLEM_RESPONSES = {
    400: "Invalid request",
    401: "Authentication required",
    403: "Permission denied",
    404: "Resource not found",
    409: "Conflicting state",
    410: "Resource expired",
    413: "Request body too large",
    422: "Request validation failed",
    429: "Capacity or rate limit exceeded",
    500: "Internal server error",
    503: "Runtime or dependency unavailable",
    507: "Insufficient storage",
}
_PROBLEM_SCHEMA_REF = "#/components/schemas/ProblemDetails"


def create_api_router(
    runtime: AppRuntime | None = None,
    *,
    include_v0_compat: bool = False,
) -> APIRouter:
    router = APIRouter()
    router.include_router(create_v1_router(runtime))
    if include_v0_compat:
        router.include_router(create_v0_compat_router(runtime))
    return router


def mount_api(
    app: FastAPI,
    runtime: AppRuntime,
    *,
    include_v0_compat: bool = False,
) -> None:
    """Attach API routes without importing or mutating ``sidecar.server``."""

    app.state.runtime = runtime
    if not getattr(app.state, "mutation_gate_middleware", False):
        app.add_middleware(MutationGateMiddleware, runtime=runtime)
        app.state.mutation_gate_middleware = True
    if not getattr(app.state, "v1_problem_details_middleware", False):
        app.add_middleware(V1ProblemDetailsMiddleware)
        app.state.v1_problem_details_middleware = True
    if not getattr(app.state, "request_id_middleware", False):
        app.add_middleware(RequestIdMiddleware)
        app.state.request_id_middleware = True
    app.include_router(create_api_router(runtime, include_v0_compat=include_v0_compat))
    _configure_openapi(app)


def _configure_openapi(app: FastAPI) -> None:
    """Describe middleware-enforced v1 Bearer authentication in OpenAPI."""

    def custom_openapi() -> dict[str, Any]:
        if app.openapi_schema is not None:
            return app.openapi_schema
        schema = get_openapi(title=app.title, version=app.version, routes=app.routes)
        components = schema.setdefault("components", {})
        security_schemes = components.setdefault("securitySchemes", {})
        security_schemes["BearerAuth"] = {
            "type": "http",
            "scheme": "bearer",
            "description": "Process-local sidecar session token",
        }
        schemas = components.get("schemas", {})
        if not isinstance(schemas, dict) or "ProblemDetails" not in schemas:
            raise RuntimeError("v1 OpenAPI is missing the ProblemDetails schema")
        for path, path_item in schema.get("paths", {}).items():
            if not str(path).startswith("/api/v1/") or not isinstance(path_item, dict):
                continue
            for method, operation in path_item.items():
                if method not in {"get", "post", "put", "patch", "delete", "options"}:
                    continue
                if not isinstance(operation, dict):
                    continue
                anonymous_pair_exchange = path == "/api/v1/auth/pair/exchange" and method == "post"
                operation["security"] = [] if anonymous_pair_exchange else [{"BearerAuth": []}]
                responses = operation.setdefault("responses", {})
                if not isinstance(responses, dict):
                    raise RuntimeError(f"invalid OpenAPI responses for {method.upper()} {path}")
                for status, description in _V1_PROBLEM_RESPONSES.items():
                    if anonymous_pair_exchange and status in {401, 403}:
                        responses.pop(str(status), None)
                        continue
                    responses[str(status)] = {
                        "description": description,
                        "content": {
                            "application/problem+json": {"schema": {"$ref": _PROBLEM_SCHEMA_REF}}
                        },
                    }
        app.openapi_schema = schema
        return schema

    app.openapi = custom_openapi


__all__ = [
    "create_api_router",
    "create_v0_compat_router",
    "create_v0_router",
    "create_v1_router",
    "mount_api",
]
