from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from sidecar.config import Settings
from sidecar.server import create_app

TOKEN = "test-session-secret-000"
HEADER = {"X-Sidecar-Auth": TOKEN}


def _settings(temp: str, *, auth: str, unsafe_dev_no_auth: bool = False) -> Settings:
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
        unsafe_dev_no_auth=unsafe_dev_no_auth,
    )


class SidecarAuthTests(unittest.TestCase):
    def test_only_livez_is_open_when_auth_configured(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            app = create_app(_settings(temp, auth=TOKEN))
            with TestClient(app) as client:
                self.assertEqual(client.get("/livez").status_code, 200)
                self.assertEqual(client.get("/health").status_code, 401)

    def test_sensitive_endpoints_require_token(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            app = create_app(_settings(temp, auth=TOKEN))
            with TestClient(app) as client:
                # No header -> rejected.
                self.assertEqual(client.post("/settings", json={}).status_code, 401)
                self.assertEqual(
                    client.post(
                        "/generate",
                        json={"input": "x", "mode": "tags", "tags": "x", "params": {}},
                    ).status_code,
                    401,
                )
                self.assertEqual(
                    client.post(
                        "/api/oc/create",
                        json={"en_name": "x", "tag_group": "y"},
                    ).status_code,
                    401,
                )
                self.assertEqual(client.get("/history").status_code, 401)
                # LLM-key-spending tag routes are gated too (401 fires before any
                # handler/network work).
                self.assertEqual(
                    client.get(
                        "/api/tags/wiki-preview-summary-zh?tag=1girl"
                    ).status_code,
                    401,
                )
                self.assertEqual(
                    client.post(
                        "/api/tags/related",
                        json={"tags": ["1girl"]},
                    ).status_code,
                    401,
                )
                # Wrong header -> rejected.
                self.assertEqual(
                    client.post(
                        "/settings",
                        json={},
                        headers={"X-Sidecar-Auth": "wrong"},
                    ).status_code,
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

    def test_private_read_endpoints_require_auth(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            app = create_app(_settings(temp, auth=TOKEN))
            with TestClient(app) as client:
                for path in (
                    "/settings",
                    "/auth/token/status",
                    "/api/oc/list",
                    "/api/data/role_tag_mapping.json",
                ):
                    self.assertEqual(client.get(path).status_code, 401)
                    self.assertEqual(client.get(path, headers=HEADER).status_code, 200)

    def test_missing_token_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaisesRegex(RuntimeError, "authentication token"):
                create_app(_settings(temp, auth=""))

    def test_explicit_unsafe_development_mode_disables_auth(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            app = create_app(_settings(temp, auth="", unsafe_dev_no_auth=True))
            with TestClient(app) as client:
                self.assertEqual(client.post("/settings", json={}).status_code, 200)
                self.assertEqual(client.get("/history").status_code, 200)


if __name__ == "__main__":
    unittest.main()
