from __future__ import annotations

import contextlib
import io
import os
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from typing import Any
from unittest import mock

from sidecar import credential_cli, credentials


class _FakeStore:
    def __init__(self) -> None:
        self.values: dict[str, str] = {}

    def patches(self) -> list[Any]:
        return [
            mock.patch.object(credentials, "_secure_available", lambda: True),
            mock.patch.object(credentials, "_secure_get", self._get),
            mock.patch.object(credentials, "_secure_set", self._set),
            mock.patch.object(credentials, "_secure_delete", self._delete),
        ]

    def _get(self, account: str) -> str:
        return self.values.get(account, "")

    def _set(self, account: str, value: str) -> bool:
        self.values[account] = value
        return True

    def _delete(self, account: str) -> None:
        self.values.pop(account, None)


class CredentialCliTests(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.data_dir = Path(tmp.name)
        self.store = _FakeStore()
        stack = ExitStack()
        self.addCleanup(stack.close)
        for patch in self.store.patches():
            stack.enter_context(patch)
        stack.enter_context(mock.patch.dict(os.environ, {credentials.CREDENTIAL_NAMESPACE_ENV: ""}))

    def _run(self, *argv: str, secret: str = "") -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(credential_cli.getpass, "getpass", return_value=secret) as prompt:
            code = credential_cli.main(["--data-dir", str(self.data_dir), *argv], out=out, err=err)
        if argv and argv[0] == "set":
            prompt.assert_called_once()
        return code, out.getvalue(), err.getvalue()

    def test_set_stores_the_secret_without_echoing_it(self) -> None:
        code, out, err = self._run("set", "novelai", secret="pst-abc123")
        self.assertEqual(code, 0)
        self.assertEqual(self.store.values, {credentials.ACCOUNT_NOVELAI: "pst-abc123"})
        self.assertIn("Stored novelai", out)
        self.assertNotIn("pst-abc123", out + err)

    def test_status_reports_presence_only(self) -> None:
        self.store.values[credentials.ACCOUNT_LLM] = "llm-secret-value"
        code, out, _err = self._run("status")
        self.assertEqual(code, 0)
        self.assertIn("llm: stored", out)
        self.assertIn("novelai: not stored", out)
        self.assertIn("llm-backup: not stored", out)
        self.assertNotIn("llm-secret-value", out)

    def test_empty_input_stores_nothing(self) -> None:
        code, _out, err = self._run("set", "llm", secret="   ")
        self.assertEqual(code, 1)
        self.assertEqual(self.store.values, {})
        self.assertIn("nothing stored", err)

    def test_unexpected_novelai_prefix_warns_but_stores(self) -> None:
        code, _out, err = self._run("set", "novelai", secret="not-a-pst")
        self.assertEqual(code, 0)
        self.assertIn("Warning", err)
        self.assertEqual(self.store.values[credentials.ACCOUNT_NOVELAI], "not-a-pst")

    def test_delete_clears_one_account(self) -> None:
        self.store.values[credentials.ACCOUNT_NOVELAI] = "pst-abc123"
        self.store.values[credentials.ACCOUNT_LLM] = "llm-key"
        code, out, _err = self._run("delete", "novelai")
        self.assertEqual(code, 0)
        self.assertIn("Cleared novelai", out)
        self.assertEqual(self.store.values, {credentials.ACCOUNT_LLM: "llm-key"})

    def test_namespace_flag_scopes_the_service(self) -> None:
        code, out, _err = self._run("--namespace", "test", "status")
        self.assertEqual(code, 0)
        self.assertIn("namespace: test", out)
        self.assertIn("Ultimate Novelai launcher (test)", out)

    def test_invalid_namespace_is_reported_not_raised(self) -> None:
        code, _out, err = self._run("--namespace", "bad name", "status")
        self.assertEqual(code, 1)
        self.assertIn(credentials.CREDENTIAL_NAMESPACE_ENV, err)

    def test_unknown_account_is_a_usage_error(self) -> None:
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as raised:
            credential_cli.main(["set", "nope"])
        self.assertEqual(raised.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
