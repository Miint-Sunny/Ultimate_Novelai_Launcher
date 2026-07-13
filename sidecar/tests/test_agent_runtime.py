from __future__ import annotations

import asyncio
import base64
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast
from unittest.mock import patch

import httpx
import yaml
from fastapi.testclient import TestClient

from backend_core.errors import InvalidArgumentError
from server.agent_router.llm.exceptions import ModelHTTPError, ModelProtocolError
from server.agent_router.llm.messages import ModelResponse, TextPart, ToolCallPart
from server.agent_router.llm.models import AnthropicModel, GoogleModel, Model, OpenAIModel
from server.agent_router.llm.output import OUTPUT_TOOL_NAME
from server.agent_router.llm.providers import OpenAIProvider
from server.agent_router.llm.result import Usage
from server.agent_router.prompts import PromptResourceError, prompt_bundle_from_text
from sidecar import agent_runtime
from sidecar.agent_runtime import (
    AgentRequestValidationError,
    AgentRuntimeUnavailable,
    DesktopAgentAdapter,
    FailoverModel,
    RequestFailoverState,
    SidecarKnowledgeSnapshot,
    build_agent_model,
    build_request_models,
    load_sidecar_knowledge,
    public_agent_error,
    should_fail_over,
)
from sidecar.api.compat.models import AgentWebGeneratePromptRequest
from sidecar.application import SettingsStore
from sidecar.config import LlmSlot, Settings
from sidecar.persistence import Database
from sidecar.security import OutboundPolicy, OutboundPolicyError, OutboundResolutionError
from sidecar.server import create_app
from sidecar.services import library as library_module
from sidecar.services.assets import AssetService
from sidecar.services.library import LibraryItem, LibraryKind, LibraryService

_PNG_DATA = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/"
    "p9sAAAAASUVORK5CYII="
)
_PNG_B64 = base64.b64encode(_PNG_DATA).decode("ascii")


def _settings(
    data_dir: Path,
    *,
    primary: bool = True,
    backup: bool = False,
    auth: bool = False,
) -> Settings:
    return Settings(
        host="127.0.0.1",
        port=38176,
        data_dir=data_dir,
        nai_token="",
        nai_base_url="https://image.novelai.net",
        llm_base_url="https://primary.example/v1" if primary else "",
        llm_api_key="primary-key" if primary else "",
        llm_model="primary-model" if primary else "",
        mock_generation=True,
        llm_provider="openai",
        llm_backup_provider="anthropic",
        llm_backup_base_url="https://backup.example" if backup else "",
        llm_backup_api_key="backup-key" if backup else "",
        llm_backup_model="backup-model" if backup else "",
        sidecar_auth_token="sidecar-secret" if auth else "",
        unsafe_dev_no_auth=not auth,
    )


def _prompt_bundle():
    planner_names = (
        "mission",
        "input_format",
        "nsfw_authorization",
        "art_fundamentals",
        "art_principles",
        "character_rules",
        "art_advanced",
        "fixed_combos",
        "technique_combos",
        "art_craft",
        "reference_examples",
        "draw_output",
    )
    return prompt_bundle_from_text(
        yaml.safe_dump(
            {
                "chat": {
                    "persona": "test persona",
                    "workflow": "test workflow",
                    "tools_hint": "test tools",
                    "reply_rules": "test replies",
                },
                "lite_chat": {"system_prompt": "Return the Lite result."},
                "planner": {
                    "system_prompts": [
                        {"name": name, "content": f"test {name}"}
                        for name in planner_names
                    ]
                },
            },
            allow_unicode=True,
            sort_keys=False,
        ),
        "synthetic-test-prompts",
    )


class FakeModel(Model):
    def __init__(self, name: str, responses: list[Any], calls: list[str] | None = None) -> None:
        self.model_name = name
        self.responses = list(responses)
        self.settings: list[dict[str, Any] | None] = []
        self.message_batches: list[list[Any]] = []
        self.calls = calls

    async def request(
        self,
        messages,
        *,
        system_parts,
        tools,
        require_tool,
        model_settings=None,
    ):
        del system_parts, tools, require_tool
        if self.calls is not None:
            self.calls.append(self.model_name)
        self.settings.append(model_settings)
        self.message_batches.append(list(messages))
        result = self.responses.pop(0)
        if isinstance(result, BaseException):
            raise result
        return result, Usage(requests=1)


class RecordingPool:
    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []

    async def request(self, policy, method, url, **kwargs):
        self.requests.append(
            {"policy": policy, "method": method, "url": url, "kwargs": kwargs}
        )
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": "ok"}}]},
            request=httpx.Request(method, url),
        )


class AgentFailoverTests(unittest.IsolatedAsyncioTestCase):
    async def test_provider_empty_success_is_protocol_failure_and_uses_backup(self) -> None:
        async def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"choices": [{"message": {}}]})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            primary = OpenAIModel(
                "primary",
                OpenAIProvider(base_url="https://primary.example/v1", http_client=client),
            )
            backup = FakeModel(
                "backup",
                [ModelResponse(parts=[TextPart(content="backup result")])],
            )
            state = RequestFailoverState()
            model = FailoverModel([primary, backup], [None, None], state)

            response, _usage = await model.request(
                [],
                system_parts=[],
                tools=[],
                require_tool=False,
            )

        self.assertTrue(state.degraded)
        self.assertEqual(state.primary_error_type, "ModelProtocolError")
        self.assertEqual(cast(TextPart, response.parts[0]).content, "backup result")

    async def test_primary_failure_pins_lite_and_planner_to_backup(self) -> None:
        calls: list[str] = []
        primary = FakeModel("primary", [ModelHTTPError(503, "secret body")], calls)
        backup = FakeModel(
            "backup",
            [
                ModelResponse(parts=[TextPart(content="lite")]),
                ModelResponse(parts=[TextPart(content="planner")]),
            ],
            calls,
        )
        events: list[str] = []

        async def degraded(_: BaseException) -> None:
            events.append("degraded")

        state = RequestFailoverState(on_failover=degraded)
        lite = FailoverModel([primary, backup], [None, {"phase": "lite"}], state)
        planner = FailoverModel([primary, backup], [None, {"phase": "planner"}], state)

        await lite.request([], system_parts=[], tools=[], require_tool=False)
        await planner.request([], system_parts=[], tools=[], require_tool=False)

        self.assertEqual(calls, ["primary", "backup", "backup"])
        self.assertEqual(events, ["degraded"])
        self.assertEqual(state.active_index, 1)
        self.assertEqual(backup.settings, [{"phase": "lite"}, {"phase": "planner"}])
        await state.switch_to_backup(ModelHTTPError(503, "second failure"))
        self.assertEqual(events, ["degraded"])

    async def test_failover_wrapper_validates_shape_and_merges_call_settings(
        self,
    ) -> None:
        model = FakeModel("one", [ModelResponse(parts=[])])
        with self.assertRaisesRegex(ValueError, "at least one"):
            FailoverModel([], [], RequestFailoverState())
        with self.assertRaisesRegex(ValueError, "align"):
            FailoverModel([model], [], RequestFailoverState())

        wrapper = FailoverModel(
            [model],
            [{"base": True}],
            RequestFailoverState(),
            request_timeout_s=1,
        )
        await wrapper.request(
            [],
            system_parts=[],
            tools=[],
            require_tool=False,
            model_settings={"call": True},
        )
        self.assertEqual(model.settings, [{"base": True, "call": True}])
        self.assertFalse(should_fail_over(asyncio.CancelledError()))

    async def test_local_validation_and_cancel_never_fail_over(self) -> None:
        for error in (
            ModelHTTPError(400, "invalid"),
            OutboundPolicyError("blocked"),
            asyncio.CancelledError(),
        ):
            with self.subTest(error=type(error).__name__):
                primary = FakeModel("primary", [error])
                backup = FakeModel("backup", [ModelResponse(parts=[])])
                state = RequestFailoverState()
                model = FailoverModel([primary, backup], [None, None], state)
                with self.assertRaises(type(error)):
                    await model.request([], system_parts=[], tools=[], require_tool=False)
                self.assertFalse(state.degraded)
                self.assertEqual(backup.settings, [])

    async def test_auth_rate_network_protocol_and_5xx_fail_over(self) -> None:
        errors: list[BaseException] = [
            ModelHTTPError(401, "denied"),
            ModelHTTPError(403, "denied"),
            ModelHTTPError(429, "slow"),
            ModelHTTPError(500, "down"),
            ModelProtocolError("openai", "malformed success"),
            httpx.ConnectError("offline"),
            OutboundResolutionError("dns failed"),
        ]
        for error in errors:
            with self.subTest(error=str(error)):
                self.assertTrue(should_fail_over(error))
                primary = FakeModel("primary", [error])
                backup = FakeModel("backup", [ModelResponse(parts=[])])
                model = FailoverModel(
                    [primary, backup],
                    [None, None],
                    RequestFailoverState(),
                )
                await model.request([], system_parts=[], tools=[], require_tool=False)
                self.assertEqual(len(backup.settings), 1)

    def test_public_errors_are_redacted_and_retry_semantics_are_stable(self) -> None:
        auth = public_agent_error(ModelHTTPError(401, "credential-value"), "r1")
        rate = public_agent_error(ModelHTTPError(429, "provider body"), "r2")
        dns = public_agent_error(OutboundResolutionError("private hostname"), "r3")
        blocked = public_agent_error(OutboundPolicyError("metadata address"), "r4")

        self.assertEqual(auth["code"], "llm_authentication_failed")
        self.assertFalse(auth["retryable"])
        self.assertNotIn("credential-value", json.dumps(auth))
        self.assertEqual(rate["code"], "llm_rate_limited")
        self.assertTrue(rate["retryable"])
        self.assertEqual(dns["status"], 502)
        self.assertEqual(dns["code"], "llm_network_error")
        self.assertTrue(dns["retryable"])
        self.assertEqual(blocked["status"], 400)
        self.assertFalse(blocked["retryable"])

        unavailable = public_agent_error(ModelHTTPError(503, "body"), "r5")
        rejected = public_agent_error(ModelHTTPError(422, "body"), "r6")
        network = public_agent_error(httpx.ConnectError("offline"), "r7")
        unknown = public_agent_error(RuntimeError("private"), "r8")
        self.assertEqual(unavailable["code"], "llm_provider_unavailable")
        self.assertTrue(unavailable["retryable"])
        self.assertEqual(rejected["status"], 400)
        self.assertEqual(rejected["code"], "llm_request_rejected")
        self.assertEqual(network["code"], "llm_network_error")
        self.assertEqual(unknown["status"], 500)
        self.assertNotIn("private", json.dumps(unknown))


class AgentModelAdapterTests(unittest.IsolatedAsyncioTestCase):
    async def test_three_provider_adapters_use_slot_scoped_policy_clients(self) -> None:
        pool = RecordingPool()
        cases = (
            (LlmSlot("openai", "https://openai.example/v1", "key", "gpt"), OpenAIModel),
            (
                LlmSlot("anthropic", "https://anthropic.example/v1", "key", "claude"),
                AnthropicModel,
            ),
            (LlmSlot("gemini", "https://gemini.example", "key", "gemini"), GoogleModel),
        )
        for slot, expected_type in cases:
            with self.subTest(provider=slot.provider):
                model = build_agent_model(
                    slot,
                    pool,  # type: ignore[arg-type]
                    policy=OutboundPolicy("loopback", resolver=lambda *_: ["127.0.0.1"]),
                )
                self.assertIsInstance(model, expected_type)
                provider = cast(Any, model).provider
                await provider.http_client.post("http://127.0.0.1/test", json={})
                self.assertEqual(pool.requests[-1]["policy"].mode.value, "loopback")
                self.assertTrue(pool.requests[-1]["kwargs"]["long_running"])

    async def test_provider_base_normalization_and_credential_isolation(self) -> None:
        pool = RecordingPool()
        policy = OutboundPolicy("public", resolver=lambda *_: ["8.8.8.8"])
        openai = build_agent_model(
            LlmSlot("openai", "https://openai.example/v1beta", "k", "m"),
            pool,  # type: ignore[arg-type]
            policy=policy,
        )
        anthropic = build_agent_model(
            LlmSlot("anthropic", "https://anthropic.example/v1", "k", "m"),
            pool,  # type: ignore[arg-type]
            policy=policy,
        )
        gemini = build_agent_model(
            LlmSlot("gemini", "https://gemini.example", "k", "m"),
            pool,  # type: ignore[arg-type]
            policy=policy,
        )
        self.assertEqual(cast(Any, openai).provider.base_url, "https://openai.example/v1")
        self.assertEqual(
            cast(Any, anthropic).provider.base_url,
            "https://anthropic.example",
        )
        self.assertEqual(
            cast(Any, gemini).provider.base_url,
            "https://gemini.example/v1beta",
        )
        await openai.request([], system_parts=[], tools=[], require_tool=False)
        provider_headers = pool.requests[-1]["kwargs"]["headers"]
        self.assertEqual(provider_headers["authorization"], "Bearer k")
        self.assertNotIn("sidecar-secret", json.dumps(provider_headers))
        with self.assertRaises(AgentRuntimeUnavailable):
            build_agent_model(
                LlmSlot("openai", "https://text.novelai.net/oa/v1", "k", "m"),
                pool,  # type: ignore[arg-type]
                policy=policy,
            )

    def test_backup_only_is_not_promoted_and_incomplete_backup_is_ignored(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            backup_only = _settings(Path(temp), primary=False, backup=True)
            self.assertEqual(backup_only.llm_slots(), [])
            with self.assertRaises(AgentRuntimeUnavailable):
                build_request_models(
                    backup_only,
                    RecordingPool(),  # type: ignore[arg-type]
                )

            primary = _settings(Path(temp), primary=True, backup=False)
            self.assertEqual(len(primary.llm_slots()), 1)

            primary_and_backup = _settings(Path(temp), primary=True, backup=True)
            request_models = build_request_models(
                primary_and_backup,
                RecordingPool(),  # type: ignore[arg-type]
            )
            self.assertEqual(len(request_models.planner._models), 2)
            self.assertEqual(
                cast(Any, request_models.planner._models[1]).provider.base_url,
                "https://backup.example",
            )

    def test_unknown_provider_and_other_normalization_branches(self) -> None:
        pool = RecordingPool()
        policy = OutboundPolicy("public", resolver=lambda *_: ["8.8.8.8"])
        with self.assertRaisesRegex(AgentRuntimeUnavailable, "unsupported"):
            build_agent_model(
                LlmSlot("unknown", "https://example.test", "k", "m"),
                pool,  # type: ignore[arg-type]
                policy=policy,
            )
        anthropic = build_agent_model(
            LlmSlot("anthropic", "https://example.test/root", "k", "m"),
            pool,  # type: ignore[arg-type]
            policy=policy,
        )
        versioned_gemini = build_agent_model(
            LlmSlot(
                "gemini",
                "https://aiplatform.googleapis.com/v1beta1/publishers/google",
                "k",
                "m",
            ),
            pool,  # type: ignore[arg-type]
            policy=policy,
        )
        self.assertEqual(cast(Any, anthropic).provider.base_url, "https://example.test/root")
        self.assertIn("/v1beta1/publishers/google", cast(Any, versioned_gemini).provider.base_url)


class AgentKnowledgeTests(unittest.IsolatedAsyncioTestCase):
    async def test_local_knowledge_paginates_all_artist_and_oc_rows(self) -> None:
        def item(kind: LibraryKind, index: int) -> LibraryItem:
            name = f"{kind}-{index}"
            data = (
                {"name": name, "artist_string": f"artist:{index}"}
                if kind == "artist"
                else {"en_name": name, "tag_group": f"character:{index}"}
            )
            return LibraryItem(
                id=name,
                owner="local",
                kind=kind,
                lookup_key=name,
                data=data,
                primary_asset_id=None,
                thumbnail_asset_id=None,
                created_at="2026-01-01T00:00:00Z",
                updated_at="2026-01-01T00:00:00Z",
            )

        rows = {
            kind: [item(kind, index) for index in range(1001)]
            for kind in ("artist", "oc")
        }

        class PaginatedLibrary:
            def __init__(self) -> None:
                self.calls: list[tuple[str, int, int]] = []

            async def list_items(self, _owner, *, kind, limit, offset=0):
                self.calls.append((kind, limit, offset))
                return rows[kind][offset : offset + limit]

        library = PaginatedLibrary()
        snapshot = await load_sidecar_knowledge(
            _settings(Path("/tmp")),
            cast(LibraryService, library),
            ["artists", "ocs"],
        )

        self.assertEqual(len(snapshot.artists), 1001)
        self.assertEqual(len(snapshot.ocs), 1001)
        self.assertEqual(snapshot.artists[-1]["id"], "artist-1000")
        self.assertEqual(snapshot.ocs[-1]["id"], "oc-1000")
        self.assertEqual(
            library.calls,
            [
                ("artist", 1000, 0),
                ("artist", 1000, 1000),
                ("oc", 1000, 0),
                ("oc", 1000, 1000),
            ],
        )

    async def test_local_knowledge_rejects_repeated_page_and_propagates_cancel(self) -> None:
        repeated = [
            LibraryItem(
                id=f"artist-{index}",
                owner="local",
                kind="artist",
                lookup_key=f"artist-{index}",
                data={"name": f"artist-{index}"},
                primary_asset_id=None,
                thumbnail_asset_id=None,
                created_at="2026-01-01T00:00:00Z",
                updated_at="2026-01-01T00:00:00Z",
            )
            for index in range(1000)
        ]

        class RepeatedPageLibrary:
            async def list_items(self, _owner, *, kind, limit, offset=0):
                del kind, limit, offset
                return repeated

        with self.assertRaisesRegex(AgentRuntimeUnavailable, "inconsistent page"):
            await load_sidecar_knowledge(
                _settings(Path("/tmp")),
                cast(LibraryService, RepeatedPageLibrary()),
                ["artists"],
            )

        class ExcessiveLibrary:
            async def list_items(self, _owner, *, kind, limit, offset=0):
                del kind, limit
                if offset == 0:
                    return repeated
                return [
                    LibraryItem(
                        id="artist-over-bound",
                        owner="local",
                        kind="artist",
                        lookup_key="artist-over-bound",
                        data={"name": "artist-over-bound"},
                        primary_asset_id=None,
                        thumbnail_asset_id=None,
                        created_at="2026-01-01T00:00:00Z",
                        updated_at="2026-01-01T00:00:00Z",
                    )
                ]

        with (
            patch.object(agent_runtime, "_MAX_KNOWLEDGE_DATA_PAGES", 1),
            self.assertRaisesRegex(AgentRuntimeUnavailable, "safe pagination bound"),
        ):
            await load_sidecar_knowledge(
                _settings(Path("/tmp")),
                cast(LibraryService, ExcessiveLibrary()),
                ["artists"],
            )

        class CancelledLibrary:
            async def list_items(self, _owner, *, kind, limit, offset=0):
                del kind, limit, offset
                raise asyncio.CancelledError

        with self.assertRaises(asyncio.CancelledError):
            await load_sidecar_knowledge(
                _settings(Path("/tmp")),
                cast(LibraryService, CancelledLibrary()),
                ["artists"],
            )

    async def test_local_sqlite_and_role_mapping_filter_and_normalize(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            data_dir = Path(temp)
            database = Database(data_dir / "db.sqlite3")
            assets = AssetService(
                database,
                data_dir / "assets",
                managed_root=data_dir,
                reserve_bytes=0,
            )
            library = LibraryService(database, assets)
            await library.initialize()
            await library.create_item(
                "local",
                "artist",
                "A1",
                {"name": "A1", "artist_string": "artist:foo"},
                item_id="artist-a1",
            )
            await library.create_item(
                "local",
                "oc",
                "alice",
                {
                    "en_name": "alice",
                    "zh_name": "爱丽丝",
                    "tag_group": "1girl, blue eyes",
                    "negative_prompt": "bad anatomy",
                },
                item_id="oc-alice",
            )
            role_dir = data_dir / "data"
            role_dir.mkdir()
            (role_dir / "role_tag_mapping.json").write_text(
                json.dumps({"alice_(wonderland)": {"role_en": "alice_(wonderland)"}}),
                encoding="utf-8",
            )

            full = await load_sidecar_knowledge(
                _settings(data_dir),
                library,
                ["artists", "ocs", "roleTags"],
            )
            only_ocs = await load_sidecar_knowledge(
                _settings(data_dir),
                library,
                ["ocs"],
            )

            self.assertEqual(full.artists[0]["prompt"], "artist:foo")
            self.assertEqual(full.ocs[0]["positive"], "1girl, blue eyes")
            self.assertIn("alice_(wonderland)", full.role_mapping)
            self.assertEqual(only_ocs.artists, ())
            self.assertEqual(only_ocs.role_mapping, {})
            await library.close()
            await database.close()

    async def test_local_knowledge_deduplicates_and_rejects_unsafe_role_files(self) -> None:
        items = [
            {"id": "one", "name": "Same"},
            {"id": "two", "name": "same"},
            {"id": "one", "name": "Other"},
        ]
        self.assertEqual(len(agent_runtime._dedupe_by_id_or_name(items)), 1)
        ocs = [
            {"id": "one", "name": "Alice"},
            {"id": "two", "zh_name": "alice"},
            {"id": "three", "name": "Bob"},
        ]
        self.assertEqual(len(agent_runtime._dedupe_ocs(ocs)), 2)

        with tempfile.TemporaryDirectory() as temp:
            data_dir = Path(temp)
            role_dir = data_dir / "data"
            role_dir.mkdir()
            role_file = role_dir / "role_tag_mapping.json"
            role_file.write_text("[]", encoding="utf-8")
            self.assertEqual(agent_runtime._load_role_mapping(data_dir), {})
            role_file.write_text("not-json", encoding="utf-8")
            self.assertEqual(agent_runtime._load_role_mapping(data_dir), {})
            role_file.unlink()
            role_file.symlink_to(role_dir)
            self.assertEqual(agent_runtime._load_role_mapping(data_dir), {})

            bounded = data_dir / "bounded.bin"
            bounded.write_bytes(b"ab")
            self.assertEqual(library_module._read_bounded_file(bounded, 2), b"ab")
            with self.assertRaisesRegex(InvalidArgumentError, "too large"):
                library_module._read_bounded_file(bounded, 1)

    async def test_request_mapping_normalizes_data_url_before_shared_runner(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            settings = _settings(Path(temp), auth=True)
            library = SimpleNamespace(list_items=None)
            adapter = DesktopAgentAdapter(
                SettingsStore(settings, loader=None),
                RecordingPool(),  # type: ignore[arg-type]
                library,  # type: ignore[arg-type]
                prompt_loader=_prompt_bundle,
            )
            await adapter.start()
            prepared = await adapter.prepare(
                AgentWebGeneratePromptRequest(
                    user_request="",
                    image_b64=f"data:image/png;base64,{_PNG_B64}",
                    knowledge_sources=[],
                ),
                lambda _: asyncio.sleep(0),
            )

            self.assertEqual(prepared.request.image_b64, _PNG_B64)
            self.assertEqual(prepared.request.image_mime_type, "image/png")
            self.assertEqual(prepared.runtime.runtime_artists, ())
            self.assertEqual(prepared.runtime.runtime_ocs, ())
            self.assertEqual(prepared.runtime.role_mapping, {})
            response = await cast(Any, prepared.runtime.http_client).get(
                "http://127.0.0.1:38176/api/tags",
                params={"tag": ["a", "b"], "limit": 2, "skip": None},
                headers=prepared.runtime.internal_headers,
            )
            self.assertEqual(response.status_code, 200)
            request_url = cast(RecordingPool, adapter.http).requests[-1]["url"]
            self.assertIn("tag=a", request_url)
            self.assertIn("tag=b", request_url)
            self.assertIn("limit=2", request_url)
            internal_headers = cast(RecordingPool, adapter.http).requests[-1]["kwargs"][
                "headers"
            ]
            self.assertEqual(
                internal_headers,
                {"Authorization": "Bearer sidecar-secret"},
            )

            self.assertTrue(await adapter.check())
            self.assertTrue(adapter.capabilities()["desktop_agent_available"])
            await adapter.stop()
            self.assertFalse(adapter.capabilities()["desktop_agent_available"])

    async def test_prepare_maps_shared_schema_failure_and_propagates_cancellation(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            settings = _settings(Path(temp))
            adapter = DesktopAgentAdapter(
                SettingsStore(settings, loader=None),
                RecordingPool(),  # type: ignore[arg-type]
                SimpleNamespace(),  # type: ignore[arg-type]
                prompt_loader=_prompt_bundle,
            )
            await adapter.start()
            request = AgentWebGeneratePromptRequest(
                user_request="test",
                knowledge_sources=[],
            )
            validation = agent_runtime.ValidationError.from_exception_data(
                "WebPromptRequest",
                [
                    {
                        "type": "value_error",
                        "loc": ("user_request",),
                        "input": "test",
                        "ctx": {"error": ValueError("synthetic")},
                    }
                ],
            )
            with (
                patch.object(
                    agent_runtime.WebPromptRequest,
                    "model_validate",
                    side_effect=validation,
                ),
                self.assertRaises(AgentRequestValidationError),
            ):
                await adapter.prepare(request, lambda _: asyncio.sleep(0))

            with (
                patch(
                    "sidecar.agent_runtime.load_sidecar_knowledge",
                    side_effect=asyncio.CancelledError,
                ),
                self.assertRaises(asyncio.CancelledError),
            ):
                await adapter.prepare(request, lambda _: asyncio.sleep(0))

    def test_ipv6_internal_url_and_query_without_params(self) -> None:
        settings = _settings(Path("/tmp"))
        settings = Settings(**{**settings.__dict__, "host": "::1", "port": 42000})
        self.assertEqual(agent_runtime._internal_base_url(settings), "http://[::1]:42000")
        self.assertEqual(
            agent_runtime._url_with_query("http://127.0.0.1/test?existing=1", None),
            "http://127.0.0.1/test?existing=1",
        )


class AgentRouteIntegrationTests(unittest.TestCase):
    def test_missing_primary_and_missing_prompt_fail_before_stream(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            no_primary = create_app(_settings(Path(temp), primary=False, backup=True))
            no_primary.state.components.agent._prompt_loader = _prompt_bundle
            with TestClient(no_primary) as client:
                response = client.post(
                    "/api/agent/web/generate-prompt",
                    json={"user_request": "test"},
                )
                self.assertEqual(response.status_code, 503)
                self.assertEqual(response.json()["detail"]["code"], "agent_model_not_configured")

            missing_prompt = create_app(_settings(Path(temp), primary=True))

            def unavailable():
                raise PromptResourceError("formal prompt missing")

            missing_prompt.state.components.agent._prompt_loader = unavailable
            with TestClient(missing_prompt) as client:
                response = client.post(
                    "/api/agent/web/generate-prompt",
                    json={"user_request": "test"},
                )
                self.assertEqual(response.status_code, 503)
                self.assertEqual(
                    response.json()["detail"]["code"],
                    "agent_prompt_resources_unavailable",
                )
                ready = client.get("/api/v1/system/ready")
                self.assertTrue(ready.json()["ready"])
                self.assertFalse(ready.json()["capabilities"]["desktop_agent_available"])

    def test_local_knowledge_failure_is_redacted_before_stream(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            app = create_app(_settings(Path(temp)))
            app.state.components.agent._prompt_loader = _prompt_bundle
            with (
                patch(
                    "sidecar.agent_runtime.load_sidecar_knowledge",
                    side_effect=OSError("private database path"),
                ),
                TestClient(app) as client,
            ):
                response = client.post(
                    "/api/agent/web/generate-prompt",
                    json={"user_request": "test"},
                )

        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["detail"]["code"], "agent_knowledge_unavailable")
        self.assertNotIn("private database path", response.text)

    def test_full_fields_tool_events_and_final_result(self) -> None:
        lite = FakeModel(
            "lite",
            [
                ModelResponse(
                    parts=[
                        ToolCallPart(
                            tool_name=OUTPUT_TOOL_NAME,
                            args={
                                "reply_text": "马上来喵。",
                                "should_draw": True,
                                "refined_resources": "",
                            },
                            tool_call_id="lite-final",
                        )
                    ]
                )
            ],
        )
        planner = FakeModel(
            "planner",
            [
                ModelResponse(
                    parts=[
                        ToolCallPart(
                            tool_name="search_artist",
                            args={"keyword": "A1"},
                            tool_call_id="artist-search",
                        )
                    ]
                ),
                ModelResponse(
                    parts=[
                        TextPart(
                            content=json.dumps(
                                {
                                    "positive": "artist:foo, 1girl, smile",
                                    "negative": "bad anatomy",
                                    "characters": [],
                                    "size": "Portrait",
                                }
                            )
                        )
                    ]
                ),
            ],
        )
        models = SimpleNamespace(
            planner=planner,
            prefilter=lite,
            state=RequestFailoverState(),
        )
        with tempfile.TemporaryDirectory() as temp:
            app = create_app(_settings(Path(temp), auth=True))
            app.state.components.agent._prompt_loader = _prompt_bundle
            with (
                patch("sidecar.agent_runtime.build_request_models", return_value=models),
                patch(
                    "sidecar.agent_runtime.load_sidecar_knowledge",
                    return_value=SidecarKnowledgeSnapshot(),
                ),
                TestClient(app) as client,
            ):
                response = client.post(
                    "/api/agent/web/generate-prompt",
                    headers={"X-Sidecar-Auth": "sidecar-secret"},
                    json={
                        "user_request": "用 A1 给 Alice 画一张图",
                        "model": "ignored-local-selector",
                        "image_b64": _PNG_B64,
                        "image_mime_type": "image/png",
                        "history": [
                            {"role": "user", "content": "previous request"},
                            {"role": "assistant", "content": "previous result"},
                        ],
                        "use_codex": True,
                        "knowledge_sources": ["artists", "ocs", "roleTags"],
                        "web_artists": [
                            {"id": "A1", "name": "A1", "prompt": "artist:foo"}
                        ],
                        "web_ocs": [
                            {
                                "id": "alice",
                                "name": "Alice",
                                "zh_name": "爱丽丝",
                                "positive": "alice, blue eyes",
                                "negative": "",
                            }
                        ],
                        "web_codex": [
                            {
                                "id": "city",
                                "category": "world",
                                "title": "Alice city",
                                "content": "cinematic city lighting",
                                "is_r18": False,
                            }
                        ],
                        "current_positive": "existing positive",
                        "current_negative": "existing negative",
                        "current_characters": [
                            {
                                "name": "Alice",
                                "positive": "alice, blue eyes",
                                "negative": "",
                            }
                        ],
                    },
                )

        self.assertEqual(response.status_code, 200)
        self.assertIn("event: tool_call", response.text)
        self.assertIn("event: tool_result", response.text)
        self.assertIn("event: final", response.text)
        self.assertIn("artist:foo", response.text)
        planner_input = repr(planner.message_batches)
        self.assertIn("previous request", planner_input)
        self.assertIn("existing positive", planner_input)
        self.assertIn("cinematic city lighting", planner_input)

    def test_degraded_precedes_final_and_backup_remains_pinned(self) -> None:
        primary = FakeModel("primary", [ModelHTTPError(503, "unavailable")])
        backup = FakeModel(
            "backup",
            [
                ModelResponse(
                    parts=[
                        ToolCallPart(
                            tool_name=OUTPUT_TOOL_NAME,
                            args={
                                "reply_text": "切换后继续喵。",
                                "should_draw": True,
                                "refined_resources": "",
                            },
                            tool_call_id="lite-final",
                        )
                    ]
                ),
                ModelResponse(
                    parts=[
                        TextPart(
                            content=json.dumps(
                                {"positive": "1girl", "negative": "", "characters": []}
                            )
                        )
                    ]
                ),
            ],
        )
        state = RequestFailoverState()

        def models(*_, on_failover=None, **__):
            state.on_failover = on_failover
            return SimpleNamespace(
                planner=FailoverModel([primary, backup], [None, None], state),
                prefilter=FailoverModel([primary, backup], [None, None], state),
                state=state,
            )

        with tempfile.TemporaryDirectory() as temp:
            app = create_app(_settings(Path(temp)))
            app.state.components.agent._prompt_loader = _prompt_bundle
            with (
                patch("sidecar.agent_runtime.build_request_models", side_effect=models),
                TestClient(app) as client,
            ):
                response = client.post(
                    "/api/agent/web/generate-prompt",
                    json={"user_request": "画一个女孩", "knowledge_sources": []},
                )

        self.assertEqual(response.status_code, 200)
        self.assertLess(response.text.index("event: degraded"), response.text.index("event: final"))
        self.assertEqual(state.active_index, 1)
        self.assertEqual(len(primary.settings), 1)
        self.assertEqual(len(backup.settings), 2)

    def test_runtime_error_is_an_sse_error_not_an_http_500(self) -> None:
        async def fail(*_):
            raise ModelProtocolError("openai", "body contained secret-value")

        with tempfile.TemporaryDirectory() as temp:
            app = create_app(_settings(Path(temp)))
            app.state.components.agent._prompt_loader = _prompt_bundle
            with (
                patch(
                    "sidecar.agent_runtime.build_request_models",
                    return_value=SimpleNamespace(
                        planner=object(),
                        prefilter=object(),
                        state=RequestFailoverState(),
                    ),
                ),
                patch("sidecar.agent_runtime.run_web_agent", side_effect=fail),
                TestClient(app) as client,
            ):
                response = client.post(
                    "/api/agent/web/generate-prompt",
                    json={"user_request": "test", "knowledge_sources": []},
                )

        self.assertEqual(response.status_code, 200)
        self.assertIn("event: error", response.text)
        self.assertIn("llm_protocol_error", response.text)
        self.assertNotIn("secret-value", response.text)

    def test_asgi_disconnect_cancels_agent_and_upstream_coroutine(self) -> None:
        started = asyncio.Event()
        cancelled = asyncio.Event()
        disconnect = asyncio.Event()

        async def block(*_):
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        async def scenario() -> None:
            with tempfile.TemporaryDirectory() as temp:
                settings = _settings(Path(temp), auth=True)
                app = create_app(settings)
                app.state.components.agent._prompt_loader = _prompt_bundle
                body = json.dumps(
                    {"user_request": "test", "knowledge_sources": []}
                ).encode()
                scope = {
                    "type": "http",
                    "asgi": {"version": "3.0", "spec_version": "2.3"},
                    "http_version": "1.1",
                    "method": "POST",
                    "scheme": "http",
                    "path": "/api/agent/web/generate-prompt",
                    "raw_path": b"/api/agent/web/generate-prompt",
                    "query_string": b"",
                    "root_path": "",
                    "headers": [
                        (b"host", b"testserver"),
                        (b"content-type", b"application/json"),
                        (b"content-length", str(len(body)).encode()),
                        (b"x-sidecar-auth", b"sidecar-secret"),
                    ],
                    "client": ("127.0.0.1", 12345),
                    "server": ("testserver", 80),
                }
                request_sent = False

                async def receive():
                    nonlocal request_sent
                    if not request_sent:
                        request_sent = True
                        return {"type": "http.request", "body": body, "more_body": False}
                    await disconnect.wait()
                    return {"type": "http.disconnect"}

                async def send(_message):
                    return None

                with (
                    patch(
                        "sidecar.agent_runtime.build_request_models",
                        return_value=SimpleNamespace(
                            planner=object(),
                            prefilter=object(),
                            state=RequestFailoverState(),
                        ),
                    ),
                    patch("sidecar.agent_runtime.run_web_agent", side_effect=block),
                ):
                    async with app.router.lifespan_context(app):
                        task = asyncio.create_task(app(scope, receive, send))
                        await asyncio.wait_for(started.wait(), timeout=2)
                        disconnect.set()
                        await asyncio.wait_for(cancelled.wait(), timeout=2)
                        await asyncio.wait_for(task, timeout=2)

        asyncio.run(scenario())

    def test_runtime_drain_cancels_active_agent_and_upstream_coroutine(self) -> None:
        started = asyncio.Event()
        cancelled = asyncio.Event()
        receive_forever = asyncio.Event()

        async def block(*_):
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        async def scenario() -> None:
            with tempfile.TemporaryDirectory() as temp:
                settings = _settings(Path(temp), auth=True)
                app = create_app(settings)
                app.state.components.agent._prompt_loader = _prompt_bundle
                components = app.state.components
                body = json.dumps(
                    {"user_request": "test", "knowledge_sources": []}
                ).encode()
                scope = {
                    "type": "http",
                    "asgi": {"version": "3.0", "spec_version": "2.3"},
                    "http_version": "1.1",
                    "method": "POST",
                    "scheme": "http",
                    "path": "/api/agent/web/generate-prompt",
                    "raw_path": b"/api/agent/web/generate-prompt",
                    "query_string": b"",
                    "root_path": "",
                    "headers": [
                        (b"host", b"testserver"),
                        (b"content-type", b"application/json"),
                        (b"content-length", str(len(body)).encode()),
                        (b"x-sidecar-auth", b"sidecar-secret"),
                    ],
                    "client": ("127.0.0.1", 12345),
                    "server": ("testserver", 80),
                }
                request_sent = False

                async def receive():
                    nonlocal request_sent
                    if not request_sent:
                        request_sent = True
                        return {"type": "http.request", "body": body, "more_body": False}
                    await receive_forever.wait()
                    return {"type": "http.disconnect"}

                async def send(_message):
                    return None

                with (
                    patch(
                        "sidecar.agent_runtime.build_request_models",
                        return_value=SimpleNamespace(
                            planner=object(),
                            prefilter=object(),
                            state=RequestFailoverState(),
                        ),
                    ),
                    patch("sidecar.agent_runtime.run_web_agent", side_effect=block),
                ):
                    async with app.router.lifespan_context(app):
                        task = asyncio.create_task(app(scope, receive, send))
                        await asyncio.wait_for(started.wait(), timeout=2)
                        self.assertEqual(components.tasks.active_count, 1)
                        drained = await components.runtime.begin_drain(timeout=2)
                        self.assertTrue(drained)
                        await asyncio.wait_for(cancelled.wait(), timeout=2)
                        await asyncio.wait_for(task, timeout=2)
                        self.assertEqual(components.tasks.active_count, 0)

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
