from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

try:
    from fastapi.testclient import TestClient

    from sidecar.config import Settings
    from sidecar.server import create_app
except ModuleNotFoundError as exc:  # pragma: no cover - dependency bootstrap guard
    TestClient = None  # type: ignore[assignment]
    _IMPORT_ERROR = exc
else:
    _IMPORT_ERROR = None


TOKEN = "test-session-secret-000"
HEADER = {"X-Sidecar-Auth": TOKEN}


def _settings(temp: str, *, auth: str) -> "Settings":
    return Settings(
        host="127.0.0.1",
        port=38176,
        data_dir=Path(temp),
        nai_token="",
        nai_base_url="https://image.novelai.net",
        llm_base_url="",
        llm_api_key="",
        llm_model="",
        mock_generation=True,
        sidecar_auth_token=auth,
    )


@unittest.skipIf(_IMPORT_ERROR is not None, f"missing dependency: {_IMPORT_ERROR}")
class SidecarAuthTests(unittest.TestCase):
    def test_health_is_open_even_when_auth_configured(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            app = create_app(_settings(temp, auth=TOKEN))
            with TestClient(app) as client:
                self.assertEqual(client.get("/health").status_code, 200)

    def test_sensitive_endpoints_require_token(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            app = create_app(_settings(temp, auth=TOKEN))
            with TestClient(app) as client:
                # No header -> rejected.
                self.assertEqual(client.post("/settings", json={}).status_code, 401)
                self.assertEqual(client.post("/generate", json={"input": "x", "mode": "tags", "tags": "x", "params": {}}).status_code, 401)
                self.assertEqual(client.post("/api/oc/create", json={"en_name": "x", "tag_group": "y"}).status_code, 401)
                self.assertEqual(client.get("/history").status_code, 401)
                # LLM-key-spending tag routes are gated too (401 fires before any
                # handler/network work).
                self.assertEqual(client.get("/api/tags/wiki-preview-summary-zh?tag=1girl").status_code, 401)
                self.assertEqual(client.post("/api/tags/related", json={"tags": ["1girl"]}).status_code, 401)
                # Wrong header -> rejected.
                self.assertEqual(
                    client.post("/settings", json={}, headers={"X-Sidecar-Auth": "wrong"}).status_code,
                    401,
                )

    def test_correct_token_is_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            app = create_app(_settings(temp, auth=TOKEN))
            with TestClient(app) as client:
                self.assertEqual(client.post("/settings", json={}, headers=HEADER).status_code, 200)
                self.assertEqual(client.get("/history", headers=HEADER).status_code, 200)
                gen = client.post(
                    "/generate",
                    json={"input": "1girl", "mode": "tags", "tags": "1girl", "params": {}},
                    headers=HEADER,
                )
                self.assertEqual(gen.status_code, 200)

    def test_read_endpoints_stay_open_with_auth_configured(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            app = create_app(_settings(temp, auth=TOKEN))
            with TestClient(app) as client:
                # Browser-directly-fetched reads must not require the header.
                self.assertEqual(client.get("/settings").status_code, 200)
                self.assertEqual(client.get("/auth/token/status").status_code, 200)
                self.assertEqual(client.get("/api/oc/list").status_code, 200)
                self.assertEqual(client.get("/api/data/role_tag_mapping.json").status_code, 200)

    def test_no_enforcement_when_token_unset(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            app = create_app(_settings(temp, auth=""))
            with TestClient(app) as client:
                # Dev workflow (`npm run sidecar`, no token) is unaffected.
                self.assertEqual(client.post("/settings", json={}).status_code, 200)
                self.assertEqual(client.get("/history").status_code, 200)


if __name__ == "__main__":
    unittest.main()
