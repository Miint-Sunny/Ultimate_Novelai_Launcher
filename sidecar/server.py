"""Sidecar ASGI composition root.

Transport handlers live under :mod:`sidecar.api`; this module only composes the
runtime, process lifecycle, middleware, and route trees.
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from ipaddress import ip_address
from typing import Any
from urllib.parse import urlsplit

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import APP_VERSION
from .api import mount_api
from .api.auth_middleware import SidecarAuthMiddleware
from .api.compat import register_compat_routes
from .composition import RuntimeComponents, build_runtime
from .config import Settings, load_settings
from .process_control import process_control
from .security import BodySizeLimitMiddleware

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)


def create_app(settings: Settings | None = None) -> FastAPI:
    process_control.reset()
    initial_settings = settings or load_settings()
    components = build_runtime(
        initial_settings,
        reload_from_environment=settings is None,
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        await components.runtime.startup()
        challenge = components.pairing.issue()
        logger.warning(
            "Browser pairing code: %s (expires in %d seconds)",
            challenge.code,
            int(challenge.expires_in),
        )
        logger.info(
            "Ultimate Novelai launcher sidecar ready at data_dir=%s",
            components.settings.current.data_dir,
        )
        try:
            yield
        finally:
            process_control.begin_drain()
            await components.runtime.shutdown()

    app = FastAPI(
        title="Ultimate Novelai launcher Sidecar",
        version=APP_VERSION,
        lifespan=lifespan,
    )
    app.state.components = components
    _register_middleware(app, components)
    mount_api(app, components.runtime)
    register_compat_routes(app, components)

    @app.get("/livez")
    def livez() -> dict[str, Any]:
        current = components.settings.current
        return {
            "service": "ultimate-novelai-launcher-sidecar",
            "version": APP_VERSION,
            "protocol": current.protocol_version,
            "instance_id": current.instance_id,
        }

    return app


def _register_middleware(app: FastAPI, components: RuntimeComponents) -> None:
    app.add_middleware(
        BodySizeLimitMiddleware,
        default_limit=72 * 1024 * 1024,
        hard_limit=72 * 1024 * 1024,
        path_limits={
            "/settings": 64 * 1024,
            "/auth": 64 * 1024,
            "/api/v1/settings": 64 * 1024,
            "/api/v1/auth": 64 * 1024,
            "/api/v1/assets": 32 * 1024 * 1024,
            # 20 MiB decoded image + 4 MiB UTF-8 context requires just under
            # 31 MiB once the image is represented as base64 JSON.
            "/api/agent": 32 * 1024 * 1024,
            "/vibe": 45 * 1024 * 1024,
            "/upscale": 45 * 1024 * 1024,
            "/api/oc": 45 * 1024 * 1024,
            "/api/artists": 45 * 1024 * 1024,
            "/api/cr": 45 * 1024 * 1024,
            "/api/vibes": 45 * 1024 * 1024,
        },
    )

    allowed_origins = [
        "tauri://localhost",
        "https://tauri.localhost",
        "http://tauri.localhost",
    ]
    allowed_origins.extend(_configured_web_origins())
    if _development_origins_enabled():
        allowed_origins.extend(
            [
                "http://127.0.0.1:1420",
                "http://localhost:1420",
                "http://127.0.0.1:5173",
                "http://localhost:5173",
            ]
        )
    app.add_middleware(SidecarAuthMiddleware, manager=components.security)
    # CORS must be registered LAST so it runs OUTSIDE authentication (Starlette
    # runs middlewares in reverse registration order). Otherwise the auth 401
    # bypasses CORS entirely: a browser cannot read the status (so pairing can
    # never begin) and credentialed preflights are rejected before CORS answers
    # them, which breaks every authenticated browser-mode request.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins,
        allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allow_headers=[
            "Authorization",
            "Content-Type",
            "Idempotency-Key",
            "Last-Event-ID",
            "X-Sidecar-Auth",
        ],
        expose_headers=[
            "Deprecation",
            "Idempotency-Replayed",
            "Location",
            "Sunset",
            "X-Request-ID",
        ],
    )


def _development_origins_enabled() -> bool:
    return os.environ.get(
        "ULTIMATE_NOVELAI_LAUNCHER_ALLOW_DEV_ORIGINS",
        "",
    ).strip().lower() in {"1", "true", "yes", "on"}


def _configured_web_origins() -> list[str]:
    raw_origins = os.environ.get("ULTIMATE_NOVELAI_LAUNCHER_WEB_ORIGINS", "")
    origins: list[str] = []
    for raw_origin in raw_origins.split(","):
        origin = raw_origin.strip()
        if not origin:
            continue
        parsed = urlsplit(origin)
        try:
            port = parsed.port
        except ValueError as exc:
            raise ValueError(f"invalid web origin: {origin}") from exc
        hostname = parsed.hostname or ""
        has_origin_only = not parsed.path and not parsed.query and not parsed.fragment
        if (
            "*" in origin
            or parsed.scheme not in {"http", "https"}
            or not hostname
            or parsed.username is not None
            or parsed.password is not None
            or not has_origin_only
        ):
            raise ValueError(f"invalid web origin: {origin}")
        if parsed.scheme == "http" and not _is_loopback_hostname(hostname):
            raise ValueError(f"insecure non-loopback web origin: {origin}")
        canonical = f"{parsed.scheme}://{parsed.hostname}"
        if ":" in hostname and not hostname.startswith("["):
            canonical = f"{parsed.scheme}://[{hostname}]"
        if port is not None:
            canonical = f"{canonical}:{port}"
        if canonical != origin:
            raise ValueError(f"web origin must use its exact canonical form: {origin}")
        if canonical not in origins:
            origins.append(canonical)
    return origins


def _is_loopback_hostname(hostname: str) -> bool:
    normalized = hostname.rstrip(".").lower()
    if normalized == "localhost" or normalized.endswith(".localhost"):
        return True
    try:
        return ip_address(normalized).is_loopback
    except ValueError:
        return False


if __name__ == "__main__":
    from .bootstrap import main

    main()
