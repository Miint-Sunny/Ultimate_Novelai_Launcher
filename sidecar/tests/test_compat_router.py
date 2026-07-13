from __future__ import annotations

import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from sidecar.config import Settings
from sidecar.server import _configured_web_origins, create_app


def _settings(data_dir: Path) -> Settings:
    return Settings(
        host="127.0.0.1",
        port=0,
        data_dir=data_dir,
        nai_token="",
        nai_base_url="https://image.novelai.net",
        llm_base_url="",
        llm_api_key="",
        llm_model="initial-model",
        mock_generation=True,
        unsafe_dev_no_auth=True,
    )


def test_compat_routes_read_the_runtime_settings_store_per_request() -> None:
    with tempfile.TemporaryDirectory() as temp:
        app = create_app(_settings(Path(temp)))
        with TestClient(app) as client:
            initial = client.get("/settings")
            assert initial.json()["llm_model"] == "initial-model"
            assert initial.headers["Deprecation"] == "true"
            assert "Sunset" in initial.headers

            app.state.components.settings.replace(llm_model="replacement-model")

            assert client.get("/settings").json()["llm_model"] == "replacement-model"


def test_configured_web_origins_accept_exact_https_and_loopback_http() -> None:
    value = "https://example.test,http://127.0.0.1:4173,http://[::1]:5173"
    with patch.dict(
        "os.environ",
        {"ULTIMATE_NOVELAI_LAUNCHER_WEB_ORIGINS": value},
        clear=False,
    ):
        assert _configured_web_origins() == value.split(",")


@pytest.mark.parametrize(
    "origin",
    [
        "*",
        "http://example.test",
        "https://user@example.test",
        "https://example.test/path",
        "https://*.example.test",
    ],
)
def test_configured_web_origins_reject_unsafe_values(origin: str) -> None:
    with (
        patch.dict(
            "os.environ",
            {"ULTIMATE_NOVELAI_LAUNCHER_WEB_ORIGINS": origin},
            clear=False,
        ),
        pytest.raises(ValueError),
    ):
        _configured_web_origins()
