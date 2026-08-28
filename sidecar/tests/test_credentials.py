from __future__ import annotations

import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

from sidecar import credentials


@contextmanager
def fake_secure_store(initial: str | None = None, available: bool = True):
    """Patch secure storage with an in-memory account-keyed test double."""
    store: dict[str, str] = {}
    if initial is not None:
        store[credentials.ACCOUNT_NOVELAI] = initial

    def _get(account: str) -> str:
        return store.get(account, "")

    def _set(account: str, value: str) -> bool:
        if not available:
            return False
        store[account] = value
        return True

    def _delete(account: str) -> None:
        store.pop(account, None)

    with (
        mock.patch.object(credentials, "_secure_get", _get),
        mock.patch.object(credentials, "_secure_set", _set),
        mock.patch.object(credentials, "_secure_delete", _delete),
        mock.patch.object(credentials, "_secure_available", lambda: available),
    ):
        yield store


class CredentialsTests(unittest.TestCase):
    def _data_dir(self):
        return Path(self._tmp.name)

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)

    def _plaintext_path(self) -> Path:
        return self._data_dir() / "secrets" / "novelai.token"

    # ---- NovelAI token ----

    def test_set_get_delete_roundtrip(self) -> None:
        with fake_secure_store():
            self.assertTrue(credentials.set_stored_token(self._data_dir(), "token-roundtrip-value"))
            self.assertEqual(
                credentials.get_stored_token(self._data_dir()),
                "token-roundtrip-value",
            )
            # No plaintext file should ever be created.
            self.assertFalse(self._plaintext_path().exists())

            credentials.delete_stored_token(self._data_dir())
            self.assertEqual(credentials.get_stored_token(self._data_dir()), "")

    def test_empty_token_clears(self) -> None:
        with fake_secure_store(initial="token-existing-value"):
            self.assertTrue(credentials.set_stored_token(self._data_dir(), "   "))
            self.assertEqual(credentials.get_stored_token(self._data_dir()), "")

    def test_no_secure_store_raises_and_writes_no_plaintext(self) -> None:
        with fake_secure_store(available=False):
            with self.assertRaises(credentials.CredentialStorageError):
                credentials.set_stored_token(self._data_dir(), "token-should-not-persist")
            self.assertFalse(self._plaintext_path().exists())
            self.assertEqual(credentials.get_stored_token(self._data_dir()), "")

    def test_secure_store_present_but_write_fails_raises(self) -> None:
        # available() True but _secure_set returns False (e.g. CLI error).
        with (
            mock.patch.object(credentials, "_secure_available", lambda: True),
            mock.patch.object(credentials, "_secure_set", lambda account, value: False),
            mock.patch.object(credentials, "_secure_get", lambda account: ""),
        ):
            with self.assertRaises(credentials.CredentialStorageError):
                credentials.set_stored_token(self._data_dir(), "token-write-fails")
            self.assertFalse(self._plaintext_path().exists())

    def test_legacy_plaintext_is_migrated_then_deleted(self) -> None:
        legacy = self._plaintext_path()
        legacy.parent.mkdir(parents=True, exist_ok=True)
        legacy.write_text("token-legacy-value", encoding="utf-8")

        with fake_secure_store() as store:
            self.assertEqual(credentials.get_stored_token(self._data_dir()), "token-legacy-value")
            # Migrated into the secure store and the plaintext file removed.
            self.assertEqual(store.get(credentials.ACCOUNT_NOVELAI), "token-legacy-value")
            self.assertFalse(legacy.exists())

    def test_set_removes_existing_legacy_plaintext(self) -> None:
        legacy = self._plaintext_path()
        legacy.parent.mkdir(parents=True, exist_ok=True)
        legacy.write_text("token-old-plaintext", encoding="utf-8")

        with fake_secure_store():
            credentials.set_stored_token(self._data_dir(), "token-new-secure")
            self.assertFalse(legacy.exists())

    def test_legacy_plaintext_without_secure_store_fails_closed_and_is_kept(self) -> None:
        legacy = self._plaintext_path()
        legacy.parent.mkdir(parents=True, exist_ok=True)
        legacy.write_text("token-orphan-value", encoding="utf-8")

        with fake_secure_store(available=False):
            with self.assertRaises(credentials.CredentialStorageError):
                credentials.get_stored_token(self._data_dir())
            self.assertTrue(legacy.exists())

    def test_legacy_plaintext_write_failure_fails_closed_and_is_kept(self) -> None:
        legacy = self._plaintext_path()
        legacy.parent.mkdir(parents=True, exist_ok=True)
        legacy.write_text("token-orphan-value", encoding="utf-8")

        with (
            mock.patch.object(credentials, "_secure_get", return_value=""),
            mock.patch.object(credentials, "_secure_available", return_value=True),
            mock.patch.object(credentials, "_secure_set", return_value=False),
        ):
            with self.assertRaises(credentials.CredentialStorageError):
                credentials.get_stored_token(self._data_dir())
        self.assertEqual(legacy.read_text(encoding="utf-8"), "token-orphan-value")

    def test_macos_keychain_write_verifies_the_round_trip(self) -> None:
        secret = "super-secret-value"
        with (
            mock.patch.object(
                credentials.shutil,
                "which",
                return_value="/usr/bin/security",
            ),
            mock.patch.object(
                credentials, "_macos_answer_password_prompt", return_value=True
            ) as prompt,
            mock.patch.object(credentials, "_macos_get_password", return_value=secret),
        ):
            self.assertTrue(credentials._macos_set_password("account", secret))

        prompt.assert_called_once_with("/usr/bin/security", "account", secret)

    def test_macos_keychain_write_keeps_the_secret_out_of_argv(self) -> None:
        # Passing the secret on argv would work, and would also publish it to
        # every `ps` on the machine. It goes down the pty instead.
        secret = "super-secret-value"
        process = mock.Mock(returncode=0)
        with (
            mock.patch.object(credentials.subprocess, "Popen", return_value=process) as popen,
            mock.patch.object(credentials.os, "write"),
            mock.patch.object(credentials.os, "close"),
        ):
            credentials._macos_answer_password_prompt("/usr/bin/security", "account", secret)

        args = popen.call_args.args[0]
        self.assertEqual(args[0], "/usr/bin/security")
        self.assertEqual(args[-1], "-w")
        self.assertNotIn(secret, args)

    def test_macos_keychain_write_fails_when_the_secret_does_not_round_trip(self) -> None:
        # The regression this guards: `security add-generic-password -w` prompts
        # on a terminal rather than reading stdin, so a sidecar's piped write
        # stored an empty password and still exited 0. Success was reported, the
        # keychain held nothing, and the loss only showed up later as a token
        # that would not save. A zero exit is therefore not enough -- the value
        # has to read back.
        process = mock.Mock(returncode=0)
        with (
            mock.patch.object(
                credentials.shutil,
                "which",
                return_value="/usr/bin/security",
            ),
            mock.patch.object(credentials.subprocess, "Popen", return_value=process),
            mock.patch.object(credentials, "_macos_get_password", return_value=""),
        ):
            self.assertFalse(credentials._macos_set_password("account", "super-secret-value"))

    def test_macos_keychain_write_requires_resolved_executable(self) -> None:
        with (
            mock.patch.object(credentials.shutil, "which", return_value=None),
            mock.patch.object(credentials.subprocess, "Popen") as popen,
        ):
            self.assertFalse(credentials._macos_set_password("account", "secret"))
        popen.assert_not_called()

    def test_macos_keychain_read_and_delete_use_resolved_executable(self) -> None:
        completed = mock.Mock(returncode=0, stdout="stored-secret\n")
        with (
            mock.patch.object(
                credentials.shutil,
                "which",
                return_value="/usr/bin/security",
            ),
            mock.patch.object(credentials.subprocess, "run", return_value=completed) as run,
        ):
            self.assertEqual(credentials._macos_get_password("account"), "stored-secret")
            credentials._macos_delete_password("account")

        self.assertEqual(run.call_args_list[0].args[0][0], "/usr/bin/security")
        self.assertEqual(run.call_args_list[1].args[0][0], "/usr/bin/security")

    def test_macos_keychain_read_and_delete_require_resolved_executable(self) -> None:
        with (
            mock.patch.object(credentials.shutil, "which", return_value=None),
            mock.patch.object(
                credentials.subprocess,
                "run",
            ) as run,
        ):
            self.assertEqual(credentials._macos_get_password("account"), "")
            credentials._macos_delete_password("account")
        run.assert_not_called()

    def test_secret_tool_uses_resolved_executable_and_stdin(self) -> None:
        completed = mock.Mock(returncode=0, stdout="stored-secret\n")
        secret = "linux-secret-value"
        with (
            mock.patch.object(
                credentials.shutil,
                "which",
                return_value="/usr/bin/secret-tool",
            ),
            mock.patch.object(credentials.subprocess, "run", return_value=completed) as run,
        ):
            self.assertEqual(credentials._secret_tool_get("account"), "stored-secret")
            self.assertTrue(credentials._secret_tool_set("account", secret))
            credentials._secret_tool_delete("account")

        for call in run.call_args_list:
            self.assertEqual(call.args[0][0], "/usr/bin/secret-tool")
            self.assertNotIn(secret, call.args[0])
        self.assertEqual(run.call_args_list[1].kwargs["input"], secret)

    def test_secret_tool_operations_require_resolved_executable(self) -> None:
        with (
            mock.patch.object(credentials.shutil, "which", return_value=None),
            mock.patch.object(
                credentials.subprocess,
                "run",
            ) as run,
        ):
            self.assertEqual(credentials._secret_tool_get("account"), "")
            self.assertFalse(credentials._secret_tool_set("account", "secret"))
            credentials._secret_tool_delete("account")
        run.assert_not_called()

    # ---- LLM API key ----

    def test_llm_key_roundtrip(self) -> None:
        with fake_secure_store() as store:
            self.assertTrue(credentials.set_stored_llm_key(self._data_dir(), "llm-key-value"))
            self.assertEqual(credentials.get_stored_llm_key(self._data_dir()), "llm-key-value")
            # Stored under the LLM account, separate from the NovelAI token.
            self.assertEqual(store.get(credentials.ACCOUNT_LLM), "llm-key-value")
            self.assertNotIn(credentials.ACCOUNT_NOVELAI, store)

            credentials.delete_stored_llm_key(self._data_dir())
            self.assertEqual(credentials.get_stored_llm_key(self._data_dir()), "")

    def test_llm_key_empty_clears(self) -> None:
        with fake_secure_store() as store:
            credentials.set_stored_llm_key(self._data_dir(), "llm-key-value")
            self.assertTrue(credentials.set_stored_llm_key(self._data_dir(), "  "))
            self.assertEqual(credentials.get_stored_llm_key(self._data_dir()), "")
            self.assertNotIn(credentials.ACCOUNT_LLM, store)

    def test_llm_key_no_secure_store_raises(self) -> None:
        with fake_secure_store(available=False):
            with self.assertRaises(credentials.CredentialStorageError):
                credentials.set_stored_llm_key(self._data_dir(), "llm-key-should-not-persist")
            self.assertEqual(credentials.get_stored_llm_key(self._data_dir()), "")

    def test_token_and_llm_key_are_independent(self) -> None:
        with fake_secure_store():
            credentials.set_stored_token(self._data_dir(), "the-token")
            credentials.set_stored_llm_key(self._data_dir(), "the-llm-key")
            self.assertEqual(credentials.get_stored_token(self._data_dir()), "the-token")
            self.assertEqual(credentials.get_stored_llm_key(self._data_dir()), "the-llm-key")
            # Deleting one leaves the other intact.
            credentials.delete_stored_token(self._data_dir())
            self.assertEqual(credentials.get_stored_token(self._data_dir()), "")
            self.assertEqual(credentials.get_stored_llm_key(self._data_dir()), "the-llm-key")


if __name__ == "__main__":
    unittest.main()
