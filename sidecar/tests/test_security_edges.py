from __future__ import annotations

import asyncio
import ipaddress
import json
import tempfile
import unittest
from collections.abc import Mapping, Sequence
from pathlib import Path
from unittest.mock import patch

from sidecar.security.auth import (
    AuthenticationError,
    AuthenticationUnavailableError,
    AuthManager,
    constant_time_token_equal,
    parse_bearer_token,
)
from sidecar.security.body_limit import BodySizeLimitMiddleware
from sidecar.security.errors import (
    OutboundPolicyError,
    OutboundResolutionError,
    PairingUnavailableError,
    PathNotFoundSecurityError,
    RequestBodyTooLargeError,
    UnsafePathError,
)
from sidecar.security.outbound import (
    OutboundMode,
    OutboundPolicy,
    same_origin,
    strip_sensitive_headers_on_cross_origin,
)
from sidecar.security.pairing import PairingManager
from sidecar.security.paths import SafePathResolver, resolve_safe_path
from sidecar.security.payloads import (
    PayloadBudgetError,
    decode_base64_payload,
    enforce_json_decoded_budget,
)
from sidecar.security.tokens import (
    generate_session_token,
    get_process_session_token,
    rotate_process_session_token,
)


class AuthenticationEdgeTests(unittest.TestCase):
    def test_token_comparison_rejects_invalid_and_bounded_inputs(self) -> None:
        self.assertFalse(constant_time_token_equal("", "secret"))
        self.assertFalse(constant_time_token_equal("x" * 4097, "secret"))
        self.assertFalse(constant_time_token_equal(1, "secret"))  # type: ignore[arg-type]
        self.assertTrue(constant_time_token_equal("secret", "secret"))

    def test_bearer_parser_rejects_malformed_headers(self) -> None:
        invalid = (
            123,
            "Bearer " + "x" * 4097,
            "Bearer bad,token",
            "Digest abc",
            "Bearer abc\x7f",
        )
        for value in invalid:
            with self.subTest(value=str(value)[:30]), self.assertRaises(AuthenticationError):
                parse_bearer_token(value)  # type: ignore[arg-type]

    def test_header_sources_and_mutable_manager_contract(self) -> None:
        class MultiHeaders:
            def getlist(self, name: str) -> list[str]:
                if name.lower() == "authorization":
                    return ["Bearer first"]
                return []

        manager = AuthManager("first")
        self.assertTrue(manager.enabled)
        self.assertEqual(manager.session_token, "first")
        self.assertEqual(manager.require(MultiHeaders()), "first")
        self.assertEqual(manager.authorization_header(), {"Authorization": "Bearer first"})
        manager.set_session_token("second")
        self.assertEqual(manager.require(authorization="Bearer second"), "second")
        self.assertEqual(manager.require(x_sidecar_auth="second"), "second")
        with self.assertRaises(TypeError):
            manager.set_session_token(1)  # type: ignore[arg-type]

    def test_legacy_disabled_and_unconfigured_modes_fail_closed(self) -> None:
        legacy_disabled = AuthManager("secret", allow_legacy_header=False)
        self.assertFalse(legacy_disabled.verify({"X-Sidecar-Auth": "secret"}))
        self.assertFalse(
            legacy_disabled.verify(
                {
                    "Authorization": "Bearer secret",
                    "X-Sidecar-Auth": "secret",
                }
            )
        )
        self.assertFalse(legacy_disabled.verify({"Authorization": "Bearer wrong"}))

        optional = AuthManager("", required=False)
        self.assertFalse(optional.enabled)
        self.assertEqual(optional.require(), "")
        with self.assertRaises(AuthenticationUnavailableError):
            optional.authorization_header()
        with self.assertRaises(AuthenticationUnavailableError):
            AuthManager("", required=True).require()
        with self.assertRaises(TypeError):
            AuthManager(1)  # type: ignore[arg-type]

    def test_duplicate_mapping_values_and_invalid_legacy_tokens_are_rejected(self) -> None:
        manager = AuthManager("secret")
        self.assertFalse(manager.verify({"Authorization": ["Bearer secret", "Bearer secret"]}))
        self.assertFalse(manager.verify({"X-Sidecar-Auth": "has space"}))
        self.assertFalse(manager.verify({"X-Sidecar-Auth": ""}))
        self.assertFalse(manager.verify(42))
        self.assertTrue(manager.verify([(b"ignored",), (b"authorization", b"Bearer secret")]))


class BodyLimitEdgeTests(unittest.TestCase):
    @staticmethod
    async def _consume(scope: dict, receive, send) -> None:
        while True:
            message = await receive()
            if message.get("type") != "http.request" or not message.get("more_body", False):
                break
        await send({"type": "http.response.start", "status": 204, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    @staticmethod
    async def _invoke(
        middleware: BodySizeLimitMiddleware,
        *,
        scope: dict,
        messages: list[dict] | None = None,
    ) -> list[dict]:
        queue = list(messages or [{"type": "http.request", "body": b""}])

        async def receive() -> dict:
            return queue.pop(0) if queue else {"type": "http.disconnect"}

        sent: list[dict] = []

        async def send(message: dict) -> None:
            sent.append(message)

        await middleware(scope, receive, send)
        return sent

    def test_constructor_validates_limits_and_rules(self) -> None:
        for value in (-1, True, "1"):
            with self.assertRaises(ValueError):
                BodySizeLimitMiddleware(self._consume, default_limit=value)  # type: ignore[arg-type]
        with self.assertRaises(ValueError):
            BodySizeLimitMiddleware(self._consume, path_limits={"relative": 1})
        middleware = BodySizeLimitMiddleware(
            self._consume,
            default_limit=None,
            global_limit=9,
            hard_limit=5,
            path_limits={"/*": None, "/large*": 8},
        )
        self.assertEqual(middleware.limit_for("/"), 5)
        self.assertEqual(middleware.limit_for("/large/value"), 5)

    def test_non_http_and_unlimited_requests_pass_through(self) -> None:
        unlimited = BodySizeLimitMiddleware(self._consume, default_limit=None)
        result = asyncio.run(
            self._invoke(unlimited, scope={"type": "http", "path": "/", "headers": []})
        )
        self.assertEqual(result[0]["status"], 204)
        non_http = BodySizeLimitMiddleware(self._consume, default_limit=0)
        result = asyncio.run(
            self._invoke(non_http, scope={"type": "websocket", "path": "/", "headers": []})
        )
        self.assertEqual(result[0]["status"], 204)

    def test_header_validation_and_v1_problem_details(self) -> None:
        middleware = BodySizeLimitMiddleware(self._consume, default_limit=2)
        malformed_headers = (
            [(b"content-length", b"x")],
            [(b"content-length", b"1"), (b"Content-Length", b"1")],
            [(b"content-length", "猫")],
            [(b"content-length", object())],
            [(b"invalid",)],
        )
        for headers in malformed_headers:
            scope = {
                "type": "http",
                "path": "/api/v1/jobs",
                "headers": headers,
                "state": {"request_id": "req-1"},
            }
            sent = asyncio.run(self._invoke(middleware, scope=scope))
            self.assertEqual(sent[0]["status"], 400)
            self.assertEqual(dict(sent[0]["headers"])[b"content-type"], b"application/problem+json")
            self.assertEqual(json.loads(sent[1]["body"])["request_id"], "req-1")

        too_large = asyncio.run(
            self._invoke(
                middleware,
                scope={
                    "type": "http",
                    "path": "/api/v1/jobs",
                    "headers": [(bytearray(b"content-length"), bytearray(b"3"))],
                },
            )
        )
        self.assertEqual(too_large[0]["status"], 413)

    def test_non_byte_body_is_rejected_and_started_response_reraises(self) -> None:
        middleware = BodySizeLimitMiddleware(self._consume, default_limit=2)
        sent = asyncio.run(
            self._invoke(
                middleware,
                scope={"type": "http", "path": "/legacy", "headers": []},
                messages=[{"type": "http.request", "body": "not-bytes"}],
            )
        )
        self.assertEqual(sent[0]["status"], 400)
        self.assertEqual(dict(sent[0]["headers"])[b"content-type"], b"application/json")

        async def starts_then_reads(scope, receive, send) -> None:
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await receive()

        started = BodySizeLimitMiddleware(starts_then_reads, default_limit=0)
        with self.assertRaises(RequestBodyTooLargeError):
            asyncio.run(
                self._invoke(
                    started,
                    scope={"type": "http", "path": "/", "headers": []},
                    messages=[{"type": "http.request", "body": b"x"}],
                )
            )


class PairingAndPathEdgeTests(unittest.TestCase):
    def test_pairing_configuration_and_factory_are_validated(self) -> None:
        with self.assertRaises(ValueError):
            PairingManager(ttl_seconds=0)
        with self.assertRaises(ValueError):
            PairingManager(ttl_seconds=float("inf"))
        with self.assertRaises(ValueError):
            PairingManager(max_attempts=0)
        with self.assertRaises(ValueError):
            PairingManager(code_digits=5)
        with self.assertRaises(ValueError):
            PairingManager(session_token="")
        manager = PairingManager(session_token="token", code_factory=lambda: "bad")
        with self.assertRaises(ValueError):
            manager.issue()

    def test_pairing_helpers_track_activity_and_invalidate(self) -> None:
        manager = PairingManager(session_token="token", code_factory=lambda: "654321")
        challenge = manager.issue()
        self.assertEqual(challenge.to_dict()["code"], "654321")
        self.assertEqual(manager.session_token, "token")
        self.assertTrue(manager.active)
        self.assertEqual(manager.attempts_remaining, 5)
        self.assertIsNone(manager.try_exchange("bad"))
        self.assertEqual(manager.attempts_remaining, 4)
        manager.invalidate()
        self.assertFalse(manager.active)
        self.assertEqual(manager.attempts_remaining, 0)
        with self.assertRaises(PairingUnavailableError):
            manager.exchange(challenge)

    def test_default_code_generation_produces_fixed_width_digits(self) -> None:
        manager = PairingManager(session_token="token")
        with patch("sidecar.security.pairing.secrets.randbelow", return_value=42):
            challenge = manager.issue()
        self.assertEqual(challenge.code, "000042")

    def test_safe_path_error_matrix_and_configured_resolver(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "root"
            root.mkdir()
            file_root = Path(temp) / "file"
            file_root.write_text("x", encoding="utf-8")
            with self.assertRaises(TypeError):
                resolve_safe_path(b"root", "value")  # type: ignore[arg-type]
            with self.assertRaises(UnsafePathError):
                resolve_safe_path(root, "bad\0name")
            with self.assertRaises(PathNotFoundSecurityError):
                resolve_safe_path(Path(temp) / "missing", "value")
            with self.assertRaises(UnsafePathError):
                resolve_safe_path(file_root, "value")
            with self.assertRaises(UnsafePathError):
                resolve_safe_path(root, root, allow_absolute=False)
            with self.assertRaises(UnsafePathError):
                resolve_safe_path(root, ".", allow_root=False)
            with self.assertRaises(PathNotFoundSecurityError):
                resolve_safe_path(root, "missing")
            resolver = SafePathResolver(root, allow_absolute=False)
            created = resolver.resolve("nested/new", must_exist=False)
            self.assertEqual(created, root.resolve() / "nested/new")


class PayloadAndTokenEdgeTests(unittest.TestCase):
    def test_payload_budget_handles_all_json_shapes(self) -> None:
        self.assertEqual(enforce_json_decoded_budget([None, True, 1, 1.0]), 0)
        self.assertEqual(enforce_json_decoded_budget(["a", "猫"]), 4)
        with self.assertRaises(PayloadBudgetError):
            enforce_json_decoded_budget({"value": object()})
        with self.assertRaises(PayloadBudgetError):
            enforce_json_decoded_budget({"prompt": "abcd"}, maximum=3)
        with self.assertRaises(PayloadBudgetError):
            decode_base64_payload("   ")
        with self.assertRaises(PayloadBudgetError):
            decode_base64_payload("eHh4eA==", maximum=1)

    def test_process_tokens_are_nonempty_and_rotate(self) -> None:
        generated = generate_session_token()
        self.assertGreater(len(generated), 20)
        old = get_process_session_token()
        new = rotate_process_session_token()
        self.assertNotEqual(new, old)
        self.assertEqual(get_process_session_token(), new)


class OutboundEdgeTests(unittest.TestCase):
    @staticmethod
    def _resolver(answers: Mapping[str, Sequence[object]]):
        def resolve(host: str, port: int) -> list[object]:
            del port
            return list(answers[host])

        return resolve

    def test_mode_and_trusted_network_validation(self) -> None:
        with self.assertRaises(ValueError):
            OutboundPolicy("invalid")
        with self.assertRaises(ValueError):
            OutboundPolicy("trusted-lan", trusted_networks=["not-a-network"])
        with self.assertRaises(ValueError):
            OutboundPolicy("trusted-lan", trusted_networks=["8.8.8.0/24"])
        policy = OutboundPolicy(
            OutboundMode.TRUSTED_LAN,
            trusted_networks=[ipaddress.ip_network("fc00::/64")],
        )
        self.assertEqual(policy.mode, OutboundMode.TRUSTED_LAN)

    def test_parser_rejects_malformed_and_dangerous_urls(self) -> None:
        policy = OutboundPolicy("public", resolver=self._resolver({}))
        values = (
            "",
            "ftp://example.com",
            "https://user@example.com",
            "https://",
            "https://example.com:",
            "https://[fe80::1%25eth0]",
            "https://metadata.google.internal",
            "https://a.metadata.google.internal",
            "https://example.com\\evil",
            "https://example.com/\x01",
            "https://example.com:99999",
        )
        for value in values:
            with self.subTest(value=value), self.assertRaises(OutboundPolicyError):
                policy.validate_url(value)

    def test_resolver_result_forms_literals_and_failures(self) -> None:
        policy = OutboundPolicy(
            "public",
            resolver=self._resolver(
                {
                    "tuple.example": [
                        (2, 1, 6, "", ("93.184.216.34", 443)),
                        ("2001:4860:4860::8888", 443),
                    ],
                    "bad.example": [object()],
                    "empty.example": [],
                }
            ),
        )
        approved = policy.validate_url("https://tuple.example")
        self.assertEqual(len(approved.addresses), 2)
        self.assertEqual(policy.validate_url("https://93.184.216.34").port, 443)
        self.assertEqual(
            policy.validate_url("https://[::ffff:5db8:d822]").addresses,
            (ipaddress.ip_address("93.184.216.34"),),
        )
        with self.assertRaises(OutboundResolutionError):
            policy.validate_url("https://bad.example")
        with self.assertRaises(OutboundResolutionError):
            policy.validate_url("https://empty.example")

    def test_always_forbidden_addresses_and_mode_mismatch(self) -> None:
        answers = {
            "link": ["169.254.1.2"],
            "unspecified": ["0.0.0.0"],  # noqa: S104 - deliberate SSRF rejection fixture
            "private": ["10.0.0.1"],
        }
        policy = OutboundPolicy("public", resolver=self._resolver(answers))
        for host in answers:
            with self.subTest(host=host), self.assertRaises(OutboundPolicyError):
                policy.validate_url(f"http://{host}")
        with self.assertRaises(OutboundPolicyError):
            OutboundPolicy("trusted-lan").validate_url("http://10.0.0.1")
        with self.assertRaises(OutboundPolicyError):
            OutboundPolicy("loopback").validate_url("http://10.0.0.1")

    def test_redirect_chain_and_header_iterables(self) -> None:
        policy = OutboundPolicy(
            "public",
            resolver=self._resolver(
                {
                    "one.example": ["93.184.216.34"],
                    "two.example": ["8.8.8.8"],
                }
            ),
        )
        self.assertEqual(policy.validate_redirect_chain([]), ())
        chain = policy.validate_redirect_chain(
            ["https://one.example/a", "/b", "https://two.example/c"]
        )
        self.assertEqual([str(item) for item in chain], [
            "https://one.example/a",
            "https://one.example/b",
            "https://two.example/c",
        ])

        headers = [("Authorization", "secret"), ("Accept", "json"), (b"Cookie", "x")]
        same = strip_sensitive_headers_on_cross_origin(
            headers,
            "https://one.example/a",
            "https://one.example:443/b",
        )
        crossed = strip_sensitive_headers_on_cross_origin(
            headers,
            "https://one.example/a",
            "https://two.example/b",
            sensitive_headers=["accept"],
        )
        self.assertEqual(same, headers)
        self.assertEqual(crossed, [])

    def test_origin_validation_fails_closed(self) -> None:
        self.assertTrue(same_origin("https://example.com", "https://example.com:443/path"))
        invalid = (
            "not-a-url",
            "ftp://example.com",
            "https://user@example.com",
            "https://example.com:",
            "https://example.com\\evil",
            "https://example.com/\x01",
            "https://example.com:99999",
        )
        for value in invalid:
            self.assertFalse(same_origin(value, "https://example.com"))


if __name__ == "__main__":
    unittest.main()
