from __future__ import annotations

import asyncio
import json
import os
import secrets
import socket
import stat
import sys
from dataclasses import replace
from pathlib import Path
from types import TracebackType
from typing import IO

import uvicorn

from . import APP_VERSION
from .config import Settings, load_settings
from .process_control import process_control

SERVICE_NAME = "ultimate-novelai-launcher-sidecar"
PROTOCOL_VERSION = 1


class InstanceAlreadyRunningError(RuntimeError):
    pass


class ReadinessServer(uvicorn.Server):
    """Uvicorn server that exposes startup completion as an asyncio event."""

    def __init__(self, config: uvicorn.Config) -> None:
        super().__init__(config)
        self.readiness = asyncio.Event()

    async def startup(self, sockets: list[socket.socket] | None = None) -> None:
        await super().startup(sockets=sockets)
        if self.started:
            self.readiness.set()


class DataDirectoryLock:
    """Cross-platform advisory lock held for the lifetime of a sidecar process."""

    def __init__(self, data_dir: Path, instance_id: str) -> None:
        self.data_dir = data_dir
        self.path = data_dir / ".sidecar.lock"
        self.instance_id = instance_id
        self._file: IO[bytes] | None = None

    def acquire(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        directory_identity = _require_plain_directory(self.data_dir)
        handle = _open_lock_file(self.path)
        try:
            _require_lock_identity(self.path, handle)
            if _require_plain_directory(self.data_dir) != directory_identity:
                raise RuntimeError("sidecar data directory changed while acquiring its lock")
            if os.name == "nt":
                self._acquire_windows(handle)
            else:
                self._acquire_posix(handle)
            handle.seek(0)
            handle.truncate()
            handle.write(self.instance_id.encode("ascii"))
            handle.flush()
            # os.fchmod does not exist on Windows; mirror secure_json's guard.
            fchmod = getattr(os, "fchmod", None)
            if fchmod is not None:
                try:
                    fchmod(handle.fileno(), 0o600)
                except OSError:
                    pass
            try:
                os.fsync(handle.fileno())
            except OSError:
                pass
            _require_lock_identity(self.path, handle)
            if _require_plain_directory(self.data_dir) != directory_identity:
                raise RuntimeError("sidecar data directory changed while acquiring its lock")
        except Exception:
            handle.close()
            raise
        self._file = handle

    @staticmethod
    def _acquire_posix(handle: IO[bytes]) -> None:
        import fcntl

        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise InstanceAlreadyRunningError(
                "another sidecar already owns this data directory"
            ) from exc

    @staticmethod
    def _acquire_windows(handle: IO[bytes]) -> None:
        import msvcrt

        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b"\0")
            handle.flush()
        handle.seek(0)
        try:
            msvcrt.locking(  # type: ignore[attr-defined]
                handle.fileno(),
                msvcrt.LK_NBLCK,  # type: ignore[attr-defined]
                1,
            )
        except OSError as exc:
            raise InstanceAlreadyRunningError(
                "another sidecar already owns this data directory"
            ) from exc

    def release(self) -> None:
        handle = self._file
        self._file = None
        if handle is None:
            return
        try:
            if os.name == "nt":
                import msvcrt

                handle.seek(0)
                msvcrt.locking(  # type: ignore[attr-defined]
                    handle.fileno(),
                    msvcrt.LK_UNLCK,  # type: ignore[attr-defined]
                    1,
                )
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        finally:
            handle.close()

    def __enter__(self) -> DataDirectoryLock:
        self.acquire()
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.release()


def _require_plain_directory(path: Path) -> tuple[int, int]:
    try:
        metadata = path.lstat()
    except OSError as exc:
        raise RuntimeError("sidecar data directory is not accessible") from exc
    if not stat.S_ISDIR(metadata.st_mode):
        raise RuntimeError("sidecar data directory must be a real directory, not a link")
    return metadata.st_dev, metadata.st_ino


def _open_lock_file(path: Path) -> IO[bytes]:
    flags = os.O_RDWR | os.O_CREAT
    flags |= getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    flags |= getattr(os, "O_BINARY", 0)
    try:
        descriptor = os.open(path, flags, 0o600)
    except OSError as exc:
        raise RuntimeError("sidecar lock file is not a safe regular file") from exc
    try:
        return os.fdopen(descriptor, "r+b", buffering=0)
    except BaseException:
        os.close(descriptor)
        raise


def _require_lock_identity(path: Path, handle: IO[bytes]) -> None:
    try:
        opened = os.fstat(handle.fileno())
        visible = path.lstat()
    except OSError as exc:
        raise RuntimeError("sidecar lock file changed while it was being opened") from exc
    if not stat.S_ISREG(opened.st_mode) or not stat.S_ISREG(visible.st_mode):
        raise RuntimeError("sidecar lock file must be a regular file, not a link")
    if opened.st_nlink != 1:
        raise RuntimeError("sidecar lock file must not have additional hard links")
    if (opened.st_dev, opened.st_ino) != (visible.st_dev, visible.st_ino):
        raise RuntimeError("sidecar lock file changed while it was being opened")
    if os.name != "nt" and opened.st_uid != os.getuid():
        raise RuntimeError("sidecar lock file must be owned by the current user")


def bind_sidecar_socket(settings: Settings) -> socket.socket:
    # Use literal loopback addresses so a modified hosts/DNS configuration cannot
    # turn the trusted local sidecar into a LAN listener.
    if settings.host not in {"127.0.0.1", "::1"}:
        raise RuntimeError("the desktop sidecar may only bind to loopback")
    family = socket.AF_INET6 if settings.host == "::1" else socket.AF_INET
    sock = socket.socket(family, socket.SOCK_STREAM)
    try:
        if os.name == "nt" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        else:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((settings.host, settings.port))
        sock.listen(socket.SOMAXCONN)
        sock.setblocking(False)
        sock.set_inheritable(False)
    except Exception:
        sock.close()
        raise
    return sock


def readiness_payload(*, instance_id: str, protocol: int, port: int) -> dict[str, object]:
    return {
        "event": "ready",
        "service": SERVICE_NAME,
        "version": APP_VERSION,
        "instance_id": instance_id,
        "protocol": protocol,
        "port": port,
    }


def settings_for_bound_socket(settings: Settings, sock: socket.socket) -> Settings:
    """Bind runtime-visible settings to the retained socket's actual port."""

    return replace(settings, port=int(sock.getsockname()[1]))


async def serve(settings: Settings | None = None) -> None:
    instance_id = (
        os.environ.get("ULTIMATE_NOVELAI_LAUNCHER_INSTANCE_ID", "").strip()
        or (settings.instance_id if settings is not None else "")
        or secrets.token_hex(16)
    )
    auth_token = (
        os.environ.get("ULTIMATE_NOVELAI_LAUNCHER_SIDECAR_AUTH", "").strip()
        or (settings.sidecar_auth_token if settings is not None else "")
        or secrets.token_urlsafe(32)
    )
    os.environ["ULTIMATE_NOVELAI_LAUNCHER_INSTANCE_ID"] = instance_id
    os.environ["ULTIMATE_NOVELAI_LAUNCHER_SIDECAR_AUTH"] = auth_token
    resolved = settings or load_settings()
    if resolved.instance_id != instance_id or resolved.sidecar_auth_token != auth_token:
        resolved = replace(
            resolved,
            instance_id=instance_id,
            sidecar_auth_token=auth_token,
        )
    protocol_raw = os.environ.get("ULTIMATE_NOVELAI_LAUNCHER_PROTOCOL", str(PROTOCOL_VERSION))
    try:
        protocol = int(protocol_raw)
    except ValueError as exc:
        raise RuntimeError("invalid sidecar protocol version") from exc
    if protocol != PROTOCOL_VERSION:
        raise RuntimeError(f"unsupported sidecar protocol {protocol}; expected {PROTOCOL_VERSION}")

    with DataDirectoryLock(resolved.data_dir, instance_id):
        sock = bind_sidecar_socket(resolved)
        # The retained socket is the authority for the process endpoint. Propagate
        # its actual port into AppRuntime so request-scoped Agent knowledge clients
        # never depend on the pre-bind ``port=0`` configuration.
        resolved = settings_for_bound_socket(resolved, sock)
        port = resolved.port
        from .server import create_app

        config = uvicorn.Config(
            create_app(resolved),
            host=resolved.host,
            port=port,
            log_level="info",
            access_log=False,
        )
        server = ReadinessServer(config)
        server_task = asyncio.create_task(server.serve(sockets=[sock]))
        readiness_task = asyncio.create_task(server.readiness.wait())
        shutdown_task: asyncio.Task[None] | None = None
        try:
            done, _ = await asyncio.wait(
                {server_task, readiness_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
            if server_task in done and not server.started:
                await server_task
                raise RuntimeError("sidecar exited before becoming ready")
            await readiness_task

            print(
                json.dumps(
                    readiness_payload(
                        instance_id=instance_id,
                        protocol=protocol,
                        port=port,
                    ),
                    separators=(",", ":"),
                ),
                flush=True,
            )
            shutdown_task = asyncio.create_task(process_control.wait_for_shutdown())
            done, _ = await asyncio.wait(
                {server_task, shutdown_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
            if shutdown_task in done:
                server.should_exit = True
            await server_task
        finally:
            readiness_task.cancel()
            if shutdown_task is not None:
                shutdown_task.cancel()
            server.should_exit = True
            sock.close()


def main() -> None:
    try:
        asyncio.run(serve())
    except InstanceAlreadyRunningError as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(73) from exc


if __name__ == "__main__":
    main()
