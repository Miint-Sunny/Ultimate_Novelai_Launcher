from __future__ import annotations

import subprocess
import sys
from pathlib import Path


def test_agent_runtime_import_does_not_load_fastapi_or_legacy_router() -> None:
    """The desktop adapter must depend only on the framework-free Agent core."""

    root = Path(__file__).resolve().parents[2]
    probe = """
import sys

import sidecar.agent_runtime  # noqa: F401

forbidden = sorted(
    name
    for name in sys.modules
    if name == "fastapi"
    or name.startswith("fastapi.")
    or name == "server.agent_router.router"
)
if forbidden:
    raise SystemExit("forbidden Agent import edge: " + ", ".join(forbidden))
"""
    result = subprocess.run(  # noqa: S603 - sys.executable runs a fixed local probe
        [sys.executable, "-c", probe],
        cwd=root,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr or result.stdout
