"""
NovelAI reCAPTCHA client for the boost path.

Primary path:
- Fetch a high-score ai_generation token from the remote CDP token API.

Fallback path:
- Use Capsolver ReCaptchaV3TaskProxyLess when the token API is disabled or
  unavailable, if fallback is enabled.
"""
from __future__ import annotations

import asyncio
from typing import Any

import httpx
from config import (
    CAPSOLVER_CLIENT_KEY,
    CAPSOLVER_HOST,
    NAI_RECAPTCHA_TOKEN_API_ACCOUNT_TIMEOUT,
    NAI_RECAPTCHA_TOKEN_API_FALLBACK_CAPSOLVER,
    NAI_RECAPTCHA_TOKEN_API_KEY,
    NAI_RECAPTCHA_TOKEN_API_TIMEOUT,
    NAI_RECAPTCHA_TOKEN_API_URL,
)

NAI_RECAPTCHA_SITEKEY = "6Lfk9nYqAAAAAP6cKauxBjMa7Z3bbiN2mvG4x59O"
NAI_WEBSITE_URL = "https://novelai.net/"

SOLVE_TIMEOUT = 90
POLL_INTERVAL = 1.5

_token_api_client: httpx.AsyncClient | None = None


class CaptchaError(RuntimeError):
    """Business error from token API or captcha provider."""


class CaptchaTimeout(TimeoutError):
    """No captcha token was produced within SOLVE_TIMEOUT."""


def _capsolver_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=30)


def _token_api_enabled() -> bool:
    return bool((NAI_RECAPTCHA_TOKEN_API_URL or "").strip())


async def _token_client() -> httpx.AsyncClient:
    global _token_api_client
    if _token_api_client is None or _token_api_client.is_closed:
        _token_api_client = httpx.AsyncClient(
            timeout=httpx.Timeout(NAI_RECAPTCHA_TOKEN_API_TIMEOUT, connect=5),
            limits=httpx.Limits(max_connections=10, max_keepalive_connections=5),
        )
    return _token_api_client


async def solve_recaptcha_v3(action: str, account: dict[str, Any] | None = None) -> str:
    """
    Solve NovelAI reCAPTCHA V3 and return a gRecaptchaResponse token.

    The action argument is kept for compatibility with callers; the remote token
    service is currently specialized for NovelAI's ai_generation action.
    """
    if _token_api_enabled():
        try:
            return await solve_recaptcha_v3_token_api(action, account=account)
        except httpx.TimeoutException as exc:
            raise CaptchaTimeout(f"token API timed out: {exc}") from exc
        except Exception as exc:
            if account:
                raise
            if not NAI_RECAPTCHA_TOKEN_API_FALLBACK_CAPSOLVER:
                raise
            print(f"[captcha] token API failed, falling back to Capsolver: {exc}")
    return await solve_recaptcha_v3_capsolver(action)


async def solve_recaptcha_v3_token_api(action: str, account: dict[str, Any] | None = None) -> str:
    if action != "ai_generation":
        print(f"[captcha] token API requested with non-standard action={action!r}")

    headers = {}
    if NAI_RECAPTCHA_TOKEN_API_KEY:
        headers["Authorization"] = f"Bearer {NAI_RECAPTCHA_TOKEN_API_KEY}"

    cli = await _token_client()
    payload = {"action": action}
    if account:
        payload.update(
            {
                "email": account.get("email") or "",
                "password": account.get("password") or "",
                "bearer": account.get("bearer") or "",
            }
        )
    timeout = (
        NAI_RECAPTCHA_TOKEN_API_ACCOUNT_TIMEOUT
        if account
        else NAI_RECAPTCHA_TOKEN_API_TIMEOUT
    )
    r = await cli.post(NAI_RECAPTCHA_TOKEN_API_URL, headers=headers, json=payload, timeout=timeout)
    r.raise_for_status()
    body = r.json()
    token = body.get("token")
    if not token:
        raise CaptchaError(f"token API returned no token: {body}")

    elapsed = body.get("elapsed_ms")
    if elapsed is not None:
        print(f"[captcha] token API ok: len={len(token)}, elapsed={elapsed}ms")
    else:
        print(f"[captcha] token API ok: len={len(token)}")
    return token


async def solve_recaptcha_v3_capsolver(action: str) -> str:
    if not CAPSOLVER_CLIENT_KEY:
        raise CaptchaError("CAPSOLVER_CLIENT_KEY is not configured")

    create_payload = {
        "clientKey": CAPSOLVER_CLIENT_KEY,
        "task": {
            "type": "ReCaptchaV3TaskProxyLess",
            "websiteURL": NAI_WEBSITE_URL,
            "websiteKey": NAI_RECAPTCHA_SITEKEY,
            "pageAction": action,
        },
    }

    async with _capsolver_client() as cli:
        r = await cli.post(f"{CAPSOLVER_HOST}/createTask", json=create_payload)
        r.raise_for_status()
        body = r.json()
        if body.get("errorId"):
            raise CaptchaError(f"createTask failed: {body}")
        task_id = body.get("taskId")
        if not task_id:
            raise CaptchaError(f"createTask returned no taskId: {body}")

        deadline = asyncio.get_event_loop().time() + SOLVE_TIMEOUT
        while asyncio.get_event_loop().time() < deadline:
            await asyncio.sleep(POLL_INTERVAL)
            rr = await cli.post(
                f"{CAPSOLVER_HOST}/getTaskResult",
                json={"clientKey": CAPSOLVER_CLIENT_KEY, "taskId": task_id},
            )
            rr.raise_for_status()
            body = rr.json()
            status = body.get("status")
            if status == "ready":
                sol = body.get("solution") or {}
                token = sol.get("gRecaptchaResponse")
                if not token:
                    raise CaptchaError(f"solution has no gRecaptchaResponse: {body}")
                return token
            if status == "failed" or body.get("errorId"):
                raise CaptchaError(f"task failed: {body}")

        raise CaptchaTimeout(f"Capsolver timed out after {SOLVE_TIMEOUT}s")


async def is_configured() -> bool:
    """Return whether any boost captcha source is configured."""
    return _token_api_enabled() or bool(CAPSOLVER_CLIENT_KEY)
