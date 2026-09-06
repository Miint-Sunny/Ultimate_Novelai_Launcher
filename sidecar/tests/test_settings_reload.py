"""Credentials written at runtime are visible without a restart (board #11).

The desktop bootstrap hands ``create_app`` explicit, socket-bound settings.  The
settings store still has to reload from the environment and the OS credential
store, otherwise ``POST/DELETE /auth/llm-key`` and ``/auth/token`` write the
keychain and keep reporting the stale state until the process restarts.  The
credential store is an in-memory double; nothing here touches a real keychain.
"""

from __future__ import annotations

import asyncio
import os
import tempfile
import unittest
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import replace
from pathlib import Path
from typing import Any
from unittest import mock

from fastapi.testclient import TestClient

from sidecar import credentials
from sidecar.application import SettingsStore
from sidecar.config import Settings, load_settings
from sidecar.server import create_app

PROCESS_TOKEN = "process-token"
BOUND_PORT = 43210


@contextmanager
def fake_secure_store() -> Iterator[dict[str, str]]:
    """In-memory stand-in for the OS credential store, keyed by account."""

    store: dict[str, str] = {}

    def _get(account: str) -> str:
        return store.get(account, "")

    def _set(account: str, value: str) -> bool:
        store[account] = value
        return True

    def _delete(account: str) -> None:
        store.pop(account, None)

    with (
        mock.patch.object(credentials, "_secure_get", _get),
        mock.patch.object(credentials, "_secure_set", _set),
        mock.patch.object(credentials, "_secure_delete", _delete),
        mock.patch.object(credentials, "_secure_available", lambda: True),
    ):
        yield store


def _bootstrap_environment(data_dir: str) -> dict[str, str]:
    return {
        "ULTIMATE_NOVELAI_LAUNCHER_DATA_DIR": data_dir,
        "ULTIMATE_NOVELAI_LAUNCHER_SIDECAR_AUTH": PROCESS_TOKEN,
        "ULTIMATE_NOVELAI_LAUNCHER_INSTANCE_ID": "instance-under-test",
        "ULTIMATE_NOVELAI_LAUNCHER_MOCK_GENERATION": "1",
        "ULTIMATE_NOVELAI_LAUNCHER_UNSAFE_DEV_NO_AUTH": "",
        # A developer shell must never leak real credentials into the test.
        "NAI_TOKEN": "",
        "LLM_API_KEY": "",
        "LLM_BACKUP_API_KEY": "",
    }


def _settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "host": "127.0.0.1",
        "port": 0,
        "data_dir": Path("/tmp/sidecar-settings-reload"),
        "nai_token": "",
        "nai_base_url": "https://image.novelai.net",
        "llm_base_url": "",
        "llm_api_key": "",
        "llm_model": "",
        "mock_generation": True,
        "sidecar_auth_token": PROCESS_TOKEN,
    }
    values.update(overrides)
    return Settings(**values)


class BootstrapAssemblyReloadTests(unittest.TestCase):
    """Same assembly as ``sidecar.bootstrap.serve``: explicit settings + environment loader."""

    def test_runtime_credential_writes_are_visible_without_a_restart(self) -> None:
        with (
            tempfile.TemporaryDirectory() as temp,
            mock.patch.dict(os.environ, _bootstrap_environment(temp), clear=False),
            fake_secure_store() as store,
        ):
            # Bootstrap binds port=0, learns the kernel port and hands the bound
            # settings over; the store must still reload credentials from the OS.
            resolved = replace(load_settings(), port=BOUND_PORT)
            app = create_app(resolved, reload_from_environment=True)
            headers = {"Authorization": f"Bearer {PROCESS_TOKEN}"}

            with TestClient(app) as client:

                def v1_settings() -> dict[str, Any]:
                    response = client.get("/api/v1/settings", headers=headers)
                    self.assertEqual(response.status_code, 200, response.text)
                    return response.json()

                self.assertFalse(v1_settings()["llm_key_configured"])

                primary = client.post(
                    "/auth/llm-key",
                    headers=headers,
                    json={"api_key": "sk-primary", "slot": "primary"},
                )
                self.assertEqual(primary.status_code, 200, primary.text)
                self.assertTrue(primary.json()["key_configured"])
                self.assertEqual(store[credentials.ACCOUNT_LLM], "sk-primary")
                self.assertTrue(v1_settings()["llm_key_configured"])

                backup = client.post(
                    "/auth/llm-key",
                    headers=headers,
                    json={"api_key": "sk-backup", "slot": "backup"},
                )
                self.assertEqual(backup.status_code, 200, backup.text)
                self.assertTrue(backup.json()["backup_key_configured"])
                self.assertTrue(v1_settings()["llm_backup_key_configured"])

                removed = client.delete("/auth/llm-key", headers=headers)
                self.assertEqual(removed.status_code, 200, removed.text)
                self.assertFalse(removed.json()["key_configured"])
                self.assertTrue(removed.json()["backup_key_configured"])
                self.assertNotIn(credentials.ACCOUNT_LLM, store)
                self.assertFalse(v1_settings()["llm_key_configured"])
                self.assertTrue(v1_settings()["llm_backup_key_configured"])

                token = client.post(
                    "/auth/token", headers=headers, json={"token": "nai-token-value"}
                )
                self.assertEqual(token.status_code, 200, token.text)
                self.assertTrue(token.json()["configured"])
                self.assertEqual(token.json()["source"], "credential-store")
                self.assertTrue(v1_settings()["nai_token_configured"])

                dropped = client.delete("/auth/token", headers=headers)
                self.assertEqual(dropped.status_code, 200, dropped.text)
                self.assertFalse(dropped.json()["configured"])
                self.assertFalse(v1_settings()["nai_token_configured"])

                # Every reload re-read the environment; none moved process identity.
                current = app.state.components.settings.current
                self.assertEqual(current.port, BOUND_PORT)
                self.assertEqual(current.data_dir, Path(temp))
                self.assertEqual(current.sidecar_auth_token, PROCESS_TOKEN)
                self.assertEqual(current.instance_id, "instance-under-test")

    def test_explicit_settings_without_the_flag_stay_frozen(self) -> None:
        """Tests that hand in synthetic settings keep them; reload is the identity."""

        with tempfile.TemporaryDirectory() as temp:
            settings = _settings(data_dir=Path(temp))
            app = create_app(settings)
            store = app.state.components.settings
            self.assertIs(asyncio.run(store.reload()), settings)


class ReloadPreservesProcessIdentityTests(unittest.TestCase):
    def test_reload_takes_fresh_credentials_but_keeps_identity(self) -> None:
        initial = _settings(
            data_dir=Path("/tmp/sidecar-a"),
            port=1234,
            instance_id="instance-1",
            sidecar_auth_token="token-1",
        )
        loaded = replace(
            initial,
            data_dir=Path("/tmp/sidecar-elsewhere"),
            port=0,
            host="::1",
            instance_id="",
            sidecar_auth_token="",
            llm_api_key="fresh-key",
            nai_token="fresh-token",
        )
        store = SettingsStore(initial, loader=lambda: loaded)

        current = asyncio.run(store.reload())

        self.assertEqual(current.llm_api_key, "fresh-key")
        self.assertEqual(current.nai_token, "fresh-token")
        self.assertEqual(current.data_dir, Path("/tmp/sidecar-a"))
        self.assertEqual(current.port, 1234)
        self.assertEqual(current.host, "127.0.0.1")
        self.assertEqual(current.instance_id, "instance-1")
        self.assertEqual(current.sidecar_auth_token, "token-1")
