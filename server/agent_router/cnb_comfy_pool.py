"""
通用 cnb ComfyUI 账户池 —— CNBComfyPool

提炼自 bot 端 core/external_ai_services.py 的千问视频 cnb 模块（_qianwen_video_*）。
把 workspace 启停 / 健康检查 / 任务队列 / 巡检 / 重启 / 动态扩容 / shutdown 等所有
和具体业务无关的通用逻辑封装成 class，多个出图服务（anima / 千问视频 / 未来的 wan / ...）
可以各自实例化一个 CNBComfyPool，状态以 name 为 namespace 隔离。

业务方（如 anima_provider）只需要:
    pool = CNBComfyPool(
        name="anima",
        accounts=ANIMA_CNB_ACCOUNTS,
        store_path=ANIMA_ACCOUNT_STORE,
        patrol_interval=ANIMA_PATROL_INTERVAL_SECONDS,
        ...
    )
    pool.start_patrol()

    # 出图时
    account, queue_position = await pool.acquire_local_account(task_id)
    try:
        base_url = await pool.ensure_account_ready_url(account)
        # 业务: POST {base_url}/prompt, 轮询 /history, GET /view
    finally:
        await pool.release_local_account(account, task_id)

    # 关闭时
    await pool.cancel_background_tasks()

设计要点:
    - 所有可变状态都是 instance attribute，不再有模块全局变量
    - 持久化 store 文件按 instance 独立
    - 巡检任务也按 instance 独立启动 + 取消
    - 业务函数（patch_payload / 提交 prompt / 等待 history / 下载图）不在这里，留给 provider
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import Iterable
from pathlib import Path
from urllib.parse import quote, urlencode

import aiohttp

# ============================================================
# 异常
# ============================================================


class CNBComfyTimeoutError(Exception):
    """workspace 启动 / 出图等待超时。"""


class CNBComfyRestartScheduledError(Exception):
    """触发了后台重启，调用方应换账户或重试。"""


# ============================================================
# CNBComfyPool
# ============================================================


class CNBComfyPool:
    """
    通用 cnb ComfyUI 账户池。所有 workspace 生命周期与本地任务队列管理都在这里。
    业务方只关心 acquire → ensure_url → 自己调 ComfyUI → release。
    """

    # ----- 构造 -----
    def __init__(
        self,
        *,
        name: str,
        accounts: list[dict],
        store_path: Path | str,
        request_timeout: int = 60,
        detail_poll_interval: int = 5,
        ready_timeout: int = 1200,
        patrol_interval: int = 60,
        idle_shutdown_seconds: int = 1200,
        account_max_running_seconds: int = 3600,
        local_active_stale_seconds: int = 180,
        scale_queue_per_account: int = 2,
        running_timeout_seconds: int = 300,
        healthcheck_timeout: int = 15,
        logger: logging.Logger | None = None,
    ):
        self.name = name
        self._raw_accounts = list(accounts or [])
        self.store_path = Path(str(store_path))
        self.request_timeout = int(request_timeout)
        self.detail_poll_interval = int(detail_poll_interval)
        self.ready_timeout = int(ready_timeout)
        self.patrol_interval = int(patrol_interval)
        self.idle_shutdown_seconds = int(idle_shutdown_seconds)
        self.account_max_running_seconds = int(account_max_running_seconds)
        self.local_active_stale_seconds = int(local_active_stale_seconds)
        self.scale_queue_per_account = int(scale_queue_per_account)
        self.running_timeout_seconds = int(running_timeout_seconds)
        self.healthcheck_timeout = int(healthcheck_timeout)
        self.logger = logger or logging.getLogger(f"cnb_comfy_pool.{name}")

        # ===== 可变状态（per-instance namespace） =====
        self._account_store_cache: dict | None = None

        self._comfy_cursor: int = 0  # 轮换游标
        self._restart_locks: dict[str, asyncio.Lock] = {}
        self._restarting_accounts: set[str] = set()

        self._local_queue: list[str] = []
        self._local_active: dict[str, dict] = {}
        self._waiting_tasks: set[str] = set()
        self._account_last_used_at: dict[str, float] = {}

        self._queue_condition: asyncio.Condition = asyncio.Condition()

        self._background_tasks: set[asyncio.Task] = set()
        self._patrol_task: asyncio.Task | None = None
        self._shutdown: bool = False

    # ----- 账户配置规范化 -----
    def _normalize_account(self, item: dict) -> dict | None:
        repo = str(item.get("repo") or "").strip()
        token = str(item.get("token") or "").strip()
        if not repo or not token:
            return None
        return {
            "name": str(item.get("name") or "").strip(),
            "api_base": str(item.get("api_base") or "https://api.cnb.cool").strip().rstrip("/"),
            "repo": repo,
            "branch": str(item.get("branch") or "main").strip(),
            "token": token,
        }

    def get_accounts(self) -> list[dict]:
        """返回规范化后的账户列表。"""
        out: list[dict] = []
        for item in self._raw_accounts:
            if not isinstance(item, dict):
                continue
            normalized = self._normalize_account(item)
            if normalized:
                out.append(normalized)
        return out

    @staticmethod
    def get_account_key(account: dict) -> str:
        name = str(account.get("name") or "").strip()
        repo = str(account.get("repo") or "").strip()
        branch = str(account.get("branch") or "main").strip()
        return name or f"{repo}@{branch}"

    # ============================================================
    # 持久化 store
    # ============================================================

    def load_account_store(self) -> dict:
        if self._account_store_cache is not None:
            return self._account_store_cache
        if not self.store_path.is_file():
            self._account_store_cache = {"accounts": {}, "urls": []}
            return self._account_store_cache
        try:
            data = json.loads(self.store_path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                data.setdefault("accounts", {})
                data.setdefault("urls", [])
                self._account_store_cache = data
                return self._account_store_cache
        except Exception as e:
            self.logger.warning(f"账户 store 解析失败 {self.store_path}: {e}")
        self._account_store_cache = {"accounts": {}, "urls": []}
        return self._account_store_cache

    def save_account_store(self, store: dict) -> None:
        self._account_store_cache = store
        self.store_path.parent.mkdir(parents=True, exist_ok=True)
        store["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        self.store_path.write_text(
            json.dumps(store, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def _sync_store_urls(self, store: dict) -> dict:
        urls: list[str] = []
        accounts_block = store.get("accounts") if isinstance(store, dict) else {}
        if isinstance(accounts_block, dict):
            for info in accounts_block.values():
                if not isinstance(info, dict):
                    continue
                url = str(info.get("url") or "").strip().rstrip("/")
                if url and url not in urls:
                    urls.append(url)
        store["urls"] = urls
        return store

    def update_account_store(self, account: dict, **fields) -> None:
        store = self.load_account_store()
        accounts_block = store.setdefault("accounts", {})
        account_key = self.get_account_key(account)
        current = accounts_block.get(account_key)
        if not isinstance(current, dict):
            current = {}
        current.update(
            {
                "name": account.get("name") or account_key,
                "repo": account.get("repo"),
                "branch": account.get("branch"),
                "api_base": account.get("api_base"),
                **fields,
            }
        )
        accounts_block[account_key] = current
        self._sync_store_urls(store)
        self.save_account_store(store)

    def get_account_url(self, account: dict) -> str:
        store = self.load_account_store()
        account_key = self.get_account_key(account)
        accounts_block = store.get("accounts") if isinstance(store, dict) else {}
        if isinstance(accounts_block, dict):
            info = accounts_block.get(account_key)
            if isinstance(info, dict):
                return str(info.get("url") or "").strip().rstrip("/")
        return ""

    def get_account_workspace_create_time(self, account: dict) -> int | None:
        store = self.load_account_store()
        account_key = self.get_account_key(account)
        accounts_block = store.get("accounts") if isinstance(store, dict) else {}
        if not isinstance(accounts_block, dict):
            return None
        info = accounts_block.get(account_key)
        if not isinstance(info, dict):
            return None
        raw_value = info.get("create_time")
        if raw_value is None:
            return None
        try:
            value = int(raw_value)
        except Exception:
            return None
        return value if value > 0 else None

    # ============================================================
    # 轮换 + 选账户
    # ============================================================

    def get_next_account(self) -> dict | None:
        accounts = self.get_accounts()
        if not accounts:
            return None
        selected = accounts[self._comfy_cursor % len(accounts)]
        self._comfy_cursor += 1
        return selected

    def get_account_order(self) -> list[dict]:
        accounts = self.get_accounts()
        if not accounts:
            return []
        start = self._comfy_cursor % len(accounts)
        ordered = accounts[start:] + accounts[:start]
        self._comfy_cursor += 1
        return ordered

    def _pick_free_account_locked(self) -> dict | None:
        accounts = self.get_accounts()
        if not accounts:
            return None
        start = self._comfy_cursor % len(accounts)
        ordered = accounts[start:] + accounts[:start]
        for offset, account in enumerate(ordered):
            account_key = self.get_account_key(account)
            if account_key in self._restarting_accounts:
                continue
            if account_key in self._local_active:
                continue
            self._comfy_cursor = start + offset + 1
            return account
        return None

    # ============================================================
    # cnb workspace REST API
    # ============================================================

    async def cnb_api_request(
        self, method: str, url: str, token: str, payload: dict | None = None
    ) -> dict:
        headers = {
            "Accept": "application/vnd.cnb.api+json",
            "Authorization": token,
        }
        if payload is not None:
            headers["Content-Type"] = "application/json"
        timeout = aiohttp.ClientTimeout(total=self.request_timeout)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.request(method.upper(), url, headers=headers, json=payload) as resp:
                text = await resp.text()
                if resp.status >= 400:
                    raise Exception(f"CNB API {resp.status}: {text[:300]}")
        return json.loads(text) if text else {}

    async def list_workspaces(self, account: dict, status: str | None = None) -> list[dict]:
        api_base = str(account.get("api_base") or "").rstrip("/")
        repo = str(account.get("repo") or "").strip()
        branch = str(account.get("branch") or "main").strip()
        token = str(account.get("token") or "").strip()
        query = {
            "slug": repo,
            "branch": branch,
            "page": 1,
            "page_size": 20,
        }
        if status:
            query["status"] = status
        list_url = f"{api_base}/workspace/list?{urlencode(query)}"
        data = await self.cnb_api_request("GET", list_url, token, None)
        items = data.get("list") if isinstance(data, dict) else None
        if not isinstance(items, list):
            return []
        matched: list[dict] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            if str(item.get("slug") or "") != repo:
                continue
            if str(item.get("branch") or "") != branch:
                continue
            matched.append(item)
        matched.sort(key=lambda x: str(x.get("create_time") or ""), reverse=True)
        return matched

    async def stop_workspace_item(self, account: dict, item: dict) -> None:
        api_base = str(account.get("api_base") or "").rstrip("/")
        token = str(account.get("token") or "").strip()
        stop_payload: dict = {}
        pipeline_id = str(item.get("pipeline_id") or "").strip()
        sn = str(item.get("sn") or "").strip()
        if pipeline_id:
            stop_payload["pipelineId"] = pipeline_id
        elif sn:
            stop_payload["sn"] = sn
        if not api_base or not token or not stop_payload:
            raise Exception("缺少停止 workspace 所需参数")
        stop_url = f"{api_base}/workspace/stop"
        try:
            await self.cnb_api_request("POST", stop_url, token, stop_payload)
        except Exception as e:
            error_text = str(e)
            if "STOP_FAIL_WRONG_STATUS" in error_text and "already end" in error_text:
                return
            raise

    @staticmethod
    def workspace_item_to_url(item: dict) -> str:
        """cnb workspace 的 ComfyUI 端口转发 URL（固定 8188）。"""
        business_id = str(item.get("business_id") or "").strip()
        if not business_id:
            return ""
        return f"https://{business_id}-8188.cnb.run"

    # ============================================================
    # ComfyUI 健康检查
    # ============================================================

    async def healthcheck(self, base_url: str, timeout_seconds: int | None = None) -> bool:
        """同时校验 /system_stats 和 /object_info 都返回正常 ComfyUI JSON 结构。"""
        base = str(base_url or "").rstrip("/")
        if not base:
            return False
        system_url = f"{base}/system_stats"
        object_info_url = f"{base}/object_info"
        timeout = aiohttp.ClientTimeout(total=int(timeout_seconds or self.healthcheck_timeout))
        try:
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.get(system_url) as resp:
                    if resp.status != 200:
                        return False
                    system_text = await resp.text()
                async with session.get(object_info_url) as resp:
                    if resp.status != 200:
                        return False
                    object_info_text = await resp.text()
        except Exception:
            return False
        try:
            system_data = json.loads(system_text) if system_text else {}
            object_info_data = json.loads(object_info_text) if object_info_text else {}
        except Exception:
            return False
        return (
            isinstance(system_data.get("system"), dict)
            and isinstance(system_data.get("devices"), list)
            and "comfyui_version" in system_data.get("system", {})
            and isinstance(object_info_data, dict)
            and bool(object_info_data)
        )

    # ============================================================
    # workspace 启停核心
    # ============================================================

    async def resolve_account_url(self, account: dict) -> str:
        """先看 store 缓存 URL；否则拉 running list 找。返回健康的 URL 或空串。"""
        stored_url = self.get_account_url(account)
        if stored_url:
            try:
                if await self.healthcheck(stored_url, 10):
                    return stored_url
            except Exception:
                self.logger.debug("缓存 workspace URL 健康检查失败", exc_info=True)

        running_items = await self.list_workspaces(account, status="running")
        for item in running_items:
            candidate = self.workspace_item_to_url(item)
            if not candidate:
                continue
            try:
                if await self.healthcheck(candidate, 10):
                    self.update_account_store(
                        account,
                        url=candidate,
                        sn=item.get("sn"),
                        pipeline_id=item.get("pipeline_id"),
                        business_id=item.get("business_id"),
                        status=item.get("status"),
                        create_time=item.get("create_time"),
                    )
                    return candidate
            except Exception:
                self.logger.debug("候选 workspace URL 健康检查失败", exc_info=True)
                continue
        return ""

    async def restart_workspace(self, account: dict, force_restart: bool = False) -> str:
        """启动（或强制重启）workspace 直到 ComfyUI 健康。返回 base_url。"""
        account_key = self.get_account_key(account)
        if account_key not in self._restart_locks:
            self._restart_locks[account_key] = asyncio.Lock()
        async with self._restart_locks[account_key]:
            ready_url = await self.resolve_account_url(account)
            if ready_url and not force_restart:
                return ready_url

            api_base = str(account.get("api_base") or "").rstrip("/")
            repo = str(account.get("repo") or "").strip()
            branch = str(account.get("branch") or "main").strip()
            token = str(account.get("token") or "").strip()
            poll_interval = self.detail_poll_interval
            ready_timeout = self.ready_timeout

            if not api_base or not repo or not token:
                raise Exception("未配置 CNB 工作空间启停参数")

            repo_path = quote(repo, safe="")
            if force_restart:
                stop_deadline = time.time() + ready_timeout
                while time.time() < stop_deadline:
                    running_items = await self.list_workspaces(account, status="running")
                    if not running_items:
                        break
                    for item in running_items:
                        try:
                            await self.stop_workspace_item(account, item)
                        except Exception as e:
                            self.logger.warning(
                                f"[{self.name}] workspace 停止失败,继续轮询重试: {repo} {branch} "
                                f"pipeline_id={item.get('pipeline_id')} sn={item.get('sn')} {e}"
                            )
                    await asyncio.sleep(max(poll_interval, 1))

                remaining_running_items = await self.list_workspaces(account, status="running")
                if remaining_running_items:
                    raise Exception("CNB 工作空间强制关闭超时，仍存在 running workspace")

                self.update_account_store(
                    account,
                    url="",
                    sn=None,
                    pipeline_id=None,
                    business_id=None,
                    status="closed",
                    create_time=None,
                )

            start_url = f"{api_base}/{repo_path}/-/workspace/start"
            await self.cnb_api_request("POST", start_url, token, {"branch": branch})

            deadline = time.time() + ready_timeout
            seen_started_workspace = False
            while time.time() < deadline:
                items = await self.list_workspaces(account, status="running")
                if items:
                    seen_started_workspace = True
                for item in items:
                    new_url = self.workspace_item_to_url(item)
                    if not new_url:
                        continue
                    try:
                        if await self.healthcheck(new_url, 15):
                            self.update_account_store(
                                account,
                                url=new_url,
                                sn=item.get("sn"),
                                pipeline_id=item.get("pipeline_id"),
                                business_id=item.get("business_id"),
                                status=item.get("status"),
                                create_time=item.get("create_time"),
                            )
                            return new_url
                    except Exception:
                        self.logger.debug("workspace 启动后的健康检查失败", exc_info=True)
                await asyncio.sleep(max(poll_interval, 1))

            if not seen_started_workspace:
                raise Exception(
                    "CNB 工作空间启动后未在超时前出现在 workspace/list 的 running 列表中"
                )
            raise Exception("CNB 工作空间重启后未在超时前变为可用")

    async def ensure_account_restarting(self, account: dict) -> None:
        """异步触发账户重启（防并发；最多 3 次重试，间隔 30s）。"""
        account_key = self.get_account_key(account)
        if account_key in self._restarting_accounts:
            return
        self._restarting_accounts.add(account_key)

        async def _runner():
            max_retries = 3
            try:
                for attempt in range(1, max_retries + 1):
                    try:
                        new_url = await self.restart_workspace(account, force_restart=True)
                        self.logger.info(
                            f"[{self.name}] workspace 已恢复 {account_key} -> {new_url}"
                        )
                        self._account_last_used_at[account_key] = time.time()
                        break
                    except asyncio.CancelledError:
                        raise
                    except Exception as e:
                        self.logger.error(
                            f"[{self.name}] workspace 恢复失败 {account_key} "
                            f"(第{attempt}/{max_retries}次): {e}"
                        )
                        if attempt < max_retries:
                            await asyncio.sleep(30)
                        else:
                            self.logger.error(
                                f"[{self.name}] workspace 恢复彻底失败 {account_key}，已耗尽重试"
                            )
            except asyncio.CancelledError:
                self.logger.info(f"[{self.name}] workspace 恢复任务被取消 {account_key}")
            finally:
                self._restarting_accounts.discard(account_key)
                try:
                    async with self._queue_condition:
                        self._queue_condition.notify_all()
                except Exception:
                    self.logger.debug("唤醒 workspace 等待队列失败", exc_info=True)

        task = asyncio.create_task(_runner())
        self._background_tasks.add(task)
        task.add_done_callback(lambda t: self._background_tasks.discard(t))

    async def ensure_account_ready_url(self, account: dict) -> str:
        """业务侧用：保证账户有可用 base_url（同步等到 ready，不走后台重启）。"""
        base_url = await self.resolve_account_url(account)
        if base_url:
            return base_url
        return await self.restart_workspace(account)

    async def stop_account_workspace(self, account: dict) -> bool:
        """关闭账户当前 running workspace；返回是否实际停了。"""
        account_key = self.get_account_key(account)
        stopped = False
        try:
            items = await self.list_workspaces(account, status="running")
            for item in items:
                try:
                    await self.stop_workspace_item(account, item)
                    stopped = True
                except Exception as e:
                    self.logger.warning(f"[{self.name}] 关闭 workspace 失败 {account_key}: {e}")
        except Exception as e:
            self.logger.warning(f"[{self.name}] 查询 workspace 失败 {account_key}: {e}")
        if stopped:
            self._account_store_cache = None
            store = self.load_account_store()
            acc_data = store.get("accounts", {}).get(account_key)
            if isinstance(acc_data, dict):
                acc_data.pop("url", None)
                acc_data.pop("status", None)
                self.save_account_store(store)
        return stopped

    # ============================================================
    # ComfyUI 队列守护（出图层用）
    # ============================================================

    async def get_queue(self, base_url: str) -> dict:
        timeout = aiohttp.ClientTimeout(total=30)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(f"{base_url}/queue") as resp:
                text = await resp.text()
                if resp.status != 200:
                    raise Exception(f"读取队列失败: {resp.status} {text[:200]}")
                return json.loads(text) if text else {}

    async def get_history(self, base_url: str) -> dict:
        timeout = aiohttp.ClientTimeout(total=30)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(f"{base_url}/history") as resp:
                text = await resp.text()
                if resp.status != 200:
                    raise Exception(f"读取历史失败: {resp.status} {text[:200]}")
                return json.loads(text) if text else {}

    async def delete_queue_items(self, base_url: str, prompt_ids: Iterable[str]) -> None:
        ids = [str(x).strip() for x in (prompt_ids or []) if str(x).strip()]
        if not ids:
            return
        timeout = aiohttp.ClientTimeout(total=30)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(f"{base_url}/queue", json={"delete": ids}) as resp:
                text = await resp.text()
                if resp.status != 200:
                    raise Exception(f"删除队列任务失败: {resp.status} {text[:200]}")

    async def interrupt(self, base_url: str) -> None:
        timeout = aiohttp.ClientTimeout(total=30)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(f"{base_url}/interrupt") as resp:
                text = await resp.text()
                if resp.status != 200:
                    raise Exception(f"中断运行任务失败: {resp.status} {text[:200]}")

    @staticmethod
    def extract_queue_prompt_ids(queue_items) -> list[str]:
        prompt_ids: list[str] = []
        for item in queue_items or []:
            if isinstance(item, str):
                if item not in prompt_ids:
                    prompt_ids.append(item)
                continue
            if isinstance(item, (list, tuple)):
                for value in item:
                    if isinstance(value, str) and value not in prompt_ids:
                        prompt_ids.append(value)
                        break
            elif isinstance(item, dict):
                for key in ("prompt_id", "id"):
                    value = item.get(key)
                    if isinstance(value, str) and value not in prompt_ids:
                        prompt_ids.append(value)
                        break
        return prompt_ids

    @staticmethod
    def extract_queue_task_meta(queue_items) -> list[dict]:
        tasks: list[dict] = []
        seen_prompt_ids: set[str] = set()
        for item in queue_items or []:
            prompt_id = None
            meta = {}
            if isinstance(item, (list, tuple)):
                for value in item:
                    if prompt_id is None and isinstance(value, str):
                        prompt_id = value
                    elif isinstance(value, dict):
                        meta = value
            elif isinstance(item, dict):
                prompt_id = item.get("prompt_id") or item.get("id")
                meta = item

            prompt_id = str(prompt_id or "").strip()
            if not prompt_id or prompt_id in seen_prompt_ids:
                continue

            create_time_raw = meta.get("create_time") if isinstance(meta, dict) else None
            try:
                create_time = int(create_time_raw) if create_time_raw is not None else None
            except Exception:
                create_time = None

            tasks.append(
                {
                    "prompt_id": prompt_id,
                    "create_time": create_time,
                    "client_id": meta.get("client_id") if isinstance(meta, dict) else None,
                }
            )
            seen_prompt_ids.add(prompt_id)
        return tasks

    async def guard_queue(self, base_url: str) -> dict:
        """读队列状态；若 running 中有任务超时则 /interrupt 并重读。"""
        queue_data = await self.get_queue(base_url)
        running_items = queue_data.get("queue_running") or []
        pending_items = queue_data.get("queue_pending") or []
        running_ids = self.extract_queue_prompt_ids(running_items)
        pending_ids = self.extract_queue_prompt_ids(pending_items)
        running_tasks = self.extract_queue_task_meta(running_items)
        now_ms = int(time.time() * 1000)
        stale_running_ids = [
            str(task.get("prompt_id") or "").strip()
            for task in running_tasks
            if task.get("create_time")
            and ((now_ms - int(task["create_time"])) / 1000.0) > self.running_timeout_seconds
        ]

        if stale_running_ids:
            try:
                await self.interrupt(base_url)
                self.logger.warning(
                    f"[{self.name}] 发现超时 running 任务,已中断: {stale_running_ids}"
                )
            except Exception as e:
                self.logger.warning(f"[{self.name}] 中断超时 running 任务失败: {e}")
            queue_data = await self.get_queue(base_url)
            running_items = queue_data.get("queue_running") or []
            pending_items = queue_data.get("queue_pending") or []
            running_ids = self.extract_queue_prompt_ids(running_items)
            pending_ids = self.extract_queue_prompt_ids(pending_items)
            running_tasks = self.extract_queue_task_meta(running_items)

        return {
            "running_ids": running_ids,
            "pending_ids": pending_ids,
            "running_tasks": running_tasks,
            "running_count": len(running_ids),
            "pending_count": len(pending_ids),
            "stale_running_ids": stale_running_ids,
        }

    async def cleanup_prompt(
        self, base_url: str, prompt_id: str | None, interrupt_running: bool = False
    ) -> None:
        if not base_url:
            return
        try:
            queue_data = await self.get_queue(base_url)
        except Exception as e:
            self.logger.warning(f"[{self.name}] 读取队列用于清理失败: {e}")
            return

        running_ids = self.extract_queue_prompt_ids(queue_data.get("queue_running") or [])
        pending_ids = self.extract_queue_prompt_ids(queue_data.get("queue_pending") or [])

        try:
            if prompt_id and prompt_id in pending_ids:
                await self.delete_queue_items(base_url, [prompt_id])
                self.logger.warning(f"[{self.name}] 已清理 pending 任务: {prompt_id}")
        except Exception as e:
            self.logger.warning(f"[{self.name}] 删除 pending 任务失败 {prompt_id}: {e}")

        if interrupt_running and prompt_id and prompt_id in running_ids:
            try:
                await self.interrupt(base_url)
                self.logger.warning(f"[{self.name}] 已中断运行中任务: {prompt_id}")
            except Exception as e:
                self.logger.warning(f"[{self.name}] 中断运行任务失败 {prompt_id}: {e}")

    # ============================================================
    # 本地任务队列 + 动态扩容
    # ============================================================

    async def acquire_local_account(self, task_id: str) -> tuple[dict, int]:
        """阻塞等到分到一个空闲账户。返回 (account, 当时入队位置)。"""
        async with self._queue_condition:
            if task_id not in self._local_queue:
                self._local_queue.append(task_id)
            self._waiting_tasks.add(task_id)
            initial_position: int | None = None
            try:
                while True:
                    overtime_accounts: list[dict] = []
                    stale_active_account_keys: list[str] = []
                    now_ts = time.time()

                    for active_account in self.get_accounts():
                        account_key = self.get_account_key(active_account)

                        # 1) 卡死检测：本地标占用但远端队列实际空
                        active_meta = self._local_active.get(account_key)
                        if isinstance(active_meta, dict):
                            started_at = float(active_meta.get("started_at") or 0)
                            if (
                                self.local_active_stale_seconds > 0
                                and started_at > 0
                                and (now_ts - started_at) > self.local_active_stale_seconds
                            ):
                                base_url = self.get_account_url(active_account)
                                if base_url:
                                    try:
                                        queue_guard = await self.guard_queue(base_url)
                                        if not queue_guard.get(
                                            "running_ids"
                                        ) and not queue_guard.get("pending_ids"):
                                            stale_active_account_keys.append(account_key)
                                            continue
                                    except Exception:
                                        self.logger.debug("巡检 stale 账户队列失败", exc_info=True)

                        # 2) workspace 跑太久：强制重启
                        if (
                            self.account_max_running_seconds > 0
                            and account_key not in self._restarting_accounts
                        ):
                            ws_ms = self.get_account_workspace_create_time(active_account)
                            if ws_ms:
                                elapsed = now_ts - (ws_ms / 1000.0)
                                if elapsed > self.account_max_running_seconds:
                                    self._local_active.pop(account_key, None)
                                    overtime_accounts.append(active_account)

                    for stale_key in stale_active_account_keys:
                        self._local_active.pop(stale_key, None)
                        self.logger.warning(f"[{self.name}] 清理本地卡死占用: {stale_key}")
                    for overtime_account in overtime_accounts:
                        await self.ensure_account_restarting(overtime_account)

                    # 3) 清理僵尸队列任务
                    zombie_ids = [
                        tid
                        for tid in self._local_queue
                        if tid != task_id and tid not in self._waiting_tasks
                    ]
                    for zombie_id in zombie_ids:
                        self._local_queue.remove(zombie_id)
                        self.logger.warning(f"[{self.name}] 清理僵尸队列任务: {zombie_id}")

                    try:
                        position = self._local_queue.index(task_id) + 1
                    except ValueError:
                        self._local_queue.append(task_id)
                        position = len(self._local_queue)
                    if initial_position is None:
                        initial_position = position

                    account = self._pick_free_account_locked() if position == 1 else None
                    if account is not None:
                        self._local_queue.remove(task_id)
                        self._local_active[self.get_account_key(account)] = {
                            "task_id": task_id,
                            "started_at": time.time(),
                        }
                        self._queue_condition.notify_all()
                        return account, (initial_position or position)
                    if self._shutdown:
                        raise asyncio.CancelledError("shutdown")
                    try:
                        await asyncio.wait_for(self._queue_condition.wait(), timeout=5.0)
                    except asyncio.TimeoutError:
                        pass
            finally:
                self._waiting_tasks.discard(task_id)

    async def enqueue_local_task(self, task_id: str) -> int:
        """入队但不阻塞等账户，返回当时位置。供"已入队"用户提示用。"""
        async with self._queue_condition:
            if task_id not in self._local_queue:
                self._local_queue.append(task_id)
            position = self._local_queue.index(task_id) + 1
            await self._check_scale_up()
            return position

    async def _check_scale_up(self) -> None:
        """按队列等待数动态启动账户（持锁时调用）。"""
        accounts = self.get_accounts()
        if not accounts:
            return
        waiting_count = len(self._local_queue)
        if waiting_count <= 0:
            return
        desired = 1 + (waiting_count // max(self.scale_queue_per_account, 1))
        desired = min(desired, len(accounts))

        for i in range(desired):
            acc = accounts[i]
            key = self.get_account_key(acc)
            if key in self._local_active or key in self._restarting_accounts:
                continue
            if self.get_account_url(acc):
                continue
            self.logger.info(f"[{self.name}] 动态扩容: 队列 {waiting_count} 等待, 启动 {key}")
            await self.ensure_account_restarting(acc)

    async def release_local_account(self, account: dict | None, task_id: str | None) -> None:
        async with self._queue_condition:
            if task_id and task_id in self._local_queue:
                self._local_queue.remove(task_id)
            if isinstance(account, dict):
                account_key = self.get_account_key(account)
                active_meta = self._local_active.get(account_key)
                active_task_id = (
                    active_meta.get("task_id") if isinstance(active_meta, dict) else None
                )
                if active_task_id == task_id:
                    self._local_active.pop(account_key, None)
                self._account_last_used_at[account_key] = time.time()
            self._queue_condition.notify_all()

    async def get_local_queue_count(self) -> int:
        async with self._queue_condition:
            return len(self._local_queue)

    # ============================================================
    # 巡检循环（空闲关 workspace 省 cnb 配额）
    # ============================================================

    async def _patrol_loop(self) -> None:
        while not self._shutdown:
            try:
                await asyncio.sleep(self.patrol_interval)
            except asyncio.CancelledError:
                break
            if self._shutdown:
                break
            if self.idle_shutdown_seconds <= 0:
                continue

            now_ts = time.time()
            for account in self.get_accounts():
                account_key = self.get_account_key(account)
                if account_key in self._local_active:
                    continue
                if account_key in self._restarting_accounts:
                    continue
                last_used = self._account_last_used_at.get(account_key, 0)
                if last_used <= 0:
                    continue
                idle_seconds = now_ts - last_used
                if idle_seconds < self.idle_shutdown_seconds:
                    continue
                url = self.get_account_url(account)
                if not url:
                    continue
                self.logger.info(
                    f"[{self.name}] 账户 {account_key} 空闲 {int(idle_seconds)}s, 关闭 workspace"
                )
                try:
                    stopped = await self.stop_account_workspace(account)
                    if stopped:
                        self.logger.info(f"[{self.name}] 账户 {account_key} workspace 已关闭")
                        self._account_last_used_at.pop(account_key, None)
                except Exception as e:
                    self.logger.error(f"[{self.name}] 账户 {account_key} 空闲关停失败: {e}")

    def start_patrol(self) -> None:
        """启动后台巡检任务（重复调用幂等）。"""
        if self._patrol_task is not None and not self._patrol_task.done():
            return
        self._patrol_task = asyncio.create_task(self._patrol_loop())
        self._background_tasks.add(self._patrol_task)
        self._patrol_task.add_done_callback(lambda t: self._background_tasks.discard(t))
        self.logger.info(f"[{self.name}] 后台巡检已启动")

    async def cancel_background_tasks(self) -> None:
        """server shutdown 时调用：取消所有后台任务 + 唤醒等待者。"""
        self._shutdown = True
        tasks = list(self._background_tasks)
        for task in tasks:
            task.cancel()
        try:
            await asyncio.wait_for(self._notify_queue_shutdown(), timeout=3.0)
        except Exception:
            self.logger.warning("关闭时唤醒等待队列失败", exc_info=True)
        if tasks:
            try:
                await asyncio.wait_for(
                    asyncio.gather(*tasks, return_exceptions=True),
                    timeout=10.0,
                )
            except asyncio.TimeoutError:
                self.logger.warning(f"[{self.name}] 后台任务取消超时,强制继续关闭")

    async def _notify_queue_shutdown(self) -> None:
        async with self._queue_condition:
            self._queue_condition.notify_all()

    # ============================================================
    # 状态查询（给管理面板 / 调试用）
    # ============================================================

    async def get_account_statuses(self) -> list[dict]:
        results: list[dict] = []
        now_ms = int(time.time() * 1000)
        for account in self.get_accounts():
            account_key = self.get_account_key(account)
            stored_url = self.get_account_url(account)
            healthy = False
            if stored_url:
                try:
                    healthy = await self.healthcheck(stored_url, 10)
                except Exception:
                    healthy = False
            latest_item: dict = {}
            latest_error = None
            try:
                items = await self.list_workspaces(account, status=None)
                if items:
                    latest_item = items[0]
            except Exception as e:
                latest_error = str(e)
            effective_url = stored_url
            if latest_item and str(latest_item.get("status") or "").lower() == "running":
                current_url = self.workspace_item_to_url(latest_item)
                if current_url:
                    effective_url = current_url
                    if current_url != stored_url:
                        self.update_account_store(
                            account,
                            url=current_url,
                            sn=latest_item.get("sn"),
                            pipeline_id=latest_item.get("pipeline_id"),
                            business_id=latest_item.get("business_id"),
                            status=latest_item.get("status"),
                            create_time=latest_item.get("create_time"),
                        )
                        if not healthy:
                            try:
                                healthy = await self.healthcheck(current_url, 10)
                            except Exception:
                                healthy = False
            running_count = 0
            pending_count = 0
            completed_count = 0
            running_seconds = None
            create_time_value = latest_item.get("create_time") if latest_item else None
            try:
                create_time_ms = int(create_time_value) if create_time_value is not None else None
            except Exception:
                create_time_ms = None
            if not create_time_ms:
                create_time_ms = self.get_account_workspace_create_time(account)
            if create_time_ms:
                running_seconds = max(0, int((now_ms - create_time_ms) / 1000.0))
            if healthy and effective_url:
                try:
                    queue_data = await self.get_queue(effective_url)
                    r_ids = self.extract_queue_prompt_ids(queue_data.get("queue_running") or [])
                    p_ids = self.extract_queue_prompt_ids(queue_data.get("queue_pending") or [])
                    running_count = len(r_ids)
                    pending_count = len(p_ids)
                except Exception:
                    self.logger.debug("读取 workspace 队列统计失败", exc_info=True)
                try:
                    history_data = await self.get_history(effective_url)
                    if isinstance(history_data, dict):
                        for history_item in history_data.values():
                            if not isinstance(history_item, dict):
                                continue
                            outputs = history_item.get("outputs")
                            if isinstance(outputs, dict) and outputs:
                                completed_count += 1
                                continue
                            status_info = history_item.get("status") or {}
                            if isinstance(status_info, dict) and status_info.get("completed"):
                                completed_count += 1
                except Exception:
                    self.logger.debug("读取 workspace 历史统计失败", exc_info=True)

            active_meta = self._local_active.get(account_key)
            is_active = isinstance(active_meta, dict)
            active_task_id = active_meta.get("task_id") if is_active else None
            active_since = float(active_meta.get("started_at") or 0) if is_active else None

            results.append(
                {
                    "name": account.get("name") or account_key,
                    "repo": account.get("repo"),
                    "branch": account.get("branch"),
                    "url": effective_url,
                    "url_healthy": healthy,
                    "workspace_status": latest_item.get("status") if latest_item else None,
                    "business_id": latest_item.get("business_id") if latest_item else None,
                    "sn": latest_item.get("sn") if latest_item else None,
                    "create_time": latest_item.get("create_time") if latest_item else None,
                    "restarting": account_key in self._restarting_accounts,
                    "error": latest_error,
                    "running_seconds": running_seconds,
                    "running_count": running_count,
                    "pending_count": pending_count,
                    "completed_count": completed_count,
                    "active": is_active,
                    "active_task_id": active_task_id,
                    "active_since": active_since,
                }
            )
        return results
