from __future__ import annotations

import asyncio
import tempfile
import time
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from sidecar import tags
from sidecar.config import Settings


class _FakeSession:
    def __init__(self, **options: object) -> None:
        self.options = options
        self.closed = False

    def close(self) -> None:
        self.closed = True


class _FakeResponse:
    status_code = 200

    @staticmethod
    def json() -> list[object]:
        return []


class _CapturingSession(_FakeSession):
    def __init__(self) -> None:
        super().__init__()
        self.requests: list[tuple[str, dict[str, object]]] = []

    def get(self, url: str, **kwargs: object) -> _FakeResponse:
        self.requests.append((url, kwargs))
        return _FakeResponse()


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
    )


def test_danbooru_session_tracks_live_proxy_settings_and_closes() -> None:
    with tempfile.TemporaryDirectory() as temp:
        settings = _settings(Path(temp))
        created: list[_FakeSession] = []

        def create_session(**options: object) -> _FakeSession:
            session = _FakeSession(**options)
            created.append(session)
            return session

        tags.close_tag_clients()
        with patch.object(tags._cffi_requests, "Session", side_effect=create_session):
            first = tags._get_danbooru_session(settings)
            assert tags._get_danbooru_session(settings) is first

            proxied = replace(settings, danbooru_proxy_url="http://127.0.0.1:7890")
            second = tags._get_danbooru_session(proxied)

            assert second is not first
            assert created[0].closed
            assert created[1].options["proxies"] == {
                "http": "http://127.0.0.1:7890",
                "https": "http://127.0.0.1:7890",
            }

            tags.close_tag_clients()
            assert created[1].closed


def test_tag_routes_reject_oversized_or_ambiguous_inputs() -> None:
    with tempfile.TemporaryDirectory() as temp:
        app = FastAPI()
        tags.register_tag_routes(app, _settings(Path(temp)))
        with TestClient(app) as client:
            assert (
                client.get(
                    "/api/tags/autocomplete",
                    params={"query": "x" * 257},
                ).status_code
                == 422
            )
            assert (
                client.get(
                    "/api/tags/autocomplete",
                    params={"query": "cat", "limit": 51},
                ).status_code
                == 422
            )
            assert (
                client.get(
                    "/api/tags/wiki",
                    params={"tags": "x" * 257},
                ).status_code
                == 422
            )
            assert (
                client.post(
                    "/api/tags/verify",
                    json={"tags": [f"tag_{index}" for index in range(21)]},
                ).status_code
                == 422
            )
            assert (
                client.post(
                    "/api/tags/verify",
                    json={"tags": ["cat"], "ignored": True},
                ).status_code
                == 422
            )
            assert (
                client.post(
                    "/api/tags/search",
                    json={"query": "   "},
                ).status_code
                == 422
            )
            assert (
                client.post(
                    "/api/tags/search",
                    json={"query": "cat", "top_k": 51},
                ).status_code
                == 422
            )
            assert (
                client.post(
                    "/api/tags/related",
                    json={"tags": [f"tag_{index}" for index in range(21)]},
                ).status_code
                == 422
            )


def test_autocomplete_keeps_query_data_out_of_the_upstream_url() -> None:
    with tempfile.TemporaryDirectory() as temp:
        app = FastAPI()
        tags.register_tag_routes(app, _settings(Path(temp)))
        session = _CapturingSession()
        stub_policy = tags.OutboundPolicy("public", resolver=lambda host, port: ["1.1.1.1"])

        with (
            patch.object(tags, "_get_danbooru_session", return_value=session),
            patch.object(tags, "_danbooru_outbound_policy", stub_policy),
        ):
            with TestClient(app) as client:
                response = client.get(
                    "/api/tags/autocomplete",
                    params={"query": "cat&limit=999", "limit": 10},
                )

        assert response.status_code == 200
        # The upstream call must carry the query only as encoded params and must
        # disable curl's implicit redirect follower (SSRF: redirects are validated
        # and followed manually via the shared outbound policy).
        assert session.requests == [
            (
                "https://danbooru.donmai.us/autocomplete.json",
                {
                    "params": {
                        "search[query]": "cat&limit=999",
                        "search[type]": "tag_query",
                        "limit": 10,
                    },
                    "timeout": 10,
                    "allow_redirects": False,
                },
            )
        ]


class _FakeRedirect:
    def __init__(self, location: str) -> None:
        self.status_code = 302
        self.headers = {"location": location}


class _RedirectingSession(_FakeSession):
    """curl-style session whose GET always returns a redirect to ``location``."""

    def __init__(self, location: str) -> None:
        super().__init__()
        self.location = location
        self.calls = 0

    def get(self, url: str, **kwargs: object) -> _FakeRedirect:
        self.calls += 1
        return _FakeRedirect(self.location)


def test_danbooru_get_rejects_redirect_to_metadata_host() -> None:
    # curl's implicit redirect follower is disabled; each Location is re-validated
    # against the shared outbound policy, so a 3xx pointing at cloud metadata is
    # rejected instead of followed.
    stub_policy = tags.OutboundPolicy("public", resolver=lambda host, port: ["1.1.1.1"])
    session = _RedirectingSession("https://169.254.169.254/latest/meta-data/")
    with patch.object(tags, "_danbooru_outbound_policy", stub_policy):
        with pytest.raises(tags.OutboundPolicyError):
            tags._danbooru_get(session, f"{tags.DANBOORU}/posts.json", timeout=5)
    assert session.calls == 1  # the redirect target was never fetched


def test_search_backend_post_without_pool_is_policy_pinned() -> None:
    # With no lifespan pool the fallback still routes through request_with_policy,
    # so a host that resolves to a private address is rejected before any socket is
    # opened — there is no unpinned raw-httpx path.
    stub_policy = tags.OutboundPolicy("public", resolver=lambda host, port: ["127.0.0.1"])
    with patch.object(tags, "_danbooru_outbound_policy", stub_policy):
        with pytest.raises(tags.OutboundPolicyError):
            asyncio.run(
                tags._search_backend_post(None, "/api/search", {"query": "x"}, timeout=5)
            )


def test_tag_caches_are_bounded_expired_and_copy_isolated() -> None:
    now = time.time()
    values: dict[str, object] = {
        "expired": {"nested": [1]},
        "old": {"nested": [2]},
        "new": {"nested": [3]},
        "orphan": {},
    }
    timestamps = {
        "expired": now - 20,
        "old": now - 2,
        "new": now - 1,
        "timestamp-only": now,
    }

    tags._prune_timed_cache(
        values,
        timestamps,
        max_entries=1,
        ttl=10,
        now=now,
    )

    assert values == {"new": {"nested": [3]}}
    assert timestamps == {"new": now - 1}

    cached = tags._timed_cache_get(values, timestamps, "new", ttl=10)
    assert cached == {"nested": [3]}
    assert cached is not None
    cached["nested"].append(4)
    assert tags._timed_cache_get(values, timestamps, "new", ttl=10) == {"nested": [3]}

    result_cache: dict = {}
    tags._result_cache_put(
        result_cache,
        ("cat",),
        [{"tag": "cat"}],
        max_entries=1,
        ttl=10,
        now=now,
    )
    result = tags._result_cache_get(result_cache, ("cat",), ttl=10)
    assert result == [{"tag": "cat"}]
    assert result is not None
    result[0]["tag"] = "mutated"
    assert tags._result_cache_get(result_cache, ("cat",), ttl=10) == [{"tag": "cat"}]
