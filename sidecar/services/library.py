from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import mimetypes
import re
import uuid
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

import aiosqlite

from backend_core.errors import AppError, ConflictError, InvalidArgumentError, ResourceNotFoundError
from backend_core.types import JsonValue
from sidecar.persistence import Database
from sidecar.security.payloads import MAX_SINGLE_ASSET_BYTES
from sidecar.services.assets import AssetRecord, AssetService

LibraryKind = Literal["oc", "artist", "cr", "vibe"]
LIBRARY_KINDS = frozenset({"oc", "artist", "cr", "vibe"})
_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$")
_MAX_DATA_BYTES = 4 * 1024 * 1024
logger = logging.getLogger(__name__)


class LibraryItemNotFoundError(ResourceNotFoundError):
    def __init__(self, item_id: str) -> None:
        super().__init__(
            "library item was not found",
            code="library_item_not_found",
            details={"item_id": item_id},
        )


class LibraryConflictError(ConflictError):
    def __init__(self, kind: str, lookup_key: str) -> None:
        super().__init__(
            "a library item already uses this key",
            code="library_key_conflict",
            details={"kind": kind, "key": lookup_key},
        )


@dataclass(frozen=True)
class LibraryItem:
    id: str
    owner: str
    kind: LibraryKind
    lookup_key: str
    data: Mapping[str, JsonValue]
    primary_asset_id: str | None
    thumbnail_asset_id: str | None
    created_at: str
    updated_at: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "owner": self.owner,
            "kind": self.kind,
            "key": self.lookup_key,
            "data": _public_data(self.data),
            "primary_asset_id": self.primary_asset_id,
            "thumbnail_asset_id": self.thumbnail_asset_id,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


class LibraryService:
    """Owner-scoped library application service backed by canonical assets.

    Historical absolute paths are treated only as migration input.  A path is
    adopted when it resolves to a regular, non-symlinked file below the configured
    asset root.  Adoption creates a catalog reference and never moves or deletes
    the historical file.
    """

    def __init__(self, database: Database, assets: AssetService) -> None:
        self.database = database
        self.assets = assets
        self._initialize_lock = asyncio.Lock()
        self._write_lock = asyncio.Lock()
        self._initialized = False

    async def initialize(self) -> None:
        async with self._initialize_lock:
            if self._initialized:
                return
            await self.database.initialize()
            await self.assets.initialize()
            await self._import_legacy_rows()
            await self._adopt_legacy_assets()
            self._initialized = True

    start = initialize

    async def close(self) -> None:
        self._initialized = False

    stop = close

    async def check(self) -> bool:
        return self._initialized and await self.database.check() and await self.assets.check()

    async def create_item(
        self,
        owner: str,
        kind: LibraryKind,
        lookup_key: str,
        data: Mapping[str, JsonValue],
        *,
        primary_payload: bytes | None = None,
        primary_media_type: str | None = None,
        thumbnail_payload: bytes | None = None,
        thumbnail_media_type: str | None = None,
        item_id: str | None = None,
    ) -> LibraryItem:
        resolved_owner = _normalize_owner(owner)
        resolved_kind = _normalize_kind(kind)
        resolved_key = _normalize_key(lookup_key)
        resolved_id = _normalize_identifier(item_id or uuid.uuid4().hex, "item_id")
        data_json = _canonical_data(data)

        async with self._write_lock:
            if await self.find_by_key(resolved_owner, resolved_kind, resolved_key) is not None:
                raise LibraryConflictError(resolved_kind, resolved_key)
            stored: list[str] = []
            try:
                primary_id = await self._store_payload(
                    resolved_id,
                    resolved_kind,
                    "primary",
                    primary_payload,
                    primary_media_type,
                    stored,
                )
                thumbnail_id = await self._store_payload(
                    resolved_id,
                    resolved_kind,
                    "thumbnail",
                    thumbnail_payload,
                    thumbnail_media_type,
                    stored,
                )
                now = _utc_now()
                async with self.database.transaction() as connection:
                    try:
                        await connection.execute(
                            """
                            INSERT INTO library_entries(
                                id, owner, kind, lookup_key, data_json,
                                primary_asset_id, thumbnail_asset_id, created_at, updated_at
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                            """,
                            (
                                resolved_id,
                                resolved_owner,
                                resolved_kind,
                                resolved_key,
                                data_json,
                                primary_id,
                                thumbnail_id,
                                now,
                                now,
                            ),
                        )
                    except aiosqlite.IntegrityError as exc:
                        raise LibraryConflictError(resolved_kind, resolved_key) from exc
            except BaseException:
                await self._remove_new_assets(stored)
                raise
        return await self.require_item(resolved_owner, resolved_id)

    async def update_item(
        self,
        owner: str,
        item_id: str,
        *,
        lookup_key: str,
        data: Mapping[str, JsonValue],
        primary_payload: bytes | None = None,
        primary_media_type: str | None = None,
        thumbnail_payload: bytes | None = None,
        thumbnail_media_type: str | None = None,
    ) -> LibraryItem:
        resolved_owner = _normalize_owner(owner)
        resolved_id = _normalize_identifier(item_id, "item_id")
        resolved_key = _normalize_key(lookup_key)
        data_json = _canonical_data(data)

        async with self._write_lock:
            current = await self.get_item(resolved_owner, resolved_id)
            if current is None:
                raise LibraryItemNotFoundError(resolved_id)
            conflict = await self.find_by_key(resolved_owner, current.kind, resolved_key)
            if conflict is not None and conflict.id != resolved_id:
                raise LibraryConflictError(current.kind, resolved_key)
            stored: list[str] = []
            try:
                primary_id = current.primary_asset_id
                if primary_payload is not None:
                    primary_id = await self._store_payload(
                        resolved_id,
                        current.kind,
                        "primary",
                        primary_payload,
                        primary_media_type,
                        stored,
                    )
                thumbnail_id = current.thumbnail_asset_id
                if thumbnail_payload is not None:
                    thumbnail_id = await self._store_payload(
                        resolved_id,
                        current.kind,
                        "thumbnail",
                        thumbnail_payload,
                        thumbnail_media_type,
                        stored,
                    )
                async with self.database.transaction() as connection:
                    try:
                        cursor = await connection.execute(
                            """
                            UPDATE library_entries
                            SET lookup_key = ?, data_json = ?, primary_asset_id = ?,
                                thumbnail_asset_id = ?, updated_at = ?
                            WHERE id = ? AND owner = ?
                            """,
                            (
                                resolved_key,
                                data_json,
                                primary_id,
                                thumbnail_id,
                                _utc_now(),
                                resolved_id,
                                resolved_owner,
                            ),
                        )
                        changed = cursor.rowcount
                        await cursor.close()
                    except aiosqlite.IntegrityError as exc:
                        raise LibraryConflictError(current.kind, resolved_key) from exc
                    if changed != 1:
                        raise LibraryItemNotFoundError(resolved_id)
            except BaseException:
                await self._remove_new_assets(stored)
                raise
        return await self.require_item(resolved_owner, resolved_id)

    async def get_item(self, owner: str, item_id: str) -> LibraryItem | None:
        resolved_owner = _normalize_owner(owner)
        resolved_id = _normalize_identifier(item_id, "item_id")
        async with self.database.connect() as connection:
            row = await _fetchone(
                connection,
                "SELECT * FROM library_entries WHERE id = ? AND owner = ?",
                (resolved_id, resolved_owner),
            )
        return _row_to_item(row) if row is not None else None

    async def require_item(self, owner: str, item_id: str) -> LibraryItem:
        item = await self.get_item(owner, item_id)
        if item is None:
            raise LibraryItemNotFoundError(item_id)
        return item

    async def find_by_key(
        self,
        owner: str,
        kind: LibraryKind,
        lookup_key: str,
    ) -> LibraryItem | None:
        resolved_owner = _normalize_owner(owner)
        resolved_kind = _normalize_kind(kind)
        resolved_key = _normalize_key(lookup_key)
        async with self.database.connect() as connection:
            row = await _fetchone(
                connection,
                """
                SELECT * FROM library_entries
                WHERE owner = ? AND kind = ? AND lookup_key = ?
                """,
                (resolved_owner, resolved_kind, resolved_key),
            )
        return _row_to_item(row) if row is not None else None

    async def list_items(
        self,
        owner: str,
        *,
        kind: LibraryKind | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[LibraryItem]:
        resolved_owner = _normalize_owner(owner)
        if limit < 1 or limit > 1000 or offset < 0:
            raise InvalidArgumentError("invalid library page")
        resolved_kind = _normalize_kind(kind) if kind is not None else None
        async with self.database.connect() as connection:
            cursor = await connection.execute(
                """
                SELECT * FROM library_entries
                WHERE owner = ? AND (? IS NULL OR kind = ?)
                ORDER BY created_at DESC, id
                LIMIT ? OFFSET ?
                """,
                (resolved_owner, resolved_kind, resolved_kind, limit, offset),
            )
            rows = await cursor.fetchall()
            await cursor.close()
        return [_row_to_item(row) for row in rows]

    async def delete_item(self, owner: str, item_id: str) -> bool:
        resolved_owner = _normalize_owner(owner)
        resolved_id = _normalize_identifier(item_id, "item_id")
        async with self._write_lock:
            async with self.database.transaction() as connection:
                cursor = await connection.execute(
                    "DELETE FROM library_entries WHERE id = ? AND owner = ?",
                    (resolved_id, resolved_owner),
                )
                deleted = cursor.rowcount == 1
                await cursor.close()
        # Asset deletion remains an explicit storage-prune operation.  In
        # particular this ensures an imported historical file is never deleted as
        # an implicit consequence of migration or catalog maintenance.
        return deleted

    async def increment_artist_usage(self, owner: str, item_id: str) -> LibraryItem:
        resolved_owner = _normalize_owner(owner)
        resolved_id = _normalize_identifier(item_id, "item_id")
        async with self._write_lock:
            current = await self.get_item(resolved_owner, resolved_id)
            if current is None or current.kind != "artist":
                raise LibraryItemNotFoundError(resolved_id)
            data = dict(current.data)
            count = data.get("usage_count", 0)
            data["usage_count"] = max(0, _coerce_int(count)) + 1
            async with self.database.transaction() as connection:
                await connection.execute(
                    """
                    UPDATE library_entries SET data_json = ?, updated_at = ?
                    WHERE id = ? AND owner = ? AND kind = 'artist'
                    """,
                    (_canonical_data(data), _utc_now(), resolved_id, resolved_owner),
                )
        return await self.require_item(resolved_owner, resolved_id)

    async def asset_for_item(
        self,
        owner: str,
        item_id: str,
        *,
        role: Literal["primary", "thumbnail"] = "primary",
    ) -> tuple[AssetRecord, Path]:
        item = await self.require_item(owner, item_id)
        asset_id = item.primary_asset_id if role == "primary" else item.thumbnail_asset_id
        if not asset_id:
            raise ResourceNotFoundError(
                "library asset was not found",
                code="library_asset_not_found",
            )
        asset = await self.assets.require_asset(asset_id)
        path = self.assets.asset_path(asset)
        if asset.status == "missing" or not path.is_file() or path.is_symlink():
            raise ResourceNotFoundError(
                "library asset was not found",
                code="library_asset_not_found",
            )
        return asset, path

    async def _store_payload(
        self,
        item_id: str,
        kind: LibraryKind,
        role: str,
        payload: bytes | None,
        media_type: str | None,
        stored: list[str],
    ) -> str | None:
        if payload is None:
            return None
        if not isinstance(payload, bytes):
            raise InvalidArgumentError("library asset payload must be bytes")
        asset_id = f"library-{uuid.uuid4().hex}"
        extension = _extension_for(media_type)
        relative_path = f"library/{kind}/{item_id}/{role}-{asset_id[-12:]}.{extension}"
        await self.assets.store_bytes(
            asset_id,
            relative_path,
            payload,
            kind=f"library-{kind}-{role}",
            media_type=media_type,
            metadata={"library_item_id": item_id, "role": role},
        )
        stored.append(asset_id)
        return asset_id

    async def _remove_new_assets(self, asset_ids: Iterable[str]) -> None:
        for asset_id in reversed(tuple(asset_ids)):
            try:
                await self.assets.delete_asset(asset_id)
            except Exception:
                # Reconciliation retains a recoverable orphan if cleanup itself
                # fails; it must not hide the original application error.
                logger.warning(
                    "failed to clean up new library asset %s",
                    asset_id,
                    exc_info=True,
                )

    async def _import_legacy_rows(self) -> None:
        """Import rows created by older bundled versions using stable IDs."""

        async with self.database.transaction() as connection:
            for table, kind in (
                ("ocs", "oc"),
                ("artists", "artist"),
                ("crs", "cr"),
                ("vibes", "vibe"),
            ):
                cursor = await connection.execute(f"SELECT * FROM {table}")  # noqa: S608
                rows = await cursor.fetchall()
                await cursor.close()
                for row in rows:
                    item_id, lookup_key, data = _legacy_row(kind, row)
                    await connection.execute(
                        """
                        INSERT OR IGNORE INTO library_entries(
                            id, owner, kind, lookup_key, data_json, primary_asset_id,
                            thumbnail_asset_id, created_at, updated_at
                        ) VALUES (?, 'local', ?, ?, ?, NULL, NULL, ?, ?)
                        """,
                        (
                            item_id,
                            kind,
                            lookup_key,
                            _canonical_data(data),
                            str(row["updated_at"]),
                            str(row["updated_at"]),
                        ),
                    )

    async def _adopt_legacy_assets(self) -> None:
        async with self.database.connect() as connection:
            cursor = await connection.execute(
                """
                SELECT * FROM library_entries
                WHERE id LIKE 'legacy-%'
                  AND (primary_asset_id IS NULL OR thumbnail_asset_id IS NULL)
                ORDER BY id
                """
            )
            rows = await cursor.fetchall()
            await cursor.close()
        for row in rows:
            item = _row_to_item(row)
            data = dict(item.data)
            primary_id = item.primary_asset_id
            thumbnail_id = item.thumbnail_asset_id
            if primary_id is None:
                primary_id = await self._try_adopt_path(
                    item,
                    data.get("legacy_primary_path"),
                    role="primary",
                )
            if thumbnail_id is None:
                thumbnail_id = await self._try_adopt_path(
                    item,
                    data.get("legacy_thumbnail_path"),
                    role="thumbnail",
                )
            if primary_id == item.primary_asset_id and thumbnail_id == item.thumbnail_asset_id:
                continue
            async with self.database.transaction() as connection:
                await connection.execute(
                    """
                    UPDATE library_entries
                    SET primary_asset_id = ?, thumbnail_asset_id = ?, updated_at = ?
                    WHERE id = ? AND owner = ?
                    """,
                    (primary_id, thumbnail_id, _utc_now(), item.id, item.owner),
                )

    async def _try_adopt_path(
        self,
        item: LibraryItem,
        raw_path: JsonValue | None,
        *,
        role: Literal["primary", "thumbnail"],
    ) -> str | None:
        try:
            return await self._adopt_path(item, raw_path, role=role)
        except (AppError, OSError):
            # Historical paths are migration input, not a required runtime
            # dependency. Retain the row and retry on a later startup after a
            # capacity or file-permission issue has been repaired.
            logger.warning(
                "skipped unsafe or unavailable legacy library asset for %s (%s)",
                item.id,
                role,
                exc_info=True,
            )
            return None

    async def _adopt_path(
        self,
        item: LibraryItem,
        raw_path: JsonValue | None,
        *,
        role: Literal["primary", "thumbnail"],
    ) -> str | None:
        if not isinstance(raw_path, str) or not raw_path:
            return None
        source = _resolve_legacy_source(
            self.assets.root,
            self.database.path.parent / "data",
            raw_path,
        )
        if source is None:
            return None
        path, relative_path, inside_asset_root = source
        digest = hashlib.sha256(f"{item.id}:{role}".encode()).hexdigest()[:24]
        asset_id = f"library-legacy-{digest}"
        async with self.database.connect() as connection:
            existing_id = await _fetchone(
                connection,
                "SELECT id FROM assets WHERE id = ?",
                (asset_id,),
            )
            if existing_id is not None:
                return asset_id
            existing_path = await _fetchone(
                connection,
                "SELECT id FROM assets WHERE relative_path = ?",
                (relative_path,),
            )
        if existing_path is not None and inside_asset_root:
            return str(existing_path["id"])
        metadata: dict[str, JsonValue] = {
            "library_item_id": item.id,
            "role": role,
            "imported_from_legacy_path": True,
        }
        media_type = mimetypes.guess_type(path.name)[0]
        if inside_asset_root:
            await self.assets.register_asset(
                asset_id,
                path,
                kind=f"library-{item.kind}-{role}",
                media_type=media_type,
                metadata=metadata,
            )
        else:
            payload = await asyncio.to_thread(
                _read_bounded_file,
                path,
                MAX_SINGLE_ASSET_BYTES,
            )
            extension = path.suffix.lower().lstrip(".") or _extension_for(media_type)
            if not re.fullmatch(r"[A-Za-z0-9]{1,10}", extension):
                extension = _extension_for(media_type)
            destination = f"library/imported/{item.kind}/{digest}/{role}.{extension}"
            await self.assets.store_bytes(
                asset_id,
                destination,
                payload,
                kind=f"library-{item.kind}-{role}",
                media_type=media_type,
                metadata=metadata,
            )
        return asset_id


def _legacy_row(kind: str, row: aiosqlite.Row) -> tuple[str, str, dict[str, JsonValue]]:
    legacy_id = str(row["id"])
    item_id = f"legacy-{kind}-{legacy_id}"
    if kind == "oc":
        key = str(row["en_name"])
        data: dict[str, JsonValue] = {
            "en_name": key,
            "zh_name": row["zh_name"],
            "zh_aliases": _json_list(row["zh_aliases_json"]),
            "tag_group": str(row["tag_group"]),
            "negative_prompt": str(row["negative_prompt"] or ""),
            "created_by": str(row["created_by"] or "local"),
            "created_at": int(row["created_at"]),
            "legacy_id": legacy_id,
            "legacy_primary_path": row["preview_path"],
        }
    elif kind == "artist":
        key = str(row["name"])
        data = {
            "name": key,
            "artist_string": str(row["artist_string"]),
            "negative": str(row["negative"] or ""),
            "usage_count": int(row["usage_count"] or 0),
            "added_by": str(row["added_by"] or "local"),
            "created_time": int(row["created_time"]),
            "legacy_id": legacy_id,
            "legacy_primary_path": row["preview_path"],
        }
    elif kind == "cr":
        key = str(row["name"])
        data = {
            "name": key,
            "zh_names": _json_list(row["zh_names_json"]),
            "created_time": int(row["created_time"]),
            "legacy_id": legacy_id,
            "legacy_primary_path": row["preview_path"],
        }
    else:
        key = str(row["filename"])
        data = {
            "name": str(row["name"]),
            "filename": key,
            "supported_models": _json_list(row["supported_models_json"]),
            "default_strength": row["default_strength"],
            "default_info_extracted": row["default_info_extracted"],
            "created_at": int(row["created_at"]),
            "has_image": bool(row["has_image"]),
            "uploader_id": str(row["uploader_id"] or "local"),
            "uploaded_at": int(row["uploaded_at"] or row["created_at"]),
            "legacy_id": legacy_id,
            "legacy_primary_path": row["file_path"],
            "legacy_thumbnail_path": row["thumbnail_path"],
        }
    return item_id, key, data


def _resolve_legacy_source(
    asset_root: Path,
    legacy_data_root: Path,
    value: str,
) -> tuple[Path, str, bool] | None:
    asset = _safe_path_below(asset_root, value)
    if asset is not None:
        return asset[0], asset[1], True
    legacy = _safe_path_below(legacy_data_root, value)
    if legacy is None:
        return None
    return legacy[0], legacy[1], False


def _safe_path_below(root: Path, value: str) -> tuple[Path, str] | None:
    candidate = Path(value)
    if not candidate.is_absolute():
        candidate = root / candidate
    try:
        root_absolute = root.absolute()
        candidate_absolute = candidate.absolute()
        lexical_relative = candidate_absolute.relative_to(root_absolute)
        if ".." in lexical_relative.parts:
            return None
        current = root_absolute
        if current.is_symlink():
            return None
        for part in lexical_relative.parts:
            current = current / part
            if current.is_symlink():
                return None
        root_resolved = root.resolve(strict=True)
        candidate_resolved = candidate.resolve(strict=True)
        relative = candidate_resolved.relative_to(root_resolved)
        if not candidate_resolved.is_file():
            return None
    except (FileNotFoundError, OSError, RuntimeError, ValueError):
        return None
    return candidate_resolved, relative.as_posix()


def _read_bounded_file(path: Path, maximum: int) -> bytes:
    if path.stat().st_size > maximum:
        raise InvalidArgumentError("legacy library asset is too large")
    with path.open("rb") as handle:
        payload = handle.read(maximum + 1)
    if len(payload) > maximum:
        raise InvalidArgumentError("legacy library asset is too large")
    return payload


def _row_to_item(row: aiosqlite.Row) -> LibraryItem:
    data = json.loads(str(row["data_json"]))
    if not isinstance(data, dict):
        raise InvalidArgumentError("library item data is invalid")
    return LibraryItem(
        id=str(row["id"]),
        owner=str(row["owner"]),
        kind=_normalize_kind(str(row["kind"])),
        lookup_key=str(row["lookup_key"]),
        data=data,
        primary_asset_id=(
            str(row["primary_asset_id"]) if row["primary_asset_id"] is not None else None
        ),
        thumbnail_asset_id=(
            str(row["thumbnail_asset_id"]) if row["thumbnail_asset_id"] is not None else None
        ),
        created_at=str(row["created_at"]),
        updated_at=str(row["updated_at"]),
    )


async def _fetchone(
    connection: aiosqlite.Connection,
    sql: str,
    parameters: Iterable[object] = (),
) -> aiosqlite.Row | None:
    cursor = await connection.execute(sql, tuple(parameters))
    row = await cursor.fetchone()
    await cursor.close()
    return row


def _normalize_owner(value: str) -> str:
    return _normalize_identifier(value, "owner")


def _normalize_identifier(value: str, label: str) -> str:
    if not isinstance(value, str) or not _IDENTIFIER.fullmatch(value):
        raise InvalidArgumentError(f"invalid {label}")
    return value


def _normalize_kind(value: str) -> LibraryKind:
    if value not in LIBRARY_KINDS:
        raise InvalidArgumentError("unknown library kind")
    return value  # type: ignore[return-value]


def _normalize_key(value: str) -> str:
    if not isinstance(value, str):
        raise InvalidArgumentError("invalid library key")
    key = value.strip()
    if not key or len(key) > 256 or any(ord(character) < 0x20 for character in key):
        raise InvalidArgumentError("invalid library key")
    return key


def _canonical_data(value: Mapping[str, JsonValue]) -> str:
    try:
        encoded = json.dumps(
            dict(value),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
    except (TypeError, ValueError) as exc:
        raise InvalidArgumentError("library data must be valid JSON") from exc
    if len(encoded.encode("utf-8")) > _MAX_DATA_BYTES:
        raise InvalidArgumentError("library data is too large")
    return encoded


def _public_data(value: Mapping[str, JsonValue]) -> dict[str, JsonValue]:
    return {key: item for key, item in value.items() if not key.startswith("legacy_")}


def _json_list(value: object) -> list[Any]:
    try:
        parsed = json.loads(str(value or "[]"))
    except json.JSONDecodeError:
        return []
    return parsed if isinstance(parsed, list) else []


def _coerce_int(value: object) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float, str)):
        try:
            return int(value)
        except ValueError:
            return 0
    return 0


def _extension_for(media_type: str | None) -> str:
    return {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/webp": "webp",
        "application/json": "json",
    }.get((media_type or "").lower(), "bin")


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


__all__ = [
    "LIBRARY_KINDS",
    "LibraryConflictError",
    "LibraryItem",
    "LibraryItemNotFoundError",
    "LibraryKind",
    "LibraryService",
]
