from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from sidecar.bootstrap import (
    DataDirectoryLock,
    InstanceAlreadyRunningError,
    bind_sidecar_socket,
    readiness_payload,
)
from sidecar.config import Settings


def make_settings(data_dir: Path, *, host: str = "127.0.0.1", port: int = 0) -> Settings:
    return Settings(
        host=host,
        port=port,
        data_dir=data_dir,
        nai_token="",
        nai_base_url="https://image.novelai.net",
        llm_base_url="",
        llm_api_key="",
        llm_model="",
        mock_generation=True,
    )


class BootstrapTests(unittest.TestCase):
    def test_data_directory_lock_is_exclusive(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            first = DataDirectoryLock(Path(directory), "first")
            second = DataDirectoryLock(Path(directory), "second")
            first.acquire()
            try:
                with self.assertRaises(InstanceAlreadyRunningError):
                    second.acquire()
            finally:
                first.release()
            second.acquire()
            second.release()

    def test_data_directory_lock_rejects_symlink_without_mutating_target(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_dir = root / "data"
            data_dir.mkdir()
            outside = root / "outside.txt"
            outside.write_text("do not overwrite", encoding="utf-8")
            (data_dir / ".sidecar.lock").symlink_to(outside)

            with self.assertRaisesRegex(RuntimeError, "safe regular file"):
                DataDirectoryLock(data_dir, "instance").acquire()

            self.assertEqual(outside.read_text(encoding="utf-8"), "do not overwrite")

    def test_data_directory_lock_rejects_symlink_data_directory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            outside = root / "outside"
            outside.mkdir()
            linked = root / "linked"
            linked.symlink_to(outside, target_is_directory=True)

            with self.assertRaisesRegex(RuntimeError, "real directory"):
                DataDirectoryLock(linked, "instance").acquire()

            self.assertFalse((outside / ".sidecar.lock").exists())

    def test_data_directory_lock_rejects_hard_link(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_dir = root / "data"
            data_dir.mkdir()
            outside = root / "outside.txt"
            outside.write_text("do not overwrite", encoding="utf-8")
            (data_dir / ".sidecar.lock").hardlink_to(outside)

            with self.assertRaisesRegex(RuntimeError, "hard links"):
                DataDirectoryLock(data_dir, "instance").acquire()

            self.assertEqual(outside.read_text(encoding="utf-8"), "do not overwrite")

    def test_socket_owns_an_ephemeral_port(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            sock = bind_sidecar_socket(make_settings(Path(directory)))
            try:
                self.assertGreater(sock.getsockname()[1], 0)
            finally:
                sock.close()

    def test_non_loopback_bind_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            for host in ("0.0.0.0", "localhost"):  # noqa: S104
                with self.subTest(host=host), self.assertRaisesRegex(RuntimeError, "loopback"):
                    bind_sidecar_socket(make_settings(Path(directory), host=host))

    def test_readiness_payload_is_instance_bound(self) -> None:
        payload = readiness_payload(instance_id="abc", protocol=1, port=4567)
        self.assertEqual(payload["event"], "ready")
        self.assertEqual(payload["instance_id"], "abc")
        self.assertEqual(payload["port"], 4567)


if __name__ == "__main__":
    unittest.main()
