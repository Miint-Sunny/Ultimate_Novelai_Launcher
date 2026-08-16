from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from sidecar.security import (
    AuthenticationError,
    AuthManager,
    BodySizeLimitMiddleware,
    OutboundPolicy,
    OutboundPolicyError,
    PairingAttemptsExceededError,
    PairingExpiredError,
    PairingInvalidError,
    PairingManager,
    PairingReplayError,
    PairingUnavailableError,
    PayloadBudgetError,
    RequestBodyTooLargeError,
    SecurityError,
    UnsafePathError,
    decode_base64_payload,
    enforce_json_decoded_budget,
    enforce_text_budget,
    resolve_safe_path,
    strip_sensitive_headers_on_cross_origin,
)


class AuthenticationSecurityTests(unittest.TestCase):
    def test_bearer_is_canonical_and_legacy_header_is_compatible(self) -> None:
        manager = AuthManager("session-secret")
        self.assertEqual(
            manager.require({"Authorization": "Bearer session-secret"}),
            "session-secret",
        )
        self.assertTrue(manager.verify({"authorization": "bearer session-secret"}))
        self.assertTrue(manager.verify({"X-Sidecar-Auth": "session-secret"}))
        self.assertEqual(
            manager.require_bearer({"Authorization": "Bearer session-secret"}),
            "session-secret",
        )
        with self.assertRaises(AuthenticationError):
            manager.require_bearer({"X-Sidecar-Auth": "session-secret"})
        with self.assertRaises(AuthenticationError):
            manager.require_bearer(
                {
                    "Authorization": "Bearer session-secret",
                    "X-Sidecar-Auth": "session-secret",
                }
            )
        self.assertFalse(manager.verify({"Authorization": "Basic session-secret"}))
        self.assertFalse(manager.verify({"Authorization": "Bearer\nsession-secret"}))

    def test_ambiguous_or_duplicate_credentials_are_rejected(self) -> None:
        manager = AuthManager("session-secret")
        self.assertFalse(
            manager.verify(
                {
                    "Authorization": "Bearer session-secret",
                    "X-Sidecar-Auth": "different",
                }
            )
        )
        self.assertFalse(
            manager.verify(
                [
                    (b"authorization", b"Bearer session-secret"),
                    (b"authorization", b"Bearer session-secret"),
                ]
            )
        )


class PairingSecurityTests(unittest.TestCase):
    def test_default_auth_and_pairing_managers_share_the_process_token(self) -> None:
        pairing = PairingManager(code_factory=lambda: "314159")
        token = pairing.exchange(pairing.issue())
        self.assertTrue(AuthManager().verify({"Authorization": f"Bearer {token}"}))

    def test_pairing_is_single_use_and_shares_the_session_token(self) -> None:
        manager = PairingManager(session_token="process-token", code_factory=lambda: "123456")
        challenge = manager.issue()
        self.assertIsInstance(challenge, str)
        self.assertEqual(challenge.code, "123456")
        self.assertEqual(challenge.expires_in, 120.0)
        self.assertEqual(manager.exchange(challenge), "process-token")
        with self.assertRaises(PairingReplayError):
            manager.exchange(challenge)
        # A retired numeric code is never silently made valid again, even if a
        # faulty generator repeats it.
        with self.assertRaises(PairingUnavailableError) as raised:
            manager.issue()
        self.assertEqual(raised.exception.code, "pairing_code_reused")

    def test_five_bad_attempts_burn_the_code(self) -> None:
        manager = PairingManager(session_token="token", code_factory=lambda: "123456")
        manager.issue()
        for expected_remaining in (4, 3, 2, 1):
            with self.assertRaises(PairingInvalidError) as raised:
                manager.exchange("000000")
            self.assertEqual(raised.exception.details["attempts_remaining"], expected_remaining)
        with self.assertRaises(PairingAttemptsExceededError) as raised:
            manager.exchange("000000")
        self.assertEqual(raised.exception.details["attempts_remaining"], 0)
        with self.assertRaises(PairingAttemptsExceededError):
            manager.exchange("123456")

    def test_code_expires_after_120_seconds(self) -> None:
        now = [10.0]
        manager = PairingManager(
            session_token="token",
            clock=lambda: now[0],
            wall_clock=lambda: 1_000.0,
            code_factory=lambda: "123456",
        )
        challenge = manager.issue()
        self.assertEqual(challenge.expires_at, 1_120.0)
        now[0] = 130.0
        with self.assertRaises(PairingExpiredError):
            manager.exchange(challenge)


async def _run_asgi_request(
    middleware: BodySizeLimitMiddleware,
    *,
    path: str,
    chunks: list[bytes],
    headers: list[tuple[bytes, bytes]] | None = None,
) -> list[dict]:
    messages = [
        {
            "type": "http.request",
            "body": chunk,
            "more_body": index < len(chunks) - 1,
        }
        for index, chunk in enumerate(chunks)
    ]

    async def receive() -> dict:
        if messages:
            return messages.pop(0)
        return {"type": "http.disconnect"}

    sent: list[dict] = []

    async def send(message: dict) -> None:
        sent.append(message)

    await middleware(
        {
            "type": "http",
            "method": "POST",
            "path": path,
            "headers": headers or [],
        },
        receive,
        send,
    )
    return sent


class BodyLimitSecurityTests(unittest.TestCase):
    @staticmethod
    async def _reader_app(scope: dict, receive, send) -> None:
        total = 0
        while True:
            message = await receive()
            if message["type"] != "http.request":
                break
            total += len(message.get("body", b""))
            if not message.get("more_body", False):
                break
        payload = str(total).encode("ascii")
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": payload})

    def test_actual_stream_is_counted_even_when_content_length_lies(self) -> None:
        middleware = BodySizeLimitMiddleware(self._reader_app, default_limit=5)
        sent = asyncio.run(
            _run_asgi_request(
                middleware,
                path="/normal",
                chunks=[b"abc", b"def"],
                headers=[(b"content-length", b"1")],
            )
        )
        self.assertEqual(sent[0]["status"], 413)
        payload = json.loads(sent[1]["body"])
        self.assertEqual(payload["error"]["code"], "request_body_too_large")

    def test_longest_path_tier_overrides_the_global_fallback(self) -> None:
        middleware = BodySizeLimitMiddleware(
            self._reader_app,
            default_limit=4,
            path_limits={"/upload": 8, "/upload/tiny": 2},
        )
        accepted = asyncio.run(
            _run_asgi_request(middleware, path="/upload/image", chunks=[b"123", b"456"])
        )
        rejected = asyncio.run(_run_asgi_request(middleware, path="/upload/tiny", chunks=[b"123"]))
        self.assertEqual(accepted[0]["status"], 200)
        self.assertEqual(rejected[0]["status"], 413)


class _Resolver:
    def __init__(self, answers: dict[str, list[str]]) -> None:
        self.answers = answers
        self.calls: list[tuple[str, int]] = []

    def __call__(self, host: str, port: int) -> list[str]:
        self.calls.append((host, port))
        return self.answers[host]


class OutboundSecurityTests(unittest.TestCase):
    def test_public_policy_rejects_mixed_private_and_metadata_answers(self) -> None:
        resolver = _Resolver(
            {
                "public.example": ["93.184.216.34"],
                "mixed.example": ["93.184.216.34", "127.0.0.1"],
                "metadata-alias.example": ["169.254.169.254"],
            }
        )
        policy = OutboundPolicy("public", resolver=resolver)
        approved = policy.validate_url("https://public.example/api")
        self.assertEqual(approved, "https://public.example/api")
        with self.assertRaises(OutboundPolicyError):
            policy.validate_url("https://mixed.example")
        with self.assertRaises(OutboundPolicyError) as raised:
            policy.validate_url("https://metadata-alias.example")
        self.assertEqual(raised.exception.code, "outbound_metadata_forbidden")

        with self.assertRaises(OutboundPolicyError) as raised:
            policy.validate_url("http://public.example/api")
        self.assertEqual(raised.exception.code, "outbound_insecure_transport_forbidden")
        with self.assertRaises(OutboundPolicyError) as raised:
            policy.validate_url("http://0xa9fea9fe")
        self.assertEqual(raised.exception.code, "outbound_ambiguous_host_forbidden")

    def test_each_redirect_hop_is_resolved_again(self) -> None:
        resolver = _Resolver({"public.example": ["93.184.216.34"]})
        policy = OutboundPolicy("public", resolver=resolver)
        result = policy.validate_redirect(
            "https://public.example/start",
            "/destination",
        )
        self.assertEqual(result, "https://public.example/destination")
        self.assertEqual(len(resolver.calls), 2)

    def test_loopback_and_explicit_trusted_lan_are_separate_modes(self) -> None:
        loopback = OutboundPolicy("loopback", resolver=_Resolver({"local": ["127.0.0.1"]}))
        self.assertEqual(loopback.validate_url("http://local:8080"), "http://local:8080")
        lan = OutboundPolicy(
            "trusted-lan",
            trusted_networks=["192.168.10.0/24"],
            resolver=_Resolver({"nas": ["192.168.10.8"]}),
        )
        self.assertEqual(lan.validate_url("http://nas"), "http://nas")

    def test_userinfo_and_multicast_are_always_rejected(self) -> None:
        policy = OutboundPolicy("public", resolver=_Resolver({"example": ["224.0.0.1"]}))
        with self.assertRaises(OutboundPolicyError) as raised:
            policy.validate_url("https://user:secret@example")
        self.assertEqual(raised.exception.code, "outbound_userinfo_forbidden")
        with self.assertRaises(OutboundPolicyError) as raised:
            policy.validate_url("https://example")
        self.assertEqual(raised.exception.code, "outbound_multicast_forbidden")
        with self.assertRaises(OutboundPolicyError):
            policy.validate_url("https://example:0")

    def test_sensitive_headers_are_removed_only_across_origin(self) -> None:
        headers = {
            "Authorization": "Bearer secret",
            "X-Sidecar-Auth": "sidecar-secret",
            "Content-Type": "application/json",
        }
        same = strip_sensitive_headers_on_cross_origin(
            headers,
            "https://example.com/a",
            "https://example.com:443/b",
        )
        crossed = strip_sensitive_headers_on_cross_origin(
            headers,
            "https://example.com/a",
            "https://other.example/b",
        )
        self.assertIn("Authorization", same)
        self.assertNotIn("Authorization", crossed)
        self.assertNotIn("X-Sidecar-Auth", crossed)
        self.assertEqual(crossed["Content-Type"], "application/json")


class SafePathSecurityTests(unittest.TestCase):
    def test_traversal_and_absolute_escape_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "root"
            root.mkdir()
            with self.assertRaises(UnsafePathError):
                resolve_safe_path(root, "../outside", must_exist=False)
            with self.assertRaises(UnsafePathError):
                resolve_safe_path(root, Path(temp) / "outside", must_exist=False)

    def test_symlink_escape_is_rejected_and_contained_links_require_opt_in(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            root = base / "root"
            root.mkdir()
            outside = base / "outside.txt"
            outside.write_text("outside", encoding="utf-8")
            inside = root / "inside.txt"
            inside.write_text("inside", encoding="utf-8")
            try:
                (root / "outside-link").symlink_to(outside)
                (root / "inside-link").symlink_to(inside)
            except (OSError, NotImplementedError):
                self.skipTest("symbolic links are unavailable")
            with self.assertRaises(UnsafePathError):
                resolve_safe_path(root, "outside-link")
            with self.assertRaises(UnsafePathError):
                resolve_safe_path(root, "outside-link", allow_symlinks=True)
            with self.assertRaises(UnsafePathError):
                resolve_safe_path(root, "inside-link")
            self.assertEqual(
                resolve_safe_path(root, "inside-link", allow_symlinks=True),
                inside.resolve(),
            )

    def test_missing_write_target_resolves_inside_root(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            result = resolve_safe_path(root, "nested/new.json", must_exist=False)
            self.assertEqual(result, root.resolve() / "nested" / "new.json")


class StableErrorContractTests(unittest.TestCase):
    def test_security_errors_expose_framework_independent_metadata(self) -> None:
        error: SecurityError = RequestBodyTooLargeError("too large")
        self.assertEqual(error.code, "request_body_too_large")
        self.assertEqual(error.status, 413)
        self.assertFalse(error.retryable)


class DecodedPayloadBudgetTests(unittest.TestCase):
    def test_base64_is_validated_before_use_and_honors_decoded_limit(self) -> None:
        payload, mime = decode_base64_payload("data:image/png;base64,cGF5bG9hZA==")
        self.assertEqual(payload, b"payload")
        self.assertEqual(mime, "image/png")
        with self.assertRaises(PayloadBudgetError):
            decode_base64_payload("not base64!")
        with self.assertRaises(PayloadBudgetError):
            decode_base64_payload("cGF5bG9hZA==", maximum=6)

    def test_nested_generation_budget_counts_decoded_binary_and_text(self) -> None:
        self.assertEqual(
            enforce_json_decoded_budget(
                {"image": "cGF5bG9hZA==", "prompt": "猫"},
                maximum=64,
            ),
            7 + len("imageprompt猫".encode()),
        )
        with self.assertRaises(PayloadBudgetError):
            enforce_json_decoded_budget(
                {"reference_images": ["cGF5bG9hZA=="]},
                maximum_single_asset=6,
            )

    def test_image_format_metadata_is_text_not_base64(self) -> None:
        # The NovelAI wire payload always carries image_format='png'. The
        # binary-name heuristic must not decode it, or every legitimate
        # desktop generation request is rejected as invalid base64.
        self.assertEqual(
            enforce_json_decoded_budget(
                {"parameters": {"image_format": "png"}},
                maximum=64,
            ),
            len(b"parametersimage_formatpng"),
        )
        # Unknown binary-looking names keep failing closed.
        with self.assertRaises(PayloadBudgetError):
            enforce_json_decoded_budget({"image_custom": "png"}, maximum=64)

    def test_text_budget_counts_utf8_bytes(self) -> None:
        self.assertEqual(enforce_text_budget(("猫",), maximum=3), 3)
        with self.assertRaises(PayloadBudgetError):
            enforce_text_budget(("猫",), maximum=2)


if __name__ == "__main__":
    unittest.main()
