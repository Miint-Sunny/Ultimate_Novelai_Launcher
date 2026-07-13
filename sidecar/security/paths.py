from __future__ import annotations

import os
from pathlib import Path

from .errors import PathNotFoundSecurityError, UnsafePathError


def _contains(parent: Path, child: Path) -> bool:
    try:
        child.relative_to(parent)
    except ValueError:
        return False
    return True


def resolve_safe_path(
    root: str | os.PathLike[str],
    untrusted: str | os.PathLike[str],
    *,
    must_exist: bool = True,
    allow_symlinks: bool = False,
    allow_absolute: bool = True,
    allow_root: bool = True,
) -> Path:
    """Resolve a path while enforcing lexical and real-path containment.

    The configured ``root`` must already exist and may itself be a trusted
    symlink.  Symlinks below it are rejected by default, including a final broken
    symlink; callers may opt in to contained symlinks with ``allow_symlinks=True``.
    ``Path.resolve`` is performed again after the lexical check, so ``..`` and a
    symlink targeting outside the root cannot escape.
    """

    root_text = os.fspath(root)
    candidate_text = os.fspath(untrusted)
    if not isinstance(root_text, str) or not isinstance(candidate_text, str):
        raise TypeError("safe paths must be text paths")
    if "\x00" in root_text or "\x00" in candidate_text:
        raise UnsafePathError("paths may not contain NUL bytes")

    root_lexical = Path(os.path.abspath(root_text))
    try:
        root_resolved = root_lexical.resolve(strict=True)
    except (FileNotFoundError, NotADirectoryError) as exc:
        raise PathNotFoundSecurityError("safe path root does not exist") from exc
    except (OSError, RuntimeError) as exc:
        raise UnsafePathError("safe path root could not be resolved") from exc
    if not root_resolved.is_dir():
        raise UnsafePathError("safe path root must be a directory")

    supplied = Path(candidate_text)
    if supplied.is_absolute():
        if not allow_absolute:
            raise UnsafePathError("absolute paths are not allowed")
        candidate_lexical = Path(os.path.abspath(candidate_text))
    else:
        candidate_lexical = Path(os.path.abspath(os.path.join(root_lexical, candidate_text)))

    # Check the spelling before resolving links.  This rejects paths that first
    # traverse outside and then happen to link back into the root.
    if not _contains(root_lexical, candidate_lexical):
        raise UnsafePathError("path escapes the configured root")
    if candidate_lexical == root_lexical and not allow_root:
        raise UnsafePathError("the configured root itself is not an allowed target")

    if not allow_symlinks:
        relative = candidate_lexical.relative_to(root_lexical)
        current = root_lexical
        for component in relative.parts:
            current = current / component
            # is_symlink() also detects a broken final link.
            if current.is_symlink():
                raise UnsafePathError(
                    "symbolic links are not allowed below the configured root",
                    code="unsafe_path_symlink",
                )

    try:
        resolved = candidate_lexical.resolve(strict=must_exist)
    except (FileNotFoundError, NotADirectoryError) as exc:
        raise PathNotFoundSecurityError("safe path does not exist") from exc
    except (OSError, RuntimeError) as exc:
        raise UnsafePathError("safe path could not be resolved") from exc

    if not _contains(root_resolved, resolved):
        raise UnsafePathError("resolved path escapes the configured root")
    if resolved == root_resolved and not allow_root:
        raise UnsafePathError("the configured root itself is not an allowed target")
    return resolved


safe_resolve = resolve_safe_path


class SafePathResolver:
    """Small configured wrapper around :func:`resolve_safe_path`."""

    def __init__(
        self,
        root: str | os.PathLike[str],
        *,
        allow_symlinks: bool = False,
        allow_absolute: bool = True,
    ) -> None:
        self.root = Path(root)
        self.allow_symlinks = allow_symlinks
        self.allow_absolute = allow_absolute

    def resolve(
        self,
        value: str | os.PathLike[str],
        *,
        must_exist: bool = True,
        allow_root: bool = True,
    ) -> Path:
        return resolve_safe_path(
            self.root,
            value,
            must_exist=must_exist,
            allow_symlinks=self.allow_symlinks,
            allow_absolute=self.allow_absolute,
            allow_root=allow_root,
        )


__all__ = ["SafePathResolver", "resolve_safe_path", "safe_resolve"]
