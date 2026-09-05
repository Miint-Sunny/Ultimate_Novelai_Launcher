"""Tag suggestions: the offline dictionary port, the official proxy, and the route.

上游一律 MockTransport,词典下载与官方联想都不得打真网络。词典排序断言照抄
nai-autocomplete 扩展的 searchTags 语义:前缀 > 包含 > 中文释义 > 别名,热度破平。
"""

from __future__ import annotations

import os
import time
import unittest
from contextlib import asynccontextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any
from unittest import mock

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from sidecar.api import mount_api
from sidecar.api.v1 import tags as tags_module
from sidecar.application import SettingsStore
from sidecar.config import Settings
from sidecar.infrastructure import HttpClientPool
from sidecar.runtime import AppRuntime
from sidecar.security import AuthManager, OutboundPolicy
from sidecar.services.tag_suggest import (
    TagDictionaryService,
    TagDictionaryUnavailableError,
    TagSuggestError,
    TagSuggestUpstreamError,
    fetch_official_tag_suggestions,
    parse_dictionary_csv,
    parse_official_suggestions,
    search_dictionary,
)

CSV_TEXT = (
    '﻿1girl,0,6421189,"1girls,sole_female",1个女孩,人物,对象\n'
    'highres,5,5763262,"high_res,high_resolution,hires",高分辨率,画面,1画质\n'
    'long_hair,0,4677240,"/lh,longhair",长发|齐腰,人物,发型，长度\n'
    'blonde_hair,0,1660569,"blond,blonde",金发,人物,发色，单色\n'
    "1boy,0,1500000,,1个男孩,人物,对象\n"
    'girl_on_top,0,120000,"cowgirl_position",女上位\n'
    "solo,0,not-a-number\n"
    "\n"
    "smile\n"
)


def _settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "host": "127.0.0.1",
        "port": 0,
        "data_dir": Path("/tmp"),
        "nai_token": "nai-secret",
        "nai_base_url": "https://image.novelai.net",
        "llm_base_url": "",
        "llm_api_key": "",
        "llm_model": "",
        "mock_generation": False,
        "sidecar_auth_token": "process-token",
    }
    values.update(overrides)
    return Settings(**values)


def _policy() -> OutboundPolicy:
    return OutboundPolicy("public", resolver=lambda _host, _port: ["93.184.216.34"])


def _pool(handler: Any) -> HttpClientPool:
    shared = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return HttpClientPool(default_client=shared, long_running_client=shared)


class ParseDictionaryTests(unittest.TestCase):
    def test_parses_columns_sorts_by_count_and_tolerates_short_rows(self) -> None:
        entries = parse_dictionary_csv(CSV_TEXT)
        self.assertEqual([entry.tag for entry in entries][:3], ["1girl", "highres", "long_hair"])
        first = entries[0]
        self.assertEqual(first.category, "0")
        self.assertEqual(first.count, 6421189)
        self.assertEqual(first.aliases, ("1girls", "sole_female"))
        self.assertEqual(first.translation, "1个女孩")
        self.assertEqual(first.group, "人物")
        self.assertEqual(first.subgroup, "对象")
        long_hair = next(entry for entry in entries if entry.tag == "long_hair")
        self.assertEqual(long_hair.translation, "长发")
        self.assertEqual(long_hair.translations, ("长发", "齐腰"))
        solo = next(entry for entry in entries if entry.tag == "solo")
        self.assertEqual(solo.count, 0)
        smile = next(entry for entry in entries if entry.tag == "smile")
        self.assertEqual((smile.category, smile.aliases, smile.translation), ("0", (), ""))

    def test_max_entries_keeps_the_most_used(self) -> None:
        entries = parse_dictionary_csv(CSV_TEXT, max_entries=2)
        self.assertEqual([entry.tag for entry in entries], ["1girl", "highres"])


class SearchDictionaryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.entries = parse_dictionary_csv(CSV_TEXT)

    def test_prefix_beats_substring_and_underscore_equals_space(self) -> None:
        tags = [item.tag for item in search_dictionary(self.entries, "girl", limit=8)]
        # girl_on_top starts with "girl" (prefix, 1000) and beats the far more popular
        # 1girl, which only contains it (500) -- exactly the extension's ordering.
        self.assertEqual(tags[:2], ["girl_on_top", "1girl"])
        spaced = search_dictionary(self.entries, "long hair", limit=8)
        self.assertEqual(spaced[0].tag, "long_hair")
        underscored = search_dictionary(self.entries, "long_hair", limit=8)
        self.assertEqual(underscored[0].tag, "long_hair")

    def test_translation_and_alias_hits_rank_below_name_hits(self) -> None:
        by_chinese = search_dictionary(self.entries, "长发", limit=8)
        self.assertEqual([item.tag for item in by_chinese], ["long_hair"])
        self.assertEqual(by_chinese[0].translation, "长发")
        by_alt_chinese = search_dictionary(self.entries, "齐腰", limit=8)
        self.assertEqual([item.tag for item in by_alt_chinese], ["long_hair"])
        by_alias = search_dictionary(self.entries, "cowgirl", limit=8)
        self.assertEqual(by_alias[0].tag, "girl_on_top")
        self.assertEqual(by_alias[0].matched_alias, "cowgirl_position")
        # "hires" is both a prefix of nothing and an alias of highres; "hi" prefixes highres
        mixed = search_dictionary(self.entries, "hi", limit=8)
        self.assertEqual(mixed[0].tag, "highres")
        self.assertIsNone(mixed[0].matched_alias)

    def test_empty_at_prefixed_and_limits(self) -> None:
        self.assertEqual(search_dictionary(self.entries, "", limit=8), [])
        self.assertEqual(search_dictionary(self.entries, "@1girl", limit=8), [])
        self.assertEqual(len(search_dictionary(self.entries, "1", limit=1)), 1)


class TagDictionaryServiceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.temp = TemporaryDirectory()
        self.cache = Path(self.temp.name) / "data" / "tag_dictionary.csv"

    def tearDown(self) -> None:
        self.temp.cleanup()

    async def test_downloads_once_writes_cache_and_serves_searches(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(200, content=CSV_TEXT.encode("utf-8"))

        pool = _pool(handler)
        try:
            service = TagDictionaryService(self.cache, pool, outbound_policy=_policy())
            items = await service.search("1gi", limit=5)
            again = await service.search("blond", limit=5)
        finally:
            await pool.close()

        self.assertEqual([item.tag for item in items], ["1girl"])
        self.assertEqual(again[0].tag, "blonde_hair")
        self.assertEqual(len(requests), 1)
        self.assertTrue(str(requests[0].url).startswith("https://raw.githubusercontent.com/"))
        self.assertTrue(self.cache.is_file())
        self.assertFalse(self.cache.with_name(self.cache.name + ".tmp").exists())
        status = service.status()
        self.assertEqual(status.entries, 8)
        self.assertFalse(status.stale)

    async def test_fresh_cache_file_is_used_without_any_request(self) -> None:
        self.cache.parent.mkdir(parents=True)
        self.cache.write_text(CSV_TEXT, encoding="utf-8")

        async def handler(request: httpx.Request) -> httpx.Response:
            raise AssertionError("a fresh cache must not trigger a download")

        pool = _pool(handler)
        try:
            service = TagDictionaryService(self.cache, pool, outbound_policy=_policy())
            items = await service.search("highres", limit=3)
        finally:
            await pool.close()
        self.assertEqual(items[0].tag, "highres")
        self.assertFalse(service.status().stale)

    async def test_stale_cache_survives_a_failed_refresh(self) -> None:
        self.cache.parent.mkdir(parents=True)
        self.cache.write_text(CSV_TEXT, encoding="utf-8")
        old = time.time() - 3 * 24 * 60 * 60
        os.utime(self.cache, (old, old))
        attempts: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            attempts.append(request)
            return httpx.Response(503)

        pool = _pool(handler)
        try:
            service = TagDictionaryService(self.cache, pool, outbound_policy=_policy())
            items = await service.search("1boy", limit=3)
        finally:
            await pool.close()
        self.assertEqual(items[0].tag, "1boy")
        self.assertEqual(len(attempts), 1)
        self.assertTrue(service.status().stale)

    async def test_no_cache_and_failed_download_is_unavailable(self) -> None:
        pool = _pool(lambda request: httpx.Response(500))
        try:
            service = TagDictionaryService(self.cache, pool, outbound_policy=_policy())
            with self.assertRaises(TagDictionaryUnavailableError):
                await service.search("1girl", limit=3)
        finally:
            await pool.close()
        self.assertFalse(self.cache.exists())

    async def test_empty_download_is_rejected(self) -> None:
        pool = _pool(lambda request: httpx.Response(200, content=b""))
        try:
            service = TagDictionaryService(self.cache, pool, outbound_policy=_policy())
            with self.assertRaises(TagDictionaryUnavailableError):
                await service.ensure_loaded()
        finally:
            await pool.close()


class OfficialSuggestionsTests(unittest.IsolatedAsyncioTestCase):
    async def test_sends_model_prompt_and_bearer_and_parses_tags(self) -> None:
        requests: list[httpx.Request] = []

        async def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(
                200,
                json={
                    "tags": [
                        {"tag": "1girl", "count": 6421189, "confidence": 0.98},
                        {"tag": "1girls", "count": "bad", "confidence": None},
                        {"not": "a tag"},
                        {"tag": "", "count": 1},
                    ]
                },
            )

        pool = _pool(handler)
        try:
            items = await fetch_official_tag_suggestions(
                settings=_settings(),
                query="  1gi ",
                model="nai-diffusion-5-curated",
                limit=10,
                http=pool,
                outbound_policy=_policy(),
            )
        finally:
            await pool.close()

        self.assertEqual(len(requests), 1)
        request = requests[0]
        self.assertEqual(request.url.host, "image.novelai.net")
        self.assertEqual(request.url.path, "/ai/generate-image/suggest-tags")
        self.assertEqual(request.url.params["model"], "nai-diffusion-5-curated")
        self.assertEqual(request.url.params["prompt"], "1gi")
        self.assertEqual(request.headers["authorization"], "Bearer nai-secret")
        self.assertEqual(
            [(item.tag, item.count, item.confidence) for item in items],
            [
                ("1girl", 6421189, 0.98),
                ("1girls", None, None),
            ],
        )

    async def test_mock_mode_short_query_and_missing_token(self) -> None:
        async def handler(request: httpx.Request) -> httpx.Response:
            raise AssertionError("no request may leave")

        pool = _pool(handler)
        try:
            self.assertEqual(
                await fetch_official_tag_suggestions(
                    settings=_settings(mock_generation=True), query="1gi", http=pool
                ),
                [],
            )
            self.assertEqual(
                await fetch_official_tag_suggestions(settings=_settings(), query="1", http=pool),
                [],
            )
            with self.assertRaises(TagSuggestError) as raised:
                await fetch_official_tag_suggestions(
                    settings=_settings(nai_token=""), query="1gi", http=pool
                )
        finally:
            await pool.close()
        self.assertEqual(raised.exception.code, "nai_token_not_configured")

    async def test_upstream_status_maps_to_retryable_flag(self) -> None:
        for status, retryable in ((500, True), (429, True), (401, False), (400, False)):
            with self.subTest(status=status):
                pool = _pool(lambda request, status=status: httpx.Response(status))
                try:
                    with self.assertRaises(TagSuggestUpstreamError) as raised:
                        await fetch_official_tag_suggestions(
                            settings=_settings(),
                            query="1gi",
                            http=pool,
                            outbound_policy=_policy(),
                        )
                finally:
                    await pool.close()
                self.assertEqual(raised.exception.status_code, status)
                self.assertEqual(raised.exception.retryable, retryable)
                self.assertEqual(raised.exception.source, "official")

    async def test_non_json_body_is_a_retryable_error(self) -> None:
        pool = _pool(lambda request: httpx.Response(200, content=b"<html>"))
        try:
            with self.assertRaises(TagSuggestError) as raised:
                await fetch_official_tag_suggestions(
                    settings=_settings(), query="1gi", http=pool, outbound_policy=_policy()
                )
        finally:
            await pool.close()
        self.assertTrue(raised.exception.retryable)

    def test_parse_respects_limit(self) -> None:
        data = {"tags": [{"tag": f"t{i}", "count": i} for i in range(5)]}
        self.assertEqual(
            [item.tag for item in parse_official_suggestions(data, limit=2)], ["t0", "t1"]
        )
        self.assertEqual(parse_official_suggestions(["not", "a", "dict"], limit=2), [])


class TagSuggestRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = TemporaryDirectory()
        self.cache = Path(self.temp.name) / "data" / "tag_dictionary.csv"
        self.cache.parent.mkdir(parents=True)
        self.cache.write_text(CSV_TEXT, encoding="utf-8")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _runtime(
        self,
        pool: HttpClientPool,
        *,
        dictionary: bool = True,
        **overrides: Any,
    ) -> AppRuntime:
        settings = _settings(data_dir=Path(self.temp.name), **overrides)
        return AppRuntime(
            settings=SettingsStore(settings, loader=None),
            security=AuthManager("process-token"),
            http=pool,
            tag_dictionary=TagDictionaryService(self.cache, None) if dictionary else None,
        )

    def _app(self, runtime: AppRuntime) -> FastAPI:
        @asynccontextmanager
        async def lifespan(_: FastAPI):
            await runtime.startup()
            try:
                yield
            finally:
                await runtime.shutdown()

        app = FastAPI(lifespan=lifespan)
        mount_api(app, runtime, include_v0_compat=False)
        return app

    def _get(
        self, client: TestClient, params: dict[str, Any], *, auth: bool = True
    ) -> httpx.Response:
        headers = {"Authorization": "Bearer process-token"} if auth else {}
        return client.get("/api/v1/tags/suggest", params=params, headers=headers)

    def test_dictionary_source_serves_the_cached_csv(self) -> None:
        pool = _pool(lambda request: httpx.Response(500))
        with TestClient(self._app(self._runtime(pool))) as client:  # type: ignore[misc]
            unauthorized = self._get(client, {"source": "dictionary", "q": "1gi"}, auth=False)
            response = self._get(client, {"source": "dictionary", "q": "长发", "limit": 3})

        self.assertEqual(unauthorized.status_code, 401)
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["source"], "dictionary")
        self.assertEqual(body["query"], "长发")
        self.assertEqual(body["items"][0]["tag"], "long_hair")
        self.assertEqual(body["items"][0]["translation"], "长发")
        self.assertEqual(body["items"][0]["group"], "人物")
        self.assertEqual(body["items"][0]["aliases"], ["/lh", "longhair"])
        self.assertIsNone(body["items"][0]["confidence"])

    def test_danbooru_source_uses_the_fetcher_and_normalises_items(self) -> None:
        seen: list[tuple[str, int]] = []

        async def fake(settings: Settings, query: str, limit: int) -> list[dict[str, Any]]:
            seen.append((query, limit))
            return [
                {
                    "type": "tag",
                    "label": "long hair",
                    "value": "long_hair",
                    "category": 0,
                    "post_count": 4677240,
                },
                {
                    "type": "tag-alias",
                    "label": "lh",
                    "value": "long_hair",
                    "category": 0,
                    "post_count": 1,
                    "antecedent": "lh",
                },
                {"garbage": True},
            ]

        pool = _pool(lambda request: httpx.Response(500))
        with mock.patch.object(tags_module, "_danbooru_autocomplete", fake):
            with TestClient(self._app(self._runtime(pool))) as client:  # type: ignore[misc]
                response = self._get(client, {"source": "danbooru", "q": "long", "limit": 5})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(seen, [("long", 5)])
        items = response.json()["items"]
        self.assertEqual([item["tag"] for item in items], ["long_hair", "long_hair"])
        self.assertEqual(items[0]["count"], 4677240)
        self.assertEqual(items[0]["category"], "0")
        self.assertEqual(items[1]["matched_alias"], "lh")

    def test_official_source_mock_mode_and_missing_token(self) -> None:
        pool = _pool(lambda request: httpx.Response(500))
        with TestClient(self._app(self._runtime(pool, mock_generation=True))) as client:  # type: ignore[misc]
            mocked = self._get(client, {"source": "official", "q": "1gi"})
        with TestClient(self._app(self._runtime(pool, nai_token=""))) as client:  # type: ignore[misc]
            missing = self._get(client, {"source": "official", "q": "1gi"})

        self.assertEqual(mocked.status_code, 200)
        self.assertEqual(mocked.json()["items"], [])
        self.assertEqual(missing.status_code, 503)
        self.assertEqual(missing.json()["code"], "nai_token_not_configured")

    def test_upstream_failures_become_problem_details(self) -> None:
        async def failing(settings: Settings, query: str, limit: int) -> list[dict[str, Any]]:
            raise TagSuggestUpstreamError("danbooru", 503)

        pool = _pool(lambda request: httpx.Response(500))
        with mock.patch.object(tags_module, "_danbooru_autocomplete", failing):
            with TestClient(self._app(self._runtime(pool, dictionary=False))) as client:  # type: ignore[misc]
                danbooru = self._get(client, {"source": "danbooru", "q": "long"})
                dictionary = self._get(client, {"source": "dictionary", "q": "long"})

        self.assertEqual(danbooru.status_code, 503)
        self.assertEqual(danbooru.json()["code"], "tag_suggest_upstream_failed")
        self.assertTrue(danbooru.json()["retryable"])
        self.assertEqual(danbooru.json()["context"], {"source": "danbooru", "upstream_status": 503})
        self.assertEqual(dictionary.status_code, 503)
        self.assertEqual(dictionary.json()["code"], "tag_dictionary_unavailable")

    def test_query_validation(self) -> None:
        pool = _pool(lambda request: httpx.Response(500))
        cases = [
            {"q": "1gi"},
            {"source": "elsewhere", "q": "1gi"},
            {"source": "dictionary"},
            {"source": "dictionary", "q": "1gi", "limit": 0},
            {"source": "dictionary", "q": "x" * 201},
            {"source": "official", "q": "1gi", "model": "Bad Model!"},
        ]
        with TestClient(self._app(self._runtime(pool))) as client:  # type: ignore[misc]
            for params in cases:
                with self.subTest(params=params):
                    response = self._get(client, params)
                    self.assertEqual(response.status_code, 422)
                    self.assertEqual(response.headers["content-type"], "application/problem+json")
            blank = self._get(client, {"source": "dictionary", "q": "   "})
        self.assertEqual(blank.status_code, 200)
        self.assertEqual(blank.json()["items"], [])


if __name__ == "__main__":
    unittest.main()
