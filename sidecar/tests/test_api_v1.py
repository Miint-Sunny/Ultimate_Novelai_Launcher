from __future__ import annotations

import asyncio
import unittest
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from backend_core.errors import AuthenticationRequiredError
from sidecar.api import mount_api
from sidecar.api.v1.events import SSEStreamingResponse
from sidecar.api.v1.models import GenerationJobCreate
from sidecar.api.v1.router import generation_event_stream
from sidecar.application import SettingsStore, TaskSupervisor
from sidecar.config import Settings
from sidecar.process_control import ProcessControl
from sidecar.runtime import AppRuntime
from sidecar.security import AuthManager, PairingManager


class _Record:
    def __init__(self, data: dict[str, Any]) -> None:
        self.data = data

    def to_dict(self) -> dict[str, Any]:
        return dict(self.data)


def _job(job_id: str = "job-1", status: str = "queued") -> _Record:
    now = datetime(2026, 7, 13, 10, 0, tzinfo=timezone.utc).isoformat()
    return _Record(
        {
            "id": job_id,
            "owner": None,
            "idempotency_key": None,
            "request_hash": "a" * 64,
            "payload": {"prompt": "1girl"},
            "status": status,
            "progress": 0.0,
            "result": None,
            "error_code": None,
            "error_message": None,
            "queue_sequence": 1,
            "created_at": now,
            "updated_at": now,
            "started_at": None,
            "finished_at": None,
        }
    )


def _payload(prompt: str) -> dict[str, Any]:
    return {
        "input": prompt,
        "mode": "tags",
        "tags": prompt,
        "negative": "",
        "params": {},
    }


class _Jobs:
    def __init__(self) -> None:
        self.record = _job()

    async def initialize(self) -> None:
        return None

    async def create_job(self, payload, *, idempotency_key=None, job_id=None):  # type: ignore[no-untyped-def]
        self.record.data["payload"] = dict(payload)
        self.record.data["idempotency_key"] = idempotency_key
        return SimpleNamespace(job=self.record, created=True)

    async def list_jobs(self, *, limit=100, offset=0, statuses=None):  # type: ignore[no-untyped-def]
        return [self.record]

    async def get_job(self, job_id):  # type: ignore[no-untyped-def]
        return self.record if job_id == self.record.data["id"] else None

    async def cancel_job(self, job_id, reason=None):  # type: ignore[no-untyped-def]
        if job_id != self.record.data["id"]:
            return None
        self.record.data["status"] = "cancelled"
        return self.record

    async def list_events(self, job_id, *, after_sequence=0, limit=1000):  # type: ignore[no-untyped-def]
        return [
            _Record(
                {
                    "sequence": 1,
                    "job_id": job_id,
                    "kind": "created",
                    "status": "queued",
                    "created_at": datetime(2026, 7, 13, tzinfo=timezone.utc).isoformat(),
                    "data": {},
                }
            )
        ]

    async def watch_events(  # type: ignore[no-untyped-def]
        self,
        job_id,
        *,
        after_sequence=0,
        poll_interval=0.25,
    ):
        for event in await self.list_events(job_id, after_sequence=after_sequence):
            yield event


def _app(runtime: AppRuntime, *, include_v0_compat: bool = False) -> FastAPI:
    @asynccontextmanager
    async def lifespan(_: FastAPI):
        await runtime.startup()
        try:
            yield
        finally:
            await runtime.shutdown()

    app = FastAPI(lifespan=lifespan)
    mount_api(app, runtime, include_v0_compat=include_v0_compat)
    return app


class ApiV1Tests(unittest.TestCase):
    def test_settings_contract_is_authenticated_strict_and_never_returns_secrets(self) -> None:
        with TemporaryDirectory() as temp:
            settings = Settings(
                host="127.0.0.1",
                port=0,
                data_dir=Path(temp),
                nai_token="nai-secret",
                nai_base_url="https://image.novelai.net",
                llm_base_url="https://llm.example/v1",
                llm_api_key="llm-secret",
                llm_model="model-a",
                mock_generation=False,
                sidecar_auth_token="process-token",
            )
            runtime = AppRuntime(
                settings=SettingsStore(settings, loader=None),
                security=AuthManager("process-token"),
            )
            with TestClient(_app(runtime)) as client:  # type: ignore[misc]
                unauthorized = client.get("/api/v1/settings")
                response = client.get(
                    "/api/v1/settings",
                    headers={"Authorization": "Bearer process-token"},
                )
                updated = client.patch(
                    "/api/v1/settings",
                    headers={"Authorization": "Bearer process-token"},
                    json={
                        "llm_network_scope": "trusted-lan",
                        "llm_trusted_networks": ["10.23.7.9/16"],
                    },
                )
                extra = client.patch(
                    "/api/v1/settings",
                    headers={"Authorization": "Bearer process-token"},
                    json={"unknown_setting": True},
                )
                schema = client.get("/openapi.json").json()

        self.assertEqual(unauthorized.status_code, 401)
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertTrue(payload["nai_token_configured"])
        self.assertTrue(payload["llm_key_configured"])
        self.assertNotIn("nai-secret", response.text)
        self.assertNotIn("llm-secret", response.text)
        self.assertEqual(updated.status_code, 200)
        self.assertEqual(updated.json()["llm_network_scope"], "trusted-lan")
        self.assertEqual(updated.json()["llm_trusted_networks"], ["10.23.0.0/16"])
        self.assertEqual(extra.status_code, 422)
        self.assertEqual(extra.json()["code"], "validation_error")
        settings_patch = schema["paths"]["/api/v1/settings"]["patch"]
        self.assertEqual(
            settings_patch["requestBody"]["content"]["application/json"]["schema"]["$ref"],
            "#/components/schemas/SettingsUpdateRequest",
        )
        self.assertEqual(
            settings_patch["responses"]["200"]["content"]["application/json"]["schema"]["$ref"],
            "#/components/schemas/SettingsResponse",
        )

    def test_settings_reject_unsafe_endpoint_and_trusted_lan_without_cidr(self) -> None:
        with TemporaryDirectory() as temp:
            settings = Settings(
                host="127.0.0.1",
                port=0,
                data_dir=Path(temp),
                nai_token="",
                nai_base_url="https://image.novelai.net",
                llm_base_url="",
                llm_api_key="",
                llm_model="",
                mock_generation=True,
            )
            runtime = AppRuntime(settings=SettingsStore(settings, loader=None))
            with TestClient(_app(runtime)) as client:  # type: ignore[misc]
                unsafe = client.patch(
                    "/api/v1/settings",
                    json={"llm_base_url": "http://169.254.169.254/latest/meta-data"},
                )
                missing_cidr = client.patch(
                    "/api/v1/settings",
                    json={"llm_network_scope": "trusted-lan"},
                )
                public_cidr = client.patch(
                    "/api/v1/settings",
                    json={"llm_trusted_networks": ["8.8.8.0/24"]},
                )
                overwide_cidr = client.patch(
                    "/api/v1/settings",
                    json={"llm_trusted_networks": ["10.0.0.0/8"]},
                )
                metadata_cidr = client.patch(
                    "/api/v1/settings",
                    json={"llm_trusted_networks": ["100.100.100.0/24"]},
                )
                empty = client.patch("/api/v1/settings", json={})
                null_value = client.patch(
                    "/api/v1/settings",
                    json={"llm_model": None},
                )

        self.assertEqual(unsafe.status_code, 400)
        self.assertEqual(unsafe.json()["code"], "invalid_settings")
        self.assertEqual(missing_cidr.status_code, 400)
        self.assertEqual(missing_cidr.json()["code"], "invalid_settings")
        self.assertEqual(public_cidr.status_code, 400)
        self.assertEqual(public_cidr.json()["code"], "invalid_settings")
        self.assertEqual(overwide_cidr.status_code, 400)
        self.assertEqual(overwide_cidr.json()["code"], "invalid_settings")
        self.assertEqual(metadata_cidr.status_code, 400)
        self.assertEqual(metadata_cidr.json()["code"], "invalid_settings")
        self.assertEqual(empty.status_code, 422)
        self.assertEqual(empty.json()["code"], "validation_error")
        self.assertEqual(null_value.status_code, 422)
        self.assertEqual(null_value.json()["code"], "validation_error")

    def test_canonical_routes_and_readiness(self) -> None:
        runtime = AppRuntime(jobs=_Jobs(), version="1.2.3")  # type: ignore[arg-type]
        with TestClient(_app(runtime)) as client:  # type: ignore[misc]
            response = client.get("/api/v1/system/ready")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["state"], "ready")
        self.assertEqual(response.json()["version"], "1.2.3")

    def test_readiness_uses_runtime_authenticator(self) -> None:
        class Security:
            def require(
                self,
                headers=None,  # type: ignore[no-untyped-def]
                *,
                authorization=None,  # type: ignore[no-untyped-def]
                x_sidecar_auth=None,  # type: ignore[no-untyped-def]
            ) -> str:
                if not headers or headers.get("authorization") != "Bearer session":
                    raise AuthenticationRequiredError("session token is required")
                return "desktop"

        runtime = AppRuntime(
            jobs=_Jobs(),  # type: ignore[arg-type]
            security=Security(),  # type: ignore[arg-type]
        )
        with TestClient(_app(runtime)) as client:  # type: ignore[misc]
            denied = client.get("/api/v1/system/ready")
            allowed = client.get(
                "/api/v1/system/ready",
                headers={"Authorization": "Bearer session"},
            )

        self.assertEqual(denied.status_code, 401)
        self.assertEqual(denied.json()["code"], "authentication_required")
        self.assertEqual(allowed.status_code, 200)

    def test_readiness_detects_removed_database_without_recreating_it(self) -> None:
        from sidecar.persistence import Database

        with TemporaryDirectory() as temp:
            path = Path(temp) / "sidecar.db"
            database = Database(path)
            runtime = AppRuntime(database=database)
            runtime.register("database", database)
            with TestClient(_app(runtime)) as client:  # type: ignore[misc]
                healthy = client.get("/api/v1/system/ready")
                path.unlink()
                runtime.invalidate_readiness()
                unhealthy = client.get("/api/v1/system/ready")

            self.assertEqual(healthy.status_code, 200)
            self.assertEqual(unhealthy.status_code, 503)
            self.assertEqual(unhealthy.json()["code"], "not_ready")
            self.assertFalse(path.exists())

    def test_create_list_get_cancel_and_events(self) -> None:
        runtime = AppRuntime(jobs=_Jobs())  # type: ignore[arg-type]
        with TestClient(_app(runtime)) as client:  # type: ignore[misc]
            created = client.post(
                "/api/v1/generation/jobs",
                headers={"Idempotency-Key": "request-1"},
                json={"payload": _payload("cat")},
            )
            listed = client.get("/api/v1/generation/jobs")
            fetched = client.get("/api/v1/generation/jobs/job-1")
            events = client.get("/api/v1/generation/jobs/job-1/events")
            cancelled = client.post("/api/v1/generation/jobs/job-1/cancel", json={})

        self.assertEqual(created.status_code, 202)
        self.assertEqual(created.headers["location"], "/api/v1/generation/jobs/job-1")
        self.assertEqual(created.json()["payload"]["tags"], "cat")
        self.assertEqual(listed.json()["count"], 1)
        self.assertEqual(fetched.status_code, 200)
        self.assertTrue(events.headers["content-type"].startswith("text/event-stream"))
        self.assertIn("id: 1", events.text)
        self.assertIn('"event_watermark":1', events.text)
        self.assertNotIn("event: created", events.text)
        self.assertEqual(cancelled.json()["status"], "cancelled")

    def test_job_list_uses_opaque_cursor(self) -> None:
        class ManyJobs(_Jobs):
            def __init__(self) -> None:
                super().__init__()
                self.records = [_job(f"job-{index}") for index in range(3)]

            async def list_jobs(  # type: ignore[no-untyped-def]
                self,
                *,
                limit=100,
                offset=0,
                statuses=None,
            ):
                return self.records[offset : offset + limit]

        runtime = AppRuntime(jobs=ManyJobs())  # type: ignore[arg-type]
        with TestClient(_app(runtime)) as client:  # type: ignore[misc]
            first = client.get("/api/v1/generation/jobs?limit=1")
            cursor = first.json()["next_cursor"]
            second = client.get(
                "/api/v1/generation/jobs",
                params={"limit": 1, "cursor": cursor},
            )
            invalid = client.get("/api/v1/generation/jobs?cursor=not-a-cursor")

        self.assertIsNone(first.json()["cursor"])
        self.assertIsInstance(cursor, str)
        self.assertEqual(first.json()["items"][0]["id"], "job-0")
        self.assertEqual(second.json()["items"][0]["id"], "job-1")
        self.assertEqual(invalid.status_code, 400)
        self.assertEqual(invalid.json()["code"], "invalid_cursor")

    def test_v1_contract_integrates_with_persistent_job_service(self) -> None:
        from sidecar.persistence import Database
        from sidecar.services.jobs import JobService

        with TemporaryDirectory() as temp:
            runtime = AppRuntime(jobs=JobService(Database(Path(temp) / "sidecar.db"), capacity=1))
            with TestClient(_app(runtime)) as client:  # type: ignore[misc]
                created = client.post(
                    "/api/v1/generation/jobs",
                    headers={"Idempotency-Key": "persistent-request"},
                    json={"payload": _payload("persistent cat")},
                )
                job_id = created.json()["id"]
                replayed = client.post(
                    "/api/v1/generation/jobs",
                    headers={"Idempotency-Key": "persistent-request"},
                    json={"payload": _payload("persistent cat")},
                )
                fetched = client.get(f"/api/v1/generation/jobs/{job_id}")
                queue_full = client.post(
                    "/api/v1/generation/jobs",
                    json={"payload": _payload("second request")},
                )
                client.post(f"/api/v1/generation/jobs/{job_id}/cancel", json={})
                events = client.get(f"/api/v1/generation/jobs/{job_id}/events")

        self.assertEqual(created.status_code, 202)
        self.assertEqual(replayed.status_code, 200)
        self.assertEqual(replayed.json()["id"], created.json()["id"])
        self.assertEqual(replayed.headers["idempotency-replayed"], "true")
        self.assertEqual(fetched.json()["payload"]["tags"], "persistent cat")
        self.assertIn("event: snapshot", events.text)
        self.assertIn('"event_watermark":2', events.text)
        self.assertNotIn("event: queued", events.text)
        self.assertEqual(queue_full.status_code, 503)
        self.assertEqual(queue_full.json()["code"], "queue_full")
        self.assertTrue(queue_full.json()["retryable"])

    def test_terminal_sse_snapshot_never_replays_older_states(self) -> None:
        from sidecar.persistence import Database
        from sidecar.services.jobs import JobService

        with TemporaryDirectory() as temp:
            service = JobService(Database(Path(temp) / "sidecar.db"))

            async def complete() -> str:
                job = (await service.create_job(_payload("done"))).job
                await service.claim_next()
                await service.succeed_job(job.id, {"ok": True})
                return job.id

            asyncio.run(service.initialize())
            job_id = asyncio.run(complete())
            runtime = AppRuntime(jobs=service)
            with TestClient(_app(runtime)) as client:  # type: ignore[misc]
                events = client.get(f"/api/v1/generation/jobs/{job_id}/events")

        self.assertIn("event: snapshot", events.text)
        self.assertIn('"status":"succeeded"', events.text)
        self.assertNotIn("event: queued", events.text)
        self.assertNotIn("event: started", events.text)
        self.assertNotIn("event: succeeded", events.text)

    def test_v1_validation_and_domain_errors_use_problem_details(self) -> None:
        runtime = AppRuntime(jobs=_Jobs())  # type: ignore[arg-type]
        with TestClient(_app(runtime)) as client:  # type: ignore[misc]
            invalid = client.post(
                "/api/v1/generation/jobs",
                json={"payload": {}, "unexpected": True},
            )
            missing = client.get("/api/v1/generation/jobs/missing")

        self.assertEqual(invalid.status_code, 422)
        self.assertTrue(invalid.headers["content-type"].startswith("application/problem+json"))
        self.assertEqual(invalid.json()["code"], "validation_error")
        self.assertEqual(invalid.json()["request_id"], invalid.headers["x-request-id"])
        self.assertEqual(missing.status_code, 404)
        self.assertEqual(missing.json()["code"], "job_not_found")

    def test_unknown_v1_route_uses_problem_details_without_changing_v0(self) -> None:
        runtime = AppRuntime(jobs=_Jobs())  # type: ignore[arg-type]
        with TestClient(_app(runtime)) as client:  # type: ignore[misc]
            unknown_v1 = client.get("/api/v1/not-a-route")
            unknown_v0 = client.get("/not-a-route")

        self.assertEqual(unknown_v1.status_code, 404)
        self.assertEqual(unknown_v1.json()["code"], "route_not_found")
        self.assertTrue(unknown_v1.headers["content-type"].startswith("application/problem+json"))
        self.assertEqual(unknown_v0.status_code, 404)
        self.assertEqual(unknown_v0.headers["content-type"], "application/json")

    def test_v0_compatibility_is_opt_in(self) -> None:
        runtime = AppRuntime(jobs=_Jobs())  # type: ignore[arg-type]
        with TestClient(_app(runtime)) as client:  # type: ignore[misc]
            self.assertEqual(client.get("/generation/tasks").status_code, 404)

        compat_runtime = AppRuntime(jobs=_Jobs())  # type: ignore[arg-type]
        with TestClient(  # type: ignore[misc]
            _app(compat_runtime, include_v0_compat=True)
        ) as client:
            response = client.get("/generation/tasks")
            missing = client.post("/generation/tasks/missing/cancel")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()["items"]), 1)
        self.assertEqual(missing.status_code, 404)
        self.assertEqual(missing.json()["code"], "job_not_found")
        self.assertEqual(missing.headers["content-type"], "application/json")

    def test_dtos_are_strict_and_forbid_unknown_fields(self) -> None:
        with self.assertRaises(ValidationError):
            GenerationJobCreate.model_validate({"payload": {}, "extra": "forbidden"})

    def test_pairing_exchange_is_anonymous_one_use_and_documented(self) -> None:
        pairing = PairingManager(
            session_token="session-token",
            code_factory=lambda: "123456",
        )
        runtime = AppRuntime(
            jobs=_Jobs(),  # type: ignore[arg-type]
            security=AuthManager("session-token"),  # type: ignore[arg-type]
            settings=SimpleNamespace(
                current=SimpleNamespace(instance_id="instance-1", protocol_version=1)
            ),
            pairing=pairing,
        )
        with TestClient(_app(runtime)) as client:  # type: ignore[misc]
            denied = client.post("/api/v1/auth/pair")
            issued = client.post(
                "/api/v1/auth/pair",
                headers={"Authorization": "Bearer session-token"},
            )
            exchanged = client.post(
                "/api/v1/auth/pair/exchange",
                json={"code": issued.json()["code"]},
            )
            replayed = client.post(
                "/api/v1/auth/pair/exchange",
                json={"code": issued.json()["code"]},
            )
            schema = client.get("/openapi.json").json()

        self.assertEqual(denied.status_code, 401)
        self.assertEqual(issued.status_code, 200)
        self.assertEqual(exchanged.json()["access_token"], "session-token")
        self.assertEqual(exchanged.json()["instance_id"], "instance-1")
        self.assertEqual(replayed.status_code, 409)
        self.assertEqual(replayed.json()["code"], "pairing_replayed")
        self.assertIn("BearerAuth", schema["components"]["securitySchemes"])
        self.assertEqual(
            schema["paths"]["/api/v1/system/ready"]["get"]["security"],
            [{"BearerAuth": []}],
        )
        self.assertEqual(
            schema["paths"]["/api/v1/auth/pair/exchange"]["post"]["security"],
            [],
        )

    def test_every_v1_operation_documents_problem_details_media_type(self) -> None:
        runtime = AppRuntime(jobs=_Jobs())  # type: ignore[arg-type]
        with TestClient(_app(runtime)) as client:  # type: ignore[misc]
            schema = client.get("/openapi.json").json()

        expected_statuses = {
            "400",
            "401",
            "403",
            "404",
            "409",
            "410",
            "413",
            "422",
            "429",
            "500",
            "503",
            "507",
        }
        for path, path_item in schema["paths"].items():
            if not path.startswith("/api/v1/"):
                continue
            for method, operation in path_item.items():
                if method not in {"get", "post", "put", "patch", "delete"}:
                    continue
                statuses = expected_statuses
                if (path, method) == ("/api/v1/auth/pair/exchange", "post"):
                    statuses = expected_statuses - {"401", "403"}
                for status in statuses:
                    response = operation["responses"][status]
                    self.assertEqual(
                        set(response["content"]),
                        {"application/problem+json"},
                        f"{method.upper()} {path} {status}",
                    )
                    self.assertEqual(
                        response["content"]["application/problem+json"]["schema"]["$ref"],
                        "#/components/schemas/ProblemDetails",
                    )

    def test_drain_is_idempotent_and_readiness_turns_unavailable(self) -> None:
        controller = ProcessControl()
        runtime = AppRuntime(
            jobs=_Jobs(),  # type: ignore[arg-type]
            tasks=TaskSupervisor(),
            process_control=controller,
        )
        with TestClient(_app(runtime)) as client:  # type: ignore[misc]
            drained = client.post("/api/v1/system/drain")
            no_longer_ready = client.get("/api/v1/system/ready")
            rejected_write = client.post(
                "/api/v1/generation/jobs",
                json={"payload": _payload("too late")},
            )
            drained_again = client.post("/api/v1/system/drain")

        self.assertEqual(drained.status_code, 200)
        self.assertTrue(drained.json()["draining"])
        self.assertEqual(no_longer_ready.status_code, 503)
        self.assertEqual(no_longer_ready.json()["code"], "not_ready")
        self.assertEqual(rejected_write.status_code, 503)
        self.assertEqual(rejected_write.json()["code"], "service_draining")
        self.assertEqual(drained_again.status_code, 200)
        self.assertTrue(controller.shutdown_requested)

    def test_storage_download_and_explicit_prune(self) -> None:
        from sidecar.persistence import Database
        from sidecar.services.assets import AssetService

        with TemporaryDirectory() as temp:
            database = Database(Path(temp) / "sidecar.db")
            assets = AssetService(database, Path(temp) / "assets", reserve_bytes=0)

            async def populate() -> None:
                await assets.initialize()
                await assets.store_bytes(
                    "asset-1",
                    "manual/item.bin",
                    b"payload",
                    media_type="application/octet-stream",
                )

            asyncio.run(populate())
            runtime = AppRuntime(assets=assets)
            runtime.register("assets", assets)
            with TestClient(_app(runtime)) as client:  # type: ignore[misc]
                status = client.get("/api/v1/storage")
                listed = client.get("/api/v1/assets")
                content = client.get("/api/v1/assets/asset-1/content")
                pruned = client.post(
                    "/api/v1/storage/prune",
                    json={"asset_ids": ["asset-1", "missing"]},
                )
                missing = client.get("/api/v1/assets/asset-1")

        self.assertEqual(status.status_code, 200)
        self.assertGreaterEqual(status.json()["catalog_bytes"], 7)
        self.assertEqual(listed.json()["items"][0]["id"], "asset-1")
        self.assertEqual(content.content, b"payload")
        self.assertEqual(pruned.json()["removed_asset_ids"], ["asset-1"])
        self.assertEqual(pruned.json()["missing_asset_ids"], ["missing"])
        self.assertEqual(missing.status_code, 404)


class SseStreamTests(unittest.IsolatedAsyncioTestCase):
    async def test_sse_response_cancels_body_iterator_on_disconnect(self) -> None:
        waiting = asyncio.Event()
        cancelled = asyncio.Event()
        receives = 0

        async def body():  # type: ignore[no-untyped-def]
            yield "event: snapshot\ndata: {}\n\n"
            waiting.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        async def receive():  # type: ignore[no-untyped-def]
            nonlocal receives
            receives += 1
            if receives == 1:
                return {"type": "http.request", "body": b"", "more_body": False}
            await waiting.wait()
            return {"type": "http.disconnect"}

        messages: list[dict[str, Any]] = []

        async def send(message):  # type: ignore[no-untyped-def]
            messages.append(dict(message))

        response = SSEStreamingResponse(body())
        await asyncio.wait_for(
            response(  # type: ignore[arg-type]
                {"type": "http", "method": "GET", "path": "/events"},
                receive,
                send,
            ),
            timeout=1,
        )

        self.assertTrue(cancelled.is_set())
        self.assertEqual(messages[0]["type"], "http.response.start")
        self.assertTrue(any(message.get("more_body") for message in messages[1:]))

    async def test_stream_emits_keepalive_while_waiting_for_persisted_event(self) -> None:
        class SlowJobs(_Jobs):
            async def watch_events(  # type: ignore[no-untyped-def]
                self,
                job_id,
                *,
                after_sequence=0,
                poll_interval=0.25,
            ):
                await asyncio.sleep(1)
                if False:
                    yield None

        class ConnectedRequest:
            url = SimpleNamespace(path="/api/v1/generation/jobs/job-1/events")

            async def is_disconnected(self) -> bool:
                return False

        jobs = SlowJobs()
        stream = generation_event_stream(
            ConnectedRequest(),  # type: ignore[arg-type]
            jobs,  # type: ignore[arg-type]
            jobs.record,
            keepalive_interval=0.001,
        )
        snapshot = await anext(stream)
        keepalive = await anext(stream)
        await stream.aclose()

        self.assertIn("event: snapshot", snapshot)
        self.assertEqual(keepalive, ": keepalive\n\n")
