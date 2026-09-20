"""Store or clear sidecar secrets from a terminal without any plaintext file.

``python -m sidecar.credential_cli set novelai`` asks for the secret with echo
off and writes it to the OS credential store, under the same service and account
the sidecar reads at startup.  ``--namespace test`` (or the
``ULTIMATE_NOVELAI_LAUNCHER_CREDENTIAL_NAMESPACE`` environment variable) keeps a
test key apart from the app's real one.  The secret is never printed, logged,
or accepted on argv; ``status`` only reports whether each account holds a value.
"""

from __future__ import annotations

import argparse
import getpass
import os
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path

from . import credentials
from .config import load_settings


@dataclass(frozen=True)
class _Account:
    label: str
    expected_prefix: str | None
    get: Callable[[Path], str]
    set: Callable[[Path, str], bool]
    delete: Callable[[Path], None]


ACCOUNTS: dict[str, _Account] = {
    "novelai": _Account(
        "NovelAI persistent token",
        "pst-",
        credentials.get_stored_token,
        credentials.set_stored_token,
        credentials.delete_stored_token,
    ),
    "llm": _Account(
        "LLM API key (primary slot)",
        None,
        credentials.get_stored_llm_key,
        credentials.set_stored_llm_key,
        credentials.delete_stored_llm_key,
    ),
    "llm-backup": _Account(
        "LLM API key (backup slot)",
        None,
        credentials.get_stored_llm_backup_key,
        credentials.set_stored_llm_backup_key,
        credentials.delete_stored_llm_backup_key,
    ),
}


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m sidecar.credential_cli",
        description="Store, clear, or inspect sidecar secrets in the OS credential store.",
    )
    parser.add_argument(
        "--namespace",
        help=(
            "store namespace, e.g. 'test'; equivalent to setting "
            f"{credentials.CREDENTIAL_NAMESPACE_ENV}"
        ),
    )
    parser.add_argument(
        "--data-dir",
        type=Path,
        help="sidecar data directory (default: the same resolution the sidecar uses)",
    )
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("set", "delete"):
        sub = commands.add_parser(name, help=f"{name} one secret")
        sub.add_argument("account", choices=sorted(ACCOUNTS))
    commands.add_parser("status", help="show which accounts hold a value")
    return parser


def _resolve_data_dir(override: Path | None) -> Path:
    if override is not None:
        return override.expanduser()
    return load_settings().data_dir


def _read_secret(prompt: str) -> str:
    # getpass keeps the terminal echo off; when stdin is not a terminal it reads
    # one line from it, which lets a password manager pipe the value in.
    return getpass.getpass(prompt).strip()


def _set(account_name: str, data_dir: Path, out, err) -> int:
    account = ACCOUNTS[account_name]
    value = _read_secret(f"{account.label}: ")
    if not value:
        print("Nothing entered; nothing stored.", file=err)
        return 1
    if account.expected_prefix and not value.startswith(account.expected_prefix):
        print(
            f"Warning: a {account.label} normally starts with {account.expected_prefix!r}; "
            "storing it anyway.",
            file=err,
        )
    if not account.set(data_dir, value):
        print("The credential store did not confirm the write.", file=err)
        return 1
    print(f"Stored {account_name} under {credentials.service_name()!r}.", file=out)
    return 0


def _delete(account_name: str, data_dir: Path, out) -> int:
    ACCOUNTS[account_name].delete(data_dir)
    print(f"Cleared {account_name} under {credentials.service_name()!r}.", file=out)
    return 0


def _status(data_dir: Path, out) -> int:
    namespace = credentials.credential_namespace() or "(none)"
    print(f"namespace: {namespace}", file=out)
    print(f"service: {credentials.service_name()!r}", file=out)
    for name, account in ACCOUNTS.items():
        state = "stored" if account.get(data_dir) else "not stored"
        print(f"{name}: {state}", file=out)
    return 0


def main(argv: Sequence[str] | None = None, *, out=None, err=None) -> int:
    out = out or sys.stdout
    err = err or sys.stderr
    args = _build_parser().parse_args(argv)
    if args.namespace is not None:
        os.environ[credentials.CREDENTIAL_NAMESPACE_ENV] = args.namespace
    try:
        credentials.credential_namespace()
        data_dir = _resolve_data_dir(args.data_dir)
        if args.command == "set":
            return _set(args.account, data_dir, out, err)
        if args.command == "delete":
            return _delete(args.account, data_dir, out)
        return _status(data_dir, out)
    except (ValueError, credentials.CredentialStorageError) as exc:
        print(str(exc), file=err)
        return 1


if __name__ == "__main__":
    sys.exit(main())
