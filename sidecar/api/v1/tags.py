"""Canonical tag suggestions: three coexisting sources behind one route."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Annotated, Any

from fastapi import APIRouter, Query, Request

from backend_core.errors import AppError, DependencyUnavailableError
from sidecar.config import Settings
from sidecar.runtime import AppRuntime
from sidecar.security import OutboundPolicyError
from sidecar.services.tag_suggest import (
    DEFAULT_SUGGEST_MODEL,
    TagDictionaryService,
    TagDictionaryUnavailableError,
    TagSuggestError,
    TagSuggestion,
    TagSuggestUpstreamError,
    fetch_official_tag_suggestions,
)

from ..dependencies import authorize_request, map_security_error, resolve_runtime
from ..problems import ProblemDetailsRoute
from .models import TagSuggestItem, TagSuggestResponse, TagSuggestSourceValue

DanbooruFetcher = Callable[[Settings, str, int], Awaitable[list[dict[str, Any]]]]


async def _danbooru_autocomplete(
    settings: Settings, query: str, limit: int
) -> list[dict[str, Any]]:
    """Danbooru ``autocomplete.json`` through the shared curl session (thread-bound)."""

    from sidecar.tags import DANBOORU, _danbooru_get, _get_danbooru_session

    def fetch() -> list[dict[str, Any]]:
        session = _get_danbooru_session(settings)
        response = _danbooru_get(
            session,
            f"{DANBOORU}/autocomplete.json",
            params={
                "search[query]": query,
                "search[type]": "tag_query",
                "limit": limit,
            },
            timeout=10,
        )
        if response.status_code != 200:
            raise TagSuggestUpstreamError("danbooru", int(response.status_code))
        payload = response.json()
        return (
            [item for item in payload if isinstance(item, dict)]
            if isinstance(payload, list)
            else []
        )

    return await asyncio.to_thread(fetch)


def danbooru_items(payload: list[dict[str, Any]], *, limit: int) -> list[TagSuggestion]:
    items: list[TagSuggestion] = []
    for entry in payload:
        tag = str(entry.get("value") or entry.get("name") or "").strip()
        if not tag:
            continue
        count = entry.get("post_count")
        category = entry.get("category")
        antecedent = str(entry.get("antecedent") or "").strip()
        items.append(
            TagSuggestion(
                tag=tag.replace(" ", "_"),
                count=int(count)
                if isinstance(count, (int, float)) and not isinstance(count, bool)
                else None,
                category=str(category) if category is not None else None,
                aliases=(antecedent,) if antecedent else (),
                matched_alias=antecedent or None,
            )
        )
        if len(items) >= limit:
            break
    return items


def create_tags_router(
    runtime: AppRuntime | None = None,
    *,
    danbooru_fetcher: DanbooruFetcher | None = None,
) -> APIRouter:
    router = APIRouter(prefix="/tags", tags=["v1-tags"], route_class=ProblemDetailsRoute)

    @router.get("/suggest", response_model=TagSuggestResponse)
    async def suggest_tags(
        request: Request,
        source: Annotated[TagSuggestSourceValue, Query()],
        q: Annotated[str, Query(min_length=1, max_length=200)],
        limit: Annotated[int, Query(ge=1, le=50)] = 10,
        model: Annotated[
            str,
            Query(pattern=r"^[a-z0-9._-]{1,64}$"),
        ] = DEFAULT_SUGGEST_MODEL,
    ) -> TagSuggestResponse:
        """三个联想来源并存,前端切 ``source`` 对比:

        ``official`` 打 NovelAI 官方联想(要 NAI token);``danbooru`` 打
        Danbooru autocomplete;``dictionary`` 用离线词典(nai-autocomplete 扩展同款,
        排序照抄它的 searchTags)。
        """
        current = resolve_runtime(request, runtime)
        current.assert_ready()
        await authorize_request(current, request)
        settings = _current_settings(current)
        query = q.strip()
        if not query:
            return TagSuggestResponse(source=source, query=q, items=[])

        try:
            if source == "official":
                http_pool = getattr(current, "http", None)
                if http_pool is None:
                    raise DependencyUnavailableError(
                        "HTTP client pool is not configured",
                        code="http_pool_unavailable",
                    )
                items = await fetch_official_tag_suggestions(
                    settings=settings,
                    query=query,
                    model=model,
                    limit=limit,
                    http=http_pool,
                )
            elif source == "danbooru":
                # Resolved per request so tests can substitute the module-level fetcher.
                fetcher = danbooru_fetcher or _danbooru_autocomplete
                items = danbooru_items(await fetcher(settings, query, limit), limit=limit)
            else:
                dictionary = getattr(current, "tag_dictionary", None)
                if not isinstance(dictionary, TagDictionaryService):
                    raise DependencyUnavailableError(
                        "tag dictionary service is not configured",
                        code="tag_dictionary_unavailable",
                        retryable=False,
                    )
                items = await dictionary.search(query, limit=limit)
        except AppError:
            # Already a domain error (missing pool / dictionary); never re-wrap it.
            raise
        except OutboundPolicyError as exc:
            mapped = map_security_error(exc)
            raise (
                mapped or DependencyUnavailableError(str(exc), code="outbound_url_rejected")
            ) from exc
        except TagSuggestUpstreamError as exc:
            raise DependencyUnavailableError(
                str(exc),
                code=exc.code,
                retryable=exc.retryable,
                details={"source": exc.source, "upstream_status": exc.status_code},
            ) from exc
        except TagDictionaryUnavailableError as exc:
            raise DependencyUnavailableError(str(exc), code=exc.code, retryable=True) from exc
        except TagSuggestError as exc:
            raise DependencyUnavailableError(
                str(exc),
                code=exc.code,
                retryable=exc.retryable,
                details={"source": source},
            ) from exc
        except Exception as exc:  # noqa: BLE001 - upstream faults become Problem Details
            raise DependencyUnavailableError(
                f"{source} tag suggestions failed: {type(exc).__name__}",
                code="tag_suggest_upstream_failed",
                retryable=True,
                details={"source": source},
            ) from exc

        return TagSuggestResponse(
            source=source,
            query=query,
            items=[_item_model(item) for item in items],
        )

    return router


def _item_model(item: TagSuggestion) -> TagSuggestItem:
    return TagSuggestItem(
        tag=item.tag,
        count=item.count,
        confidence=item.confidence,
        category=item.category,
        translation=item.translation,
        aliases=list(item.aliases),
        matched_alias=item.matched_alias,
        group=item.group,
        subgroup=item.subgroup,
    )


def _current_settings(runtime: AppRuntime) -> Settings:
    value = getattr(runtime.settings, "current", runtime.settings)
    if not isinstance(value, Settings):
        raise DependencyUnavailableError(
            "settings store is not configured",
            code="settings_store_unavailable",
        )
    return value


router = create_tags_router()

__all__ = ["create_tags_router", "danbooru_items", "router"]
