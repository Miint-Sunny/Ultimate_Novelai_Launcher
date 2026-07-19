"""Tag autocomplete / verify / wiki / semantic-search / related endpoints.

Ported from the legacy server/app.py so they run in the sidecar (local-only):
- Danbooru calls use curl_cffi (Chrome TLS impersonation) to pass Cloudflare;
  set DANBOORU_PROXY_URL if your network needs a proxy.
- Semantic search / related use the DanbooruSearch HF Space over httpx.
- Chinese wiki-summary and the related fallback use the sidecar's configured LLM
  (the user's own key) via llm.client.chat_completion.

Response shapes match the legacy backend so the frontend is unchanged.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import copy
import json
import re
import threading
import time
from collections.abc import Callable, Mapping
from typing import Annotated, Any, cast

import httpx
from curl_cffi import requests as _cffi_requests
from curl_cffi.requests import ProxySpec
from fastapi import HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .config import Settings
from .db import lookup_tag_translations
from .infrastructure import HttpClientPool, request_with_policy
from .llm.client import chat_completion
from .security import OutboundPolicy, OutboundPolicyError

DANBOORU = "https://danbooru.donmai.us"
DANBOORU_SEARCH_BASE = "https://sakizuki-danboorusearch.hf.space"

WIKI_CACHE_TTL = 3600
_WIKI_CACHE_MAX = 1000
_SEARCH_CACHE_TTL = 1800
_SEARCH_CACHE_MAX = 500
_RELATED_CACHE_TTL = 86400
_RELATED_CACHE_MAX = 1000

_TAG_MAX_LENGTH = 256
_SEMANTIC_QUERY_MAX_LENGTH = 500
_WIKI_QUERY_MAX_LENGTH = (_TAG_MAX_LENGTH + 1) * 10
_AUTOCOMPLETE_LIMIT_MAX = 50
_VERIFY_TAGS_MAX = 20
_WIKI_BATCH_MAX = 50
_RELATED_TAGS_MAX = 20
_RELATED_CATEGORIES_MAX = 10

CJK_RANGE = r"\u4e00-\u9fff"
_POST_EXAMPLE_RATING = "rating:g,s"
_POST_EXAMPLE_IMAGE_EXTS = {"jpg", "jpeg", "png", "webp", "gif"}

_RELATED_FALLBACK_SYS = (
    "You are a Danbooru tag co-occurrence engine. "
    "Given anchor tags, output a JSON array of 12 General-category Danbooru tags "
    "that commonly appear with the anchor in image illustrations. "
    "Only output General tags. Use canonical lowercase underscore tag names. "
    'Each item must be {"tag": <english_tag>, "cn_name": <short Chinese name>}. '
    "Do not repeat anchor tags. Output a single JSON array only."
)

# ---- module-level caches (TTL) ----
_wiki_cache: dict[str, list] = {}
_wiki_cache_time: dict[str, float] = {}
_wiki_exists_cache: dict[str, bool] = {}
_wiki_exists_cache_time: dict[str, float] = {}
_wiki_preview_cache: dict[str, dict] = {}
_wiki_preview_cache_time: dict[str, float] = {}
_wiki_summary_zh_cache: dict[str, str] = {}
_wiki_summary_zh_cache_time: dict[str, float] = {}
_search_cache: dict[tuple, tuple[float, list]] = {}
_related_cache: dict[tuple, tuple[float, list]] = {}
_tag_cache_lock = threading.RLock()

# ---- Danbooru session (curl_cffi, Chrome impersonation, optional proxy) ----
_danbooru_session = None  # type: ignore[var-annotated]
_danbooru_proxy_key: tuple[tuple[str, str], ...] = ()
_danbooru_session_lock = threading.Lock()


def _danbooru_proxies(settings: Settings) -> ProxySpec | None:
    url = str(getattr(settings, "danbooru_proxy_url", "") or "")
    if not url:
        return None
    if url.startswith("socks5://"):
        url = "socks5h://" + url[len("socks5://") :]
    return {"http": url, "https": url}


def _get_danbooru_session(settings: Settings):
    global _danbooru_proxy_key, _danbooru_session
    proxies = _danbooru_proxies(settings)
    proxy_key = tuple(
        sorted(
            (str(name), str(value))
            for name, value in cast(Mapping[str, str], proxies or {}).items()
        )
    )
    with _danbooru_session_lock:
        if _danbooru_session is None or proxy_key != _danbooru_proxy_key:
            if _danbooru_session is not None:
                _danbooru_session.close()
            _danbooru_session = _cffi_requests.Session(
                impersonate="chrome",
                proxies=proxies,
            )
            _danbooru_proxy_key = proxy_key
        return _danbooru_session


def close_tag_clients() -> None:
    """Close the compatibility curl session during runtime shutdown."""

    global _danbooru_proxy_key, _danbooru_session
    with _danbooru_session_lock:
        if _danbooru_session is not None:
            _danbooru_session.close()
        _danbooru_session = None
        _danbooru_proxy_key = ()
    _clear_tag_caches()


# ---- shared SSRF policy for the Danbooru / search-backend calls ----
# curl_cffi keeps the Chrome TLS impersonation that clears Cloudflare but cannot
# pin the socket to a validated IP, so the Danbooru helpers validate the resolved
# DNS answers before every hop and follow redirects manually with re-validation
# instead of trusting curl's own follower. The policy is module-level so tests can
# inject a resolver.
_REDIRECT_STATUS = frozenset({301, 302, 303, 307, 308})
_DANBOORU_MAX_REDIRECTS = 3
_danbooru_outbound_policy = OutboundPolicy("public")


def _danbooru_get(
    session,
    url: str,
    *,
    params: Mapping[str, Any] | None = None,
    timeout: float,
):
    """GET a Danbooru URL with the shared SSRF policy enforced on the initial
    request and every redirect hop.

    Redirect following is disabled on the curl session so a 3xx to a private or
    metadata host is never followed implicitly; each Location is re-validated
    against the outbound policy before it is fetched.
    """
    policy = _danbooru_outbound_policy
    current = str(policy.validate_url(url))
    hop_params = params
    for _ in range(_DANBOORU_MAX_REDIRECTS + 1):
        resp = session.get(
            current,
            params=hop_params,
            timeout=timeout,
            allow_redirects=False,
        )
        if resp.status_code not in _REDIRECT_STATUS:
            return resp
        location = resp.headers.get("location") or resp.headers.get("Location")
        if not location:
            return resp
        current = str(policy.validate_redirect(current, location))
        hop_params = None
    raise OutboundPolicyError("too many Danbooru redirects")


async def _search_backend_post(
    http: HttpClientPool | None,
    path: str,
    payload: Any,
    *,
    timeout: float,
) -> httpx.Response:
    """POST to the DanbooruSearch backend through the shared SSRF policy.

    Uses the lifespan-owned pool when present; otherwise owns a redirect-disabled
    client so request_with_policy re-validates every hop. There is no unpinned path.
    """
    url = f"{DANBOORU_SEARCH_BASE}{path}"
    policy = _danbooru_outbound_policy
    if http is not None:
        return await http.request(policy, "POST", url, json=payload, timeout=timeout)
    async with httpx.AsyncClient(follow_redirects=False) as client:
        return await request_with_policy(client, policy, "POST", url, json=payload, timeout=timeout)


def _normalize_tag(tag: str) -> str:
    return tag.strip().lower().replace(" ", "_")


def _wiki_cache_fresh(ts: float) -> bool:
    return (time.time() - ts) < WIKI_CACHE_TTL


def _prune_timed_cache(
    values: dict[Any, Any],
    timestamps: dict[Any, float],
    *,
    max_entries: int,
    ttl: float,
    now: float | None = None,
) -> None:
    """Expire and bound a value/timestamp pair without leaving orphan keys."""

    current = time.time() if now is None else now
    with _tag_cache_lock:
        for key in set(values) | set(timestamps):
            timestamp = timestamps.get(key)
            if key not in values or timestamp is None or current - timestamp >= ttl:
                values.pop(key, None)
                timestamps.pop(key, None)

        overflow = len(timestamps) - max_entries
        if overflow > 0:
            oldest = sorted(timestamps, key=timestamps.__getitem__)[:overflow]
            for key in oldest:
                values.pop(key, None)
                timestamps.pop(key, None)


def _timed_cache_get(
    values: dict[Any, Any],
    timestamps: dict[Any, float],
    key: Any,
    *,
    ttl: float = WIKI_CACHE_TTL,
) -> Any | None:
    current = time.time()
    with _tag_cache_lock:
        timestamp = timestamps.get(key)
        if key not in values or timestamp is None or current - timestamp >= ttl:
            values.pop(key, None)
            timestamps.pop(key, None)
            return None
        return copy.deepcopy(values[key])


def _timed_cache_put(
    values: dict[Any, Any],
    timestamps: dict[Any, float],
    key: Any,
    value: Any,
    *,
    max_entries: int = _WIKI_CACHE_MAX,
    ttl: float = WIKI_CACHE_TTL,
    now: float | None = None,
) -> None:
    current = time.time() if now is None else now
    with _tag_cache_lock:
        values[key] = copy.deepcopy(value)
        timestamps[key] = current
    _prune_timed_cache(
        values,
        timestamps,
        max_entries=max_entries,
        ttl=ttl,
        now=current,
    )


def _result_cache_get(cache: dict, key: tuple, *, ttl: float) -> list | None:
    current = time.time()
    with _tag_cache_lock:
        entry = cache.get(key)
        if entry is None:
            return None
        timestamp, value = entry
        if current - timestamp >= ttl:
            cache.pop(key, None)
            return None
        return copy.deepcopy(value)


def _result_cache_put(
    cache: dict,
    key: tuple,
    value: list,
    *,
    max_entries: int,
    ttl: float,
    now: float | None = None,
) -> None:
    current = time.time() if now is None else now
    with _tag_cache_lock:
        cache[key] = (current, copy.deepcopy(value))
        expired = [cache_key for cache_key, (ts, _) in cache.items() if current - ts >= ttl]
        for cache_key in expired:
            cache.pop(cache_key, None)
        overflow = len(cache) - max_entries
        if overflow > 0:
            oldest = sorted(cache, key=lambda cache_key: cache[cache_key][0])[:overflow]
            for cache_key in oldest:
                cache.pop(cache_key, None)


def _prune_wiki_caches() -> None:
    for values, timestamps in (
        (_wiki_cache, _wiki_cache_time),
        (_wiki_exists_cache, _wiki_exists_cache_time),
        (_wiki_preview_cache, _wiki_preview_cache_time),
        (_wiki_summary_zh_cache, _wiki_summary_zh_cache_time),
    ):
        _prune_timed_cache(
            values,
            timestamps,
            max_entries=_WIKI_CACHE_MAX,
            ttl=WIKI_CACHE_TTL,
        )


def _clear_tag_caches() -> None:
    with _tag_cache_lock:
        for cache in (
            _wiki_cache,
            _wiki_cache_time,
            _wiki_exists_cache,
            _wiki_exists_cache_time,
            _wiki_preview_cache,
            _wiki_preview_cache_time,
            _wiki_summary_zh_cache,
            _wiki_summary_zh_cache_time,
            _search_cache,
            _related_cache,
        ):
            cache.clear()


# ---- wiki markup helpers ----


def _wiki_example_refs(body: str) -> list[tuple[str, int]]:
    refs: list[tuple[str, int]] = []
    for match in re.finditer(r"!(post|asset)\s+#(\d+)", body or "", flags=re.IGNORECASE):
        refs.append((match.group(1).lower(), int(match.group(2))))
    return refs


def _strip_wiki_markup(text: str) -> str:
    cleaned = (text or "").replace("\r\n", "\n")
    cleaned = re.sub(r"h\d\.\s*", "", cleaned)
    cleaned = re.sub(r"\[\[(?:[^|\]]+\|)?([^\]]+)\]\]", r"\1", cleaned)
    cleaned = re.sub(r"!(?:post|asset)\s+#\d+:[^\n]*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"^\*\s*", "", cleaned, flags=re.MULTILINE)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def _build_wiki_summary(body: str, limit: int = 320) -> str:
    text = re.split(
        r"\nh\d\.\s+(?:Examples|See also)\b",
        body or "",
        maxsplit=1,
        flags=re.IGNORECASE,
    )[0]
    text = _strip_wiki_markup(text)
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= limit:
        return text
    clipped = text[:limit].rsplit(" ", 1)[0].strip()
    return f"{clipped}..." if clipped else text[:limit]


def _limit_chinese_preview_text(text: str, limit: int = 140) -> str:
    text = re.sub(r"\s+", " ", text or "").strip()
    if len(text) <= limit:
        return text
    return text[:limit].rstrip("，。；、,. ") + "..."


def _absolute_danbooru_url(url: str | None) -> str | None:
    if not url:
        return None
    if url.startswith("//"):
        return f"https:{url}"
    if url.startswith("/"):
        return f"{DANBOORU}{url}"
    return url


# ---- Danbooru fetchers (sync; run via asyncio.to_thread) ----


def _fetch_wiki_page(settings: Settings, tag: str) -> dict | None:
    session = _get_danbooru_session(settings)
    resp = _danbooru_get(
        session, f"{DANBOORU}/wiki_pages.json", params={"search[title]": tag}, timeout=5
    )
    if resp.status_code != 200:
        return None
    data = resp.json()
    if not data:
        return None
    page = data[0] if isinstance(data, list) else data
    if not isinstance(page, dict) or page.get("is_deleted"):
        return None
    return page


def _check_wiki_page_exists(settings: Settings, tag: str) -> tuple[bool, bool]:
    """Return (request_ok, has_wiki); network failures stay out of the negative cache."""
    try:
        session = _get_danbooru_session(settings)
        resp = _danbooru_get(
            session, f"{DANBOORU}/wiki_pages.json", params={"search[title]": tag}, timeout=5
        )
        if resp.status_code != 200:
            return False, False
        data = resp.json()
        if not data:
            return True, False
        page = data[0] if isinstance(data, list) else data
        return True, isinstance(page, dict) and not page.get("is_deleted")
    except Exception as e:
        print(f"Wiki exists check request error for {tag}: {e}")
        return False, False


def _fetch_wiki_example(session, ref_type: str, ref_id: int) -> dict | None:
    if ref_type == "post":
        resp = _danbooru_get(session, f"{DANBOORU}/posts/{ref_id}.json", timeout=8)
        if resp.status_code != 200:
            return None
        data = resp.json()
        if not isinstance(data, dict):
            return None
        preview_url = _absolute_danbooru_url(
            data.get("large_file_url") or data.get("file_url") or data.get("preview_file_url")
        )
        return {
            "type": "post",
            "id": ref_id,
            "previewUrl": preview_url,
            "pageUrl": f"{DANBOORU}/posts/{ref_id}",
            "width": data.get("image_width"),
            "height": data.get("image_height"),
        }

    if ref_type == "asset":
        resp = _danbooru_get(session, f"{DANBOORU}/media_assets/{ref_id}.json", timeout=8)
        if resp.status_code != 200:
            return None
        data = resp.json()
        if not isinstance(data, dict):
            return None
        preview_url = _absolute_danbooru_url(
            data.get("file_url")
            or data.get("large_file_url")
            or data.get("image_url")
            or data.get("preview_file_url")
        )
        variants = data.get("variants") or []
        if not preview_url and isinstance(variants, list):
            variant_candidates = [v for v in variants if isinstance(v, dict) and v.get("url")]
            variant_candidates.sort(
                key=lambda v: (v.get("width") or 0) * (v.get("height") or 0), reverse=True
            )
            for variant in variant_candidates:
                candidate = _absolute_danbooru_url(variant.get("url"))
                if candidate:
                    preview_url = candidate
                    break
        return {
            "type": "asset",
            "id": ref_id,
            "previewUrl": preview_url,
            "pageUrl": f"{DANBOORU}/media_assets/{ref_id}",
            "width": data.get("image_width") or data.get("width"),
            "height": data.get("image_height") or data.get("height"),
        }

    return None


def _fetch_posts_examples(session, tag: str, limit: int = 4) -> list[dict]:
    try:
        resp = _danbooru_get(
            session,
            f"{DANBOORU}/posts.json",
            params={"tags": f"{tag} {_POST_EXAMPLE_RATING}", "limit": limit * 4},
            timeout=8,
        )
        if resp.status_code != 200:
            return []
        data = resp.json()
    except Exception as e:
        print(f"Wiki posts fallback fetch error for {tag}: {e}")
        return []

    if not isinstance(data, list):
        return []

    examples: list[dict] = []
    for post in data:
        if not isinstance(post, dict) or post.get("is_deleted") or post.get("is_banned"):
            continue
        if (post.get("file_ext") or "").lower() not in _POST_EXAMPLE_IMAGE_EXTS:
            continue
        post_id = post.get("id")
        preview_url = _absolute_danbooru_url(
            post.get("large_file_url") or post.get("file_url") or post.get("preview_file_url")
        )
        if not post_id or not preview_url:
            continue
        examples.append(
            {
                "type": "post",
                "id": post_id,
                "previewUrl": preview_url,
                "pageUrl": f"{DANBOORU}/posts/{post_id}",
                "width": post.get("image_width"),
                "height": post.get("image_height"),
            }
        )
        if len(examples) >= limit:
            break
    return examples


def _fetch_wiki_chinese(settings: Settings, tag: str) -> tuple[str, list[str]]:
    try:
        session = _get_danbooru_session(settings)
        resp = _danbooru_get(
            session, f"{DANBOORU}/wiki_pages.json", params={"search[title]": tag}, timeout=5
        )
        if resp.status_code != 200:
            return tag, []
        data = resp.json()
        if not data:
            return tag, []
        page = data[0] if isinstance(data, list) else data
        other_names = page.get("other_names") or []
        chinese_names = []
        for name in other_names:
            if isinstance(name, str) and re.search(f"[{CJK_RANGE}]", name):
                # exclude Japanese kana
                if not re.search(r"[\u30a0-\u30ff\u3040-\u309f]", name):
                    chinese_names.append(name.strip())
        return tag, chinese_names[:3]
    except Exception as e:
        print(f"Wiki fetch error for {tag}: {e}")
        return tag, []


# ---- LLM-backed helpers (use the sidecar's configured LLM) ----


def _extract_chat_text(result: dict) -> str:
    try:
        message = result.get("choices", [{}])[0].get("message", {})
        content = message.get("content")
        if isinstance(content, str):
            return content.strip()
        if isinstance(content, list):
            parts = []
            for item in content:
                if isinstance(item, dict):
                    text = item.get("text") or item.get("content")
                    if isinstance(text, str):
                        parts.append(text)
            return "\n".join(parts).strip()
    except Exception:
        return ""
    return ""


async def _translate_wiki_preview_summary(
    settings: Settings,
    tag: str,
    body: str,
    fallback_summary: str,
    http: HttpClientPool | None = None,
) -> str:
    source = _build_wiki_summary(body, limit=1200) or fallback_summary
    if not source:
        return ""
    messages = [
        {
            "role": "system",
            "content": (
                "你是 Danbooru 标签 wiki 的中文预览摘要助手。"
                "请根据用户提供的 tag 和 wiki 内容，输出一段自然中文说明，120字以内。"
                "选择性忽略 Examples、See also、链接格式、编辑说明、无关引用和过细的历史信息。"
                "重点说明这个标签的含义、使用场景、容易混淆点。"
                "不要使用 Markdown，不要逐字翻译，不要输出英文原文。"
            ),
        },
        {"role": "user", "content": f"Tag: {tag}\nWiki内容:\n{source}"},
    ]
    try:
        result = await chat_completion(
            settings=settings,
            messages=messages,
            temperature=0.2,
            max_tokens=300,
            http=http,
        )
        return _limit_chinese_preview_text(_extract_chat_text(result), 140)
    except Exception as e:
        print(f"Wiki summary translation error for {tag}: {e}")
        return ""


def _parse_ds_fallback_results(content: str) -> list[dict]:
    if not content:
        return []
    text = content.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    start = text.find("[")
    end = text.rfind("]")
    if start == -1 or end == -1 or end <= start:
        return []
    try:
        arr = json.loads(text[start : end + 1])
    except Exception:
        return []
    if not isinstance(arr, list):
        return []

    cleaned: list[dict] = []
    seen: set[str] = set()
    for item in arr:
        if not isinstance(item, dict):
            continue
        tag = str(item.get("tag", "")).strip().lower().replace(" ", "_")
        if not tag or tag in seen:
            continue
        seen.add(tag)
        cn = item.get("cn_name") or item.get("zh") or ""
        cn = cn.split(",")[0].split("，")[0].strip() if isinstance(cn, str) else ""
        cleaned.append({"tag": tag, "cn_name": cn, "category": "General", "npmi": 0.0})
    return cleaned


async def _ds_fallback_related(
    settings: Settings,
    anchor_tags: list[str],
    limit: int,
    http: HttpClientPool | None = None,
) -> list[dict]:
    messages = [
        {"role": "system", "content": _RELATED_FALLBACK_SYS},
        {"role": "user", "content": "Anchor tags: " + ", ".join(anchor_tags)},
    ]
    try:
        result = await chat_completion(
            settings=settings,
            messages=messages,
            temperature=0.3,
            max_tokens=1500,
            http=http,
        )
        return _parse_ds_fallback_results(_extract_chat_text(result))[:limit]
    except Exception as e:
        print(f"[tags_related] DS fallback error: {e}")
        return []


# ---- request models ----


class _StrictRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")


TagValue = Annotated[str, Field(min_length=1, max_length=_TAG_MAX_LENGTH, strict=True)]
CategoryValue = Annotated[str, Field(min_length=1, max_length=64, strict=True)]


class TagsVerifyRequest(_StrictRequest):
    tags: list[TagValue] = Field(default_factory=list, max_length=_VERIFY_TAGS_MAX)

    @field_validator("tags")
    @classmethod
    def strip_tags(cls, values: list[str]) -> list[str]:
        return _strip_nonempty_values(values, "tags")


class TagsWikiExistsRequest(_StrictRequest):
    tags: list[TagValue] = Field(default_factory=list, max_length=_WIKI_BATCH_MAX)

    @field_validator("tags")
    @classmethod
    def strip_tags(cls, values: list[str]) -> list[str]:
        return _strip_nonempty_values(values, "tags")


class TagsSearchRequest(_StrictRequest):
    query: str = Field(min_length=1, max_length=_SEMANTIC_QUERY_MAX_LENGTH, strict=True)
    limit: int = Field(default=30, ge=1, le=200, strict=True)
    top_k: int = Field(default=50, ge=1, le=50, strict=True)
    show_nsfw: bool = True

    @field_validator("query")
    @classmethod
    def strip_query(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("query must not be blank")
        return stripped


class TagsRelatedRequest(_StrictRequest):
    tags: list[TagValue] = Field(min_length=1, max_length=_RELATED_TAGS_MAX)
    limit: int = Field(default=30, ge=1, le=100, strict=True)
    show_nsfw: bool = True
    categories: list[CategoryValue] | None = Field(
        default=None,
        max_length=_RELATED_CATEGORIES_MAX,
    )

    @field_validator("tags")
    @classmethod
    def strip_tags(cls, values: list[str]) -> list[str]:
        return _strip_nonempty_values(values, "tags")

    @field_validator("categories")
    @classmethod
    def strip_categories(cls, values: list[str] | None) -> list[str] | None:
        if values is None:
            return None
        return _strip_nonempty_values(values, "categories")


def _strip_nonempty_values(values: list[str], field_name: str) -> list[str]:
    stripped = [value.strip() for value in values]
    if any(not value for value in stripped):
        raise ValueError(f"{field_name} must not contain blank values")
    return stripped


def _bounded_csv_tags(raw: str, *, max_items: int) -> list[str]:
    tags: list[str] = []
    seen: set[str] = set()
    for value in raw.split(","):
        tag = value.strip()
        if not tag:
            continue
        if len(tag) > _TAG_MAX_LENGTH:
            raise HTTPException(status_code=422, detail="tag is too long")
        if tag not in seen:
            seen.add(tag)
            tags.append(tag)
        if len(tags) >= max_items:
            break
    return tags


def register_tag_routes(
    app,
    settings: Settings | Callable[[], Settings],
    auth: Any = None,
    http: HttpClientPool | None = None,
) -> None:
    """Register authenticated compatibility routes against live settings."""

    current_settings = settings if callable(settings) else lambda: settings
    llm_deps = [auth] if auth is not None else []

    @app.get("/api/tags/autocomplete")
    async def tags_autocomplete(
        query: Annotated[str, Query(max_length=_TAG_MAX_LENGTH)],
        limit: Annotated[int, Query(ge=1, le=_AUTOCOMPLETE_LIMIT_MAX)] = 10,
    ) -> Any:
        if not query or len(query) < 2:
            return []
        normalized_query = query.strip()
        if len(normalized_query) < 2:
            return []

        def _fetch():
            session = _get_danbooru_session(current_settings())
            resp = _danbooru_get(
                session,
                f"{DANBOORU}/autocomplete.json",
                params={
                    "search[query]": normalized_query,
                    "search[type]": "tag_query",
                    "limit": limit,
                },
                timeout=10,
            )
            return resp.json() if resp.status_code == 200 else []

        try:
            return await asyncio.to_thread(_fetch)
        except Exception as e:
            print(f"Danbooru API error: {e}")
            return []

    @app.post("/api/tags/verify")
    async def tags_verify(req: TagsVerifyRequest) -> dict[str, Any]:
        if not req.tags:
            return {}
        tags = [
            tag.strip().lower().replace(" ", "_").replace("-", "_")
            for tag in req.tags
            if tag.strip()
        ]
        if not tags:
            return {}

        def _fetch():
            session = _get_danbooru_session(current_settings())
            names_param = ",".join(tags)
            resp = _danbooru_get(
                session,
                f"{DANBOORU}/tags.json",
                params={"search[name_comma]": names_param, "limit": len(tags)},
                timeout=10,
            )
            if resp.status_code != 200:
                return {}
            result: dict[str, int] = {}
            for item in resp.json():
                name = item.get("name", "")
                if name:
                    result[name] = item.get("post_count", 0)
            return result

        try:
            return await asyncio.to_thread(_fetch)
        except Exception as e:
            print(f"Danbooru tags verify error: {e}")
            return {}

    @app.get("/api/tags/wiki")
    async def tags_wiki(
        tags: Annotated[str, Query(max_length=_WIKI_QUERY_MAX_LENGTH)],
    ) -> dict[str, Any]:
        _prune_wiki_caches()
        tag_list = _bounded_csv_tags(tags, max_items=10)
        if not tag_list:
            return {}

        result: dict[str, list] = {}
        tags_to_fetch: list[str] = []
        now = time.time()

        # 1) in-memory cache, 2) tag-translation DB, 3) Danbooru
        stored = lookup_tag_translations(current_settings(), tag_list)
        for tag in tag_list:
            cached_names = _timed_cache_get(_wiki_cache, _wiki_cache_time, tag)
            if cached_names is not None:
                if cached_names:
                    result[tag] = cached_names
                continue
            zh = stored.get(tag) or stored.get(_normalize_tag(tag))
            if zh:
                result[tag] = [zh]
                _timed_cache_put(_wiki_cache, _wiki_cache_time, tag, [zh], now=now)
                continue
            tags_to_fetch.append(tag)

        if not tags_to_fetch:
            return result

        def _fetch_all():
            with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
                return list(
                    executor.map(
                        lambda t: _fetch_wiki_chinese(current_settings(), t),
                        tags_to_fetch,
                    )
                )

        for tag, chinese_names in await asyncio.to_thread(_fetch_all):
            _timed_cache_put(
                _wiki_cache,
                _wiki_cache_time,
                tag,
                chinese_names,
                now=now,
            )
            if chinese_names:
                result[tag] = chinese_names

        return result

    @app.post("/api/tags/wiki-exists-batch")
    async def tags_wiki_exists_batch(req: TagsWikiExistsRequest) -> dict[str, bool]:
        _prune_wiki_caches()
        if not req.tags:
            return {}
        tags = []
        seen = set()
        for raw_tag in req.tags:
            tag = _normalize_tag(str(raw_tag))
            if tag and tag not in seen:
                seen.add(tag)
                tags.append(tag)
        if not tags:
            return {}

        result: dict[str, bool] = {}
        tags_to_fetch: list[str] = []
        now = time.time()
        for tag in tags:
            preview = _timed_cache_get(_wiki_preview_cache, _wiki_preview_cache_time, tag)
            exists = _timed_cache_get(_wiki_exists_cache, _wiki_exists_cache_time, tag)
            if preview is not None:
                result[tag] = True
            elif exists is not None:
                result[tag] = bool(exists)
            else:
                tags_to_fetch.append(tag)

        def _check(tag: str) -> tuple[str, bool | None]:
            ok, has_wiki = _check_wiki_page_exists(current_settings(), tag)
            return tag, (has_wiki if ok else None)

        if tags_to_fetch:

            def _fetch_all():
                with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
                    return list(executor.map(_check, tags_to_fetch))

            for tag, has_wiki in await asyncio.to_thread(_fetch_all):
                if has_wiki is None:
                    continue
                _timed_cache_put(
                    _wiki_exists_cache,
                    _wiki_exists_cache_time,
                    tag,
                    has_wiki,
                    now=now,
                )
                result[tag] = has_wiki

        return result

    @app.get("/api/tags/wiki-preview")
    async def tags_wiki_preview(
        tag: Annotated[str, Query(max_length=_TAG_MAX_LENGTH)],
    ) -> dict[str, Any]:
        _prune_wiki_caches()
        normalized = _normalize_tag(tag)
        if not normalized:
            return {"hasWiki": False}

        cached = _timed_cache_get(_wiki_preview_cache, _wiki_preview_cache_time, normalized)
        if cached is not None:
            cached_summary = _timed_cache_get(
                _wiki_summary_zh_cache,
                _wiki_summary_zh_cache_time,
                normalized,
            )
            if cached_summary is not None:
                cached["summaryZh"] = cached_summary
            return cached

        def _fetch() -> dict[str, Any]:
            page = _fetch_wiki_page(current_settings(), normalized)
            if not page:
                return {"hasWiki": False}
            body = page.get("body") or ""
            session = _get_danbooru_session(current_settings())
            examples: list[dict] = []
            seen_examples = set()
            for ref_type, ref_id in _wiki_example_refs(body):
                key = (ref_type, ref_id)
                if key in seen_examples:
                    continue
                seen_examples.add(key)
                example = None
                try:
                    example = _fetch_wiki_example(session, ref_type, ref_id)
                except Exception as e:
                    print(f"Wiki example fetch error for {normalized} {ref_type}#{ref_id}: {e}")
                if example:
                    examples.append(example)
                if len(examples) >= 6:
                    break
            if not examples:
                try:
                    examples = _fetch_posts_examples(session, normalized, limit=4)
                except Exception as e:
                    print(f"Wiki posts fallback error for {normalized}: {e}")
            return {
                "hasWiki": True,
                "title": page.get("title") or normalized,
                "otherNames": page.get("other_names") or [],
                "summary": _build_wiki_summary(body),
                "body": body,
                "example": examples[0] if examples else None,
                "examples": examples,
            }

        try:
            payload = await asyncio.to_thread(_fetch)
            now = time.time()
            _timed_cache_put(
                _wiki_exists_cache,
                _wiki_exists_cache_time,
                normalized,
                bool(payload.get("hasWiki")),
                now=now,
            )
            if payload.get("hasWiki"):
                cached_summary = _timed_cache_get(
                    _wiki_summary_zh_cache,
                    _wiki_summary_zh_cache_time,
                    normalized,
                )
                if cached_summary is not None:
                    payload["summaryZh"] = cached_summary
                _timed_cache_put(
                    _wiki_preview_cache,
                    _wiki_preview_cache_time,
                    normalized,
                    payload,
                    now=now,
                )
            return payload
        except Exception as e:
            print(f"Wiki preview fetch error for {normalized}: {e}")
            return {"hasWiki": False}

    @app.get("/api/tags/wiki-preview-summary-zh", dependencies=llm_deps)
    async def tags_wiki_preview_summary_zh(
        tag: Annotated[str, Query(max_length=_TAG_MAX_LENGTH)],
    ) -> dict[str, Any]:
        _prune_wiki_caches()
        normalized = _normalize_tag(tag)
        if not normalized:
            return {"hasWiki": False, "summaryZh": ""}

        cached_summary = _timed_cache_get(
            _wiki_summary_zh_cache,
            _wiki_summary_zh_cache_time,
            normalized,
        )
        if cached_summary is not None:
            return {"hasWiki": True, "summaryZh": cached_summary}

        body = ""
        summary = ""
        cached = _timed_cache_get(_wiki_preview_cache, _wiki_preview_cache_time, normalized)
        if cached:
            body = cached.get("body") or ""
            summary = cached.get("summary") or ""
        else:

            def _fetch_page_for_translation():
                page = _fetch_wiki_page(current_settings(), normalized)
                return (page.get("body") or "") if page else ""

            body = await asyncio.to_thread(_fetch_page_for_translation) or ""
            summary = _build_wiki_summary(body) if body else ""

        if not body and not summary:
            return {"hasWiki": False, "summaryZh": ""}

        summary_zh = await _translate_wiki_preview_summary(
            current_settings(),
            normalized,
            body,
            summary,
            http,
        )
        now = time.time()
        if summary_zh:
            _timed_cache_put(
                _wiki_summary_zh_cache,
                _wiki_summary_zh_cache_time,
                normalized,
                summary_zh,
                now=now,
            )
            if cached:
                cached["summaryZh"] = summary_zh
                _timed_cache_put(
                    _wiki_preview_cache,
                    _wiki_preview_cache_time,
                    normalized,
                    cached,
                    now=now,
                )
        return {"hasWiki": True, "summaryZh": summary_zh}

    @app.post("/api/tags/search")
    async def tags_search(req: TagsSearchRequest) -> dict[str, Any]:
        query = req.query
        safe_limit = req.limit
        safe_top_k = req.top_k
        cache_key = (query, req.show_nsfw, safe_limit, safe_top_k)
        now = time.time()
        cached = _result_cache_get(_search_cache, cache_key, ttl=_SEARCH_CACHE_TTL)
        if cached is not None:
            return {"results": cached, "cached": True}

        payload = {
            "query": query,
            "limit": safe_limit,
            "top_k": safe_top_k,
            "show_nsfw": req.show_nsfw,
            "target_categories": ["General"],
        }
        results: list[dict] = []
        upstream_error: str | None = None
        try:
            resp = await _search_backend_post(http, "/api/search", payload, timeout=30)
            if resp.status_code != 200:
                upstream_error = f"upstream_{resp.status_code}"
            else:
                data = resp.json()
                raw_results = data.get("results", []) if isinstance(data, dict) else []
                for item in raw_results:
                    if not isinstance(item, dict):
                        continue
                    tag = str(item.get("tag", "") or "").strip()
                    if not tag:
                        continue
                    results.append(
                        {
                            "tag": tag,
                            "cn_name": item.get("cn_name", "") or "",
                            "category": item.get("category", "") or "",
                            "nsfw": item.get("nsfw", "") or "",
                            "count": int(item.get("count", 0) or 0),
                            "score": float(item.get("final_score", 0.0) or 0.0),
                        }
                    )
        except httpx.TimeoutException:
            upstream_error = "timeout"
        except Exception as e:
            print(f"[tags_search] fetch error: {e}")
            upstream_error = "fetch_failed"

        _result_cache_put(
            _search_cache,
            cache_key,
            results,
            max_entries=_SEARCH_CACHE_MAX,
            ttl=_SEARCH_CACHE_TTL,
            now=now,
        )

        body: dict = {"results": results}
        if upstream_error and not results:
            body["error"] = upstream_error
        return body

    @app.post("/api/tags/related", dependencies=llm_deps)
    async def tags_related(req: TagsRelatedRequest) -> dict[str, Any]:
        norm_tags = tuple(sorted({_normalize_tag(tag) for tag in req.tags}))
        norm_categories = tuple(sorted(set(req.categories))) if req.categories else None
        safe_limit = req.limit
        cache_key = (norm_tags, req.show_nsfw, safe_limit, norm_categories)

        now = time.time()
        cached_results = _result_cache_get(
            _related_cache,
            cache_key,
            ttl=_RELATED_CACHE_TTL,
        )
        if cached_results is not None:
            return {"results": cached_results, "cached": True}

        upstream_limit = max(safe_limit * 4, 100) if norm_categories else safe_limit
        results: list[dict] = []
        upstream_error: str | None = None
        try:
            related_payload = {
                "tags": list(norm_tags),
                "limit": upstream_limit,
                "show_nsfw": req.show_nsfw,
            }
            resp = await _search_backend_post(http, "/api/related", related_payload, timeout=90)
            if resp.status_code != 200:
                upstream_error = f"upstream_{resp.status_code}"
            else:
                data = resp.json()
                if isinstance(data, list):
                    results = data
                elif isinstance(data, dict):
                    results = data.get("results", [])
        except httpx.TimeoutException:
            upstream_error = "timeout"
        except Exception as e:
            print(f"[tags_related] fetch error: {e}")
            upstream_error = "fetch_failed"

        if norm_categories:
            cat_set = set(norm_categories)
            results = [r for r in results if isinstance(r, dict) and r.get("category") in cat_set]
        results = results[:safe_limit]

        fallback_used = False
        if not results:
            ds_results = await _ds_fallback_related(
                current_settings(),
                list(norm_tags),
                safe_limit,
                http,
            )
            if norm_categories:
                cat_set = set(norm_categories)
                ds_results = [r for r in ds_results if r.get("category") in cat_set]
            if ds_results:
                results = ds_results[:safe_limit]
                fallback_used = True

        _result_cache_put(
            _related_cache,
            cache_key,
            results,
            max_entries=_RELATED_CACHE_MAX,
            ttl=_RELATED_CACHE_TTL,
            now=now,
        )

        body: dict = {"results": results}
        if fallback_used:
            body["fallback"] = "ds"
        if upstream_error and not results:
            body["error"] = upstream_error
        return body
