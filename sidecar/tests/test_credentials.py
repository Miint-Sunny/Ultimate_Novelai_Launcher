from __future__ import annotations

import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

from sidecar import credentials


@contextmanager
def fake_secure_store(initial: str | None = None, available: bool = True):
    """Patch the secure backend with an in-memory, account-keyed store so tests never touch the real OS keychain."""
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

    with mock.patch.object(credentials, "_secure_get", _get), mock.patch.object(
        credentials, "_secure_set", _set
    ), mock.patch.object(credentials, "_secure_delete", _delete), mock.patch.object(
        credentials, "_secure_available", lambda: available
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
            self.assertEqual(credentials.get_stored_token(self._data_dir()), "token-roundtrip-value")
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
        with mock.patch.object(credentials, "_secure_available", lambda: True), mock.patch.object(
            credentials, "_secure_set", lambda account, value: False
        ), mock.patch.object(credentials, "_secure_get", lambda account: ""):
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

    def test_legacy_plaintext_without_secure_store_is_readable_but_kept(self) -> None:
        # No secure store available: existing plaintext stays readable (no data loss),
        # but we never create new plaintext.
        legacy = self._plaintext_path()
        legacy.parent.mkdir(parents=True, exist_ok=True)
        legacy.write_text("token-orphan-value", encoding="utf-8")

        with fake_secure_store(available=False):
            self.assertEqual(credentials.get_stored_token(self._data_dir()), "token-orphan-value")
            self.assertTrue(legacy.exists())

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
