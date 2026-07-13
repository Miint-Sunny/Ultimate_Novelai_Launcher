"""Request-scoped desktop Agent composition for the ``dev`` sidecar.

The shared Agent remains transport-neutral in :mod:`server.agent_router`.  This
module adapts sidecar settings, the lifecycle-owned HTTP pool, and the canonical
local library to that runner without introducing a second Agent implementation.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import stat
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast
from urllib.parse import urlencode, urlsplit, urlunsplit

import httpx
from pydantic import ValidationError

from server.agent_router.llm.exceptions import ModelHTTPError, ModelProtocolError
from server.agent_router.llm.messages import (
    ModelMessage,
    ModelResponse,
    SystemPromptPart,
    ToolDefinition,
)
from server.agent_router.llm.models import AnthropicModel, GoogleModel, Model, OpenAIModel
from server.agent_router.llm.providers import AnthropicProvider, GoogleProvider, OpenAIProvider
from server.agent_router.llm.result import Usage
from server.agent_router.prompts import (
    AgentPromptBundle,
    PromptResourceError,
    load_packaged_prompt_bundle,
)
from server.agent_router.schemas import AgentResult, SseEvent, WebPromptRequest
from server.agent_router.web_hooks import build_web_agent_hooks
from server.agent_router.web_runtime import WebAgentRuntime, run_web_agent
from sidecar.application import SettingsStore
from sidecar.config import LlmSlot, Settings
from sidecar.infrastructure import HttpClientPool
from sidecar.security import OutboundPolicy, OutboundPolicyError, OutboundResolutionError
from sidecar.security.payloads import MAX_AGENT_IMAGE_BYTES, decode_base64_payload
from sidecar.services.library import LibraryItem, LibraryKind, LibraryService

if TYPE_CHECKING:
    from sidecar.api.compat.models import AgentWebGeneratePromptRequest

logger = logging.getLogger(__name__)

_FAILOVER_HTTP_STATUSES = frozenset({401, 403, 408, 425, 429})
_GOOGLE_SAFETY_OFF = (
    {"category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "OFF"},
    {"category": "HARM_CATEGORY_HARASSMENT", "threshold": "OFF"},
    {"category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "OFF"},
    {"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "OFF"},
    {"category": "HARM_CATEGORY_CIVIC_INTEGRITY", "threshold": "OFF"},
    {"category": "HARM_CATEGORY_JAILBREAK", "threshold": "OFF"},
)
_ROLE_MAPPING_LIMIT = 4 * 1024 * 1024
_LOCAL_LIBRARY_OWNER = "local"
_KNOWLEDGE_PAGE_SIZE = 1000
_MAX_KNOWLEDGE_DATA_PAGES = 100

EventEmitter = Callable[[SseEvent], Awaitable[None]]


class AgentRuntimeUnavailable(RuntimeError):
    """A pre-stream dependency required by the desktop Agent is unavailable."""

    def __init__(self, message: str, *, code: str = "desktop_agent_unavailable") -> None:
        super().__init__(message)
        self.code = code


class AgentRequestValidationError(ValueError):
    """The compatibility DTO could not be mapped to the shared Agent contract."""

    code = "agent_request_invalid"


class _PolicyHttpClient:
    """Small ``httpx.AsyncClient`` facade backed by the shared pinned pool.

    The Agent model implementations currently accept an ``AsyncClient`` and call
    ``post`` directly. Injecting ``HttpClientPool.default`` would bypass the policy
    approval context and its pinned transport would correctly reject the socket.
    This request-scoped facade instead routes each operation through
    :meth:`HttpClientPool.request`, which validates DNS and every redirect hop.
    """

    def __init__(
        self,
        pool: HttpClientPool,
        policy: OutboundPolicy,
        *,
        long_running: bool,
    ) -> None:
        self._pool = pool
        self._policy = policy
        self._long_running = long_running

    async def post(
        self,
        url: str,
        *,
        headers: Mapping[str, str] | None = None,
        json: Any = None,
        content: bytes | str | None = None,
        timeout: httpx.Timeout | float | None = None,
        **_: Any,
    ) -> httpx.Response:
        return await self._pool.request(
            self._policy,
            "POST",
            url,
            long_running=self._long_running,
            headers=headers,
            json=json,
            content=content,
            timeout=timeout,
        )

    async def get(
        self,
        url: str,
        *,
        params: Mapping[str, Any] | None = None,
        headers: Mapping[str, str] | None = None,
        timeout: httpx.Timeout | float | None = None,
        **_: Any,
    ) -> httpx.Response:
        return await self._pool.request(
            self._policy,
            "GET",
            _url_with_query(url, params),
            long_running=self._long_running,
            headers=headers,
            timeout=timeout,
        )


@dataclass
class RequestFailoverState:
    """Model choice shared by Lite and Planner for exactly one Agent request."""

    active_index: int = 0
    degraded: bool = False
    primary_error_type: str = ""
    on_failover: Callable[[BaseException], Awaitable[None]] | None = None
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock, init=False, repr=False)

    async def switch_to_backup(self, error: BaseException) -> None:
        async with self._lock:
            if self.active_index != 0:
                return
            self.active_index = 1
            self.degraded = True
            self.primary_error_type = type(error).__name__
            callback = self.on_failover
        if callback is not None:
            await callback(error)


class FailoverModel(Model):
    """Pin all later calls to backup after one eligible primary failure."""

    def __init__(
        self,
        models: Sequence[Model],
        settings: Sequence[Mapping[str, Any] | None],
        state: RequestFailoverState,
        *,
        request_timeout_s: float | None = None,
    ) -> None:
        if not models:
            raise ValueError("at least one Agent model is required")
        if len(models) != len(settings):
            raise ValueError("model settings must align with Agent models")
        self._models = tuple(models)
        self._settings = tuple(settings)
        self._state = state
        self._request_timeout_s = request_timeout_s
        self.model_name = models[0].model_name

    async def request(
        self,
        messages: list[ModelMessage],
        *,
        system_parts: list[SystemPromptPart],
        tools: list[ToolDefinition],
        require_tool: bool,
        model_settings: dict[str, Any] | None = None,
    ) -> tuple[ModelResponse, Usage]:
        index = min(self._state.active_index, len(self._models) - 1)
        try:
            return await self._request_index(
                index,
                messages,
                system_parts=system_parts,
                tools=tools,
                require_tool=require_tool,
                model_settings=model_settings,
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            if index != 0 or len(self._models) < 2 or not should_fail_over(exc):
                raise
            # Causal ordering matters: the UI learns about degraded mode before
            # the backup request can emit tools or a final result.
            await self._state.switch_to_backup(exc)
            return await self._request_index(
                1,
                messages,
                system_parts=system_parts,
                tools=tools,
                require_tool=require_tool,
                model_settings=model_settings,
            )

    async def _request_index(
        self,
        index: int,
        messages: list[ModelMessage],
        *,
        system_parts: list[SystemPromptPart],
        tools: list[ToolDefinition],
        require_tool: bool,
        model_settings: dict[str, Any] | None,
    ) -> tuple[ModelResponse, Usage]:
        combined = dict(self._settings[index] or {})
        if model_settings:
            combined.update(model_settings)
        operation = self._models[index].request(
            messages,
            system_parts=system_parts,
            tools=tools,
            require_tool=require_tool,
            model_settings=combined or None,
        )
        if self._request_timeout_s is None:
            return await operation
        return await asyncio.wait_for(operation, timeout=self._request_timeout_s)


def should_fail_over(error: BaseException) -> bool:
    """Classify only upstream/provider failures as backup-eligible."""

    if isinstance(error, asyncio.CancelledError):
        return False
    if isinstance(error, OutboundResolutionError):
        return True
    if isinstance(error, OutboundPolicyError):
        return False
    if isinstance(error, ModelHTTPError):
        return error.status_code in _FAILOVER_HTTP_STATUSES or error.status_code >= 500
    if isinstance(error, ModelProtocolError):
        return True
    return isinstance(error, (httpx.RequestError, TimeoutError, ConnectionError, OSError))


def public_agent_error(error: BaseException, request_id: str) -> dict[str, Any]:
    """Return a stable, redacted Problem-like SSE error payload."""

    status = 502
    code = "llm_upstream_error"
    title = "LLM provider error"
    detail = "the configured LLM provider could not complete the Agent request"
    retryable = False
    if isinstance(error, OutboundResolutionError):
        status = 502
        code = "llm_network_error"
        title = "LLM provider unavailable"
        detail = "the configured LLM provider host could not be resolved"
        retryable = True
    elif isinstance(error, OutboundPolicyError):
        status = error.status
        code = error.code
        title = "LLM endpoint rejected"
        detail = "the configured LLM endpoint failed the outbound network policy"
        retryable = error.retryable
    elif isinstance(error, ModelHTTPError):
        provider_status = error.status_code
        retryable = provider_status in _FAILOVER_HTTP_STATUSES or provider_status >= 500
        if provider_status in {401, 403}:
            code = "llm_authentication_failed"
            detail = "the configured LLM provider rejected its credential"
            retryable = False
        elif provider_status == 429:
            code = "llm_rate_limited"
            detail = "the configured LLM provider rate-limited the request"
        elif provider_status in {408, 425} or provider_status >= 500:
            code = "llm_provider_unavailable"
            detail = "the configured LLM provider is temporarily unavailable"
        else:
            status = 400
            code = "llm_request_rejected"
            title = "LLM request rejected"
            detail = "the configured LLM provider rejected the Agent request"
    elif isinstance(error, ModelProtocolError):
        code = "llm_protocol_error"
        detail = "the configured LLM provider returned an invalid response"
        retryable = True
    elif isinstance(error, (httpx.RequestError, TimeoutError, ConnectionError, OSError)):
        code = "llm_network_error"
        detail = "the configured LLM provider could not be reached"
        retryable = True
    else:
        status = 500
        code = "agent_runtime_error"
        title = "Agent runtime error"
        detail = "the desktop Agent could not complete the request"
    return {
        "code": code,
        "status": status,
        "title": title,
        "detail": detail,
        "message": detail,
        "retryable": retryable,
        "request_id": request_id,
    }


@dataclass(frozen=True)
class RequestModels:
    planner: FailoverModel
    prefilter: FailoverModel
    state: RequestFailoverState


def build_request_models(
    settings: Settings,
    http: HttpClientPool,
    *,
    on_failover: Callable[[BaseException], Awaitable[None]] | None = None,
) -> RequestModels:
    """Build one primary/backup pair shared by the request's two phases."""

    slots = settings.llm_slots()
    if not slots:
        raise AgentRuntimeUnavailable(
            "LLM is not configured; configure a complete primary provider, base URL, "
            "model, and API key",
            code="agent_model_not_configured",
        )
    models = [
        build_agent_model(
            slot,
            http,
            policy=_slot_policy(settings, index),
        )
        for index, slot in enumerate(slots)
    ]
    state = RequestFailoverState(on_failover=on_failover)
    return RequestModels(
        planner=FailoverModel(
            models,
            [_planner_settings(slot) for slot in slots],
            state,
        ),
        prefilter=FailoverModel(
            models,
            [_prefilter_settings(slot) for slot in slots],
            state,
            request_timeout_s=30.0,
        ),
        state=state,
    )


def build_agent_model(
    slot: LlmSlot,
    http: HttpClientPool,
    *,
    policy: OutboundPolicy,
) -> Model:
    """Build one tool-capable model without creating another HTTP connection pool."""

    if slot.provider not in {"openai", "anthropic", "gemini"}:
        raise AgentRuntimeUnavailable(
            f"unsupported Agent LLM provider: {slot.provider}",
            code="agent_model_unsupported",
        )
    base = _normalize_agent_base(slot)
    if slot.provider == "openai" and (urlsplit(base).hostname or "").casefold() == (
        "text.novelai.net"
    ):
        raise AgentRuntimeUnavailable(
            "NovelAI text API does not support the tool-call contract required by the "
            "desktop Agent",
            code="agent_model_tools_unsupported",
        )
    client = cast(
        httpx.AsyncClient,
        _PolicyHttpClient(http, policy, long_running=True),
    )
    if slot.provider == "anthropic":
        return AnthropicModel(
            slot.model,
            AnthropicProvider(base_url=base, api_key=slot.api_key, http_client=client),
        )
    if slot.provider == "gemini":
        return GoogleModel(
            slot.model,
            GoogleProvider(base_url=base, api_key=slot.api_key, http_client=client),
        )
    return OpenAIModel(
        slot.model,
        OpenAIProvider(base_url=base, api_key=slot.api_key, http_client=client),
        supports_vision=True,
    )


@dataclass(frozen=True)
class SidecarKnowledgeSnapshot:
    artists: tuple[Mapping[str, Any], ...] = ()
    ocs: tuple[Mapping[str, Any], ...] = ()
    role_mapping: Mapping[str, Any] = field(default_factory=dict)


async def _list_all_knowledge_items(
    library: LibraryService,
    *,
    kind: LibraryKind,
) -> list[LibraryItem]:
    """Read a complete kind without accepting a broken pagination contract.

    The final empty-page probe allows exactly ``_MAX_KNOWLEDGE_DATA_PAGES``
    full data pages. Larger libraries fail explicitly instead of being silently
    truncated, while duplicate/foreign/oversized pages fail before they can loop.
    ``CancelledError`` is intentionally not caught so request cancellation reaches
    the in-flight SQLite operation.
    """

    items: list[LibraryItem] = []
    seen_ids: set[str] = set()
    offset = 0
    for page_index in range(_MAX_KNOWLEDGE_DATA_PAGES + 1):
        page = await library.list_items(
            _LOCAL_LIBRARY_OWNER,
            kind=kind,
            limit=_KNOWLEDGE_PAGE_SIZE,
            offset=offset,
        )
        if not isinstance(page, list) or len(page) > _KNOWLEDGE_PAGE_SIZE:
            raise AgentRuntimeUnavailable(
                f"local {kind} knowledge returned an invalid page",
                code="agent_knowledge_unavailable",
            )
        if page_index == _MAX_KNOWLEDGE_DATA_PAGES and page:
            raise AgentRuntimeUnavailable(
                f"local {kind} knowledge exceeds the safe pagination bound",
                code="agent_knowledge_unavailable",
            )

        page_ids: set[str] = set()
        for item in page:
            if (
                not isinstance(item, LibraryItem)
                or not item.id
                or item.owner != _LOCAL_LIBRARY_OWNER
                or item.kind != kind
                or item.id in seen_ids
                or item.id in page_ids
            ):
                raise AgentRuntimeUnavailable(
                    f"local {kind} knowledge returned an inconsistent page",
                    code="agent_knowledge_unavailable",
                )
            page_ids.add(item.id)

        items.extend(page)
        seen_ids.update(page_ids)
        if len(page) < _KNOWLEDGE_PAGE_SIZE:
            return items
        offset += len(page)

    raise AssertionError("knowledge pagination loop exhausted without a terminal page")


async def load_sidecar_knowledge(
    settings: Settings,
    library: LibraryService,
    knowledge_sources: Sequence[str],
) -> SidecarKnowledgeSnapshot:
    """Read only the request-enabled local sources from canonical sidecar data."""

    enabled = {item.casefold() for item in knowledge_sources}
    artists: tuple[Mapping[str, Any], ...] = ()
    ocs: tuple[Mapping[str, Any], ...] = ()
    role_mapping: Mapping[str, Any] = {}
    if "artists" in enabled:
        artists = tuple(
            _dedupe_by_id_or_name(
                _artist_from_item(item)
                for item in await _list_all_knowledge_items(library, kind="artist")
            )
        )
    if "ocs" in enabled:
        ocs = tuple(
            _dedupe_ocs(
                _oc_from_item(item)
                for item in await _list_all_knowledge_items(library, kind="oc")
            )
        )
    if "roletags" in enabled:
        role_mapping = await asyncio.to_thread(_load_role_mapping, settings.data_dir)
    return SidecarKnowledgeSnapshot(
        artists=artists,
        ocs=ocs,
        role_mapping=role_mapping,
    )


@dataclass(frozen=True)
class PreparedAgentRequest:
    request: WebPromptRequest
    runtime: WebAgentRuntime

    async def run(self, emit: EventEmitter) -> AgentResult:
        return await run_web_agent(self.request, self.runtime, emit)


class DesktopAgentAdapter:
    """Lifecycle-aware adapter from sidecar services to the shared Web Agent."""

    def __init__(
        self,
        settings: SettingsStore,
        http: HttpClientPool,
        library: LibraryService,
        *,
        prompt_loader: Callable[[], AgentPromptBundle] = load_packaged_prompt_bundle,
    ) -> None:
        self.settings = settings
        self.http = http
        self.library = library
        self._prompt_loader = prompt_loader
        self._prompt_bundle: AgentPromptBundle | None = None
        self._prompt_error = "prompt resource has not been checked"

    async def start(self) -> None:
        """Preflight prompts without making the otherwise healthy process unready."""

        try:
            self._prompt_bundle = self._prompt_loader()
        except PromptResourceError as exc:
            self._prompt_bundle = None
            self._prompt_error = str(exc) or "desktop Agent prompt resource is unavailable"
        else:
            self._prompt_error = ""

    async def stop(self) -> None:
        self._prompt_bundle = None

    async def check(self) -> bool:
        # Prompt/model absence is a capability state, not process death.
        return True

    def capabilities(self) -> dict[str, Any]:
        prompt_ready = self._prompt_bundle is not None
        model_ready = bool(self.settings.current.llm_slots())
        return {
            "agent_prompt_resources": "available" if prompt_ready else "unavailable",
            "desktop_agent_available": prompt_ready and model_ready,
        }

    async def prepare(
        self,
        request: AgentWebGeneratePromptRequest,
        emit: EventEmitter,
    ) -> PreparedAgentRequest:
        prompt_bundle = self._prompt_bundle
        settings = self.settings.current
        if not settings.llm_slots():
            raise AgentRuntimeUnavailable(
                "LLM is not configured; configure a complete primary provider, base URL, "
                "model, and API key",
                code="agent_model_not_configured",
            )
        if prompt_bundle is None:
            raise AgentRuntimeUnavailable(
                self._prompt_error or "desktop Agent prompt resource is unavailable",
                code="agent_prompt_resources_unavailable",
            )

        normalized = _normalize_request(request)
        try:
            shared_request = WebPromptRequest.model_validate(normalized)
        except ValidationError as exc:
            raise AgentRequestValidationError(
                "desktop Agent request does not match the shared Agent contract"
            ) from exc

        async def on_failover(_: BaseException) -> None:
            await emit(SseEvent(event="degraded", data={"reason": "llm_backup"}))

        request_models = build_request_models(
            settings,
            self.http,
            on_failover=on_failover,
        )
        try:
            knowledge = await load_sidecar_knowledge(
                settings,
                self.library,
                shared_request.knowledge_sources,
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning(
                "desktop Agent knowledge snapshot failed error_type=%s",
                type(exc).__name__,
            )
            raise AgentRuntimeUnavailable(
                "the local Agent knowledge library is temporarily unavailable",
                code="agent_knowledge_unavailable",
            ) from exc
        internal_client = cast(
            httpx.AsyncClient,
            _PolicyHttpClient(
                self.http,
                OutboundPolicy("loopback"),
                long_running=False,
            ),
        )
        return PreparedAgentRequest(
            request=shared_request,
            runtime=WebAgentRuntime(
                planner_model=request_models.planner,
                prefilter_model=request_models.prefilter,
                hooks=build_web_agent_hooks(),
                prefilter_timeout_s=65.0,
                http_client=internal_client,
                internal_base_url=_internal_base_url(settings),
                internal_headers=(
                    {"Authorization": f"Bearer {settings.sidecar_auth_token}"}
                    if settings.sidecar_auth_token
                    else {}
                ),
                prompt_bundle=prompt_bundle,
                runtime_artists=knowledge.artists,
                runtime_ocs=knowledge.ocs,
                role_mapping=knowledge.role_mapping,
            ),
        )


def _slot_policy(settings: Settings, index: int) -> OutboundPolicy:
    if index == 0:
        return OutboundPolicy(
            settings.llm_network_scope,
            trusted_networks=settings.llm_trusted_networks,
        )
    return OutboundPolicy(
        settings.llm_backup_network_scope,
        trusted_networks=settings.llm_backup_trusted_networks,
    )


def _normalize_agent_base(slot: LlmSlot) -> str:
    base = slot.base_url.rstrip("/")
    if slot.provider == "openai":
        return base[: -len("/v1beta")] + "/v1" if base.endswith("/v1beta") else base
    if slot.provider == "anthropic":
        for suffix in ("/v1beta", "/v1"):
            if base.endswith(suffix):
                return base[: -len(suffix)]
        return base
    if slot.provider == "gemini" and "/v1" not in urlsplit(base).path:
        return f"{base}/v1beta"
    return base


def _planner_settings(slot: LlmSlot) -> Mapping[str, Any] | None:
    if slot.provider == "gemini":
        return {
            "google_safety_settings": [dict(item) for item in _GOOGLE_SAFETY_OFF],
            "thinking": True,
        }
    if slot.provider == "openai":
        return {"parallel_tool_calls": False}
    return None


def _prefilter_settings(slot: LlmSlot) -> Mapping[str, Any]:
    result: dict[str, Any] = {"temperature": 0.1}
    if slot.provider == "gemini":
        result["google_safety_settings"] = [dict(item) for item in _GOOGLE_SAFETY_OFF[:-1]]
        result["thinking"] = False
    return result


def _artist_from_item(item: LibraryItem) -> dict[str, Any]:
    data = dict(item.data)
    name = str(data.get("name") or item.lookup_key).strip()
    return {
        "id": item.id,
        "name": name,
        "prompt": str(data.get("prompt") or data.get("artist_string") or "").strip(),
        "negative": str(data.get("negative") or "").strip(),
    }


def _oc_from_item(item: LibraryItem) -> dict[str, Any]:
    data = dict(item.data)
    english_name = str(data.get("en_name") or data.get("name") or item.lookup_key).strip()
    return {
        "id": item.id,
        "en_name": english_name,
        "name": english_name,
        "zh_name": str(data.get("zh_name") or "").strip(),
        "zh_aliases": data.get("zh_aliases") if isinstance(data.get("zh_aliases"), list) else [],
        "positive": str(data.get("positive") or data.get("tag_group") or "").strip(),
        "negative": str(data.get("negative") or data.get("negative_prompt") or "").strip(),
    }


def _dedupe_by_id_or_name(items: Sequence[Mapping[str, Any]] | Any) -> list[Mapping[str, Any]]:
    result: list[Mapping[str, Any]] = []
    seen_ids: set[str] = set()
    seen_names: set[str] = set()
    for item in items:
        item_id = str(item.get("id") or "").strip().casefold()
        name = str(item.get("name") or "").strip().casefold()
        if (item_id and item_id in seen_ids) or (name and name in seen_names):
            continue
        if item_id:
            seen_ids.add(item_id)
        if name:
            seen_names.add(name)
        result.append(item)
    return result


def _dedupe_ocs(items: Sequence[Mapping[str, Any]] | Any) -> list[Mapping[str, Any]]:
    result: list[Mapping[str, Any]] = []
    seen: set[str] = set()
    for item in items:
        identities = {
            str(item.get(key) or "").strip().casefold()
            for key in ("id", "en_name", "name", "zh_name")
            if str(item.get(key) or "").strip()
        }
        if identities & seen:
            continue
        seen.update(identities)
        result.append(item)
    return result


def _load_role_mapping(data_dir: Path) -> Mapping[str, Any]:
    path = data_dir / "data" / "role_tag_mapping.json"
    try:
        metadata = path.lstat()
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > _ROLE_MAPPING_LIMIT:
            return {}
        with path.open("rb") as handle:
            payload = handle.read(_ROLE_MAPPING_LIMIT + 1)
        if len(payload) > _ROLE_MAPPING_LIMIT:
            return {}
        value = json.loads(payload.decode("utf-8"))
    except (FileNotFoundError, OSError, UnicodeDecodeError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _normalize_request(request: AgentWebGeneratePromptRequest) -> dict[str, Any]:
    value = request.model_dump(mode="json")
    image = request.image_b64
    if image is None:
        return value
    decoded, embedded_mime = decode_base64_payload(image, maximum=MAX_AGENT_IMAGE_BYTES)
    value["image_b64"] = base64.b64encode(decoded).decode("ascii")
    if embedded_mime is not None:
        value["image_mime_type"] = embedded_mime
    return value


def _internal_base_url(settings: Settings) -> str:
    host = settings.host.strip()
    if host == "::1":
        host = "[::1]"
    return f"http://{host}:{settings.port}"


def _url_with_query(url: str, params: Mapping[str, Any] | None) -> str:
    if not params:
        return url
    parsed = urlsplit(url)
    query_items: list[tuple[str, str]] = []
    for key, value in params.items():
        if isinstance(value, (list, tuple)):
            query_items.extend((str(key), str(item)) for item in value)
        elif value is not None:
            query_items.append((str(key), str(value)))
    extra = urlencode(query_items)
    query = "&".join(part for part in (parsed.query, extra) if part)
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, query, parsed.fragment))


__all__ = [
    "AgentRequestValidationError",
    "AgentRuntimeUnavailable",
    "DesktopAgentAdapter",
    "FailoverModel",
    "PreparedAgentRequest",
    "RequestFailoverState",
    "RequestModels",
    "SidecarKnowledgeSnapshot",
    "build_agent_model",
    "build_request_models",
    "load_sidecar_knowledge",
    "public_agent_error",
    "should_fail_over",
]
