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
import json
import re
import time
from typing import Any, Optional

import httpx
from pydantic import BaseModel

from curl_cffi import requests as _cffi_requests

from .config import Settings
from .db import lookup_tag_translations
from .llm.client import chat_completion

DANBOORU = "https://danbooru.donmai.us"
DANBOORU_SEARCH_BASE = "https://sakizuki-danboorusearch.hf.space"

WIKI_CACHE_TTL = 3600
_SEARCH_CACHE_TTL = 1800
_SEARCH_CACHE_MAX = 500
_RELATED_CACHE_TTL = 86400
_RELATED_CACHE_MAX = 1000

CJK_RANGE = r"\u4e00-\u9fff"
_POST_EXAMPLE_RATING = "rating:g,s"
_POST_EXAMPLE_IMAGE_EXTS = {"jpg", "jpeg", "png", "webp", "gif"}

_RELATED_FALLBACK_SYS = (
    "You are a Danbooru tag co-occurrence engine. "
    "Given anchor tags, output a JSON array of 12 General-category Danbooru tags "
    "that commonly appear with the anchor in image illustrations. "
    "Only output General tags. Use canonical lowercase underscore tag names. "
    "Each item must be {\"tag\": <english_tag>, \"cn_name\": <short Chinese name>}. "
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

# ---- Danbooru session (curl_cffi, Chrome impersonation, optional proxy) ----
_danbooru_session = None  # type: ignore[var-annotated]


def _danbooru_proxies(settings: Settings):
    url = getattr(settings, "danbooru_proxy_url", "") or ""
    if not url:
        return None
    if url.startswith("socks5://"):
        url = "socks5h://" + url[len("socks5://"):]
    return {"http": url, "https": url}


def _get_danbooru_session(settings: Settings):
    global _danbooru_session
    if _danbooru_session is None:
        _danbooru_session = _cffi_requests.Session(impersonate="chrome")
        proxies = _danbooru_proxies(settings)
        if proxies:
            _danbooru_session.proxies = dict(proxies)
    return _danbooru_session


def _normalize_tag(tag: str) -> str:
    return tag.strip().lower().replace(" ", "_")


def _wiki_cache_fresh(ts: float) -> bool:
    return (time.time() - ts) < WIKI_CACHE_TTL


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
    text = re.split(r"\nh\d\.\s+(?:Examples|See also)\b", body or "", maxsplit=1, flags=re.IGNORECASE)[0]
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


def _absolute_danbooru_url(url: Optional[str]) -> Optional[str]:
    if not url:
        return None
    if url.startswith("//"):
        return f"https:{url}"
    if url.startswith("/"):
        return f"{DANBOORU}{url}"
    return url


# ---- Danbooru fetchers (sync; run via asyncio.to_thread) ----


def _fetch_wiki_page(settings: Settings, tag: str) -> Optional[dict]:
    session = _get_danbooru_session(settings)
    resp = session.get(f"{DANBOORU}/wiki_pages.json", params={"search[title]": tag}, timeout=5)
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
        resp = session.get(f"{DANBOORU}/wiki_pages.json", params={"search[title]": tag}, timeout=5)
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


def _fetch_wiki_example(session, ref_type: str, ref_id: int) -> Optional[dict]:
    if ref_type == "post":
        resp = session.get(f"{DANBOORU}/posts/{ref_id}.json", timeout=8)
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
        resp = session.get(f"{DANBOORU}/media_assets/{ref_id}.json", timeout=8)
        if resp.status_code != 200:
            return None
        data = resp.json()
        if not isinstance(data, dict):
            return None
        preview_url = _absolute_danbooru_url(
            data.get("file_url") or data.get("large_file_url") or data.get("image_url") or data.get("preview_file_url")
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
        resp = session.get(
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
        examples.append({
            "type": "post",
            "id": post_id,
            "previewUrl": preview_url,
            "pageUrl": f"{DANBOORU}/posts/{post_id}",
            "width": post.get("image_width"),
            "height": post.get("image_height"),
        })
        if len(examples) >= limit:
            break
    return examples


def _fetch_wiki_chinese(settings: Settings, tag: str) -> tuple[str, list[str]]:
    try:
        session = _get_danbooru_session(settings)
        resp = session.get(f"{DANBOORU}/wiki_pages.json", params={"search[title]": tag}, timeout=5)
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


async def _translate_wiki_preview_summary(settings: Settings, tag: str, body: str, fallback_summary: str) -> str:
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
        result = await chat_completion(settings=settings, messages=messages, temperature=0.2, max_tokens=300)
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
        arr = json.loads(text[start:end + 1])
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


async def _ds_fallback_related(settings: Settings, anchor_tags: list[str], limit: int) -> list[dict]:
    messages = [
        {"role": "system", "content": _RELATED_FALLBACK_SYS},
        {"role": "user", "content": "Anchor tags: " + ", ".join(anchor_tags)},
    ]
    try:
        result = await chat_completion(settings=settings, messages=messages, temperature=0.3, max_tokens=1500)
        return _parse_ds_fallback_results(_extract_chat_text(result))[:limit]
    except Exception as e:
        print(f"[tags_related] DS fallback error: {e}")
        return []


# ---- request models ----


class TagsSearchRequest(BaseModel):
    query: str
    limit: int = 30
    top_k: int = 50
    show_nsfw: bool = True


class TagsRelatedRequest(BaseModel):
    tags: list[str]
    limit: int = 30
    show_nsfw: bool = True
    categories: Optional[list[str]] = None


def register_tag_routes(app, settings: Settings, auth: Any = None) -> None:
    # Most tag routes only hit external Danbooru and are left open (they are fetched
    # directly by the browser). The two that reach the user's LLM key via
    # chat_completion (related / wiki-preview-summary-zh) are gated on the sidecar
    # auth token so a local/drive-by caller cannot spend the key.
    llm_deps = [auth] if auth is not None else []

    @app.get("/api/tags/autocomplete")
    async def tags_autocomplete(query: str, limit: int = 10) -> Any:
        if not query or len(query) < 2:
            return []

        def _fetch():
            session = _get_danbooru_session(settings)
            url = (
                f"{DANBOORU}/autocomplete.json"
                f"?search%5Bquery%5D={query}&search%5Btype%5D=tag_query&limit={limit}"
            )
            resp = session.get(url, timeout=10)
            return resp.json() if resp.status_code == 200 else []

        try:
            return await asyncio.to_thread(_fetch)
        except Exception as e:
            print(f"Danbooru API error: {e}")
            return []

    @app.post("/api/tags/verify")
    async def tags_verify(req: dict) -> dict[str, Any]:
        tags = req.get("tags", [])
        if not tags:
            return {}
        tags = [t.strip().lower().replace(" ", "_").replace("-", "_") for t in tags[:20] if t.strip()]
        if not tags:
            return {}

        def _fetch():
            session = _get_danbooru_session(settings)
            names_param = ",".join(tags)
            url = f"{DANBOORU}/tags.json?search[name_comma]={names_param}&limit={len(tags)}"
            resp = session.get(url, timeout=10)
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
    async def tags_wiki(tags: str) -> dict[str, Any]:
        tag_list = [t.strip() for t in tags.split(",") if t.strip()][:10]
        if not tag_list:
            return {}

        result: dict[str, list] = {}
        tags_to_fetch: list[str] = []
        now = time.time()

        # 1) in-memory cache, 2) tag-translation DB, 3) Danbooru
        stored = lookup_tag_translations(settings, tag_list)
        for tag in tag_list:
            if tag in _wiki_cache and (now - _wiki_cache_time.get(tag, 0)) < WIKI_CACHE_TTL:
                if _wiki_cache[tag]:
                    result[tag] = _wiki_cache[tag]
                continue
            zh = stored.get(tag) or stored.get(_normalize_tag(tag))
            if zh:
                result[tag] = [zh]
                _wiki_cache[tag] = [zh]
                _wiki_cache_time[tag] = now
                continue
            tags_to_fetch.append(tag)

        if not tags_to_fetch:
            return result

        def _fetch_all():
            with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
                return list(executor.map(lambda t: _fetch_wiki_chinese(settings, t), tags_to_fetch))

        for tag, chinese_names in await asyncio.to_thread(_fetch_all):
            _wiki_cache[tag] = chinese_names
            _wiki_cache_time[tag] = now
            if chinese_names:
                result[tag] = chinese_names

        return result

    @app.post("/api/tags/wiki-exists-batch")
    async def tags_wiki_exists_batch(req: dict) -> dict[str, bool]:
        raw_tags = req.get("tags", [])
        if not raw_tags:
            return {}
        tags = []
        seen = set()
        for raw_tag in raw_tags[:50]:
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
            if tag in _wiki_preview_cache and _wiki_cache_fresh(_wiki_preview_cache_time.get(tag, 0)):
                result[tag] = True
            elif tag in _wiki_exists_cache and _wiki_cache_fresh(_wiki_exists_cache_time.get(tag, 0)):
                result[tag] = _wiki_exists_cache[tag]
            else:
                tags_to_fetch.append(tag)

        def _check(tag: str) -> tuple[str, Optional[bool]]:
            ok, has_wiki = _check_wiki_page_exists(settings, tag)
            return tag, (has_wiki if ok else None)

        if tags_to_fetch:
            def _fetch_all():
                with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
                    return list(executor.map(_check, tags_to_fetch))

            for tag, has_wiki in await asyncio.to_thread(_fetch_all):
                if has_wiki is None:
                    continue
                _wiki_exists_cache[tag] = has_wiki
                _wiki_exists_cache_time[tag] = now
                result[tag] = has_wiki

        return result

    @app.get("/api/tags/wiki-preview")
    async def tags_wiki_preview(tag: str) -> dict[str, Any]:
        normalized = _normalize_tag(tag)
        if not normalized:
            return {"hasWiki": False}

        if normalized in _wiki_preview_cache and _wiki_cache_fresh(_wiki_preview_cache_time.get(normalized, 0)):
            cached = _wiki_preview_cache[normalized]
            if normalized in _wiki_summary_zh_cache and _wiki_cache_fresh(_wiki_summary_zh_cache_time.get(normalized, 0)):
                cached["summaryZh"] = _wiki_summary_zh_cache[normalized]
            return cached

        def _fetch():
            page = _fetch_wiki_page(settings, normalized)
            if not page:
                return {"hasWiki": False}
            body = page.get("body") or ""
            session = _get_danbooru_session(settings)
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
            _wiki_exists_cache[normalized] = bool(payload.get("hasWiki"))
            _wiki_exists_cache_time[normalized] = now
            if payload.get("hasWiki"):
                if normalized in _wiki_summary_zh_cache and _wiki_cache_fresh(_wiki_summary_zh_cache_time.get(normalized, 0)):
                    payload["summaryZh"] = _wiki_summary_zh_cache[normalized]
                _wiki_preview_cache[normalized] = payload
                _wiki_preview_cache_time[normalized] = now
            return payload
        except Exception as e:
            print(f"Wiki preview fetch error for {normalized}: {e}")
            return {"hasWiki": False}

    @app.get("/api/tags/wiki-preview-summary-zh", dependencies=llm_deps)
    async def tags_wiki_preview_summary_zh(tag: str) -> dict[str, Any]:
        normalized = _normalize_tag(tag)
        if not normalized:
            return {"hasWiki": False, "summaryZh": ""}

        if normalized in _wiki_summary_zh_cache and _wiki_cache_fresh(_wiki_summary_zh_cache_time.get(normalized, 0)):
            return {"hasWiki": True, "summaryZh": _wiki_summary_zh_cache[normalized]}

        body = ""
        summary = ""
        cached = _wiki_preview_cache.get(normalized)
        if cached and _wiki_cache_fresh(_wiki_preview_cache_time.get(normalized, 0)):
            body = cached.get("body") or ""
            summary = cached.get("summary") or ""
        else:
            def _fetch_page_for_translation():
                page = _fetch_wiki_page(settings, normalized)
                return (page.get("body") or "") if page else ""

            body = await asyncio.to_thread(_fetch_page_for_translation) or ""
            summary = _build_wiki_summary(body) if body else ""

        if not body and not summary:
            return {"hasWiki": False, "summaryZh": ""}

        summary_zh = await _translate_wiki_preview_summary(settings, normalized, body, summary)
        now = time.time()
        if summary_zh:
            _wiki_summary_zh_cache[normalized] = summary_zh
            _wiki_summary_zh_cache_time[normalized] = now
            if cached:
                cached["summaryZh"] = summary_zh
                _wiki_preview_cache[normalized] = cached
        return {"hasWiki": True, "summaryZh": summary_zh}

    @app.post("/api/tags/search")
    async def tags_search(req: TagsSearchRequest) -> dict[str, Any]:
        query = (req.query or "").strip()
        if not query:
            return {"results": []}
        safe_limit = max(1, min(req.limit, 200))
        safe_top_k = max(1, min(req.top_k, 50))
        cache_key = (query, req.show_nsfw, safe_limit, safe_top_k)
        now = time.time()
        if cache_key in _search_cache:
            ts, cached = _search_cache[cache_key]
            if now - ts < _SEARCH_CACHE_TTL:
                return {"results": cached, "cached": True}

        payload = {
            "query": query,
            "limit": safe_limit,
            "top_k": safe_top_k,
            "show_nsfw": req.show_nsfw,
            "target_categories": ["General"],
        }
        results: list[dict] = []
        upstream_error: Optional[str] = None
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(f"{DANBOORU_SEARCH_BASE}/api/search", json=payload)
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
                    results.append({
                        "tag": tag,
                        "cn_name": item.get("cn_name", "") or "",
                        "category": item.get("category", "") or "",
                        "nsfw": item.get("nsfw", "") or "",
                        "count": int(item.get("count", 0) or 0),
                        "score": float(item.get("final_score", 0.0) or 0.0),
                    })
        except httpx.TimeoutException:
            upstream_error = "timeout"
        except Exception as e:
            print(f"[tags_search] fetch error: {e}")
            upstream_error = "fetch_failed"

        _search_cache[cache_key] = (now, results)
        if len(_search_cache) > _SEARCH_CACHE_MAX:
            oldest = min(_search_cache, key=lambda k: _search_cache[k][0])
            del _search_cache[oldest]

        body: dict = {"results": results}
        if upstream_error and not results:
            body["error"] = upstream_error
        return body

    @app.post("/api/tags/related", dependencies=llm_deps)
    async def tags_related(req: TagsRelatedRequest) -> dict[str, Any]:
        if not req.tags:
            return {"results": []}
        norm_tags = tuple(sorted(t.lower().strip().replace(" ", "_") for t in req.tags if t.strip()))
        if not norm_tags:
            return {"results": []}
        norm_categories = tuple(sorted(req.categories)) if req.categories else None
        safe_limit = max(1, min(req.limit, 100))
        cache_key = (norm_tags, req.show_nsfw, safe_limit, norm_categories)

        now = time.time()
        if cache_key in _related_cache:
            ts, cached_results = _related_cache[cache_key]
            if now - ts < _RELATED_CACHE_TTL:
                return {"results": cached_results, "cached": True}

        upstream_limit = max(safe_limit * 4, 100) if norm_categories else safe_limit
        results: list[dict] = []
        upstream_error: Optional[str] = None
        try:
            async with httpx.AsyncClient(timeout=90) as client:
                resp = await client.post(
                    f"{DANBOORU_SEARCH_BASE}/api/related",
                    json={"tags": list(norm_tags), "limit": upstream_limit, "show_nsfw": req.show_nsfw},
                )
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
            ds_results = await _ds_fallback_related(settings, list(norm_tags), safe_limit)
            if norm_categories:
                cat_set = set(norm_categories)
                ds_results = [r for r in ds_results if r.get("category") in cat_set]
            if ds_results:
                results = ds_results[:safe_limit]
                fallback_used = True

        _related_cache[cache_key] = (now, results)
        if len(_related_cache) > _RELATED_CACHE_MAX:
            oldest = min(_related_cache, key=lambda k: _related_cache[k][0])
            del _related_cache[oldest]

        body: dict = {"results": results}
        if fallback_used:
            body["fallback"] = "ds"
        if upstream_error and not results:
            body["error"] = upstream_error
        return body
