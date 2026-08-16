"""SSH local port-forward: reach a cloud ComfyUI as a loopback endpoint.

AutoDL-style GPU rentals cannot expose public ports; they only offer SSH.
This manager forwards ``127.0.0.1:<local>`` to the instance's ComfyUI
(``127.0.0.1:8188`` remotely), after which the ordinary family-A client
talks to ``http://127.0.0.1:<local>`` under the unchanged loopback policy.

Security posture:

- The server host key is pinned: the operator supplies the instance's full
  public key line, and a connection to any other key fails closed. There is
  deliberately no "skip verification" escape hatch.
- Credentials (private key or password) come from an injected loader so the
  wiring layer can keep them in the OS credential store. Key material never
  appears in logs, error messages, or ``repr``.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

import asyncssh

logger = logging.getLogger(__name__)

_CONNECT_TIMEOUT_S = 20.0
_HOST_KEY_ALGO_PREFIXES = ("ssh-", "ecdsa-", "sk-")


class SshTunnelError(Exception):
    def __init__(self, message: str, code: str = "tunnel_failed") -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class SshTunnelSecret:
    """One of the two fields must be non-empty; both stay out of repr."""

    private_key: str = field(default="", repr=False)
    password: str = field(default="", repr=False)


SecretLoader = Callable[[], SshTunnelSecret | Awaitable[SshTunnelSecret]]


@dataclass(frozen=True)
class SshTunnelConfig:
    host: str
    port: int = 22
    username: str = "root"
    # 实例的 SSH 主机公钥整行（"ssh-ed25519 AAAA..."），从实例控制台或
    # 首次人工 ssh 的 known_hosts 里取。缺失即失败封闭。
    host_public_key: str = ""
    remote_host: str = "127.0.0.1"
    remote_port: int = 8188
    local_port: int = 0  # 0 = 内核自动分配

    def validate(self) -> None:
        if not self.host.strip():
            raise SshTunnelError("SSH 隧道未配置主机", code="tunnel_not_configured")
        for label, value, minimum in (
            ("port", self.port, 1),
            ("remote_port", self.remote_port, 1),
            ("local_port", self.local_port, 0),
        ):
            if not isinstance(value, int) or value < minimum or value > 65535:
                raise SshTunnelError(
                    f"SSH 隧道 {label} 非法", code="tunnel_not_configured"
                )
        key = self.host_public_key.strip()
        if not key:
            raise SshTunnelError(
                "SSH 隧道要求钉扎主机公钥（host_public_key）",
                code="tunnel_hostkey_required",
            )
        parts = key.split()
        if len(parts) < 2 or not parts[0].startswith(_HOST_KEY_ALGO_PREFIXES):
            raise SshTunnelError(
                "host_public_key 不是有效的公钥行", code="tunnel_hostkey_invalid"
            )


class SshTunnelManager:
    """Own one SSH connection plus one local forward listener."""

    def __init__(
        self,
        config: SshTunnelConfig,
        *,
        secret_loader: SecretLoader,
        connector: Callable[..., Awaitable[Any]] | None = None,
    ) -> None:
        self._config = config
        self._secret_loader = secret_loader
        self._connector = connector or asyncssh.connect
        self._conn: Any = None
        self._listener: Any = None
        self._local_port: int = 0
        self._watcher: asyncio.Task[None] | None = None
        self._lock = asyncio.Lock()

    @property
    def running(self) -> bool:
        return self._conn is not None and self._listener is not None

    @property
    def local_url(self) -> str:
        if not self.running:
            return ""
        return f"http://127.0.0.1:{self._local_port}"

    def status(self) -> dict[str, Any]:
        return {
            "running": self.running,
            "local_port": self._local_port if self.running else 0,
            "endpoint": self.local_url,
            "remote": (
                f"{self._config.remote_host}:{self._config.remote_port}"
                if self._config.host.strip()
                else ""
            ),
        }

    async def start(self) -> int:
        """Open the tunnel (idempotent) and return the local port."""

        async with self._lock:
            if self.running:
                return self._local_port
            self._config.validate()
            secret = await self._load_secret()
            connect_kwargs = self._build_connect_kwargs(secret)
            try:
                conn = await self._connector(
                    self._config.host,
                    self._config.port,
                    **connect_kwargs,
                )
            except SshTunnelError:
                raise
            except asyncssh.HostKeyNotVerifiable as exc:
                # 主机公钥与钉扎不符：可能是实例重建，也可能是中间人。
                raise SshTunnelError(
                    "SSH 主机公钥与钉扎值不符，拒绝连接",
                    code="tunnel_hostkey_mismatch",
                ) from exc
            except asyncssh.PermissionDenied as exc:
                raise SshTunnelError(
                    "SSH 认证被拒绝", code="tunnel_auth_failed"
                ) from exc
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                raise SshTunnelError(
                    f"SSH 连接失败: {type(exc).__name__}",
                    code="tunnel_unreachable",
                ) from exc

            try:
                listener = await conn.forward_local_port(
                    "127.0.0.1",
                    self._config.local_port,
                    self._config.remote_host,
                    self._config.remote_port,
                )
            except asyncio.CancelledError:
                conn.close()
                raise
            except Exception as exc:
                conn.close()
                raise SshTunnelError(
                    f"本地端口转发建立失败: {type(exc).__name__}",
                    code="tunnel_forward_failed",
                ) from exc

            self._conn = conn
            self._listener = listener
            self._local_port = int(listener.get_port())
            self._watcher = asyncio.create_task(
                self._watch_connection(conn), name="ssh-tunnel-watcher"
            )
            logger.info(
                "SSH 隧道已建立: 127.0.0.1:%s -> %s:%s (经 %s)",
                self._local_port,
                self._config.remote_host,
                self._config.remote_port,
                self._config.host,
            )
            return self._local_port

    async def stop(self) -> None:
        async with self._lock:
            watcher, self._watcher = self._watcher, None
            listener, self._listener = self._listener, None
            conn, self._conn = self._conn, None
            self._local_port = 0
        if watcher is not None:
            watcher.cancel()
        if listener is not None:
            try:
                listener.close()
            except Exception:  # noqa: BLE001 - already tearing down
                logger.debug("关闭隧道监听器失败", exc_info=True)
        if conn is not None:
            conn.close()
            try:
                await conn.wait_closed()
            except Exception:  # noqa: BLE001
                logger.debug("等待 SSH 连接关闭失败", exc_info=True)

    close = stop

    async def _load_secret(self) -> SshTunnelSecret:
        try:
            loaded = self._secret_loader()
            if asyncio.iscoroutine(loaded):
                loaded = await loaded
        except Exception as exc:
            # 凭据库取失败即失败封闭；不携带任何细节以免泄露。
            raise SshTunnelError(
                "SSH 凭据不可用", code="tunnel_credentials_unavailable"
            ) from exc
        if not isinstance(loaded, SshTunnelSecret) or not (
            loaded.private_key.strip() or loaded.password
        ):
            raise SshTunnelError(
                "SSH 凭据未配置", code="tunnel_credentials_unavailable"
            )
        return loaded

    def _build_connect_kwargs(self, secret: SshTunnelSecret) -> dict[str, Any]:
        kwargs: dict[str, Any] = {
            "username": self._config.username or "root",
            "known_hosts": self._pinned_known_hosts(),
            "connect_timeout": _CONNECT_TIMEOUT_S,
        }
        if secret.private_key.strip():
            try:
                kwargs["client_keys"] = [
                    asyncssh.import_private_key(secret.private_key)
                ]
            except Exception as exc:
                # 不把密钥内容或解析细节写进错误。
                raise SshTunnelError(
                    "SSH 私钥无法解析", code="tunnel_key_invalid"
                ) from exc
        else:
            kwargs["password"] = secret.password
        return kwargs

    def _pinned_known_hosts(self) -> Any:
        key = self._config.host_public_key.strip()
        host = self._config.host.strip()
        try:
            # import_known_hosts 会静默跳过坏行；先显式解析公钥，保证坏材料
            # 在连接前就失败，而不是留下一个空的钉扎集。
            asyncssh.import_public_key(key)
            lines = [
                f"[{host}]:{self._config.port} {key}",
                f"{host} {key}",
            ]
            return asyncssh.import_known_hosts("\n".join(lines) + "\n")
        except Exception as exc:
            raise SshTunnelError(
                "host_public_key 不是有效的公钥行", code="tunnel_hostkey_invalid"
            ) from exc

    async def _watch_connection(self, conn: Any) -> None:
        try:
            await conn.wait_closed()
        except asyncio.CancelledError:
            return
        except Exception:  # noqa: BLE001
            logger.debug("SSH 连接监视器异常退出", exc_info=True)
        async with self._lock:
            if self._conn is conn:
                # 连接从远端断开：清掉状态，让 running 立刻反映真相。
                self._conn = None
                self._listener = None
                self._local_port = 0
                self._watcher = None
                logger.warning("SSH 隧道连接已断开（%s）", self._config.host)


__all__ = [
    "SshTunnelConfig",
    "SshTunnelError",
    "SshTunnelManager",
    "SshTunnelSecret",
]
