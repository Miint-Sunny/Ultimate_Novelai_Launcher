"""Tag suggestion sources behind one canonical endpoint.

Three sources coexist on purpose so the user can compare them from the UI:

* ``official``    — NovelAI's own ``/ai/generate-image/suggest-tags`` (needs the
                    NAI token; shape ``{tags: [{tag, count, confidence}]}``).
* ``danbooru``    — Danbooru ``autocomplete.json`` (lives in the API layer next to
                    the other Danbooru compat helpers).
* ``dictionary``  — the offline Danbooru dictionary the user's own
                    ``nai-autocomplete`` extension uses (a CSV published by
                    saltysalrua/nai-discordbot).  The ranking here is a port of that
                    extension's ``searchTags`` so results feel identical.
"""

from __future__ import annotations

import asyncio
import csv
import io
import logging
import os
import time
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import httpx

from ..config import Settings
from ..infrastructure import HttpClientPool
from ..nai.client import USER_AGENT
from ..security import OutboundPolicy

logger = logging.getLogger(__name__)

SUGGEST_TAGS_URL = "https://image.novelai.net/ai/generate-image/suggest-tags"
DEFAULT_SUGGEST_MODEL = "nai-diffusion-5-full"
OFFICIAL_TIMEOUT = httpx.Timeout(10.0, read=10.0)

# Same dictionary the nai-autocomplete extension pulls on first use.
DICTIONARY_URL = "https://raw.githubusercontent.com/saltysalrua/nai-discordbot/refs/heads/main/danbooru_all_2.csv"
DICTIONARY_TTL_SECONDS = 24 * 60 * 60
DICTIONARY_TIMEOUT = httpx.Timeout(30.0, read=120.0)
# The full file is ~150k rows; the extension keeps 30k in its cache.  Keep the
# most-used entries so the in-memory index stays small and scans stay quick.
DICTIONARY_MAX_ENTRIES = 60_000
_DICTIONARY_MAX_BYTES = 64 * 1024 * 1024
_TRANSIENT_STATUSES = frozenset({408, 425, 429}) | frozenset(range(500, 600))


class TagSuggestError(Exception):
    """A suggestion source could not answer."""

    code = "tag_suggest_failed"
    retryable = False

    def __init__(self, message: str, *, code: str | None = None, retryable: bool | None = None):
        super().__init__(message)
        self.message = message
        if code is not None:
            self.code = code
        if retryable is not None:
            self.retryable = retryable


class TagSuggestUpstreamError(TagSuggestError):
    code = "tag_suggest_upstream_failed"

    def __init__(self, source: str, status_code: int, excerpt: str = "") -> None:
        super().__init__(
            f"{source} tag suggestions failed with HTTP {status_code}",
            retryable=status_code in _TRANSIENT_STATUSES,
        )
        self.source = source
        self.status_code = status_code
        self.excerpt = excerpt


class TagDictionaryUnavailableError(TagSuggestError):
    code = "tag_dictionary_unavailable"
    retryable = True


@dataclass(frozen=True, slots=True)
class TagSuggestion:
    """One suggestion, normalised across sources (missing fields stay ``None``)."""

    tag: str
    count: int | None = None
    confidence: float | None = None
    category: str | None = None
    translation: str | None = None
    aliases: tuple[str, ...] = ()
    matched_alias: str | None = None
    group: str | None = None
    subgroup: str | None = None


# ---------------------------------------------------------------------------
# official: NovelAI suggest-tags
# ---------------------------------------------------------------------------


async def fetch_official_tag_suggestions(
    *,
    settings: Settings,
    query: str,
    model: str = DEFAULT_SUGGEST_MODEL,
    limit: int = 10,
    http: HttpClientPool,
    outbound_policy: OutboundPolicy | None = None,
) -> list[TagSuggestion]:
    """Ask NovelAI for tag completions; ``mock_generation`` answers offline."""

    if settings.mock_generation:
        return []
    if not settings.nai_token:
        raise TagSuggestError("NAI token is not configured", code="nai_token_not_configured")
    normalized = query.strip()
    if len(normalized) < 2:
        return []
    url = f"{SUGGEST_TAGS_URL}?{urlencode({'model': model, 'prompt': normalized})}"
    headers = {
        "Authorization": f"Bearer {settings.nai_token}",
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
        "Origin": "https://novelai.net",
        "Referer": "https://novelai.net",
    }
    response = await http.request(
        outbound_policy or OutboundPolicy("public"),
        "GET",
        url,
        headers=headers,
        timeout=OFFICIAL_TIMEOUT,
    )
    if response.status_code != 200:
        raise TagSuggestUpstreamError("official", response.status_code, response.text[:500])
    try:
        data = response.json()
    except ValueError as exc:
        raise TagSuggestError("NovelAI suggest-tags response was not JSON", retryable=True) from exc
    return parse_official_suggestions(data, limit=limit)


def parse_official_suggestions(data: Any, *, limit: int) -> list[TagSuggestion]:
    raw_tags = data.get("tags") if isinstance(data, dict) else None
    items: list[TagSuggestion] = []
    for entry in raw_tags or []:
        if not isinstance(entry, dict):
            continue
        tag = str(entry.get("tag") or "").strip()
        if not tag:
            continue
        count = entry.get("count")
        confidence = entry.get("confidence")
        items.append(
            TagSuggestion(
                tag=tag,
                count=int(count)
                if isinstance(count, (int, float)) and not isinstance(count, bool)
                else None,
                confidence=(
                    float(confidence)
                    if isinstance(confidence, (int, float)) and not isinstance(confidence, bool)
                    else None
                ),
            )
        )
        if len(items) >= limit:
            break
    return items


# ---------------------------------------------------------------------------
# dictionary: the offline Danbooru CSV
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class DictionaryEntry:
    tag: str
    category: str
    count: int
    aliases: tuple[str, ...]
    translation: str
    translations: tuple[str, ...]
    group: str
    subgroup: str
    norm: str = field(repr=False)
    translation_norms: tuple[str, ...] = field(repr=False)
    alias_norms: tuple[str, ...] = field(repr=False)


def _normalize(text: str) -> str:
    return text.strip().lower().replace("_", " ")


def parse_dictionary_csv(
    text: str, *, max_entries: int = DICTIONARY_MAX_ENTRIES
) -> list[DictionaryEntry]:
    """Parse ``tag,category,count,"aliases",translation|alt,group,subgroup`` rows.

    Columns after the tag are optional.  Entries come back sorted by post count
    (descending) and truncated to ``max_entries``, mirroring the extension's
    cache shape.
    """

    entries: list[DictionaryEntry] = []
    reader = csv.reader(io.StringIO(text.lstrip("﻿")))
    for row in reader:
        if not row:
            continue
        tag = row[0].strip()
        if not tag:
            continue
        category = row[1].strip() if len(row) > 1 and row[1].strip() else "0"
        raw_count = row[2].strip() if len(row) > 2 else ""
        count = int(raw_count) if raw_count.isdigit() else 0
        aliases = tuple(
            alias.strip() for alias in (row[3].split(",") if len(row) > 3 else []) if alias.strip()
        )
        translations = tuple(
            part.strip() for part in (row[4].split("|") if len(row) > 4 else []) if part.strip()
        )
        group = row[5].strip() if len(row) > 5 else ""
        subgroup = row[6].strip() if len(row) > 6 else ""
        entries.append(
            DictionaryEntry(
                tag=tag,
                category=category,
                count=count,
                aliases=aliases,
                translation=translations[0] if translations else "",
                translations=translations,
                group=group,
                subgroup=subgroup,
                norm=_normalize(tag),
                translation_norms=tuple(part.lower() for part in translations),
                alias_norms=tuple(_normalize(alias) for alias in aliases),
            )
        )
    entries.sort(key=lambda entry: entry.count, reverse=True)
    if max_entries > 0:
        del entries[max_entries:]
    return entries


def search_dictionary(
    entries: Sequence[DictionaryEntry],
    query: str,
    *,
    limit: int = 8,
) -> list[TagSuggestion]:
    """Port of nai-autocomplete's ``searchTags`` (tag part).

    Prefix match beats substring, which beats a translation hit, which beats an
    alias hit; post count breaks ties.  The scan stops after ``limit * 3``
    candidates because the entries are already sorted by popularity.
    """

    q = _normalize(query)
    if not q or q.startswith("@"):
        return []
    scored: list[tuple[float, DictionaryEntry, str | None]] = []
    for entry in entries:
        if len(scored) >= limit * 3:
            break
        matched_alias: str | None = None
        if entry.norm.startswith(q):
            score = 1000.0
        elif q in entry.norm:
            score = 500.0
        elif any(q in translation for translation in entry.translation_norms):
            score = 300.0
        else:
            alias_index = next(
                (index for index, alias in enumerate(entry.alias_norms) if q in alias),
                None,
            )
            if alias_index is None:
                continue
            score = 200.0
            matched_alias = entry.aliases[alias_index]
        scored.append((score + entry.count / 1e6, entry, matched_alias))
    scored.sort(key=lambda item: item[0], reverse=True)
    return [
        TagSuggestion(
            tag=entry.tag,
            count=entry.count,
            category=entry.category,
            translation=entry.translation or None,
            aliases=entry.aliases,
            matched_alias=matched_alias,
            group=entry.group or None,
            subgroup=entry.subgroup or None,
        )
        for _score, entry, matched_alias in scored[:limit]
    ]


@dataclass(frozen=True)
class DictionaryStatus:
    entries: int
    fetched_at: float | None
    stale: bool


class TagDictionaryService:
    """Download-once, refresh-daily dictionary with an in-memory search index.

    The CSV is cached under the sidecar data directory (written atomically) so a
    restart never re-downloads within the TTL, and a failed refresh keeps serving
    the stale copy rather than losing autocomplete.
    """

    def __init__(
        self,
        cache_path: Path,
        http: HttpClientPool | None,
        *,
        url: str = DICTIONARY_URL,
        ttl_seconds: float = DICTIONARY_TTL_SECONDS,
        max_entries: int = DICTIONARY_MAX_ENTRIES,
        outbound_policy: OutboundPolicy | None = None,
        clock: Any = time.time,
    ) -> None:
        self.cache_path = Path(cache_path)
        self._http = http
        self._url = url
        self._ttl = ttl_seconds
        self._max_entries = max_entries
        self._policy = outbound_policy
        self._clock = clock
        self._entries: list[DictionaryEntry] = []
        self._fetched_at: float | None = None
        self._lock = asyncio.Lock()

    @property
    def entries(self) -> Sequence[DictionaryEntry]:
        return self._entries

    def status(self) -> DictionaryStatus:
        fetched_at = self._fetched_at
        stale = fetched_at is None or (self._clock() - fetched_at) > self._ttl
        return DictionaryStatus(entries=len(self._entries), fetched_at=fetched_at, stale=stale)

    async def search(self, query: str, *, limit: int = 8) -> list[TagSuggestion]:
        await self.ensure_loaded()
        return search_dictionary(self._entries, query, limit=limit)

    async def ensure_loaded(self) -> None:
        """Load from a fresh cache file, otherwise download; keep stale data on failure."""

        if self._entries and not self.status().stale:
            return
        async with self._lock:
            if self._entries and not self.status().stale:
                return
            cached_at = self._cache_mtime()
            if cached_at is not None and (self._clock() - cached_at) <= self._ttl:
                await self._load_from_cache(cached_at)
                return
            try:
                await self._download()
                return
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning(
                    "tag dictionary refresh failed error_type=%s; keeping the cached copy",
                    type(exc).__name__,
                )
                if self._entries:
                    return
                if cached_at is not None:
                    await self._load_from_cache(cached_at)
                    return
                raise TagDictionaryUnavailableError(
                    "the tag dictionary has not been downloaded yet and the download failed"
                ) from exc

    def _cache_mtime(self) -> float | None:
        try:
            return self.cache_path.stat().st_mtime
        except OSError:
            return None

    async def _load_from_cache(self, cached_at: float) -> None:
        text = await asyncio.to_thread(self.cache_path.read_text, "utf-8", "replace")
        self._entries = await asyncio.to_thread(
            parse_dictionary_csv, text, max_entries=self._max_entries
        )
        self._fetched_at = cached_at

    async def _download(self) -> None:
        if self._http is None:
            raise TagDictionaryUnavailableError("no HTTP client pool for the dictionary download")
        response = await self._http.request(
            self._policy or OutboundPolicy("public"),
            "GET",
            self._url,
            long_running=True,
            headers={"User-Agent": USER_AGENT, "Accept": "text/csv, text/plain"},
            timeout=DICTIONARY_TIMEOUT,
        )
        if response.status_code != 200:
            raise TagSuggestUpstreamError("dictionary", response.status_code)
        payload = response.content
        if not payload or len(payload) > _DICTIONARY_MAX_BYTES:
            raise TagDictionaryUnavailableError(
                "the tag dictionary download was empty or too large"
            )
        text = payload.decode("utf-8", errors="replace")
        entries = await asyncio.to_thread(parse_dictionary_csv, text, max_entries=self._max_entries)
        if not entries:
            raise TagDictionaryUnavailableError("the tag dictionary download had no rows")
        await asyncio.to_thread(self._write_cache, payload)
        self._entries = entries
        self._fetched_at = self._clock()

    def _write_cache(self, payload: bytes) -> None:
        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.cache_path.with_name(self.cache_path.name + ".tmp")
        with open(temporary, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, self.cache_path)


__all__ = [
    "DEFAULT_SUGGEST_MODEL",
    "DICTIONARY_MAX_ENTRIES",
    "DICTIONARY_TTL_SECONDS",
    "DICTIONARY_URL",
    "SUGGEST_TAGS_URL",
    "DictionaryEntry",
    "DictionaryStatus",
    "TagDictionaryService",
    "TagDictionaryUnavailableError",
    "TagSuggestError",
    "TagSuggestUpstreamError",
    "TagSuggestion",
    "fetch_official_tag_suggestions",
    "parse_dictionary_csv",
    "parse_official_suggestions",
    "search_dictionary",
]
