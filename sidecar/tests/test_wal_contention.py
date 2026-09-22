"""切进 WAL 时的锁竞争:busy_timeout 盖不住它,退避要自己做。

背景(实测,不是推断):`PRAGMA journal_mode = WAL` 在别的连接持写锁时
**0.000 s 就抛 ``database is locked``,尽管 busy_timeout 设了 5000 ms** ——
切**进** WAL 要独占锁,而这条语句不走 busy handler。CI(ubuntu)上因此偶发红:
两条初始化路径撞在一起,输掉的那条 fail-closed 起不来。生产上同样会发生:
sidecar 重启与旧进程收尾重叠、单实例守卫失手时,同一个库上就有两条初始化路径。

这里的用例**不靠竞态**:锁由测试自己持有和释放,每一条都是确定的。
"""

from __future__ import annotations

import asyncio
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

import aiosqlite

from sidecar.persistence.migrations import (
    DatabaseIntegrityError,
    configure_live_connection,
)


def _hold_write_lock(path: Path) -> sqlite3.Connection:
    """拿一条**持着写锁**的连接回来。调用方负责关掉它来释放锁。"""
    connection = sqlite3.connect(path)
    connection.execute("PRAGMA busy_timeout = 5000")
    connection.execute("CREATE TABLE IF NOT EXISTS lock_probe(x)")
    connection.commit()
    connection.execute("BEGIN IMMEDIATE")
    connection.execute("INSERT INTO lock_probe VALUES (1)")
    return connection


class WalContentionTests(unittest.IsolatedAsyncioTestCase):
    async def test_busy_timeout_alone_does_not_cover_the_wal_switch(self) -> None:
        """钉住前提:这就是为什么非自己退避不可。

        这条不测我们的代码,测的是 SQLite 的行为——一旦哪天它改了(busy handler
        开始覆盖 journal_mode 切换),这条会红,提醒下一个人 `_enable_wal` 可以简化掉。
        """
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "app.sqlite3"
            with closing(_hold_write_lock(path)):
                async with aiosqlite.connect(path) as connection:
                    await connection.execute("PRAGMA busy_timeout = 5000")
                    loop = asyncio.get_running_loop()
                    started = loop.time()
                    with self.assertRaises(aiosqlite.OperationalError) as raised:
                        await connection.execute("PRAGMA journal_mode = WAL")
                    elapsed = loop.time() - started
            self.assertIn("locked", str(raised.exception).lower())
            # 5 s 的 busy_timeout 却在 1 s 内就返回 ⇒ busy handler 没被调用。
            self.assertLess(elapsed, 1.0)

    async def test_wal_switch_waits_out_a_competing_writer(self) -> None:
        """对手在预算内收尾 → 我们重试成功,不再 fail-closed。"""
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "app.sqlite3"
            holder = _hold_write_lock(path)

            async def release_soon() -> None:
                await asyncio.sleep(0.05)
                holder.rollback()
                holder.close()

            releaser = asyncio.create_task(release_soon())
            try:
                async with aiosqlite.connect(path) as connection:
                    await configure_live_connection(
                        connection, busy_timeout_ms=5000, enable_wal=True
                    )
                    cursor = await connection.execute("PRAGMA journal_mode")
                    row = await cursor.fetchone()
                    await cursor.close()
            finally:
                await releaser
            if row is None:
                self.fail("PRAGMA journal_mode returned no row")
            self.assertEqual(str(row[0]).lower(), "wal")

    async def test_exhausted_budget_still_fails_closed(self) -> None:
        """对手一直不放手 → 仍然起不来。带着错的 journal mode 起来更危险。"""
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "app.sqlite3"
            with closing(_hold_write_lock(path)):
                async with aiosqlite.connect(path) as connection:
                    with self.assertRaises(DatabaseIntegrityError):
                        await configure_live_connection(
                            connection, busy_timeout_ms=100, enable_wal=True
                        )

    async def test_already_wal_is_idempotent_under_contention(self) -> None:
        """库已经是 WAL 时不需要独占锁 —— 这正是重试能成的原因。"""
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "app.sqlite3"
            with closing(sqlite3.connect(path)) as setup:
                setup.execute("PRAGMA journal_mode = WAL")
                setup.commit()

            with closing(_hold_write_lock(path)):
                async with aiosqlite.connect(path) as connection:
                    loop = asyncio.get_running_loop()
                    started = loop.time()
                    await configure_live_connection(
                        connection, busy_timeout_ms=5000, enable_wal=True
                    )
                    elapsed = loop.time() - started
            # 走的是幂等路径:没等预算,立刻返回。
            self.assertLess(elapsed, 1.0)

    async def test_non_lock_errors_are_not_swallowed(self) -> None:
        """只吸收锁竞争。损坏 / 只读 / 磁盘满之类要原样冒上去,不能被重试掩盖。"""
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "app.sqlite3"
            path.write_bytes(b"this is definitely not a sqlite database")
            async with aiosqlite.connect(path) as connection:
                started = asyncio.get_running_loop().time()
                with self.assertRaises(DatabaseIntegrityError):
                    await configure_live_connection(
                        connection, busy_timeout_ms=5000, enable_wal=True
                    )
                elapsed = asyncio.get_running_loop().time() - started
            # 立刻抛,而不是先把 5 s 预算耗光。
            self.assertLess(elapsed, 1.0)


if __name__ == "__main__":
    unittest.main()
