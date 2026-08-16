"""Family-A ComfyUI channel: protocol client, templates, and executor dispatch."""

from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch as mock_patch

from pydantic import ValidationError

from sidecar.application.settings import SettingsStore
from sidecar.comfy import ComfyUIClient, ComfyUIError, generate_comfy_image
from sidecar.comfy.service import comfy_outbound_policy
from sidecar.comfy.workflows import load_workflow_template, patch_workflow
from sidecar.config import Settings
from sidecar.local_settings import normalize_editable_updates
from sidecar.nai.models import GenerateRequest, GenerationParams
from sidecar.persistence import Database
from sidecar.security import OutboundPolicy, OutboundPolicyError
from sidecar.services.assets import AssetService
from sidecar.services.generation import NovelAIGenerationExecutor
from sidecar.services.jobs import JobService


class _FakeResponse:
    def __init__(self, status_code: int, body: Any = None, content: bytes = b"") -> None:
        self.status_code = status_code
        self._body = body
        if content:
            self.content = content
        elif isinstance(body, bytes):
            self.content = body
        elif body is not None:
            self.content = json.dumps(body).encode()
        else:
            self.content = b""

    def json(self) -> Any:
        if isinstance(self._body, (bytes, str)):
            return json.loads(self._body)
        if self._body is None:
            raise ValueError("no body")
        return self._body


class _FakePool:
    """Scripted HttpClientPool double keyed by ``METHOD path``."""

    def __init__(self, routes: dict[str, Any]) -> None:
        self.routes = routes
        self.calls: list[tuple[str, str]] = []

    async def request(
        self,
        policy: OutboundPolicy,
        method: str,
        url: str,
        **_kwargs: Any,
    ) -> _FakeResponse:
        path = url.split("://", 1)[1].split("/", 1)[1].split("?", 1)[0]
        key = f"{method} /{path}"
        self.calls.append((method, url))
        handler = self.routes.get(key)
        if handler is None:
            raise AssertionError(f"unexpected request: {key}")
        result = handler.pop(0) if isinstance(handler, list) else handler
        if isinstance(result, Exception):
            raise result
        return result


def _client(pool: _FakePool) -> ComfyUIClient:
    return ComfyUIClient(
        base_url="http://127.0.0.1:8188",
        policy=OutboundPolicy("loopback"),
        http=pool,  # type: ignore[arg-type]
    )


def _workflow() -> dict[str, Any]:
    return {
        "3": {
            "class_type": "KSampler",
            "inputs": {
                "seed": 1,
                "steps": 30,
                "cfg": 7.5,
                "positive": ["6", 0],
                "negative": ["7", 0],
                "latent_image": ["5", 0],
            },
        },
        "5": {
            "class_type": "EmptyLatentImage",
            "inputs": {"width": 512, "height": 512, "batch_size": 1},
        },
        "6": {"class_type": "CLIPTextEncode", "inputs": {"text": "placeholder"}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"text": "bad"}},
        "9": {"class_type": "SaveImage", "inputs": {"images": ["3", 0]}},
    }


def _history_success() -> dict[str, Any]:
    return {
        "pid-1": {
            "status": {"status_str": "success", "completed": True, "messages": []},
            "outputs": {
                "9": {
                    "images": [
                        {"filename": "out_00001_.png", "subfolder": "", "type": "output"}
                    ]
                }
            },
        }
    }


class WorkflowTemplateTests(unittest.TestCase):
    def test_user_template_loads_and_patches(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            user_dir = Path(directory)
            (user_dir / "anime-xl.json").write_text(json.dumps(_workflow()), "utf-8")
            workflow = load_workflow_template("anime-xl", user_dir=user_dir)

            params = GenerationParams(
                provider="comfy", model="anime-xl", width=832, height=1216, seed=42
            )
            patched = patch_workflow(workflow, tags="1girl", negative="lowres", params=params)

            self.assertEqual(patched["6"]["inputs"]["text"], "1girl")
            self.assertEqual(patched["7"]["inputs"]["text"], "lowres")
            self.assertEqual(patched["5"]["inputs"]["width"], 832)
            self.assertEqual(patched["5"]["inputs"]["height"], 1216)
            self.assertEqual(patched["3"]["inputs"]["seed"], 42)
            # The workflow author's tuning is authoritative for steps/cfg.
            self.assertEqual(patched["3"]["inputs"]["steps"], 30)
            self.assertEqual(patched["3"]["inputs"]["cfg"], 7.5)
            # The template itself stays untouched.
            self.assertEqual(workflow["6"]["inputs"]["text"], "placeholder")

    def test_seed_defaults_to_random(self) -> None:
        params = GenerationParams(provider="comfy", model="anime-xl", seed=None)
        patched = patch_workflow(_workflow(), tags="t", negative="", params=params)
        self.assertIsInstance(patched["3"]["inputs"]["seed"], int)
        self.assertNotEqual(patched["3"]["inputs"]["seed"], 1)

    def test_missing_template_fails_with_provisioning_hint(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ComfyUIError) as caught:
                load_workflow_template("absent", user_dir=Path(directory))
            self.assertEqual(caught.exception.code, "comfy_workflow_missing")
            self.assertIn("absent.json", str(caught.exception))

    def test_invalid_template_shapes_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            user_dir = Path(directory)
            cases = {
                "not-json": "{broken",
                "not-a-map": json.dumps(["nodes"]),
                # UI-format exports have a top-level "nodes" list, not a node map.
                "ui-format": json.dumps({"nodes": [], "links": []}),
            }
            for name, content in cases.items():
                (user_dir / f"{name}.json").write_text(content, "utf-8")
                with self.assertRaises(ComfyUIError) as caught:
                    load_workflow_template(name, user_dir=user_dir)
                self.assertEqual(caught.exception.code, "comfy_workflow_invalid", name)

    def test_traversal_ids_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            for bad in ("../etc/passwd", "a/b", "A-Upper", ""):
                with self.assertRaises(ComfyUIError) as caught:
                    load_workflow_template(bad, user_dir=Path(directory))
                self.assertEqual(caught.exception.code, "comfy_workflow_invalid", bad)


class ClientProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def test_generate_happy_path(self) -> None:
        pool = _FakePool(
            {
                "POST /prompt": _FakeResponse(200, {"prompt_id": "pid-1"}),
                "GET /history/pid-1": _FakeResponse(200, _history_success()),
                "GET /view": _FakeResponse(200, content=b"png-bytes"),
            }
        )
        progress: list[float] = []

        async def on_progress(value: float) -> None:
            progress.append(value)

        image = await _client(pool).generate(_workflow(), on_progress=on_progress)
        self.assertEqual(image, b"png-bytes")
        self.assertTrue(progress and progress[0] == 0.05)
        view_url = next(url for method, url in pool.calls if "/view" in url)
        self.assertIn("filename=out_00001_.png", view_url)

    async def test_rejected_workflow_maps_node_errors(self) -> None:
        pool = _FakePool(
            {
                "POST /prompt": _FakeResponse(
                    400,
                    {"error": {"message": "invalid prompt"}, "node_errors": {"6": {}}},
                )
            }
        )
        with self.assertRaises(ComfyUIError) as caught:
            await _client(pool).generate(_workflow())
        self.assertEqual(caught.exception.code, "comfy_rejected")
        self.assertIn("invalid prompt", str(caught.exception))

    async def test_transport_failure_is_wrapped_without_body(self) -> None:
        pool = _FakePool({"POST /prompt": ConnectionError("secret internals")})
        with self.assertRaises(ComfyUIError) as caught:
            await _client(pool).submit(_workflow())
        self.assertEqual(caught.exception.code, "comfy_unreachable")
        self.assertNotIn("secret internals", str(caught.exception))

    async def test_execution_error_surfaces_concise_detail(self) -> None:
        entry = {
            "pid-1": {
                "status": {
                    "status_str": "error",
                    "completed": False,
                    "messages": [
                        ["execution_error", {"exception_message": "OOM on cuda:0"}]
                    ],
                },
                "outputs": {},
            }
        }
        pool = _FakePool(
            {
                "POST /prompt": _FakeResponse(200, {"prompt_id": "pid-1"}),
                "GET /history/pid-1": _FakeResponse(200, entry),
            }
        )
        with self.assertRaises(ComfyUIError) as caught:
            await _client(pool).generate(_workflow())
        self.assertEqual(caught.exception.code, "comfy_failed")
        self.assertIn("OOM", str(caught.exception))

    async def test_finished_run_without_images_fails(self) -> None:
        entry = _history_success()
        entry["pid-1"]["outputs"] = {"9": {"images": []}}
        pool = _FakePool(
            {
                "POST /prompt": _FakeResponse(200, {"prompt_id": "pid-1"}),
                "GET /history/pid-1": _FakeResponse(200, entry),
            }
        )
        with self.assertRaises(ComfyUIError) as caught:
            await _client(pool).generate(_workflow())
        self.assertEqual(caught.exception.code, "comfy_no_output")

    async def test_dropped_run_fails_instead_of_spinning(self) -> None:
        pool = _FakePool(
            {
                "POST /prompt": _FakeResponse(200, {"prompt_id": "pid-1"}),
                "GET /history/pid-1": _FakeResponse(200, {}),
                "GET /queue": _FakeResponse(
                    200, {"queue_running": [], "queue_pending": []}
                ),
            }
        )
        with self.assertRaises(ComfyUIError) as caught:
            await _client(pool).generate(_workflow())
        self.assertEqual(caught.exception.code, "comfy_failed")

    async def test_cancellation_dequeues_and_interrupts(self) -> None:
        pool = _FakePool(
            {
                "POST /prompt": _FakeResponse(200, {"prompt_id": "pid-1"}),
                "GET /history/pid-1": _FakeResponse(200, {}),
                "GET /queue": _FakeResponse(
                    200, {"queue_running": [[0, "pid-1"]], "queue_pending": []}
                ),
                "POST /queue": _FakeResponse(200, {}),
                "POST /interrupt": _FakeResponse(200, {}),
            }
        )
        task = asyncio.create_task(
            _client(pool).generate(_workflow(), poll_interval=0.01)
        )
        for _ in range(200):
            await asyncio.sleep(0.005)
            if any("/queue" in url for _method, url in pool.calls):
                break
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        methods = [(method, url.rsplit("/", 1)[1].split("?")[0]) for method, url in pool.calls]
        self.assertIn(("POST", "queue"), methods)
        self.assertIn(("POST", "interrupt"), methods)


class ClientProtocolEdgeTests(unittest.IsolatedAsyncioTestCase):
    async def test_submit_protocol_violations(self) -> None:
        cases = [
            (_FakeResponse(200, b"not-json{"), "comfy_protocol"),
            (_FakeResponse(200, {"no_prompt_id": True}), "comfy_protocol"),
            (_FakeResponse(400, b"<html>busy</html>"), "comfy_rejected"),
            (_FakeResponse(400, ["not-a-dict"]), "comfy_rejected"),
            (_FakeResponse(400, {"node_errors": {"6": {}, "7": {}}}), "comfy_rejected"),
        ]
        for response, expected_code in cases:
            pool = _FakePool({"POST /prompt": response})
            with self.assertRaises(ComfyUIError) as caught:
                await _client(pool).submit(_workflow())
            self.assertEqual(caught.exception.code, expected_code)
        # node_errors without error.message names the offending nodes.
        with self.assertRaises(ComfyUIError) as caught:
            await _client(
                _FakePool({"POST /prompt": _FakeResponse(400, {"node_errors": {"6": {}}})})
            ).submit(_workflow())
        self.assertIn("6", str(caught.exception))

    async def test_history_and_queue_protocol_violations(self) -> None:
        client = _client(_FakePool({"GET /history/pid-1": _FakeResponse(500, {})}))
        with self.assertRaises(ComfyUIError) as caught:
            await client.history_entry("pid-1")
        self.assertEqual(caught.exception.code, "comfy_protocol")

        client = _client(_FakePool({"GET /history/pid-1": _FakeResponse(200, b"nope{")}))
        with self.assertRaises(ComfyUIError):
            await client.history_entry("pid-1")

        client = _client(_FakePool({"GET /queue": _FakeResponse(500, {})}))
        with self.assertRaises(ComfyUIError) as caught:
            await client.queue_state("pid-1")
        self.assertEqual(caught.exception.code, "comfy_protocol")

        client = _client(_FakePool({"GET /queue": _FakeResponse(200, b"nope{")}))
        with self.assertRaises(ComfyUIError):
            await client.queue_state("pid-1")

        client = _client(_FakePool({"GET /queue": _FakeResponse(200, ["not", "dict"])}))
        self.assertEqual(await client.queue_state("pid-1"), "absent")

        malformed_rows = {"queue_running": [["only-number"]], "queue_pending": "x"}
        client = _client(_FakePool({"GET /queue": _FakeResponse(200, malformed_rows)}))
        self.assertEqual(await client.queue_state("pid-1"), "absent")

    async def test_view_failures(self) -> None:
        client = _client(_FakePool({}))
        with self.assertRaises(ComfyUIError) as caught:
            await client.fetch_image({"subfolder": ""})
        self.assertEqual(caught.exception.code, "comfy_no_output")

        client = _client(_FakePool({"GET /view": _FakeResponse(404, {})}))
        with self.assertRaises(ComfyUIError) as caught:
            await client.fetch_image({"filename": "a.png"})
        self.assertEqual(caught.exception.code, "comfy_no_output")

    async def test_generation_timeout(self) -> None:
        pool = _FakePool(
            {
                "POST /prompt": _FakeResponse(200, {"prompt_id": "pid-1"}),
                "GET /history/pid-1": _FakeResponse(200, {}),
            }
        )
        with self.assertRaises(ComfyUIError) as caught:
            await _client(pool).generate(_workflow(), timeout_s=0.0)
        self.assertEqual(caught.exception.code, "comfy_timeout")

    async def test_pending_queue_reports_floor_progress(self) -> None:
        pool = _FakePool(
            {
                "POST /prompt": _FakeResponse(200, {"prompt_id": "pid-1"}),
                "GET /history/pid-1": [
                    _FakeResponse(200, {}),
                    _FakeResponse(200, _history_success()),
                ],
                "GET /queue": _FakeResponse(
                    200, {"queue_running": [], "queue_pending": [[1, "pid-1"]]}
                ),
                "GET /view": _FakeResponse(200, content=b"png-bytes"),
            }
        )
        progress: list[float] = []

        async def on_progress(value: float) -> None:
            progress.append(value)

        image = await _client(pool).generate(
            _workflow(), on_progress=on_progress, poll_interval=0.01
        )
        self.assertEqual(image, b"png-bytes")
        self.assertEqual(progress, [0.05, 0.1])

    async def test_cancellation_survives_unreachable_cleanup(self) -> None:
        pool = _FakePool(
            {
                "POST /prompt": _FakeResponse(200, {"prompt_id": "pid-1"}),
                "GET /history/pid-1": _FakeResponse(200, {}),
                "GET /queue": _FakeResponse(
                    200, {"queue_running": [[0, "pid-1"]], "queue_pending": []}
                ),
                "POST /queue": ConnectionError("gone"),
                "POST /interrupt": ConnectionError("gone"),
            }
        )
        task = asyncio.create_task(_client(pool).generate(_workflow(), poll_interval=0.01))
        await asyncio.sleep(0.03)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task

    async def test_execution_error_without_message_detail(self) -> None:
        for messages in (
            "not-a-list",
            [["execution_error", {"node_type": "KSampler"}]],
            [["progress", {}]],
        ):
            entry = {
                "pid-1": {
                    "status": {
                        "status_str": "error",
                        "completed": False,
                        "messages": messages,
                    }
                }
            }
            pool = _FakePool(
                {
                    "POST /prompt": _FakeResponse(200, {"prompt_id": "pid-1"}),
                    "GET /history/pid-1": _FakeResponse(200, entry),
                }
            )
            with self.assertRaises(ComfyUIError) as caught:
                await _client(pool).generate(_workflow())
            self.assertEqual(caught.exception.code, "comfy_failed")

    async def test_output_image_fallback_and_statusless_entries(self) -> None:
        # No status dict at all (older ComfyUI) plus only non-"output" images:
        # the temp image is still better than failing the whole run.
        entry = {
            "pid-1": {
                "outputs": {
                    "9": {
                        "images": [
                            {"filename": "tmp_1.png", "subfolder": "t", "type": "temp"}
                        ]
                    },
                    "bad": "not-a-dict",
                    "empty": {"images": "not-a-list"},
                }
            }
        }
        pool = _FakePool(
            {
                "POST /prompt": _FakeResponse(200, {"prompt_id": "pid-1"}),
                "GET /history/pid-1": _FakeResponse(200, entry),
                "GET /view": _FakeResponse(200, content=b"temp-bytes"),
            }
        )
        image = await _client(pool).generate(_workflow())
        self.assertEqual(image, b"temp-bytes")
        view_url = next(url for _method, url in pool.calls if "/view" in url)
        self.assertIn("filename=tmp_1.png", view_url)
        self.assertIn("type=temp", view_url)


class _FakeTraversable:
    def __init__(self, payload: bytes | None) -> None:
        self._payload = payload

    def joinpath(self, _name: str) -> _FakeTraversable:
        return self

    def is_file(self) -> bool:
        return self._payload is not None

    def read_bytes(self) -> bytes:
        assert self._payload is not None
        return self._payload


class PackagedTemplateTests(unittest.TestCase):
    def test_packaged_template_is_used_when_user_file_is_absent(self) -> None:
        payload = json.dumps(_workflow()).encode()
        with tempfile.TemporaryDirectory() as directory:
            with mock_patch(
                "sidecar.comfy.workflows.resources.files",
                return_value=_FakeTraversable(payload),
            ):
                workflow = load_workflow_template("builtin", user_dir=Path(directory))
        self.assertIn("3", workflow)

    def test_oversized_templates_fail_closed(self) -> None:
        huge = b" " * (2 * 1024 * 1024 + 1)
        with tempfile.TemporaryDirectory() as directory:
            user_dir = Path(directory)
            (user_dir / "huge.json").write_bytes(huge)
            with self.assertRaises(ComfyUIError) as caught:
                load_workflow_template("huge", user_dir=user_dir)
            self.assertEqual(caught.exception.code, "comfy_workflow_invalid")
            with mock_patch(
                "sidecar.comfy.workflows.resources.files",
                return_value=_FakeTraversable(huge),
            ):
                with self.assertRaises(ComfyUIError) as packaged:
                    load_workflow_template("huge2", user_dir=user_dir)
            self.assertEqual(packaged.exception.code, "comfy_workflow_invalid")

    def test_patch_ignores_malformed_links_and_nodes(self) -> None:
        workflow = {
            "1": {"class_type": "X", "inputs": "not-a-dict"},
            "2": {
                "class_type": "KSampler",
                "inputs": {"positive": "const", "negative": ["404", 0], "seed": 3},
            },
            "3": {"class_type": "Y", "inputs": {"positive": ["4", 0], "negative": ["4", 0]}},
            "4": {"class_type": "ConditioningCombine", "inputs": {"conditioning": []}},
        }
        params = GenerationParams(provider="comfy", model="anime-xl", seed=9)
        patched = patch_workflow(workflow, tags="t", negative="n", params=params)
        self.assertEqual(patched["2"]["inputs"]["positive"], "const")
        self.assertEqual(patched["2"]["inputs"]["seed"], 9)
        self.assertEqual(patched["4"]["inputs"], {"conditioning": []})


def _settings(root: Path, **overrides: Any) -> Settings:
    values: dict[str, Any] = dict(
        host="127.0.0.1",
        port=0,
        data_dir=root,
        nai_token="",
        nai_base_url="https://image.novelai.net",
        llm_base_url="",
        llm_api_key="",
        llm_model="",
        mock_generation=False,
    )
    values.update(overrides)
    return Settings(**values)


class ServiceDispatchTests(unittest.IsolatedAsyncioTestCase):
    async def test_unconfigured_endpoint_fails_closed_without_requests(self) -> None:
        pool = _FakePool({})
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ComfyUIError) as caught:
                await generate_comfy_image(
                    settings=_settings(Path(directory)),
                    tags="1girl",
                    negative="",
                    params=GenerationParams(provider="comfy", model="anime-xl"),
                    http=pool,  # type: ignore[arg-type]
                )
        self.assertEqual(caught.exception.code, "comfy_not_configured")
        self.assertEqual(pool.calls, [])

    async def test_configured_endpoint_runs_patched_workflow(self) -> None:
        pool = _FakePool(
            {
                "POST /prompt": _FakeResponse(200, {"prompt_id": "pid-1"}),
                "GET /history/pid-1": _FakeResponse(200, _history_success()),
                "GET /view": _FakeResponse(200, content=b"png-bytes"),
            }
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workflows = root / "comfy-workflows"
            workflows.mkdir()
            (workflows / "anime-xl.json").write_text(json.dumps(_workflow()), "utf-8")
            image = await generate_comfy_image(
                settings=_settings(root, comfy_base_url="http://127.0.0.1:8188"),
                tags="1girl",
                negative="",
                params=GenerationParams(provider="comfy", model="anime-xl"),
                http=pool,  # type: ignore[arg-type]
            )
        self.assertEqual(image, b"png-bytes")

    def test_outbound_policy_matches_scope(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            loopback = comfy_outbound_policy(
                _settings(root, comfy_base_url="http://127.0.0.1:8188")
            )
            self.assertEqual(loopback.mode.value, "loopback")
            lan = comfy_outbound_policy(
                _settings(
                    root,
                    comfy_base_url="http://192.168.1.20:8188",
                    comfy_network_scope="trusted-lan",
                    comfy_trusted_networks=("192.168.1.0/24",),
                )
            )
            self.assertEqual(lan.mode.value, "trusted-lan")
            # The policy itself refuses a public destination for this channel.
            # (An IP literal keeps the check DNS-free in tests.)
            with self.assertRaises(OutboundPolicyError):
                loopback.validate_url("http://8.8.8.8:8188/prompt")


class ExecutorDispatchTests(unittest.IsolatedAsyncioTestCase):
    async def _executor_with_job(
        self, root: Path, payload: dict[str, Any]
    ) -> tuple[NovelAIGenerationExecutor, JobService, Any]:
        database = Database(root / "executor.sqlite3")
        assets = AssetService(
            database,
            root / "assets",
            quota_bytes=64 * 1024 * 1024,
            reserve_bytes=0,
        )
        jobs = JobService(database)
        await jobs.initialize()
        await jobs.create_job(payload, job_id="comfy-job")  # type: ignore[arg-type]
        job = await jobs.claim_next()
        assert job is not None
        executor = NovelAIGenerationExecutor(
            SettingsStore(
                _settings(root, comfy_base_url="http://127.0.0.1:8188"),
                loader=None,
            ),
            assets,
            _FakePool({}),  # type: ignore[arg-type]
            jobs=jobs,
        )
        await executor.initialize()
        return executor, jobs, job

    async def test_comfy_provider_dispatch_stores_asset_and_progress(self) -> None:
        payload = {
            "input": "1girl",
            "mode": "tags",
            "params": {"provider": "comfy", "model": "anime-xl"},
        }
        with tempfile.TemporaryDirectory() as directory:
            executor, jobs, job = await self._executor_with_job(Path(directory), payload)
            captured: dict[str, Any] = {}

            async def fake_generate(**kwargs: Any) -> bytes:
                captured.update(kwargs)
                await kwargs["on_progress"](0.5)
                # A non-monotonic estimate must be swallowed, not raise.
                await kwargs["on_progress"](0.25)
                return b"png-bytes"

            with mock_patch(
                "sidecar.services.generation.generate_comfy_image",
                side_effect=fake_generate,
            ):
                result = await executor(job)

            self.assertEqual(result["tags"], "1girl")
            self.assertEqual(captured["params"].model, "anime-xl")
            current = await jobs.require_job(job.id)
            self.assertEqual(current.progress, 0.5)

    async def test_comfy_provider_without_http_pool_fails_closed(self) -> None:
        payload = {
            "input": "1girl",
            "mode": "tags",
            "params": {"provider": "comfy", "model": "anime-xl"},
        }
        with tempfile.TemporaryDirectory() as directory:
            executor, _jobs, job = await self._executor_with_job(Path(directory), payload)
            executor.http = None
            with self.assertRaises(Exception) as caught:
                await executor(job)
            self.assertEqual(getattr(caught.exception, "code", ""), "comfy_not_configured")

    async def test_progress_reporter_absent_without_job_store(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            executor = NovelAIGenerationExecutor(
                SettingsStore(_settings(root), loader=None),
                AssetService(
                    Database(root / "plain.sqlite3"),
                    root / "assets",
                    quota_bytes=64 * 1024 * 1024,
                    reserve_bytes=0,
                ),
            )
            self.assertIsNone(executor._progress_reporter("any"))  # noqa: SLF001


class ContractTests(unittest.TestCase):
    def test_provider_defaults_to_nai_and_keeps_model_whitelist(self) -> None:
        request = GenerateRequest(input="1girl")
        self.assertEqual(request.params.provider, "nai")
        with self.assertRaises(ValidationError):
            GenerationParams(model="anime-xl")  # non-NAI model without provider

    def test_comfy_provider_accepts_workflow_ids_only(self) -> None:
        params = GenerationParams(provider="comfy", model="anime-xl")
        self.assertEqual(params.model, "anime-xl")
        for bad in ("../evil", "a/b", "UPPER", "-leading"):
            with self.assertRaises(ValidationError):
                GenerationParams(provider="comfy", model=bad)

    def test_editable_settings_accept_comfy_keys_and_reject_public_scope(self) -> None:
        accepted = normalize_editable_updates(
            {
                "comfy_base_url": "http://127.0.0.1:8188",
                "comfy_network_scope": "loopback",
            }
        )
        self.assertEqual(accepted["comfy_base_url"], "http://127.0.0.1:8188")
        with self.assertRaises(ValueError):
            normalize_editable_updates({"comfy_network_scope": "public"})
        with self.assertRaises(ValueError):
            normalize_editable_updates({"comfy_base_url": "ftp://127.0.0.1/x"})
        with self.assertRaises(ValueError):
            # Link-local/cloud-metadata space is never a valid ComfyUI endpoint.
            normalize_editable_updates({"comfy_base_url": "http://169.254.169.254/"})


if __name__ == "__main__":
    unittest.main()
