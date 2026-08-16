"""CORS must wrap authentication, or browser pairing can never begin.

Starlette runs middlewares in reverse registration order. If the auth
middleware ends up outside CORS, its 401 carries no CORS headers -- a browser
cannot read the status that should route it to the pairing screen -- and
credentialed preflights are rejected before CORS can answer them.
"""

from __future__ import annotations

import tempfile
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from sidecar.config import Settings
from sidecar.server import create_app

DEV_ORIGIN = "http://127.0.0.1:5173"


def _settings(data_dir: Path) -> Settings:
    return Settings(
        host="127.0.0.1",
        port=0,
        data_dir=data_dir,
        nai_token="",
        nai_base_url="https://image.novelai.net",
        llm_base_url="",
        llm_api_key="",
        llm_model="test-model",
        mock_generation=True,
        sidecar_auth_token="test-process-token",
    )


def _dev_origin_app():
    return patch.dict(
        "os.environ",
        {"ULTIMATE_NOVELAI_LAUNCHER_ALLOW_DEV_ORIGINS": "1"},
        clear=False,
    )


def test_unauthorized_response_still_carries_cors_headers() -> None:
    with tempfile.TemporaryDirectory() as temp, _dev_origin_app():
        app = create_app(_settings(Path(temp)))
        with TestClient(app) as client:
            response = client.get(
                "/api/v1/system/ready",
                headers={"Origin": DEV_ORIGIN},
            )
    # The 401 itself must be readable cross-origin so the frontend can map it
    # to "pairing required" instead of an opaque network failure.
    assert response.status_code == 401
    assert response.headers.get("access-control-allow-origin") == DEV_ORIGIN


def test_credentialed_preflight_is_answered_before_authentication() -> None:
    with tempfile.TemporaryDirectory() as temp, _dev_origin_app():
        app = create_app(_settings(Path(temp)))
        with TestClient(app) as client:
            response = client.options(
                "/api/v1/system/ready",
                headers={
                    "Origin": DEV_ORIGIN,
                    "Access-Control-Request-Method": "GET",
                    "Access-Control-Request-Headers": "authorization",
                },
            )
    # A preflight carries no Authorization header by design; auth running
    # outside CORS would 401 it and break every authenticated browser call.
    assert response.status_code == 200
    assert response.headers.get("access-control-allow-origin") == DEV_ORIGIN
    assert "authorization" in response.headers.get("access-control-allow-headers", "").lower()
