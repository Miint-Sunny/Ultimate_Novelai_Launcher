from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from sidecar.config import Settings
from sidecar.server import create_app

ONE_PIXEL_DATA_URL = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
)


class ServerTests(unittest.TestCase):
    @staticmethod
    def _settings(data_dir: Path) -> Settings:
        return Settings(
            host="127.0.0.1",
            port=0,
            data_dir=data_dir,
            nai_token="",
            nai_base_url="https://image.novelai.net",
            llm_base_url="",
            llm_api_key="",
            llm_model="",
            mock_generation=True,
            sidecar_auth_token="process-secret",
        )

    def test_v1_streamed_body_limit_uses_actual_bytes_not_content_length(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            app = create_app(self._settings(Path(temp)))

            def chunks():
                yield b'{"code":"'
                yield b"1" * (65 * 1024)
                yield b'"}'

            with TestClient(app) as client:
                response = client.post(
                    "/api/v1/auth/pair/exchange",
                    content=chunks(),
                    headers={
                        "Content-Type": "application/json",
                        "Content-Length": "1",
                    },
                )

        self.assertEqual(response.status_code, 413)
        self.assertEqual(response.headers["content-type"], "application/problem+json")
        payload = response.json()
        self.assertEqual(payload["status"], 413)
        self.assertEqual(payload["code"], "request_body_too_large")
        self.assertEqual(payload["title"], "Request body too large")
        self.assertEqual(payload["context"]["limit"], 64 * 1024)
        self.assertGreater(payload["context"]["received"], 64 * 1024)
        self.assertEqual(response.headers["x-request-id"], payload["request_id"])

    def test_v1_malformed_json_remains_a_400_problem(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            app = create_app(self._settings(Path(temp)))
            with TestClient(app) as client:
                response = client.post(
                    "/api/v1/auth/pair/exchange",
                    content=b'{"code":',
                    headers={"Content-Type": "application/json"},
                )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.headers["content-type"], "application/problem+json")
        payload = response.json()
        self.assertEqual(payload["status"], 400)
        self.assertEqual(payload["code"], "invalid_request_body")
        self.assertNotEqual(payload["code"], "request_body_too_large")

    def test_v1_requires_bearer_while_compat_accepts_legacy_header(self) -> None:
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
                sidecar_auth_token="process-secret",
            )
            with TestClient(create_app(settings)) as client:
                legacy_v1 = client.get(
                    "/api/v1/system/ready",
                    headers={"X-Sidecar-Auth": "process-secret"},
                )
                bearer_v1 = client.get(
                    "/api/v1/system/ready",
                    headers={"Authorization": "Bearer process-secret"},
                )
                legacy_compat = client.get(
                    "/health",
                    headers={"X-Sidecar-Auth": "process-secret"},
                )

            self.assertEqual(legacy_v1.status_code, 401)
            self.assertEqual(legacy_v1.json()["code"], "authentication_failed")
            self.assertEqual(bearer_v1.status_code, 200)
            self.assertEqual(legacy_compat.status_code, 200)

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
                unsafe_dev_no_auth=True,
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
                unsafe_dev_no_auth=True,
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
                unsafe_dev_no_auth=True,
            )
            app = create_app(settings)
            with TestClient(app) as client:
                rejected = client.post(
                    "/api/translate/proxy",
                    json={
                        "base_url": "https://should-not-be-used.example/v1",
                        "api_key": "redacted-test-key",
                        "model": "should-not-be-used",
                        "messages": [{"role": "user", "content": "translate this"}],
                    },
                )
                self.assertEqual(rejected.status_code, 422)

                response = client.post(
                    "/api/translate/proxy",
                    json={"messages": [{"role": "user", "content": "translate this"}]},
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
                unsafe_dev_no_auth=True,
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
                unsafe_dev_no_auth=True,
            )
            app = create_app(settings)
            with TestClient(app) as client:
                role_tags = client.get("/api/data/role_tag_mapping.json")
                self.assertEqual(role_tags.status_code, 200)
                self.assertEqual(role_tags.json(), {})

                common = client.get("/api/data/NAI_Common.json")
                self.assertEqual(common.status_code, 200)
                self.assertEqual(common.json(), [])

    def test_main_accepts_complete_agent_shape_then_reports_capability_unavailable(self) -> None:
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
                unsafe_dev_no_auth=True,
            )
            app = create_app(settings)
            with TestClient(app) as client:
                response = client.post(
                    "/api/agent/web/generate-prompt",
                    json={
                        "user_request": "画一个笑着的女孩",
                        "model": "",
                        "history": [{"role": "user", "content": "上一轮"}],
                        "use_codex": True,
                        "knowledge_sources": ["roleTags", "artists", "vibes", "ocs"],
                        "web_artists": [{"id": "A1", "name": "A1", "prompt": "artist:a"}],
                        "web_ocs": [
                            {
                                "id": "OC1",
                                "name": "Alice",
                                "zh_name": "爱丽丝",
                                "positive": "blue eyes",
                                "negative": "",
                            }
                        ],
                        "web_codex": [
                            {
                                "id": "C1",
                                "category": "world",
                                "title": "夜城",
                                "content": "霓虹灯下的城市",
                                "is_r18": False,
                            }
                        ],
                        "current_positive": "1girl",
                        "current_negative": "lowres",
                        "current_characters": [
                            {"name": "Alice", "positive": "smile", "negative": ""}
                        ],
                    },
                )
                extra = client.post(
                    "/api/agent/web/generate-prompt",
                    json={"user_request": "cat", "silently_ignored": True},
                )
                invalid_image = client.post(
                    "/api/agent/web/generate-prompt",
                    json={"user_request": "cat", "image_b64": "not-base64"},
                )
                image_only = client.post(
                    "/api/agent/web/generate-prompt",
                    json={
                        "user_request": "",
                        "image_b64": ONE_PIXEL_DATA_URL.split(",", 1)[1],
                        "image_mime_type": "image/png",
                    },
                )
                mismatched_mime = client.post(
                    "/api/agent/web/generate-prompt",
                    json={
                        "user_request": "describe this",
                        "image_b64": ONE_PIXEL_DATA_URL.split(",", 1)[1],
                        "image_mime_type": "image/jpeg",
                    },
                )
                ready = client.get("/api/v1/system/ready")

                self.assertEqual(response.status_code, 503)
                self.assertEqual(
                    response.json()["detail"]["code"],
                    "desktop_agent_unavailable_on_main",
                )
                self.assertEqual(extra.status_code, 422)
                self.assertEqual(invalid_image.status_code, 422)
                self.assertEqual(image_only.status_code, 503)
                self.assertEqual(mismatched_mime.status_code, 422)
                self.assertFalse(ready.json()["capabilities"]["desktop_agent_available"])

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
                unsafe_dev_no_auth=True,
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
                    json={
                        "name": "pose ref",
                        "image_base64": ONE_PIXEL_DATA_URL,
                        "zh_names": ["姿势"],
                    },
                )
                self.assertEqual(cr.status_code, 200)
                cr_id = cr.json()["cr"]["id"]
                self.assertEqual(
                    client.put(
                        f"/api/cr/{cr_id}",
                        json={"name": "pose ref 2"},
                    ).status_code,
                    200,
                )
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
                unsafe_dev_no_auth=True,
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
