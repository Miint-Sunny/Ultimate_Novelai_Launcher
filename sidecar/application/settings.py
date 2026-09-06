from __future__ import annotations

import asyncio
from collections.abc import Callable, Mapping
from dataclasses import replace
from typing import Any
from urllib.parse import urlsplit

from backend_core.errors import InvalidArgumentError
from sidecar.config import Settings, load_settings
from sidecar.local_settings import (
    normalize_editable_updates,
    normalize_trusted_networks,
    write_local_settings,
)


class SettingsStore:
    """The single mutable settings reference owned by ``AppRuntime``."""

    def __init__(
        self,
        initial: Settings,
        *,
        loader: Callable[[], Settings] | None = load_settings,
    ) -> None:
        self._current = initial
        self._loader = loader
        self._lock = asyncio.Lock()

    @property
    def current(self) -> Settings:
        return self._current

    async def update(self, updates: Mapping[str, Any]) -> Settings:
        async with self._lock:
            try:
                normalized = normalize_editable_updates(dict(updates))
                self._validate_network_scope(normalized)
            except ValueError as exc:
                raise InvalidArgumentError(
                    str(exc),
                    code="invalid_settings",
                ) from exc
            write_local_settings(self._current.data_dir, normalized)
            if self._loader is None:
                self._current = replace(self._current, **normalized)
                return self._current
            return self._reload_locked()

    async def reload(self) -> Settings:
        async with self._lock:
            return self._reload_locked()

    def replace(self, **changes: Any) -> Settings:
        self._current = replace(self._current, **changes)
        return self._current

    def set(self, settings: Settings) -> Settings:
        self._current = settings
        return self._current

    def _reload_locked(self) -> Settings:
        if self._loader is None:
            return self._current
        previous = self._current
        loaded = self._loader()
        # The shell handshake is process identity, not user-editable configuration.
        self._current = replace(
            loaded,
            # Host and port are process identity after bootstrap has retained the
            # port=0 socket and learned its kernel-assigned port. A settings reload
            # must not restore the environment's original zero or a different bind
            # address, otherwise request-local Agent tools call the wrong endpoint.
            host=previous.host,
            port=previous.port,
            # The data directory is process identity too: the directory lock, the
            # database, the asset root and the backups were all opened from it at
            # startup, so a reload must never move a running process elsewhere.
            data_dir=previous.data_dir,
            instance_id=previous.instance_id or loaded.instance_id,
            protocol_version=previous.protocol_version,
            sidecar_auth_token=previous.sidecar_auth_token or loaded.sidecar_auth_token,
        )
        return self._current

    def _validate_network_scope(self, updates: Mapping[str, Any]) -> None:
        for scope_key, networks_key, base_url_key in (
            ("llm_network_scope", "llm_trusted_networks", "llm_base_url"),
            (
                "llm_backup_network_scope",
                "llm_backup_trusted_networks",
                "llm_backup_base_url",
            ),
            ("comfy_network_scope", "comfy_trusted_networks", "comfy_base_url"),
        ):
            if (
                scope_key not in updates
                and networks_key not in updates
                and base_url_key not in updates
            ):
                continue
            scope = updates.get(scope_key, getattr(self._current, scope_key))
            networks = updates.get(networks_key, getattr(self._current, networks_key))
            base_url = str(updates.get(base_url_key, getattr(self._current, base_url_key))).strip()
            if scope == "public" and base_url and urlsplit(base_url).scheme != "https":
                raise ValueError(f"{base_url_key} must use HTTPS for public network scope")
            if scope == "trusted-lan":
                canonical = normalize_trusted_networks(list(networks), canonical=True)
                if not canonical:
                    raise ValueError(f"{networks_key} is required for trusted-lan scope")
