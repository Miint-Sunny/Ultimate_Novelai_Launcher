"""HTTP protocol client for ComfyUI's ``/prompt`` .. ``/view`` API surface.

The client never talks to the network directly: every hop goes through the
injected ``HttpClientPool`` so the shared SSRF policy validates each URL and
every DNS answer. Cancellation of the waiting coroutine is translated into a
best-effort queue delete plus ``POST /interrupt`` so the GPU stops burning.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Awaitable, Callable
from typing import Any
from urllib.parse import urlencode

import httpx

from sidecar.infrastructure import HttpClientPool
from sidecar.security import OutboundPolicy

ProgressCallback = Callable[[float], Awaitable[None]]

_CONTROL_TIMEOUT = httpx.Timeout(10.0, connect=5.0, read=30.0)
_VIEW_TIMEOUT = httpx.Timeout(20.0, connect=5.0, read=180.0)
# How long the run may sit in queue + execute before we give up. Local video
# workflows are slow, so this is deliberately generous.
DEFAULT_GENERATION_TIMEOUT_S = 1800.0
# Bounded window for the interrupt/dequeue cleanup after cancellation.
_CANCEL_CLEANUP_TIMEOUT_S = 8.0


class ComfyUIError(Exception):
    def __init__(self, message: str, code: str = "comfy_failed") -> None:
        super().__init__(message)
        self.code = code


class ComfyUIClient:
    """One ComfyUI origin plus the outbound policy that is allowed to reach it."""

    def __init__(
        self,
        *,
        base_url: str,
        policy: OutboundPolicy,
        http: HttpClientPool,
    ) -> None:
        self._base_url = base_url.strip().rstrip("/")
        self._policy = policy
        self._http = http
        self._client_id = uuid.uuid4().hex

    def _url(self, path: str, query: dict[str, str] | None = None) -> str:
        url = f"{self._base_url}/{path.lstrip('/')}"
        if query:
            url = f"{url}?{urlencode(query)}"
        return url

    async def _request(
        self,
        method: str,
        path: str,
        *,
        query: dict[str, str] | None = None,
        json: Any = None,
        timeout: httpx.Timeout = _CONTROL_TIMEOUT,
    ) -> httpx.Response:
        try:
            return await self._http.request(
                self._policy,
                method,
                self._url(path, query),
                json=json,
                timeout=timeout,
                max_redirects=0,
            )
        except ComfyUIError:
            raise
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # Policy rejections and transport failures alike; the message stays
            # local (loopback/LAN) and short, never an upstream response body.
            raise ComfyUIError(
                f"ComfyUI endpoint is unreachable: {type(exc).__name__}",
                code="comfy_unreachable",
            ) from exc

    async def submit(self, workflow: dict[str, Any]) -> str:
        response = await self._request(
            "POST",
            "/prompt",
            json={"prompt": workflow, "client_id": self._client_id},
        )
        if response.status_code != 200:
            detail = _workflow_rejection_detail(response)
            raise ComfyUIError(
                f"ComfyUI rejected the workflow (HTTP {response.status_code}){detail}",
                code="comfy_rejected",
            )
        try:
            body = response.json()
        except Exception as exc:
            raise ComfyUIError(
                "ComfyUI returned invalid JSON for /prompt",
                code="comfy_protocol",
            ) from exc
        prompt_id = body.get("prompt_id") if isinstance(body, dict) else None
        if not isinstance(prompt_id, str) or not prompt_id:
            raise ComfyUIError(
                "ComfyUI did not return a prompt id",
                code="comfy_protocol",
            )
        return prompt_id

    async def history_entry(self, prompt_id: str) -> dict[str, Any] | None:
        """The finished-execution record, or ``None`` while still queued/running."""

        response = await self._request("GET", f"/history/{prompt_id}")
        if response.status_code != 200:
            raise ComfyUIError(
                f"ComfyUI /history returned HTTP {response.status_code}",
                code="comfy_protocol",
            )
        try:
            body = response.json()
        except Exception as exc:
            raise ComfyUIError(
                "ComfyUI returned invalid JSON for /history",
                code="comfy_protocol",
            ) from exc
        entry = body.get(prompt_id) if isinstance(body, dict) else None
        return entry if isinstance(entry, dict) else None

    async def queue_state(self, prompt_id: str) -> str:
        """``running`` | ``pending`` | ``absent`` for the submitted prompt."""

        response = await self._request("GET", "/queue")
        if response.status_code != 200:
            raise ComfyUIError(
                f"ComfyUI /queue returned HTTP {response.status_code}",
                code="comfy_protocol",
            )
        try:
            body = response.json()
        except Exception as exc:
            raise ComfyUIError(
                "ComfyUI returned invalid JSON for /queue",
                code="comfy_protocol",
            ) from exc
        if not isinstance(body, dict):
            return "absent"
        if _queue_contains(body.get("queue_running"), prompt_id):
            return "running"
        if _queue_contains(body.get("queue_pending"), prompt_id):
            return "pending"
        return "absent"

    async def fetch_image(self, image_ref: dict[str, Any]) -> bytes:
        query = {
            "filename": str(image_ref.get("filename") or ""),
            "subfolder": str(image_ref.get("subfolder") or ""),
            "type": str(image_ref.get("type") or "output"),
        }
        if not query["filename"]:
            raise ComfyUIError(
                "ComfyUI output image has no filename",
                code="comfy_no_output",
            )
        response = await self._request("GET", "/view", query=query, timeout=_VIEW_TIMEOUT)
        if response.status_code != 200 or not response.content:
            raise ComfyUIError(
                f"ComfyUI /view returned HTTP {response.status_code}",
                code="comfy_no_output",
            )
        return response.content

    async def delete_queued(self, prompt_id: str) -> None:
        await self._request("POST", "/queue", json={"delete": [prompt_id]})

    async def interrupt(self) -> None:
        await self._request("POST", "/interrupt", json={})

    async def generate(
        self,
        workflow: dict[str, Any],
        *,
        on_progress: ProgressCallback | None = None,
        poll_interval: float = 1.0,
        timeout_s: float = DEFAULT_GENERATION_TIMEOUT_S,
    ) -> bytes:
        """Submit one workflow and wait for its first output image.

        Cancelling this coroutine dequeues/interrupts the remote run inside a
        bounded cleanup window before the cancellation is re-raised.
        """

        prompt_id = await self.submit(workflow)
        try:
            entry = await self._wait_for_history(
                prompt_id,
                on_progress=on_progress,
                poll_interval=poll_interval,
                timeout_s=timeout_s,
            )
        except asyncio.CancelledError:
            await asyncio.shield(self._cleanup_after_cancel(prompt_id))
            raise
        return await self.fetch_image(_first_output_image(entry))

    async def _wait_for_history(
        self,
        prompt_id: str,
        *,
        on_progress: ProgressCallback | None,
        poll_interval: float,
        timeout_s: float,
    ) -> dict[str, Any]:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout_s
        progress = 0.05
        if on_progress is not None:
            await on_progress(progress)
        while True:
            entry = await self.history_entry(prompt_id)
            if entry is not None:
                _raise_on_failed_status(entry)
                return entry
            if loop.time() >= deadline:
                raise ComfyUIError(
                    f"ComfyUI run did not finish within {int(timeout_s)}s",
                    code="comfy_timeout",
                )
            state = await self.queue_state(prompt_id)
            if state == "absent":
                # Not in history and not in queue: the server dropped it
                # (restart, external queue clear). Fail instead of spinning.
                raise ComfyUIError(
                    "ComfyUI lost the submitted run",
                    code="comfy_failed",
                )
            # Coarse monotonic progress: queued runs hold near the floor while
            # executing runs creep toward 0.9 without ever reaching it.
            target = 0.1 if state == "pending" else progress + (0.9 - progress) * 0.1
            if target > progress + 0.005 and on_progress is not None:
                await on_progress(min(target, 0.9))
            progress = max(progress, min(target, 0.9))
            await asyncio.sleep(poll_interval)

    async def _cleanup_after_cancel(self, prompt_id: str) -> None:
        async def attempt() -> None:
            try:
                await self.delete_queued(prompt_id)
            except ComfyUIError:
                pass
            try:
                await self.interrupt()
            except ComfyUIError:
                pass

        try:
            await asyncio.wait_for(attempt(), timeout=_CANCEL_CLEANUP_TIMEOUT_S)
        except (TimeoutError, asyncio.CancelledError):
            # The worker's drain window owns the final deadline; an unreachable
            # endpoint must not stall acknowledgement of the cancellation.
            pass


def _queue_contains(rows: Any, prompt_id: str) -> bool:
    if not isinstance(rows, list):
        return False
    for row in rows:
        # Queue rows are [number, prompt_id, prompt, ...] tuples.
        if isinstance(row, list) and len(row) >= 2 and row[1] == prompt_id:
            return True
    return False


def _workflow_rejection_detail(response: httpx.Response) -> str:
    try:
        body = response.json()
    except Exception:
        return ""
    if not isinstance(body, dict):
        return ""
    error = body.get("error")
    if isinstance(error, dict):
        message = error.get("message")
        if isinstance(message, str) and message:
            return f": {message[:200]}"
    node_errors = body.get("node_errors")
    if isinstance(node_errors, dict) and node_errors:
        return f": invalid nodes {', '.join(sorted(node_errors)[:5])}"
    return ""


def _raise_on_failed_status(entry: dict[str, Any]) -> None:
    status = entry.get("status")
    if not isinstance(status, dict):
        return
    if status.get("completed") is True:
        return
    status_str = status.get("status_str")
    if status_str == "error":
        raise ComfyUIError(
            f"ComfyUI execution failed{_execution_error_detail(status)}",
            code="comfy_failed",
        )


def _execution_error_detail(status: dict[str, Any]) -> str:
    messages = status.get("messages")
    if not isinstance(messages, list):
        return ""
    for item in messages:
        if not (isinstance(item, list) and len(item) >= 2 and item[0] == "execution_error"):
            continue
        data = item[1]
        if isinstance(data, dict):
            detail = data.get("exception_message") or data.get("node_type")
            if isinstance(detail, str) and detail:
                return f": {detail[:200]}"
    return ""


def _first_output_image(entry: dict[str, Any]) -> dict[str, Any]:
    outputs = entry.get("outputs")
    if isinstance(outputs, dict):
        fallback: dict[str, Any] | None = None
        for node_output in outputs.values():
            if not isinstance(node_output, dict):
                continue
            images = node_output.get("images")
            if not isinstance(images, list):
                continue
            for image in images:
                if not isinstance(image, dict) or not image.get("filename"):
                    continue
                if image.get("type") == "output":
                    return image
                fallback = fallback or image
        if fallback is not None:
            return fallback
    raise ComfyUIError(
        "ComfyUI run finished without an output image",
        code="comfy_no_output",
    )


__all__ = [
    "ComfyUIClient",
    "ComfyUIError",
    "DEFAULT_GENERATION_TIMEOUT_S",
    "ProgressCallback",
]
