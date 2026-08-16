"""Canonical non-secret sidecar settings API."""

from __future__ import annotations

import inspect
from typing import cast

from fastapi import APIRouter, Request

from backend_core.errors import DependencyUnavailableError
from sidecar.config import Settings
from sidecar.runtime import AppRuntime

from ..dependencies import authorize_request, resolve_runtime
from ..problems import ProblemDetailsRoute
from .models import (
    ComfyNetworkScopeValue,
    NetworkScopeValue,
    ProviderValue,
    SettingsResponse,
    SettingsUpdateRequest,
)


def create_settings_router(runtime: AppRuntime | None = None) -> APIRouter:
    router = APIRouter(
        prefix="/settings",
        tags=["v1-settings"],
        route_class=ProblemDetailsRoute,
    )

    @router.get("", response_model=SettingsResponse)
    async def get_settings(request: Request) -> SettingsResponse:
        current = resolve_runtime(request, runtime)
        current.assert_ready()
        await authorize_request(current, request)
        return settings_response(_current_settings(current), version=current.version)

    @router.patch("", response_model=SettingsResponse)
    async def update_settings(
        body: SettingsUpdateRequest,
        request: Request,
    ) -> SettingsResponse:
        current = resolve_runtime(request, runtime)
        current.assert_ready()
        await authorize_request(current, request)
        store = current.settings
        updater = getattr(store, "update", None)
        if not callable(updater):
            raise DependencyUnavailableError(
                "settings store is not configured",
                code="settings_store_unavailable",
            )
        result = updater(body.model_dump(exclude_none=True))
        if inspect.isawaitable(result):
            result = await result
        if not isinstance(result, Settings):
            raise DependencyUnavailableError(
                "settings store returned an invalid value",
                code="settings_store_unavailable",
            )
        current.invalidate_readiness()
        return settings_response(result, version=current.version)

    return router


def _current_settings(runtime: AppRuntime) -> Settings:
    value = getattr(runtime.settings, "current", runtime.settings)
    if not isinstance(value, Settings):
        raise DependencyUnavailableError(
            "settings store is not configured",
            code="settings_store_unavailable",
        )
    return value


def settings_response(settings: Settings, *, version: str) -> SettingsResponse:
    return SettingsResponse(
        version=version,
        data_dir=str(settings.data_dir),
        nai_base_url=settings.nai_base_url,
        nai_configured=settings.nai_configured,
        nai_token_configured=bool(settings.nai_token),
        llm_provider=cast(ProviderValue, settings.llm_provider),
        llm_base_url=settings.llm_base_url,
        llm_model=settings.llm_model,
        llm_key_configured=bool(settings.llm_api_key),
        llm_network_scope=cast(NetworkScopeValue, settings.llm_network_scope),
        llm_trusted_networks=list(settings.llm_trusted_networks),
        llm_backup_provider=cast(ProviderValue, settings.llm_backup_provider),
        llm_backup_base_url=settings.llm_backup_base_url,
        llm_backup_model=settings.llm_backup_model,
        llm_backup_key_configured=bool(settings.llm_backup_api_key),
        llm_backup_network_scope=cast(
            NetworkScopeValue,
            settings.llm_backup_network_scope,
        ),
        llm_backup_trusted_networks=list(settings.llm_backup_trusted_networks),
        llm_configured=settings.llm_configured,
        comfy_base_url=settings.comfy_base_url,
        comfy_network_scope=cast(ComfyNetworkScopeValue, settings.comfy_network_scope),
        comfy_trusted_networks=list(settings.comfy_trusted_networks),
        comfy_configured=settings.comfy_configured,
    )


router = create_settings_router()

__all__ = ["create_settings_router", "router", "settings_response"]
