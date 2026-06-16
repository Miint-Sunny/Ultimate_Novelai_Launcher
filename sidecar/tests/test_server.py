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


ONE_PIXEL_DATA_URL = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
)


@unittest.skipIf(_IMPORT_ERROR is not None, f"missing dependency: {_IMPORT_ERROR}")
class ServerTests(unittest.TestCase):
    def test_health_and_history(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            settings = Settings(
                host="127.0.0.1",
                port=38176,
                data_dir=Path(temp),
                nai_token="",
                nai_base_url="https://image.novelai.net",
                llm_base_url="",
                llm_api_key="",
                llm_model="",
                mock_generation=True,
            )
            app = create_app(settings)
            with TestClient(app) as client:
                health = client.get("/health")
                self.assertEqual(health.status_code, 200)
                self.assertTrue(health.json()["ok"])
                self.assertTrue(health.json()["nai_configured"])

                history = client.get("/history")
                self.assertEqual(history.status_code, 200)
                self.assertEqual(history.json()["items"], [])

    def test_mock_generate_persists_history(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            settings = Settings(
                host="127.0.0.1",
                port=38176,
                data_dir=Path(temp),
                nai_token="",
                nai_base_url="https://image.novelai.net",
                llm_base_url="",
                llm_api_key="",
                llm_model="",
                mock_generation=True,
            )
            app = create_app(settings)
            with TestClient(app) as client:
                response = client.post(
                    "/generate",
                    json={
                        "input": "1girl, smile",
                        "mode": "tags",
                        "tags": "1girl, smile",
                        "negative": "bad anatomy",
                        "params": {},
                    },
                )
                self.assertEqual(response.status_code, 200)
                body = response.json()
                self.assertTrue(body["image_url"].startswith("/images/"))

                history = client.get("/history").json()["items"]
                self.assertEqual(len(history), 1)
                self.assertEqual(history[0]["status"], "success")

    def test_translate_proxy_uses_sidecar_llm_configuration(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            settings = Settings(
                host="127.0.0.1",
                port=38176,
                data_dir=Path(temp),
                nai_token="",
                nai_base_url="https://image.novelai.net",
                llm_base_url="",
                llm_api_key="",
                llm_model="",
                mock_generation=True,
            )
            app = create_app(settings)
            with TestClient(app) as client:
                response = client.post(
                    "/api/translate/proxy",
                    json={
                        "base_url": "https://should-not-be-used.example/v1",
                        "api_key": "redacted-test-key",
                        "model": "should-not-be-used",
                        "messages": [{"role": "user", "content": "translate this"}],
                    },
                )
                self.assertEqual(response.status_code, 400)
                self.assertIn("LLM is not configured", response.json()["detail"])

    def test_tag_translation_endpoints(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            settings = Settings(
                host="127.0.0.1",
                port=38176,
                data_dir=Path(temp),
                nai_token="",
                nai_base_url="https://image.novelai.net",
                llm_base_url="",
                llm_api_key="",
                llm_model="",
                mock_generation=True,
            )
            app = create_app(settings)
            with TestClient(app) as client:
                submit = client.post(
                    "/api/tags/translations/submit",
                    json={"entries": [{"tag": "1girl", "zh": "1个女孩", "source": "ai"}]},
                )
                self.assertEqual(submit.status_code, 200)
                self.assertEqual(submit.json()["count"], 1)

                lookup = client.post(
                    "/api/tags/translations/lookup",
                    json={"tags": ["1girl", "missing"]},
                )
                self.assertEqual(lookup.status_code, 200)
                self.assertEqual(lookup.json(), {"1girl": "1个女孩"})

    def test_legacy_data_endpoints_return_expected_empty_shapes(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            settings = Settings(
                host="127.0.0.1",
                port=38176,
                data_dir=Path(temp),
                nai_token="",
                nai_base_url="https://image.novelai.net",
                llm_base_url="",
                llm_api_key="",
                llm_model="",
                mock_generation=True,
            )
            app = create_app(settings)
            with TestClient(app) as client:
                role_tags = client.get("/api/data/role_tag_mapping.json")
                self.assertEqual(role_tags.status_code, 200)
                self.assertEqual(role_tags.json(), {})

                common = client.get("/api/data/NAI_Common.json")
                self.assertEqual(common.status_code, 200)
                self.assertEqual(common.json(), [])

    def test_legacy_agent_stream_reports_missing_llm(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            settings = Settings(
                host="127.0.0.1",
                port=38176,
                data_dir=Path(temp),
                nai_token="",
                nai_base_url="https://image.novelai.net",
                llm_base_url="",
                llm_api_key="",
                llm_model="",
                mock_generation=True,
            )
            app = create_app(settings)
            with TestClient(app) as client:
                response = client.post(
                    "/api/agent/web/generate-prompt",
                    json={"user_request": "画一个笑着的女孩"},
                )
                self.assertEqual(response.status_code, 200)
                self.assertIn("event: error", response.text)
                self.assertIn("LLM is not configured", response.text)

    def test_local_oc_artist_and_cr_lifecycle(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            settings = Settings(
                host="127.0.0.1",
                port=38176,
                data_dir=Path(temp),
                nai_token="",
                nai_base_url="https://image.novelai.net",
                llm_base_url="",
                llm_api_key="",
                llm_model="",
                mock_generation=True,
            )
            app = create_app(settings)
            with TestClient(app) as client:
                oc = client.post(
                    "/api/oc/create",
                    json={
                        "en_name": "alice",
                        "zh_name": "爱丽丝",
                        "zh_aliases": ["小爱"],
                        "tag_group": "1girl, blue eyes",
                        "negative_prompt": "bad anatomy",
                        "preview_base64": ONE_PIXEL_DATA_URL,
                    },
                )
                self.assertEqual(oc.status_code, 200)
                oc_body = oc.json()["oc"]
                self.assertEqual(oc_body["en_name"], "alice")
                self.assertTrue(oc_body["preview_url"].startswith("/api/oc/preview/"))
                self.assertEqual(client.get(oc_body["preview_url"]).status_code, 200)

                oc_update = client.put("/api/oc/alice", json={"tag_group": "1girl, smile"})
                self.assertEqual(oc_update.status_code, 200)
                self.assertEqual(oc_update.json()["oc"]["tag_group"], "1girl, smile")
                self.assertEqual(client.get("/api/oc/list").json()["total"], 1)

                artist = client.post(
                    "/api/artists/create",
                    json={
                        "name": "soft shading",
                        "artist_string": "soft shading, delicate lineart",
                        "negative": "flat color",
                        "preview_base64": ONE_PIXEL_DATA_URL,
                    },
                )
                self.assertEqual(artist.status_code, 200)
                self.assertEqual(client.get("/api/artists/list").json()["total"], 1)
                self.assertTrue(client.post("/api/artists/soft%20shading/use").json()["success"])

                cr = client.post(
                    "/api/cr/create",
                    json={"name": "pose ref", "image_base64": ONE_PIXEL_DATA_URL, "zh_names": ["姿势"]},
                )
                self.assertEqual(cr.status_code, 200)
                cr_id = cr.json()["cr"]["id"]
                self.assertEqual(client.put(f"/api/cr/{cr_id}", json={"name": "pose ref 2"}).status_code, 200)
                self.assertEqual(client.delete(f"/api/cr/{cr_id}").status_code, 200)
                self.assertEqual(client.delete("/api/oc/alice").status_code, 200)
                self.assertEqual(client.delete("/api/artists/soft%20shading").status_code, 200)

    def test_local_vibe_roundtrip_and_path_guard(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            settings = Settings(
                host="127.0.0.1",
                port=38176,
                data_dir=Path(temp),
                nai_token="",
                nai_base_url="https://image.novelai.net",
                llm_base_url="",
                llm_api_key="",
                llm_model="",
                mock_generation=True,
            )
            app = create_app(settings)
            vibe_payload = {
                "identifier": "novelai-vibe-transfer",
                "version": 1,
                "type": "image",
                "name": "Warm Light",
                "thumbnail": ONE_PIXEL_DATA_URL,
                "image": "placeholder-image",
                "encodings": {
                    "v4-5full": {
                        "0.5": "encoded-vibe",
                    }
                },
                "importInfo": {"strength": 0.6, "information_extracted": 0.5},
            }
            with TestClient(app) as client:
                upload = client.post(
                    "/api/vibes/upload",
                    json={"vibe_data": vibe_payload, "name": "Warm Light", "uploader_id": "local"},
                )
                self.assertEqual(upload.status_code, 200)
                filename = upload.json()["filename"]

                listed = client.get("/api/vibes/list")
                self.assertEqual(listed.status_code, 200)
                self.assertEqual(listed.json()["total"], 1)
                self.assertEqual(listed.json()["vibes"][0]["filename"], filename)
                self.assertEqual(listed.json()["vibes"][0]["uploaderId"], "local")
                self.assertEqual(client.get(f"/api/vibes/thumbnail/{filename}").status_code, 200)

                file_response = client.get(f"/api/vibes/file/{filename}")
                self.assertEqual(file_response.status_code, 200)
                self.assertEqual(file_response.json()["name"], "Warm Light")

                encoding = client.get(
                    f"/api/vibes/encoding/{filename}",
                    params={"model": "nai-diffusion-4-5-full", "ie": "0.5"},
                )
                self.assertEqual(encoding.status_code, 200)
                self.assertTrue(encoding.json()["found"])
                self.assertEqual(encoding.json()["encoding"], "encoded-vibe")

                blocked = client.get("/api/vibes/file/..%2Fescape.json")
                self.assertIn(blocked.status_code, {400, 404})
                blocked_backslash = client.get("/api/vibes/file/..%5Cescape.json")
                self.assertEqual(blocked_backslash.status_code, 400)
                self.assertEqual(client.delete(f"/api/vibes/file/{filename}").status_code, 200)


if __name__ == "__main__":
    unittest.main()
