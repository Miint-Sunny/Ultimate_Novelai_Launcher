"""Enforce the line gate for every new backend module in the maturity slice."""

from __future__ import annotations

from pathlib import Path

from coverage import Coverage

MINIMUM_LINE_PERCENT = 90.0
TARGETS = (
    "backend_core/",
    "cloud_backend/",
    "sidecar/application/",
    "sidecar/persistence/",
    "sidecar/process_control.py",
    "sidecar/runtime.py",
    "sidecar/security/",
    "sidecar/services/assets.py",
    "sidecar/services/backup.py",
    "sidecar/services/generation.py",
    "sidecar/services/jobs.py",
    "sidecar/services/library.py",
    "server/agent_router/web_hooks.py",
    "server/agent_router/web_runtime.py",
)


def _relative_name(path: str, root: Path) -> str:
    candidate = Path(path)
    if not candidate.is_absolute():
        candidate = root / candidate
    return candidate.resolve().relative_to(root).as_posix()


def _expected_modules(root: Path) -> set[str]:
    expected: set[str] = set()
    for target in TARGETS:
        path = root / target
        if target.endswith("/"):
            if not path.is_dir():
                raise SystemExit(f"coverage target directory is missing: {target}")
            expected.update(
                module.relative_to(root).as_posix()
                for module in path.rglob("*.py")
                if module.is_file()
            )
        else:
            if not path.is_file():
                raise SystemExit(f"coverage target module is missing: {target}")
            expected.add(target)
    return expected


def main() -> None:
    root = Path(__file__).resolve().parents[2]
    coverage = Coverage(config_file=root / "pyproject.toml")
    coverage.load()
    measured = {
        _relative_name(path, root): path
        for path in coverage.get_data().measured_files()
        if _relative_name(path, root).endswith(".py")
    }
    expected = _expected_modules(root)
    missing_modules = sorted(expected - measured.keys())
    if missing_modules:
        raise SystemExit("coverage did not measure: " + ", ".join(missing_modules))
    selected = {name: measured[name] for name in expected}

    failures: list[str] = []
    print("Per-module line coverage gate:")
    for name in sorted(selected):
        _filename, statements, _excluded, missing, _formatted = coverage.analysis2(selected[name])
        covered = len(statements) - len(missing)
        percent = 100.0 if not statements else covered * 100.0 / len(statements)
        print(f"  {percent:6.2f}%  {name}")
        if percent + 1e-9 < MINIMUM_LINE_PERCENT:
            failures.append(f"{name} ({percent:.2f}%)")
    if failures:
        raise SystemExit(
            f"each target module must have at least {MINIMUM_LINE_PERCENT:.0f}% line coverage: "
            + ", ".join(failures)
        )


if __name__ == "__main__":
    main()
