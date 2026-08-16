"""SSH 隧道管理器：主机公钥钉扎、凭据失败封闭、生命周期与断线感知。"""

from __future__ import annotations

import asyncio
import unittest
from typing import Any

import asyncssh

from sidecar.comfy.tunnel import (
    SshTunnelConfig,
    SshTunnelError,
    SshTunnelManager,
    SshTunnelSecret,
)

_KEY = asyncssh.generate_private_key("ssh-ed25519")
_PRIVATE_PEM = _KEY.export_private_key().decode()
_HOST_KEY_LINE = _KEY.export_public_key().decode().strip()


class _FakeListener:
    def __init__(self, port: int) -> None:
        self._port = port
        self.closed = False

    def get_port(self) -> int:
        return self._port

    def close(self) -> None:
        self.closed = True


class _FakeConn:
    def __init__(self) -> None:
        self.closed = asyncio.Event()
        self.forwards: list[tuple[str, int, str, int]] = []
        self.listener: _FakeListener | None = None

    async def forward_local_port(self, host: str, port: int, rhost: str, rport: int):
        self.forwards.append((host, port, rhost, rport))
        self.listener = _FakeListener(port or 54321)
        return self.listener

    def close(self) -> None:
        self.closed.set()

    async def wait_closed(self) -> None:
        await self.closed.wait()


def _config(**overrides: Any) -> SshTunnelConfig:
    values: dict[str, Any] = {
        "host": "connect.autodl.example",
        "port": 23022,
        "username": "root",
        "host_public_key": _HOST_KEY_LINE,
    }
    values.update(overrides)
    return SshTunnelConfig(**values)


def _key_secret() -> SshTunnelSecret:
    return SshTunnelSecret(private_key=_PRIVATE_PEM)


class _Recorder:
    def __init__(self, conn: _FakeConn | Exception) -> None:
        self.conn = conn
        self.calls: list[tuple[str, int, dict[str, Any]]] = []

    async def __call__(self, host: str, port: int, **kwargs: Any):
        self.calls.append((host, port, dict(kwargs)))
        if isinstance(self.conn, Exception):
            raise self.conn
        return self.conn


class TunnelLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_start_pins_host_key_and_is_idempotent(self) -> None:
        conn = _FakeConn()
        recorder = _Recorder(conn)
        manager = SshTunnelManager(
            _config(), secret_loader=_key_secret, connector=recorder
        )

        port = await manager.start()
        self.assertEqual(port, 54321)
        self.assertTrue(manager.running)
        self.assertEqual(manager.local_url, "http://127.0.0.1:54321")
        self.assertEqual(conn.forwards, [("127.0.0.1", 0, "127.0.0.1", 8188)])

        host, ssh_port, kwargs = recorder.calls[0]
        self.assertEqual((host, ssh_port), ("connect.autodl.example", 23022))
        self.assertEqual(kwargs["username"], "root")
        self.assertEqual(len(kwargs["client_keys"]), 1)
        self.assertNotIn("password", kwargs)
        # 钉扎的 known_hosts 认自己的公钥，拒绝其他任何密钥。
        known_hosts = kwargs["known_hosts"]
        matched = known_hosts.match("connect.autodl.example", "", 23022)
        self.assertTrue(matched[0])
        other_key = asyncssh.generate_private_key("ssh-ed25519")
        self.assertNotIn(
            other_key.convert_to_public(),
            matched[0],
        )

        self.assertEqual(await manager.start(), port)
        self.assertEqual(len(recorder.calls), 1)

        await manager.stop()
        self.assertFalse(manager.running)
        self.assertEqual(manager.local_url, "")
        assert conn.listener is not None
        self.assertTrue(conn.listener.closed)
        self.assertTrue(conn.closed.is_set())

    async def test_password_auth_used_only_without_private_key(self) -> None:
        conn = _FakeConn()
        recorder = _Recorder(conn)
        manager = SshTunnelManager(
            _config(),
            secret_loader=lambda: SshTunnelSecret(password="pw"),  # noqa: S106
            connector=recorder,
        )
        await manager.start()
        _host, _port, kwargs = recorder.calls[0]
        self.assertEqual(kwargs["password"], "pw")
        self.assertNotIn("client_keys", kwargs)
        await manager.stop()

    async def test_remote_disconnect_flips_running(self) -> None:
        conn = _FakeConn()
        manager = SshTunnelManager(
            _config(), secret_loader=_key_secret, connector=_Recorder(conn)
        )
        await manager.start()
        self.assertTrue(manager.running)
        conn.closed.set()
        for _ in range(20):
            await asyncio.sleep(0.01)
            if not manager.running:
                break
        self.assertFalse(manager.running)
        self.assertEqual(manager.status()["endpoint"], "")


class TunnelFailClosedTests(unittest.IsolatedAsyncioTestCase):
    async def _expect_error(
        self, manager: SshTunnelManager, code: str, recorder: _Recorder | None = None
    ) -> SshTunnelError:
        with self.assertRaises(SshTunnelError) as caught:
            await manager.start()
        self.assertEqual(caught.exception.code, code)
        if recorder is not None:
            self.assertEqual(recorder.calls, [])
        return caught.exception

    async def test_missing_host_key_fails_before_any_connection(self) -> None:
        recorder = _Recorder(_FakeConn())
        manager = SshTunnelManager(
            _config(host_public_key=""), secret_loader=_key_secret, connector=recorder
        )
        await self._expect_error(manager, "tunnel_hostkey_required", recorder)

    async def test_malformed_host_key_rejected(self) -> None:
        recorder = _Recorder(_FakeConn())
        manager = SshTunnelManager(
            _config(host_public_key="not-a-key"),
            secret_loader=_key_secret,
            connector=recorder,
        )
        await self._expect_error(manager, "tunnel_hostkey_invalid", recorder)

    async def test_missing_or_failing_credentials_fail_closed(self) -> None:
        recorder = _Recorder(_FakeConn())
        empty = SshTunnelManager(
            _config(), secret_loader=SshTunnelSecret, connector=recorder
        )
        await self._expect_error(empty, "tunnel_credentials_unavailable", recorder)

        def boom() -> SshTunnelSecret:
            raise RuntimeError("keychain locked")

        failing = SshTunnelManager(_config(), secret_loader=boom, connector=recorder)
        error = await self._expect_error(
            failing, "tunnel_credentials_unavailable", recorder
        )
        self.assertNotIn("keychain", str(error))

    async def test_invalid_private_key_never_reaches_connector(self) -> None:
        recorder = _Recorder(_FakeConn())
        manager = SshTunnelManager(
            _config(),
            secret_loader=lambda: SshTunnelSecret(private_key="garbage"),
            connector=recorder,
        )
        error = await self._expect_error(manager, "tunnel_key_invalid", recorder)
        self.assertNotIn("garbage", str(error))

    async def test_hostkey_mismatch_and_auth_failures_map_to_codes(self) -> None:
        mismatch = SshTunnelManager(
            _config(),
            secret_loader=_key_secret,
            connector=_Recorder(asyncssh.HostKeyNotVerifiable("key mismatch")),
        )
        await self._expect_error(mismatch, "tunnel_hostkey_mismatch")

        denied = SshTunnelManager(
            _config(),
            secret_loader=_key_secret,
            connector=_Recorder(asyncssh.PermissionDenied("denied")),
        )
        await self._expect_error(denied, "tunnel_auth_failed")

        refused = SshTunnelManager(
            _config(),
            secret_loader=_key_secret,
            connector=_Recorder(ConnectionRefusedError("refused")),
        )
        error = await self._expect_error(refused, "tunnel_unreachable")
        self.assertIn("ConnectionRefusedError", str(error))

    async def test_forward_failure_closes_the_connection(self) -> None:
        class _NoForwardConn(_FakeConn):
            async def forward_local_port(self, host, port, rhost, rport):
                raise OSError("address in use")

        conn = _NoForwardConn()
        manager = SshTunnelManager(
            _config(), secret_loader=_key_secret, connector=_Recorder(conn)
        )
        await self._expect_error(manager, "tunnel_forward_failed")
        self.assertTrue(conn.closed.is_set())
        self.assertFalse(manager.running)

    async def test_config_port_bounds(self) -> None:
        for overrides in ({"port": 0}, {"port": 70000}, {"remote_port": 0}, {"host": " "}):
            with self.assertRaises(SshTunnelError):
                _config(**overrides).validate()

    async def test_garbage_key_material_rejected_despite_valid_prefix(self) -> None:
        # 算法前缀合法但 base64 是垃圾：import_known_hosts 会静默跳过坏行，
        # 必须在连接前显式失败，而不是留下空钉扎集。
        recorder = _Recorder(_FakeConn())
        manager = SshTunnelManager(
            _config(host_public_key="ssh-ed25519 !!!not-base64!!!"),
            secret_loader=_key_secret,
            connector=recorder,
        )
        await self._expect_error(manager, "tunnel_hostkey_invalid", recorder)

    async def test_connector_raised_tunnel_errors_pass_through(self) -> None:
        manager = SshTunnelManager(
            _config(),
            secret_loader=_key_secret,
            connector=_Recorder(SshTunnelError("代理拒绝", code="tunnel_proxy_refused")),
        )
        await self._expect_error(manager, "tunnel_proxy_refused")


class TunnelTeardownEdgeTests(unittest.IsolatedAsyncioTestCase):
    async def test_stop_survives_failing_listener_and_wait_closed(self) -> None:
        class _GrumpyListener(_FakeListener):
            def close(self) -> None:
                raise RuntimeError("already gone")

        class _GrumpyConn(_FakeConn):
            async def forward_local_port(self, host, port, rhost, rport):
                self.listener = _GrumpyListener(port or 54321)
                return self.listener

            async def wait_closed(self) -> None:
                if self.closed.is_set():
                    raise RuntimeError("transport torn down")
                await self.closed.wait()

        conn = _GrumpyConn()
        manager = SshTunnelManager(
            _config(), secret_loader=_key_secret, connector=_Recorder(conn)
        )
        await manager.start()
        await manager.stop()
        self.assertFalse(manager.running)
        self.assertTrue(conn.closed.is_set())

    async def test_watcher_survives_wait_closed_exception(self) -> None:
        class _ExplodingWaitConn(_FakeConn):
            async def wait_closed(self) -> None:
                raise RuntimeError("poll failed")

        manager = SshTunnelManager(
            _config(),
            secret_loader=_key_secret,
            connector=_Recorder(_ExplodingWaitConn()),
        )
        await manager.start()
        for _ in range(20):
            await asyncio.sleep(0.01)
            if not manager.running:
                break
        # 监视器把异常当作连接终结：状态如实翻转，绝不悬挂 running=True。
        self.assertFalse(manager.running)


if __name__ == "__main__":
    unittest.main()
