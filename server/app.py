"""
⚠️ LEGACY — 旧版独立后端单体（quarantined）

这是参考项目遗留的大单体后端，直接调用 NovelAI 生图/vibe/upscale/anlas 并自带队列。
桌面端的活跃实现已迁移到 sidecar/（FastAPI），前端通过 src/api/sidecar.ts 访问。

维护约束：
- 不要在本文件新增功能；新行为请加到 sidecar/。
- 仅作为可选的云/队列/workshop 适配面保留，待逐步迁移后下线。
- 不要在日志中打印 token / cookie / Authorization / 完整 base64 图片。

NovelAI Web UI 后端服务（独立运行版）
- 内置图片生成队列：直接调用 NovelAI API，不依赖 Bot
- 排队系统：多用户共享Token时的单线程队列管理
- Bot授权：通过授权码实现Bot登录
- 数据API：提供Bot端data目录的JSON文件访问
"""
import asyncio
import collections
import hashlib
import json
import os
import secrets
import shutil
import tempfile
import time
import uuid
import base64
import math
import re
import html as html_lib
import sys
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Literal, Optional, Dict, Any, Callable, List, Mapping, Protocol, Tuple
from urllib.parse import urlsplit
import threading

from fastapi import Depends, FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
import aiohttp
import aiofiles
import httpx
import msgpack

# ``server/run.py`` historically starts with ``server/`` as sys.path[0].  Keep
# that entrypoint compatible while allowing the neutral cloud backend package to
# remain at the repository root.
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from backend_core.jobs import JobStatus
from cloud_backend.body_limit import StreamingBodyLimitMiddleware
from cloud_backend.rate_limit import RateLimitMiddleware, RateLimitRule
from cloud_backend.errors import (
    CloudBackendError,
    InvalidCapabilityError,
    InvalidRequestError,
    JobStateConflictError,
    ResourceNotFoundError,
    UsageRecordingError,
)
from cloud_backend.identity import Principal, ResourceOwner
from cloud_backend.library_access import LibraryOwnershipService, OwnerScopedLibraryStorage
from cloud_backend.infrastructure import (
    CloudJobResultStore,
    SecureJsonObjectStore,
    SQLiteCloudJobRepository,
    SQLiteWorkshopQuotaRepository,
    StorageIntegrityError,
)
from cloud_backend.jobs import CloudJob
from cloud_backend.job_events import JobEventSubscriptionSet
from cloud_backend.legacy_adapter import (
    LegacyQuotaLedger,
    LegacyTaskAccess,
    bearer_token,
    persistent_capability_key,
)
from cloud_backend.outbound import (
    PublicEndpointPolicy,
    SafeBinaryHttpClient,
    SafeBytesHttpClient,
    SafeJsonHttpClient,
)
from cloud_backend.pairing import PairingCapacityError, PairingCodeRegistry
from cloud_backend.paid_operations import (
    MAX_PAID_RESULT_BYTES,
    MAX_TRANSLATE_CONTEXT_BYTES,
    PaidOperationService,
    UsageCharge,
    normalize_image_base64,
    validate_translate_context,
)
from agent_router.access import AgentAccess
from workshop_providers import (
    FunctionWorkshopProvider,
    ModalComfyProvider,
    WorkshopProviderRegistry,
    WorkshopProviderRequest,
)

from config import (
    BOT_DATA_DIR, NOVELAI_TOKENS, NOVELAI_ANLAS_ONLY_TOKEN, PROXY_URL, IMAGE_GENERATION_PROXY_URL, DANBOORU_PROXY_URL, TOKEN_MAX_CONSECUTIVE_ERRORS,
    TRANSLATE_EN2ZH_BASE_URL, TRANSLATE_EN2ZH_API_KEY, TRANSLATE_EN2ZH_MODEL, TRANSLATE_EN2ZH_PROXY, TRANSLATE_EN2ZH_EXTRA_PAYLOAD,
    # PUBLIC_AI_* 已不再被 app.py 直接使用；agent_router/model_provider.py 从 config.PUBLIC_AI_CHANNELS 读
    GENSPARK_API_BASE, GENSPARK_API_KEY, GENSPARK_STYLE, GENSPARK_COOKIE, GENSPARK_MODEL_MAP,
    BIG_GPT_BASE_URL, BIG_GPT_API_KEY, BIG_GPT_MODEL, BIG_GPT_QUALITY, BIG_GPT_MODERATION,
    BIG_GPT_BACKGROUND, BIG_GPT_TIMEOUT, BIG_GPT_RATIO_TABLE,
    WD_TAGGER_PROXY, WD_TAGGER_SPACE_URL,
    BILLING_TOTAL_COST, BILLING_ANLAS_THRESHOLD, BILLING_ANLAS_SURCHARGE,
    BILLING_FREE_THRESHOLD, BILLING_TIER_WEIGHTS, BILLING_CYCLE_DAY,
    CAPSOLVER_CLIENT_KEY, NAI_BOOST_ACCOUNTS_FILE, NAI_BOOST_STATE_FILE,
    NAI_BOOST_COOLDOWN_PER_ACCOUNT_SEC, NAI_BOOST_GLOBAL_COOLDOWN_SEC,
    NAI_BOOST_403_THRESHOLD, NAI_BOOST_403_WINDOW,
    NAI_BOOST_TOKEN_REFRESH_AHEAD_SEC,
    NAI_BOOST_ACTIVE_ACCOUNTS, NAI_BOOST_QUOTA_REFRESH_SEC,
    NAI_RECAPTCHA_TOKEN_API_URL,
)
# 整模块导入，供访问控制读取"可选、向后兼容"的安全配置项（老 config.py 缺字段时取默认）。
import config as _appcfg

_CLOUD_TENANT_ID = str(getattr(_appcfg, "CLOUD_TENANT_ID", "default") or "default")
_DIRECT_TASK_TENANT_ID = f"{_CLOUD_TENANT_ID}:direct"
_BOT_TASK_TENANT_ID = f"{_CLOUD_TENANT_ID}:bot"
_task_access = LegacyTaskAccess.from_secret(
    persistent_capability_key(
        getattr(_appcfg, "JOB_CAPABILITY_SECRET", ""),
        Path(
            getattr(
                _appcfg,
                "JOB_CAPABILITY_KEY_PATH",
                Path(__file__).resolve().parent / "data" / "job_capability.key",
            )
        ),
    )
)
_quota_ledger = LegacyQuotaLedger(
    Path(
        getattr(
            _appcfg,
            "CLOUD_QUOTA_DB_PATH",
            Path(__file__).resolve().parent / "data" / "cloud_quota.db",
        )
    ),
    enabled=bool(getattr(_appcfg, "CLOUD_QUOTA_ENABLED", False)),
)
_cloud_jobs = SQLiteCloudJobRepository(
    Path(
        getattr(
            _appcfg,
            "CLOUD_JOBS_DB_PATH",
            Path(__file__).resolve().parent / "data" / "cloud_jobs.db",
        )
    )
)
_cloud_job_results = CloudJobResultStore(
    Path(
        getattr(
            _appcfg,
            "CLOUD_JOB_RESULTS_DIR",
            Path(__file__).resolve().parent / "data" / "cloud_job_results",
        )
    )
)
_GENERATION_QUEUE_CAPACITY = max(
    1,
    int(getattr(_appcfg, "LEGACY_GENERATION_QUEUE_CAPACITY", 32)),
)
_safe_outbound_json = SafeJsonHttpClient()
_safe_outbound_large_json = SafeJsonHttpClient(max_response_bytes=48 * 1024 * 1024)
_safe_outbound_bytes = SafeBytesHttpClient()
_safe_outbound_binary = SafeBinaryHttpClient()

# Boost 通道
from captcha_client import (
    solve_recaptcha_v3 as boost_solve_captcha,
    CaptchaError,
    CaptchaTimeout,
)

# 可选：代理支持
try:
    from aiohttp_socks import ProxyConnector
except ImportError:
    ProxyConnector = None

class SafeJsonStore:
    """线程安全的 JSON 文件读写，带原子写入和备份机制。
    
    - asyncio.Lock 保护同进程内并发
    - 写入时先写临时文件，验证 JSON 合法后 rename 到目标路径（原子操作）
    - 写入前自动备份上一版（.backup 文件）
    """

    def __init__(self, file_path: Path):
        self.file_path = file_path
        self._lock = asyncio.Lock()

    async def load(self) -> dict:
        """加载 JSON 数据，文件不存在或损坏时返回空 dict"""
        async with self._lock:
            return self._load_sync()

    def _load_sync(self) -> dict:
        """同步加载（在锁内调用）"""
        if not self.file_path.exists():
            return {}
        try:
            with open(self.file_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            print(f"[SafeJsonStore] 加载 {self.file_path} 失败: {e}，尝试备份恢复")
            return self._try_restore_from_backup()

    def _try_restore_from_backup(self) -> dict:
        """主文件损坏时尝试从备份恢复"""
        backup_path = self.file_path.with_suffix(self.file_path.suffix + ".backup")
        if not backup_path.exists():
            return {}
        try:
            with open(backup_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            # 备份有效，恢复到主文件
            shutil.copy2(backup_path, self.file_path)
            print(f"[SafeJsonStore] 已从备份恢复: {self.file_path}")
            return data
        except Exception:
            return {}

    async def save(self, data: dict) -> bool:
        """原子写入 JSON 数据，写入前备份上一版"""
        async with self._lock:
            return self._save_sync(data)

    def _save_sync(self, data: dict) -> bool:
        """同步保存（在锁内调用）"""
        try:
            self.file_path.parent.mkdir(parents=True, exist_ok=True)

            # 备份当前文件
            backup_path = self.file_path.with_suffix(self.file_path.suffix + ".backup")
            if self.file_path.exists():
                try:
                    shutil.copy2(self.file_path, backup_path)
                except OSError as e:
                    print(f"[SafeJsonStore] 创建备份失败: {e}")

            # 写入临时文件
            fd, temp_path = tempfile.mkstemp(
                suffix=".tmp",
                prefix=f"{self.file_path.name}_",
                dir=self.file_path.parent,
            )
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as tmp:
                    json.dump(data, tmp, ensure_ascii=False, indent=2)

                # 验证写入的 JSON 合法
                with open(temp_path, "r", encoding="utf-8") as f:
                    json.loads(f.read())

                # 原子替换（同一文件系统内 rename 是原子的）
                shutil.move(temp_path, self.file_path)
                return True

            except Exception:
                # 清理临时文件
                try:
                    os.unlink(temp_path)
                except OSError:
                    pass
                raise

        except Exception as e:
            print(f"[SafeJsonStore] 保存 {self.file_path} 失败: {e}")
            return False

    async def update(self, updater) -> bool:
        """读取-修改-写入的原子操作。
        
        updater 是一个接收 dict 并原地修改（或返回新 dict）的函数。
        整个过程在同一把锁内完成，避免 TOCTOU 竞态。
        """
        async with self._lock:
            data = self._load_sync()
            result = updater(data)
            if result is not None:
                data = result
            return self._save_sync(data)

# ==================== NovelAI 配置 ====================


def get_novelai_tokens() -> list[str]:
    """获取所有可用的 NovelAI Token"""
    return [t for t in NOVELAI_TOKENS if t]


def get_proxy_url() -> str:
    """获取代理 URL"""
    return PROXY_URL


def get_image_generation_proxy_url() -> str:
    """Proxy for image generation only. Empty means direct connection."""
    return IMAGE_GENERATION_PROXY_URL or ""


def _danbooru_proxies() -> dict:
    """获取 Danbooru 请求的 requests 代理字典"""
    if not DANBOORU_PROXY_URL:
        return None
    p = DANBOORU_PROXY_URL.replace("socks5://", "socks5h://") if DANBOORU_PROXY_URL.startswith("socks5://") else DANBOORU_PROXY_URL
    return {"http": p, "https": p}


# ==================== Danbooru 全局 Session ====================
# Danbooru 走 Cloudflare,会基于 TLS/JA3 指纹拦截 python-requests,
# 所以这里用 curl_cffi 模拟 Chrome 的 TLS 指纹。
from curl_cffi import requests as _cffi_requests

_danbooru_session = None  # type: ignore[var-annotated]


def _get_danbooru_session():
    """获取或创建 Danbooru 专用的全局 Session(curl_cffi,模拟 Chrome 绕过 Cloudflare)"""
    global _danbooru_session
    if _danbooru_session is None:
        _danbooru_session = _cffi_requests.Session(impersonate="chrome")
        proxies = _danbooru_proxies()
        if proxies:
            _danbooru_session.proxies = dict(proxies)
    return _danbooru_session


# ==================== NovelAI 图片生成全局 httpx Session (HTTP/2) ====================

_nai_session: httpx.AsyncClient | None = None


def _get_nai_session() -> httpx.AsyncClient:
    """获取或创建 NovelAI 图片生成专用的全局 httpx Client（HTTP/2 复用连接）"""
    global _nai_session
    if _nai_session is None or _nai_session.is_closed:
        proxy_url = get_image_generation_proxy_url()
        timeout = httpx.Timeout(300, connect=30, read=90)
        _nai_session = httpx.AsyncClient(
            http2=True,
            proxy=proxy_url if proxy_url else None,
            timeout=timeout,
        )
    return _nai_session


async def _close_nai_session():
    """关闭全局 NovelAI session"""
    global _nai_session
    if _nai_session and not _nai_session.is_closed:
        await _nai_session.aclose()
        _nai_session = None


# ==================== Token 管理器 ====================

class TokenManager:
    """多 Token 统一管理：点数追踪、错误熔断、智能选取、并发控制"""
    
    MAX_CONSECUTIVE_ERRORS = TOKEN_MAX_CONSECUTIVE_ERRORS
    
    def __init__(self):
        self._tokens: Dict[str, dict] = {}  # token -> {anlas, errors, disabled, in_use, last_error, ...}
        self._lock = None
        self._cond = None
        self._initialized = False

    async def _ensure_init(self):
        if not self._initialized:
            self._lock = asyncio.Lock()
            self._cond = asyncio.Condition(self._lock)
            self._initialized = True
            
    async def register(self, token: str):
        """注册一个 Token"""
        await self._ensure_init()
        async with self._lock:
            if token not in self._tokens:
                self._tokens[token] = {
                    "anlas": 0,
                    "errors": 0,          # 连续错误计数
                    "disabled": False,
                    "in_use": False,      # 是否正在被Worker或encode_vibe使用
                    "last_error": "",
                    "disabled_at": 0.0,
                    "total_success": 0,
                    "total_errors": 0,
                }
                print(f"[TokenManager] 注册 Token: {hashlib.sha256(token.encode()).hexdigest()[:8]}")
    
    async def register_all(self):
        """注册配置中的所有 Token"""
        for token in get_novelai_tokens():
            await self.register(token)
    
    async def record_success(self, token: str):
        """记录成功，重置连续错误计数"""
        await self._ensure_init()
        async with self._lock:
            info = self._tokens.get(token)
            if info:
                info["errors"] = 0
                info["total_success"] += 1
    
    async def record_error(self, token: str, error_msg: str):
        """记录错误，连续错误达到阈值自动禁用"""
        await self._ensure_init()
        async with self._cond:
            info = self._tokens.get(token)
            if not info:
                return
            info["errors"] += 1
            info["total_errors"] += 1
            info["last_error"] = error_msg
            if (
                self.MAX_CONSECUTIVE_ERRORS > 0
                and info["errors"] >= self.MAX_CONSECUTIVE_ERRORS
                and not info["disabled"]
            ):
                info["disabled"] = True
                info["disabled_at"] = time.time()
                print(f"[TokenManager] ⚠ Token {hashlib.sha256(token.encode()).hexdigest()[:8]} 已自动禁用"
                      f"（连续 {info['errors']} 次错误，最后错误: {error_msg}）")
                # 状态发生变化，唤醒正在等待的协程以便重新评估
                self._cond.notify_all()
    
    async def is_disabled(self, token: str) -> bool:
        """检查 Token 是否已禁用"""
        await self._ensure_init()
        async with self._lock:
            info = self._tokens.get(token)
            return info["disabled"] if info else False
    
    async def update_anlas(self, token: str, anlas: int):
        """更新某个 Token 的 anlas 点数"""
        await self._ensure_init()
        async with self._lock:
            info = self._tokens.get(token)
            if info:
                info["anlas"] = anlas
    
    async def get_total_anlas(self) -> int:
        """获取所有可用（未禁用）Token 的 anlas 总和"""
        await self._ensure_init()
        async with self._lock:
            return sum(
                info["anlas"] for info in self._tokens.values()
                if not info["disabled"]
            )
            
    async def acquire_token(self, need_anlas: bool = False) -> str:
        """获取一个可用且未被占用的 Token，如果没有则等待"""
        await self._ensure_init()
        async with self._cond:
            while True:
                # 检查是否所有 Token 都被禁用了
                if self._tokens and not any(not info["disabled"] for info in self._tokens.values()):
                    raise Exception("所有 Token 均已失效或被禁用")
                    
                available = [
                    (token, info) for token, info in self._tokens.items()
                    if not info["disabled"] and not info["in_use"]
                ]
                if available:
                    if need_anlas:
                        available.sort(key=lambda x: x[1]["anlas"], reverse=True)
                    else:
                        available.sort(key=lambda x: x[1]["errors"])
                    
                    best_token = available[0][0]
                    self._tokens[best_token]["in_use"] = True
                    return best_token
                
                # 如果都没有可用（比如都在in_use状态），则等待其他任务释放
                await self._cond.wait()
                
    async def release_token(self, token: str):
        """释放被占用的 Token"""
        await self._ensure_init()
        async with self._cond:
            info = self._tokens.get(token)
            if info:
                info["in_use"] = False
                # 唤醒等待拿 Token 的协程
                self._cond.notify()
    
    async def get_best_token(self, need_anlas: bool = False) -> Optional[str]:
        """临时获取最佳 Token（不占用，用于非并发场景的 fallback）"""
        await self._ensure_init()
        async with self._lock:
            available = [
                (token, info) for token, info in self._tokens.items()
                if not info["disabled"]
            ]
            if not available:
                return None
            if need_anlas:
                available.sort(key=lambda x: x[1]["anlas"], reverse=True)
            else:
                available.sort(key=lambda x: x[1]["errors"])
            return available[0][0]
    
    async def get_status(self) -> list:
        """获取所有 Token 的状态（用于调试/监控）"""
        await self._ensure_init()
        async with self._lock:
            return [
                {
                    "token_id": hashlib.sha256(token.encode()).hexdigest()[:8],
                    "anlas": info["anlas"],
                    "consecutive_errors": info["errors"],
                    "disabled": info["disabled"],
                    "in_use": info["in_use"],
                    "last_error": info["last_error"],
                    "total_success": info["total_success"],
                    "total_errors": info["total_errors"],
                }
                for token, info in self._tokens.items()
            ]


# 全局 Token 管理器
token_manager = TokenManager()


def _task_needs_anlas(params: dict) -> bool:
    """判断任务是否会消耗 anlas 点数"""
    width = params.get("width", 832)
    height = params.get("height", 1216)
    steps = params.get("steps", 28)
    pixels = width * height

    # 超尺寸或超步数
    if steps > 28 or pixels > 1048576:
        return True
    # 有 Precise Reference
    if params.get("director_reference_images"):
        return True
    # 有 Vibe Reference（生成时）
    if params.get("reference_image_multiple"):
        return True
    return False


def _boost_can_handle(params: dict) -> bool:
    """Boost 通道（trial 号）能否接这个任务。

    Trial 号走 multipart 路径，NovelAI 在 multipart 模式下把以下字段当作 form part
    name 引用而非 base64 内嵌：image / mask / reference_image_multiple /
    director_reference_images。

    vibe（reference_image_multiple）已按抓到的真实前端协议补完 multipart 拆 part
    逻辑（part name = ref_multiple_{i}，见 generate_novelai_image_stream），可走 boost。
    其余三类（img2img / infill / PR）的 part 命名未实测，暂走付费 JSON 路径。
    """
    width = params.get("width", 832)
    height = params.get("height", 1216)
    steps = params.get("steps", 28)
    pixels = width * height

    # 协议未补完的引用图：强制让付费 worker 接
    if (
        params.get("image")
        or params.get("mask")
        or params.get("director_reference_images")
    ):
        return False
    # 大尺寸 / 高步数 —— trial 号没 anlas 点数
    if pixels > 1048576 or steps > 28:
        return False
    return True


# ==================== Boost 通道：Trial 账号池 ====================

class TrialAccountPool:
    """管理一批 NovelAI 免费试用账号（trial_activated=True）。
    每个号配额 30 张图，用完即失效。

    持久化拆为两文件，避免 git 推送时运行时状态污染账号清单：
      - accounts.json：账号清单（email/password/outlook_*/初始 token 等），代码只读
      - state.json   ：运行时状态（trial_image_left / warmed_at_ips / novelai_token / novelai_token_exp），
                       本机 .gitignore；不存在则从 accounts.json 自动迁移生成。

    并发模型：
      - in_use 标记防止同号并发（NovelAI 硬限制：同账号 1 个生图任务）
      - 按实际 boost 并发动态激活账号；active 号会一直使用到用完再补下一批
      - acquire() 只从 active 小队列里选 `not in_use AND image_left > 0 AND not in_cooldown` 的号
      - 首次真正使用前只刷新 active 小队列余额；之后靠本地扣减
      - release() 释放 in_use，可选 deduct=1 张
    """

    STATE_FIELDS = ("trial_image_left", "warmed_at_ips", "novelai_token", "novelai_token_exp")

    def __init__(self, json_path: Path, state_path: Path, active_count: int = 0):
        self._path = Path(json_path)
        self._state_path = Path(state_path)
        self._state_bak = self._state_path.with_suffix(self._state_path.suffix + ".bak")
        self._lock = asyncio.Lock()
        # email -> {bearer, password, image_left, in_use, last_used, cooldown_until, exp}
        self._accounts: Dict[str, Dict[str, Any]] = {}
        self._active_emails: set[str] = set()
        self._quota_refreshed_emails: set[str] = set()
        self._active_limit = max(0, int(active_count or 0))

    def _load_state_file(self) -> Dict[str, Dict[str, Any]]:
        if not self._state_path.exists():
            return {}
        try:
            with open(self._state_path, "r", encoding="utf-8") as f:
                return json.load(f) or {}
        except Exception as e:
            print(f"[boost] 加载 state {self._state_path} 失败（按空处理）: {e}")
            return {}

    def _migrate_state_from_accounts(self, raw_accounts: Dict[str, Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
        """首次启动：从 accounts.json 抽取 STATE_FIELDS 写到 state.json，保留真实余额。"""
        state: Dict[str, Dict[str, Any]] = {}
        for email, info in raw_accounts.items():
            entry: Dict[str, Any] = {}
            for k in self.STATE_FIELDS:
                if k in info:
                    entry[k] = info[k]
            if entry:
                state[email] = entry
        try:
            tmp = self._state_path.with_suffix(self._state_path.suffix + ".tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(state, f, indent=2, ensure_ascii=False)
            tmp.replace(self._state_path)
            print(f"[boost] 已从 accounts.json 自动迁移生成 state.json（{len(state)} 个账号）")
        except Exception as e:
            print(f"[boost] 写入 state.json 失败（内存继续使用快照）: {e}")
        return state

    async def load(self) -> None:
        """启动时加载。仅取 status=ok 的；其它（denied/failed）忽略。
        合并规则：accounts.json 提供 baseline + state.json 覆盖 STATE_FIELDS。
        """
        if not self._path.exists():
            print(f"[boost] 账号文件不存在: {self._path}")
            return
        try:
            with open(self._path, "r", encoding="utf-8") as f:
                raw = json.load(f)
        except Exception as e:
            print(f"[boost] 加载 {self._path} 失败: {e}")
            return

        state = self._load_state_file()
        if not state:
            state = self._migrate_state_from_accounts(raw)

        async with self._lock:
            self._accounts.clear()
            for email, info in raw.items():
                if info.get("status") != "ok":
                    continue
                # 合并：state 优先覆盖 STATE_FIELDS
                merged = dict(info)
                st = state.get(email) or {}
                for k in self.STATE_FIELDS:
                    if k in st:
                        merged[k] = st[k]
                if not merged.get("novelai_token"):
                    continue
                self._accounts[email] = {
                    "bearer": merged["novelai_token"],
                    "password": merged.get("password", ""),
                    "image_left": int(merged.get("trial_image_left", 0)),
                    "in_use": False,
                    "last_used": 0.0,
                    "cooldown_until": 0.0,
                    "exp": int(merged.get("novelai_token_exp", 0)),
                    "raw": info,  # 留 accounts.json 原值用于写回静态字段
                }
        print(f"[boost] 加载 trial 账号 {len(self._accounts)} 个，"
              f"剩余总额度 {sum(a['image_left'] for a in self._accounts.values())} 张（按本地 JSON 缓存）")

    def _active_accounts_locked(self) -> List[Tuple[str, Dict[str, Any]]]:
        return [
            (em, self._accounts[em])
            for em in self._active_emails
            if em in self._accounts
        ]

    def _activate_next_locked(self) -> bool:
        """按文件顺序激活下一个有余额账号。返回是否有新增。"""
        if self._active_limit and len(self._active_emails) >= self._active_limit:
            return False
        for email, acct in self._accounts.items():
            if email in self._active_emails:
                continue
            if acct["image_left"] <= 0:
                continue
            self._active_emails.add(email)
            return True
        return False

    def _log_active_change_locked(self, before: set[str]) -> None:
        if self._active_emails != before:
            limit_text = str(self._active_limit) if self._active_limit else "dynamic"
            active = ", ".join(sorted(self._active_emails)) or "-"
            print(f"[boost] active 小队列 {len(self._active_emails)}/{limit_text}: {active}")

    def _prune_active_locked(self) -> None:
        """移除已用完账号；不主动补号，补号只在并发需要时发生。"""
        before = set(self._active_emails)
        self._active_emails = {
            em for em in self._active_emails
            if em in self._accounts and self._accounts[em]["image_left"] > 0
        }
        self._log_active_change_locked(before)

    def _ensure_min_active_locked(self) -> None:
        """首次使用前至少激活一个号；后续并发扩容由 acquire 触发。"""
        before = set(self._active_emails)
        self._prune_active_locked()
        if not self._active_emails:
            self._activate_next_locked()
        self._log_active_change_locked(before)

    def _expand_active_for_demand_locked(self) -> None:
        """active 内没有可立即取用的号（in_use 或 cooldown 中都算占用）时，
        按实际并发需求再启用一个号。cooldown 中的号保留在 active 里，
        cooldown 结束后自动重回轮转，余额不丢。"""
        before = set(self._active_emails)
        self._prune_active_locked()
        if not self._active_emails:
            self._activate_next_locked()
        else:
            now = time.time()
            has_usable = any(
                em in self._accounts
                and not self._accounts[em]["in_use"]
                and self._accounts[em]["cooldown_until"] <= now
                for em in self._active_emails
            )
            if not has_usable:
                self._activate_next_locked()
        self._log_active_change_locked(before)

    async def _refresh_quota_items_from_server(self, items: List[Tuple[str, Dict[str, Any]]]) -> None:
        """对指定账号调 /ai/trial-status，用 NovelAI 端真实余额覆盖本地 image_left。"""
        if not items:
            return
        print(f"[boost] 首次使用前刷 active 余额：查 {len(items)} 个号的 remaining_image_actions…")
        diff_count = 0
        async with httpx.AsyncClient(timeout=15) as cli:
            for email, acct in items:
                real_left: Optional[int] = None
                try:
                    r = await cli.get(
                        "https://image.novelai.net/ai/trial-status",
                        headers={"Authorization": f"Bearer {acct['bearer']}"},
                    )
                    if r.status_code != 200:
                        print(f"[boost]   {email} HTTP {r.status_code}，跳过")
                    else:
                        real_left = int(r.json().get("remaining_image_actions", 0))
                except Exception as e:
                    print(f"[boost]   {email} 查询异常：{e}")
                async with self._lock:
                    if email in self._accounts:
                        self._quota_refreshed_emails.add(email)
                        if real_left is not None:
                            old = self._accounts[email]["image_left"]
                            self._accounts[email]["image_left"] = real_left
                            if old != real_left:
                                diff_count += 1
                                print(f"[boost]   {email}  本地={old} → 服务端={real_left}")
        async with self._lock:
            self._prune_active_locked()
            await self._save_unsafe()
            active_total = sum(a["image_left"] for _, a in self._active_accounts_locked())
        print(f"[boost] active 余额刷新完成：{diff_count} 个号有偏差已纠正，"
              f"active 缓存余额 {active_total} 张")

    async def refresh_quotas_from_server(self) -> None:
        """兼容旧调用：只刷新 active 小队列，不再全池扫描。"""
        async with self._lock:
            self._ensure_min_active_locked()
            items = [(em, dict(a)) for em, a in self._active_accounts_locked()]
        await self._refresh_quota_items_from_server(items)

    async def refresh_all_quotas_from_server(self) -> None:
        """全量刷新所有账号余额。用于追上 NAI 端 trial reset / 外部消耗。

        如果某个本地 image_left=0 的号在 NAI 端恢复了余额，刷新后会再次
        变成 eligible，下次 _activate_next_locked 能挑到它。
        """
        async with self._lock:
            items = [(em, dict(a)) for em, a in self._accounts.items()]
        await self._refresh_quota_items_from_server(items)

    async def prewarm_active(self, target_n: int) -> None:
        """启动时一次性把 active 队列扩到 target_n 个号，并并发刷一次余额。

        正常运行靠 acquire 的按需 _expand_active_for_demand_locked 慢慢扩容；
        但启动时知道 active_count 上限，直接铺满能让第一波并发任务不需要
        排队等"激活下一个号 + 查余额"的串行延迟。
        """
        if target_n <= 0:
            return
        async with self._lock:
            for _ in range(max(0, target_n - len(self._active_emails))):
                if not self._activate_next_locked():
                    break
            items = [(em, dict(a)) for em, a in self._active_accounts_locked()]
        if items:
            await self._refresh_quota_items_from_server(items)

    async def _refresh_account_once_before_use(self, email: str) -> None:
        """本进程内每个账号第一次真正使用前刷新一次余额；之后只靠本地扣减。"""
        async with self._lock:
            if email in self._quota_refreshed_emails:
                return
            acct = self._accounts.get(email)
            if not acct:
                return
            item = (email, dict(acct))
        try:
            await self._refresh_quota_items_from_server([item])
        except Exception as e:
            async with self._lock:
                self._quota_refreshed_emails.add(email)
            print(f"[boost] {email} 首次余额刷新异常（忽略，用本地缓存值）: {e}")

    async def _save_unsafe(self) -> None:
        """无锁版（调用方必须已持锁）。只写 state.json；accounts.json 永不修改。"""
        if self._state_path.exists():
            try:
                shutil.copy2(self._state_path, self._state_bak)
            except Exception as e:
                print(f"[boost] 备份 state .bak 失败（继续写主文件）: {e}")
        try:
            existing = self._load_state_file()
            for email, acct in self._accounts.items():
                entry = existing.get(email) or {}
                entry["trial_image_left"] = acct["image_left"]
                entry["novelai_token"] = acct["bearer"]
                entry["novelai_token_exp"] = acct["exp"]
                # warmed_at_ips 由 warmup_accounts.py 直接写 accounts.json，
                # 这里不主动产出新值；保留原 state 中的旧值不动。
                existing[email] = entry
            tmp = self._state_path.with_suffix(self._state_path.suffix + ".tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(existing, f, indent=2, ensure_ascii=False)
            tmp.replace(self._state_path)
        except Exception as e:
            print(f"[boost] 保存 {self._state_path} 失败: {e}")

    async def acquire(self) -> Optional[Tuple[str, Dict[str, Any]]]:
        """挑一个 active 且 in_use=False AND image_left>0 AND 不在 cooldown 的号。
        返回 (email, account_dict) 或 None。"""
        while True:
            now = time.time()
            async with self._lock:
                self._expand_active_for_demand_locked()
                candidates = [
                    (em, a) for em, a in self._accounts.items()
                    if em in self._active_emails
                    and not a["in_use"]
                    and a["image_left"] > 0
                    and a["cooldown_until"] <= now
                ]
                if not candidates:
                    return None
                # active 小队列内优先复用更久未用的号，避免同号连击；不跨全池均摊。
                candidates.sort(key=lambda x: (x[1]["last_used"], -x[1]["image_left"]))
                email, acct = candidates[0]
                need_refresh = email not in self._quota_refreshed_emails
                if not need_refresh:
                    acct["in_use"] = True
                    acct["last_used"] = now
                    return email, acct
            await self._refresh_account_once_before_use(email)

    async def release(self, email: str, deduct: bool = False, cooldown_sec: float = 0.0) -> None:
        async with self._lock:
            acct = self._accounts.get(email)
            if not acct:
                return
            acct["in_use"] = False
            if deduct:
                acct["image_left"] = max(0, acct["image_left"] - 1)
            if cooldown_sec > 0:
                acct["cooldown_until"] = time.time() + cooldown_sec
            self._prune_active_locked()
            await self._save_unsafe()

    async def update_token(self, email: str, new_bearer: str, new_exp: int) -> None:
        """token 续期：刷新 bearer + exp 并持久化。"""
        async with self._lock:
            acct = self._accounts.get(email)
            if not acct:
                return
            acct["bearer"] = new_bearer
            acct["exp"] = new_exp
            await self._save_unsafe()

    async def has_eligible(self) -> bool:
        now = time.time()
        async with self._lock:
            self._expand_active_for_demand_locked()
            return any(
                em in self._active_emails
                and (not a["in_use"])
                and a["image_left"] > 0
                and a["cooldown_until"] <= now
                for em, a in self._accounts.items()
            )

    async def stats(self) -> Dict[str, Any]:
        now = time.time()
        async with self._lock:
            self._prune_active_locked()
            total = len(self._accounts)
            eligible = sum(
                1 for em, a in self._accounts.items()
                if em in self._active_emails
                and (not a["in_use"])
                and a["image_left"] > 0
                and a["cooldown_until"] <= now
            )
            in_use = sum(1 for em, a in self._accounts.items() if em in self._active_emails and a["in_use"])
            total_left = sum(a["image_left"] for em, a in self._accounts.items() if em in self._active_emails)
            return {
                "total": total,
                "active": len(self._active_emails),
                "eligible": eligible,
                "in_use": in_use,
                "total_image_left": total_left,
            }

    async def iter_accounts_for_refresh(self) -> List[Tuple[str, Dict[str, Any]]]:
        """返回 active 账号副本（用于后台 token 续期扫描）。"""
        async with self._lock:
            self._prune_active_locked()
            return [(em, dict(a)) for em, a in self._accounts.items() if em in self._active_emails]


# 全局 boost 状态
trial_pool: Optional[TrialAccountPool] = None
_boost_global_cooldown_until = 0.0  # 时间戳；> now 表示在全局冷却期内
# 滑动窗口：True = 403/captcha-rejected，False = 成功；其他失败（429/网络）不入。
# 窗口内 True 数 ≥ NAI_BOOST_403_THRESHOLD → 全局冷却。
_boost_recent_results: collections.deque = collections.deque(maxlen=NAI_BOOST_403_WINDOW)


def _boost_recent_403_count() -> int:
    return sum(1 for x in _boost_recent_results if x)


def _boost_cooldown_remaining_sec() -> int:
    return max(0, int(_boost_global_cooldown_until - time.time()))


# ---- Boost 通道：access_key 派生 + token 自动续期 ----
def _derive_nai_access_key(email: str, password: str) -> str:
    """与 NovelAI 前端公式一致：
      pre_salt = password[:6] + email.lower() + "novelai_data_access_key"
      salt = blake2b(pre_salt, 16)
      raw  = argon2id(password, salt, opslimit=2, memlimit=2_000_000, hashlen=64)
      access_key = base64url(raw)[:64]
    """
    import hashlib
    import nacl.pwhash
    pre_salt = f"{password[:6]}{email.lower()}novelai_data_access_key".encode()
    salt = hashlib.blake2b(pre_salt, digest_size=16).digest()
    raw = nacl.pwhash.argon2id.kdf(
        size=64,
        password=password.encode(),
        salt=salt,
        opslimit=2,
        memlimit=2_000_000,
    )
    return base64.urlsafe_b64encode(raw).decode()[:64]


def _jwt_exp(token: str) -> int:
    payload_b64 = token.split(".")[1]
    payload_b64 += "=" * (-len(payload_b64) % 4)
    return int(json.loads(base64.urlsafe_b64decode(payload_b64))["exp"])


async def _refresh_nai_token(email: str, password: str) -> Tuple[str, int]:
    """用 email + password 调 /user/login 拿新 30 天 token。返回 (token, exp)。"""
    key = _derive_nai_access_key(email, password)
    async with httpx.AsyncClient(
        timeout=30,
        proxy=PROXY_URL if PROXY_URL else None,
    ) as cli:
        r = await cli.post(
            "https://api.novelai.net/user/login",
            json={"key": key},
        )
        if r.status_code not in (200, 201):
            raise RuntimeError(f"login HTTP {r.status_code}: {r.text[:200]}")
        token = r.json()["accessToken"]
    return token, _jwt_exp(token)


async def trial_pool_full_refresh_loop():
    """每 NAI_BOOST_QUOTA_REFRESH_SEC 秒扫全池一次余额。

    用途：NAI 端 trial credit 周期性重置（月度），或被外部消耗。本地缓存
    的 image_left 一旦 drop 到 0 这个号就被 _prune_active_locked 移出 active
    再也不进；全量刷新能让恢复的号自动重新可用。
    """
    while True:
        try:
            await asyncio.sleep(NAI_BOOST_QUOTA_REFRESH_SEC)
            if trial_pool is None:
                continue
            t0 = time.time()
            await trial_pool.refresh_all_quotas_from_server()
            print(f"[boost/quota-refresh] 全量刷新完成，耗时 {time.time()-t0:.1f}s")
        except asyncio.CancelledError:
            raise
        except Exception as e:
            print(f"[boost/quota-refresh] loop error: {e}")


async def boost_token_refresher():
    """每小时扫一次 trial_pool；临到期（<NAI_BOOST_TOKEN_REFRESH_AHEAD_SEC）的 token 主动续期。"""
    while True:
        try:
            await asyncio.sleep(3600)
            if trial_pool is None:
                continue
            now = time.time()
            accounts = await trial_pool.iter_accounts_for_refresh()
            refreshed = 0
            for email, acct in accounts:
                if not acct["password"]:
                    continue
                if acct["exp"] - now > NAI_BOOST_TOKEN_REFRESH_AHEAD_SEC:
                    continue
                try:
                    new_token, new_exp = await _refresh_nai_token(email, acct["password"])
                    await trial_pool.update_token(email, new_token, new_exp)
                    refreshed += 1
                    print(f"[boost/refresh] {email}  新到期 {time.ctime(new_exp)}")
                except Exception as e:
                    print(f"[boost/refresh] {email} 续期失败: {e}")
            if refreshed:
                print(f"[boost/refresh] 本轮续期 {refreshed} 个号")
        except asyncio.CancelledError:
            raise
        except Exception as e:
            print(f"[boost/refresh] loop error: {e}")


# ==================== NovelAI 图片生成队列系统 ====================

# 队列状态
_image_queue: asyncio.Queue = None
_queue_lock: asyncio.Lock = None
_workers_started = False
_task_counter = 0
_current_task = 0
_running_count = 0
_generation_admitting = 0
_state_lock = threading.Lock()
_user_pending: Dict[str, int] = {}
_generation_upstream_tasks: Dict[str, asyncio.Task] = {}

# WebSocket 连接管理（用于推送生成进度）
_generation_websockets: Dict[str, set[WebSocket]] = {}


async def _ensure_queue():
    """确保队列已初始化"""
    global _image_queue, _queue_lock
    if _image_queue is None:
        _image_queue = asyncio.Queue(maxsize=_GENERATION_QUEUE_CAPACITY)
        _queue_lock = asyncio.Lock()


async def _iter_chunks_with_timeout(content, chunk_timeout: float):
    """带超时的异步 chunk 迭代器"""
    aiter = content.iter_any().__aiter__()
    while True:
        try:
            chunk = await asyncio.wait_for(aiter.__anext__(), timeout=chunk_timeout)
            yield chunk
        except StopAsyncIteration:
            break


async def generate_novelai_image_stream(
    params: dict,
    progress_callback: Callable = None,
    token: str = None,
    recaptcha_token: Optional[str] = None,
) -> str:
    """
    流式生成 NovelAI 图片
    :param params: 生成参数
    :param progress_callback: 进度回调 async def callback(step, total_steps, image_b64, is_final)
    :param token: NovelAI Token（Bearer）
    :param recaptcha_token: 当非空时，走 trial / shared-trial 路径，
        请求体改成 multipart/form-data，payload 顶层加 recaptcha_token 字段
    :return: 最终图片的 base64 编码
    """
    if token is None:
        token = await token_manager.get_best_token() or get_novelai_tokens()[0]
    use_token = token
    is_boost = recaptcha_token is not None
    
    # 提取参数
    input_text1 = params.get("input_text1", "")
    input_text2 = params.get("input_text2", "")
    seed = params.get("seed", 0)
    width = params.get("width", 832)
    height = params.get("height", 1216)
    steps = params.get("steps", 28)
    scale = params.get("scale", 5)
    model = params.get("model", "nai-diffusion-4-5-full")
    sampler = params.get("sampler", "k_euler_ancestral")
    cfg_rescale = params.get("cfg_rescale", 0)
    noise_schedule = params.get("noise_schedule", "karras")
    skip_cfg_above_sigma = params.get("skip_cfg_above_sigma")
    quality_toggle = params.get("quality_toggle", False)
    uc_preset = params.get("uc_preset", 4)
    normalize_reference_strength_multiple = params.get(
        "normalize_reference_strength_multiple", True
    )
    
    # 处理角色提示词
    character_prompts = params.get("character_prompts", [])
    char_captions = params.get("char_captions", [])
    negative_char_captions = []
    
    if character_prompts and not char_captions:
        for cp in character_prompts:
            if cp.get("enabled") and cp.get("prompt"):
                center = cp.get("center", {"x": 0.5, "y": 0.5})
                char_captions.append({
                    "char_caption": cp.get("prompt", ""),
                    "centers": [center]
                })
                if cp.get("uc"):
                    negative_char_captions.append({
                        "char_caption": cp.get("uc", ""),
                        "centers": [center]
                    })
    
    url = 'https://image.novelai.net/ai/generate-image-stream'
    headers = {
        'accept': '*/*',
        'accept-language': 'en-US,en;q=0.9',
        'Authorization': f'Bearer {use_token}',
        # Content-Type 视 is_boost 而定：boost 路径走 multipart/form-data 携 recaptcha_token，
        # 付费路径走 application/json。下面在调 client.stream() 时切换。
        'origin': 'https://novelai.net',
        'referer': 'https://novelai.net/',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
        # NovelAI 前端每次请求都带这两个 header；trial/shared-trial 路径会校验它们的存在。
        # 缺了它们 boost 通道生图必 403（付费 Bearer 路径较宽松，未必受影响）。
        # x-correlation-id 必须 6 个字符（NovelAI 服务端硬限）。
        'x-correlation-id': secrets.token_hex(3),
        'x-initiated-at': time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime()),
    }
    
    payload = {
        "input": input_text1,
        "model": model,
        "action": params.get("action", "generate"),
        "use_new_shared_trial": True,
        "parameters": {
            "params_version": 3,
            "width": width,
            "height": height,
            "scale": scale,
            "seed": int(seed),
            "sampler": sampler,
            "steps": steps,
            "n_samples": 1,
            "ucPreset": uc_preset,
            "qualityToggle": quality_toggle,
            "cfg_rescale": cfg_rescale,
            "noise_schedule": noise_schedule,
            "skip_cfg_above_sigma": skip_cfg_above_sigma,
            "legacy": False,
            "add_original_image": True,
            "use_coords": True,
            "legacy_uc": False,
            "normalize_reference_strength_multiple": normalize_reference_strength_multiple,
            "v4_prompt": {
                "caption": {
                    "base_caption": input_text1,
                    "char_captions": char_captions
                },
                "use_coords": True,
                "use_order": True
            },
            "v4_negative_prompt": {
                "caption": {
                    "base_caption": input_text2,
                    "char_captions": negative_char_captions
                },
                "legacy_uc": False
            },
            "negative_prompt": input_text2,
            "characterPrompts": character_prompts,
            "deliberate_euler_ancestral_bug": False,
            "prefer_brownian": True,
            "image_format": "png",
            "stream": "msgpack"
        }
    }
    
    # 图生图参数
    if params.get("image"):
        payload["action"] = "img2img"
        payload["parameters"]["image"] = params["image"]
        payload["parameters"]["strength"] = params.get("strength", 0.6)
        payload["parameters"]["noise"] = params.get("noise", 0.1)
    
    # 局部重绘参数
    if params.get("action") == "infill" and params.get("mask"):
        payload["action"] = "infill"
        payload["parameters"]["image"] = params["image"]
        payload["parameters"]["mask"] = params["mask"]
        payload["parameters"]["strength"] = params.get("strength", 0.7)
        payload["parameters"]["noise"] = params.get("noise", 0)
        payload["parameters"]["extra_noise_seed"] = int(seed)
        payload["parameters"]["add_original_image"] = True
    
    # Vibe 参数
    if params.get("reference_image_multiple"):
        payload["parameters"]["reference_image_multiple"] = params["reference_image_multiple"]
        # NovelAI API 的 normalize_reference_strength_multiple 仅对缓存模式生效，
        # 直接传编码数据时需要服务端自行归一化 strength
        strengths = params.get("reference_strength_multiple", [0.5])
        if normalize_reference_strength_multiple and len(strengths) > 1:
            total = sum(strengths)
            if total > 1:
                strengths = [s / total for s in strengths]
        payload["parameters"]["reference_strength_multiple"] = strengths
        print(f"[NovelAI] Vibe: count={len(params['reference_image_multiple'])}, "
              f"strengths={strengths}, "
              f"normalize={normalize_reference_strength_multiple}")
    
    # CR/Precise Reference 参数
    if params.get("director_reference_images"):
        payload["parameters"]["director_reference_images"] = params["director_reference_images"]
        payload["parameters"]["director_reference_descriptions"] = params.get("director_reference_descriptions", [])
        payload["parameters"]["director_reference_information_extracted"] = params.get("director_reference_information_extracted", [1])
        payload["parameters"]["director_reference_strength_values"] = params.get("director_reference_strength_values", [1])
        payload["parameters"]["director_reference_secondary_strength_values"] = params.get("director_reference_secondary_strength_values", [0])
    
    # 代理设置（已在全局 session 中配置）
    CHUNK_TIMEOUT = 45
    last_image_data = None
    final_sent = False
    
    # Boost 路径：把 recaptcha_token 注入 payload 顶层，并切到 multipart/form-data
    if is_boost:
        payload["recaptcha_token"] = recaptcha_token
        payload.setdefault("use_new_shared_trial", True)

        # vibe：NovelAI 在 multipart 模式下把 parameters.reference_image_multiple
        # 字段当作 form part name 引用。按真实前端抓包，命名是 ref_multiple_{i}，
        # 每张 vibe 的 base64 解码后作为独立 part，Content-Type: image/png。
        # （注：项目这里发的是 encoded vibe vector 不是 PNG，但 NovelAI 服务端不严格
        # 校验 Content-Type，付费 JSON 路径也是同一份 vector 已经验证可用。）
        vibe_parts: list[tuple[str, bytes]] = []  # (part_name, raw_bytes)
        p = payload["parameters"]
        if isinstance(p.get("reference_image_multiple"), list):
            new_refs: list[str] = []
            for i, b64 in enumerate(p["reference_image_multiple"]):
                part_name = f"ref_multiple_{i}"
                try:
                    raw = base64.b64decode(b64) if isinstance(b64, str) else b""
                except Exception:
                    raw = b""
                if raw:
                    vibe_parts.append((part_name, raw))
                    new_refs.append(part_name)
                else:
                    new_refs.append(b64)  # 解码失败兜底（理论不发生）
            p["reference_image_multiple"] = new_refs

        boundary = "----WebKitFormBoundary" + secrets.token_hex(8)
        body_chunks: list[bytes] = []
        # 按真实前端抓包顺序：vibe parts 在前，request part 在后
        for part_name, raw in vibe_parts:
            body_chunks.append(
                (
                    f"--{boundary}\r\n"
                    f'Content-Disposition: form-data; name="{part_name}"; filename="blob"\r\n'
                    f"Content-Type: image/png\r\n\r\n"
                ).encode("utf-8")
            )
            body_chunks.append(raw)
            body_chunks.append(b"\r\n")
        body_chunks.append(
            (
                f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="request"; filename="blob"\r\n'
                f"Content-Type: application/json\r\n\r\n"
                f"{json.dumps(payload, ensure_ascii=False, separators=(',', ':'))}\r\n"
            ).encode("utf-8")
        )
        body_chunks.append(f"--{boundary}--\r\n".encode("utf-8"))
        multipart_body = b"".join(body_chunks)

        if vibe_parts:
            sizes = ", ".join(f"{n}={len(r)/1024:.0f}KB" for n, r in vibe_parts)
            print(f"[NovelAI/boost] multipart vibe parts {len(vibe_parts)} 个: {sizes}")

        boost_headers = dict(headers, **{
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        })

    # Boost 路径：用一次性的 HTTP/1.1 client（mirror test script 行为）。
    # 测试脚本能过 / boost worker 全局 HTTP/2 + 复用连接 403 —— 唯一可见差异在这里。
    # 推测 NovelAI 对 trial/shared-trial 路径的校验对 HTTP/2 多路复用或者连接复用敏感。
    # 付费路径继续用 _nai_session（HTTP/2 + 全局复用），那条 NovelAI 不查 captcha 没事。
    try:
        _t_req = time.monotonic()
        if is_boost:
            boost_client = httpx.AsyncClient(
                http2=False,
                timeout=httpx.Timeout(300, connect=30, read=90),
                proxy=get_image_generation_proxy_url() if get_image_generation_proxy_url() else None,
            )
            try:
                async with boost_client.stream(
                    "POST", url, headers=boost_headers, content=multipart_body,
                ) as response:
                    print(f"[NovelAI/boost] HTTP响应耗时: {time.monotonic()-_t_req:.2f}s (HTTP/{response.http_version})")
                    if response.status_code != 200:
                        body_text = (await response.aread())[:500].decode("utf-8", errors="replace")
                        print(f"[NovelAI/boost] 请求失败: {response.status_code}  body={body_text}")
                        raise Exception(f"请求失败: {response.status_code} {body_text}")
                    buffer = b""
                    _first_chunk = True
                    async for chunk in response.aiter_bytes():
                        if _first_chunk:
                            print(f"[NovelAI/boost] 首个chunk耗时: {time.monotonic()-_t_req:.2f}s, size={len(chunk)}")
                            _first_chunk = False
                        buffer += chunk

                        while len(buffer) >= 4:
                            msg_len = int.from_bytes(buffer[:4], 'big')
                            if len(buffer) < 4 + msg_len:
                                break
                            msg_data = buffer[4:4+msg_len]
                            buffer = buffer[4+msg_len:]
                            try:
                                message = msgpack.unpackb(msg_data, raw=False)
                                step_ix = message.get("step_ix")
                                image_data = message.get("image")
                                if "code" in message and message.get("code") != 200:
                                    err_code = message.get("code")
                                    err_msg = message.get("message", "未知错误")
                                    print(f"[NovelAI/boost] API 错误: code={err_code}, message={err_msg}")
                                    if isinstance(err_code, int) and 100 <= err_code <= 599:
                                        raise _NaiStreamError(
                                            f"请求失败: {err_code} "
                                            f"{json.dumps({'message': err_msg}, ensure_ascii=False)}"
                                        )
                                    raise _NaiStreamError(err_msg)
                                if image_data and isinstance(image_data, bytes):
                                    last_image_data = image_data
                                    if progress_callback:
                                        image_b64 = base64.b64encode(image_data).decode('utf-8')
                                        if step_ix is not None:
                                            await progress_callback(step_ix + 1, steps, image_b64, False)
                                        else:
                                            await progress_callback(steps, steps, image_b64, True)
                                            final_sent = True
                            except _NaiStreamError:
                                raise
                            except Exception as e:
                                print(f"[NovelAI/boost] 解析 msgpack 失败: {e}")
            finally:
                await boost_client.aclose()

            # boost 路径里上面已经处理完整流，下面共用代码跳过
            if last_image_data and progress_callback and not final_sent:
                final_b64 = base64.b64encode(last_image_data).decode('utf-8')
                await progress_callback(steps, steps, final_b64, True)
            if last_image_data:
                return base64.b64encode(last_image_data).decode('utf-8')
            return None

        # 付费路径（保持原样：全局 HTTP/2 session + JSON 体）
        client = _get_nai_session()
        stream_ctx = client.stream(
            "POST", url,
            headers=dict(headers, **{"Content-Type": "application/json"}),
            json=payload,
        )
        async with stream_ctx as response:
            print(f"[NovelAI{'/boost' if is_boost else ''}] HTTP响应耗时: {time.monotonic()-_t_req:.2f}s (HTTP/{response.http_version})")
            if response.status_code != 200:
                await response.aread()
                print(f"[NovelAI] 请求失败: {response.status_code}")
                raise Exception(f"请求失败: {response.status_code}")

            buffer = b""
            _first_chunk = True
            async for chunk in response.aiter_bytes():
                if _first_chunk:
                    print(f"[NovelAI] 首个chunk耗时: {time.monotonic()-_t_req:.2f}s, size={len(chunk)}")
                    _first_chunk = False
                buffer += chunk

                while len(buffer) >= 4:
                    msg_len = int.from_bytes(buffer[:4], 'big')
                    if len(buffer) < 4 + msg_len:
                        break

                    msg_data = buffer[4:4+msg_len]
                    buffer = buffer[4+msg_len:]

                    try:
                        message = msgpack.unpackb(msg_data, raw=False)
                        step_ix = message.get("step_ix")
                        image_data = message.get("image")

                        # 检查是否是错误消息
                        if "code" in message and message.get("code") != 200:
                            err_code = message.get("code")
                            err_msg = message.get("message", "未知错误")
                            print(f"[NovelAI] API 错误: code={err_code}, message={err_msg}")
                            if isinstance(err_code, int) and 100 <= err_code <= 599:
                                raise _NaiStreamError(
                                    f"请求失败: {err_code} "
                                    f"{json.dumps({'message': err_msg}, ensure_ascii=False)}"
                                )
                            raise _NaiStreamError(err_msg)

                        if image_data and isinstance(image_data, bytes):
                            last_image_data = image_data

                            if progress_callback:
                                image_b64 = base64.b64encode(image_data).decode('utf-8')

                                if step_ix is not None:
                                    await progress_callback(step_ix + 1, steps, image_b64, False)
                                else:
                                    await progress_callback(steps, steps, image_b64, True)
                                    final_sent = True
                    except _NaiStreamError:
                        raise
                    except Exception as e:
                        print(f"[NovelAI] 解析 msgpack 失败: {e}")

        if last_image_data and progress_callback and not final_sent:
            final_b64 = base64.b64encode(last_image_data).decode('utf-8')
            await progress_callback(steps, steps, final_b64, True)

        if last_image_data:
            return base64.b64encode(last_image_data).decode('utf-8')
        return None

    except httpx.TimeoutException:
        raise Exception(f"流式生成超时")
    except Exception as e:
        print(f"[NovelAI] 流式生成失败: {e}")
        raise


async def novelai_worker(worker_id: int, token: str):
    """NovelAI 图片生成 Worker"""
    global _current_task, _running_count
    
    worker_name = f"Worker-{worker_id + 1}"
    print(f"[{worker_name}] 启动，Token: {hashlib.sha256(token.encode()).hexdigest()[:8]}")
    
    while True:
        item = await _image_queue.get()
        task_id, params, task_seq = item
        
        # 提取关键参数
        width = params.get("width", 832)
        height = params.get("height", 1216)
        steps = params.get("steps", 28)
        seed = params.get("seed", 0)
        
        # 检查任务是否已被取消
        task = _generation_tasks.get(task_id)
        user_id = task.get("user_id", "unknown") if task else "unknown"
        
        if task and task.get("status") == "cancelled":
            print(f"[{worker_name}] 跳过已取消的任务: id={task_id}, user={user_id}")
            # 减少用户待处理计数（仅当取消 API 未提前减过时）
            if not task.get("_pending_decremented"):
                task_user_id = task.get("user_id", "")
                if task_user_id:
                    with _state_lock:
                        cnt = _user_pending.get(task_user_id, 0)
                        if cnt > 0:
                            _user_pending[task_user_id] = cnt - 1
            # 清理 WebSocket 订阅
            _generation_websockets.pop(task_id, None)
            _image_queue.task_done()
            # 广播队列位置更新
            await _broadcast_queue_position_update()
            continue
        
        print(f"[{worker_name}] 开始处理任务: id={task_id}, user={user_id}, seq={task_seq}, size={width}x{height}, steps={steps}, seed={seed}")
        
        if task_seq > 0:
            with _state_lock:
                _current_task = task_seq
        
        with _state_lock:
            _running_count += 1
        
        start_time = time.time()
        
        try:
            # 进度回调
            async def progress_callback(step: int, total_steps: int, image_b64: str, is_final: bool = False):
                task = _generation_tasks.get(task_id)
                if task:
                    task["step"] = step
                    task["total_steps"] = total_steps
                    if is_final:
                        task["result"] = image_b64
                        task["status"] = "completed"
                        print(f"[{worker_name}] 生成完成: id={task_id}, user={user_id}, step={step}/{total_steps}")
                    elif step > 0:
                        print(f"[{worker_name}] 生成进度: id={task_id}, user={user_id}, step={step}/{total_steps}")
                    await _notify_task_update(task_id, task["status"], step, total_steps, image_b64 if is_final else None, image_b64 if not is_final else None)
            
            # 智能选择并独占一个可用的 Token（解决并发 429 报错）
            # 注意：acquire_token() 可能阻塞等待，此时任务状态仍为 queued
            need_anlas = _task_needs_anlas(params)
            use_token = await token_manager.acquire_token(need_anlas=need_anlas)
            
            try:
                # 获取到 Token 后才标记为生成中，避免前端在等待 Token 阶段显示进度条
                task = _generation_tasks.get(task_id)
                persisted = await _cloud_jobs.get(task_id)
                if persisted is None or persisted.status is not JobStatus.QUEUED:
                    if persisted and persisted.status is JobStatus.CANCELLED and task:
                        task["status"] = "cancelled"
                    continue
                if task:
                    task["status"] = "generating"
                    # 只发一次 generating 通知（不再额外调用 progress_callback(0)）
                    await _notify_task_update(task_id, "generating", 0, params.get("steps", 28))

                # 调用流式生成
                result_b64 = await _await_generation_upstream(
                    task_id,
                    lambda: generate_novelai_image_stream(params, progress_callback, use_token),
                )
            
                elapsed = time.time() - start_time
                
                if result_b64:
                    task = _generation_tasks.get(task_id)
                    if task and task["status"] != "completed":
                        task["result"] = result_b64
                        task["status"] = "completed"
                        await _notify_task_update(task_id, "completed", params.get("steps", 28), params.get("steps", 28), result_b64)
                    await token_manager.record_success(use_token)
                    print(f"[{worker_name}] ✓ 任务完成: id={task_id}, user={user_id}, 耗时={elapsed:.1f}s")
                    
                    # 记录 Web 端使用统计
                    bot_uid = (_generation_tasks.get(task_id) or {}).get("bot_user_id")
                    if bot_uid:
                        await _record_web_stats(bot_uid, params)
                        await _record_generation_duration(bot_uid, elapsed)
                elif (_generation_tasks.get(task_id) or {}).get("status") != "cancelled":
                    task = _generation_tasks.get(task_id)
                    if task:
                        task["status"] = "failed"
                        task["error"] = "生成失败：服务器未返回图像数据，请稍后重试"
                        await _notify_task_update(task_id, "failed", error=task["error"])
                    await token_manager.record_error(use_token, "无返回数据")
                    print(f"[{worker_name}] ✗ 任务失败: id={task_id}, user={user_id}, 原因=无返回数据, 耗时={elapsed:.1f}s")
                        
            except Exception as e:
                import traceback
                tb = traceback.format_exc()
                elapsed = time.time() - start_time
                print(f"[{worker_name}] ✗ 任务异常: id={task_id}, user={user_id}, 错误={e}, 耗时={elapsed:.1f}s")
                print(f"[{worker_name}] 异常堆栈:\n{tb}")
                task = _generation_tasks.get(task_id)
                cancelled = await _finish_cancel_if_requested(task_id)
                if task and not cancelled:
                    task["status"] = "failed"
                    task["error"] = _humanize_nai_error(str(e))
                    await _notify_task_update(task_id, "failed", error=task["error"])
                if not cancelled:
                    await token_manager.record_error(use_token, str(e))
            finally:
                # 任务完成或失败，释放占用的 Token，允许其他 worker 或 vibe 请求使用
                await token_manager.release_token(use_token)
                
        except Exception as e:
            # 捕获获取 Token 异常等外部错误
            import traceback
            tb = traceback.format_exc()
            elapsed = time.time() - start_time
            print(f"[{worker_name}] ✗ 获取Token/初始化异常: id={task_id}, user={user_id}, 错误={e}, 耗时={elapsed:.1f}s")
            task = _generation_tasks.get(task_id)
            cancelled = await _finish_cancel_if_requested(task_id)
            if task and not cancelled:
                task["status"] = "failed"
                task["error"] = _humanize_nai_error(str(e))
                await _notify_task_update(task_id, "failed", error=task["error"])
        finally:
            # 减少用户待处理计数（仅当取消 API 未提前减过时）
            task = _generation_tasks.get(task_id)
            if task:
                if not task.get("_pending_decremented"):
                    task_user_id = task.get("user_id", "")
                    if task_user_id:
                        with _state_lock:
                            cnt = _user_pending.get(task_user_id, 0)
                            if cnt > 0:
                                _user_pending[task_user_id] = cnt - 1
                # 任务结束后清理大体积的 params 数据，释放内存（保留关键字段用于状态查询）
                task.pop("params", None)

            await _settle_generation_quota(task_id)
            
            # 清理 WebSocket 订阅
            _generation_websockets.pop(task_id, None)
            
            with _state_lock:
                _running_count -= 1
                remaining = _image_queue.qsize()
            _image_queue.task_done()
            print(f"[{worker_name}] 队列剩余: {remaining} 个任务")
            
            # 广播队列位置更新给所有排队中的任务
            await _broadcast_queue_position_update()


async def _boost_handle(task_id: str, params: dict, task_seq: int):
    """单个 boost 任务的完整处理流程（ephemeral asyncio task）。
    失败时回退到 _image_queue，让 paid worker 接管。"""
    global _current_task, _running_count, _boost_global_cooldown_until

    worker_name = "Boost"

    width = params.get("width", 832)
    height = params.get("height", 1216)
    steps = params.get("steps", 28)

    task = _generation_tasks.get(task_id)
    user_id = task.get("user_id", "unknown") if task else "unknown"

    # 取消检查
    if task and task.get("status") == "cancelled":
        print(f"[{worker_name}] 跳过已取消任务: id={task_id}, user={user_id}")
        if task and not task.get("_pending_decremented"):
            tu = task.get("user_id", "")
            if tu:
                with _state_lock:
                    cnt = _user_pending.get(tu, 0)
                    if cnt > 0:
                        _user_pending[tu] = cnt - 1
        _generation_websockets.pop(task_id, None)
        await _broadcast_queue_position_update()
        return

    print(f"[{worker_name}] 接单: id={task_id}, user={user_id}, seq={task_seq}, "
          f"size={width}x{height}, steps={steps}")

    if task_seq > 0:
        with _state_lock:
            _current_task = task_seq
    with _state_lock:
        _running_count += 1

    start_time = time.time()
    held_email: Optional[str] = None
    fallback_to_queue = False
    provider_started = False

    try:
        # progress_callback（接口跟 paid worker 完全一致）
        async def progress_callback(step, total_steps, image_b64, is_final=False):
            t = _generation_tasks.get(task_id)
            if t:
                t["step"] = step
                t["total_steps"] = total_steps
                if is_final:
                    t["result"] = image_b64
                    t["status"] = "completed"
                    print(f"[{worker_name}] 生成完成: id={task_id}, user={user_id}, "
                          f"step={step}/{total_steps}")
                elif step > 0:
                    print(f"[{worker_name}] 生成进度: id={task_id}, user={user_id}, "
                          f"step={step}/{total_steps}")
                await _notify_task_update(
                    task_id, t["status"], step, total_steps,
                    image_b64 if is_final else None,
                    image_b64 if not is_final else None,
                )

        # 1. 取 trial 账号
        acq = await trial_pool.acquire() if trial_pool else None
        if not acq:
            print(f"[{worker_name}] 没有可用 trial 号，回退到队列")
            fallback_to_queue = True
            return
        held_email, acct = acq
        print(f"[{worker_name}] 用号 {held_email}  image_left={acct['image_left']}")

        # 2. 解 captcha
        try:
            captcha_token = await boost_solve_captcha(
                "ai_generation",
                account={
                    "email": held_email,
                    "password": acct.get("password", ""),
                    "bearer": acct.get("bearer", ""),
                },
            )
        except (CaptchaError, CaptchaTimeout) as e:
            print(f"[{worker_name}] captcha 失败: {e}")
            # captcha 失败不计入全局 403 计数（那是给 NovelAI 风控用的，不是 captcha 服务挂）
            # captcha 失败也不影响账号（不扣不冷却）；账号在 finally 里释放
            fallback_to_queue = True
            return

        # 2.5. captcha 解完了，再瞄一眼 paid worker 状态：
        # 如果在 captcha 那 5-10s 里 paid 已经空出来了，就把任务还回队列让 paid 抢，
        # 避免浪费 trial 配额 + captcha 钱 + 用户多等 5s。
        # 检查条件：(a) 任务没被取消 (b) 至少 1 个 paid token 已空 (c) 当前队列空 / 也不长
        if not _all_paid_busy():
            t = _generation_tasks.get(task_id)
            if t and t.get("status") not in ("cancelled", "completed"):
                print(f"[{worker_name}] captcha 解完时 paid 已空闲 → 撤回任务让 paid 接，"
                      f"丢掉 captcha 但省 1 张 trial（号 {held_email}）")
                # 账号 release 不扣 deduct 也不 cooldown
                await trial_pool.release(held_email)
                held_email = None
                fallback_to_queue = True
                return  # 走 finally 把任务塞回 _image_queue

        # 3. 标记 generating
        t = _generation_tasks.get(task_id)
        persisted = await _cloud_jobs.get(task_id)
        if persisted is None or persisted.status is not JobStatus.QUEUED:
            if persisted and persisted.status is JobStatus.CANCELLED and t:
                t["status"] = "cancelled"
            fallback_to_queue = False
            return
        if t:
            t["status"] = "generating"
            await _notify_task_update(task_id, "generating", 0, params.get("steps", 28))

        # 4. 调用流式生成（带 recaptcha_token = 走 boost 路径）
        result_b64 = await _await_generation_upstream(
            task_id,
            lambda: generate_novelai_image_stream(
                params,
                progress_callback,
                token=acct["bearer"],
                recaptcha_token=captcha_token,
            ),
        )
        provider_started = True
        elapsed = time.time() - start_time

        if result_b64:
            t = _generation_tasks.get(task_id)
            if t and t["status"] != "completed":
                t["result"] = result_b64
                t["status"] = "completed"
                await _notify_task_update(
                    task_id, "completed",
                    params.get("steps", 28), params.get("steps", 28),
                    result_b64,
                )
            print(f"[{worker_name}] ✓ 完成: id={task_id}, user={user_id}, "
                  f"号 {held_email}, 耗时={elapsed:.1f}s")
            # 滑动窗口记录成功
            _boost_recent_results.append(False)
            # 统计
            bot_uid = (_generation_tasks.get(task_id) or {}).get("bot_user_id")
            if bot_uid:
                await _record_web_stats(bot_uid, params)
                await _record_generation_duration(bot_uid, elapsed)
            # 成功：扣 1 张额度
            await trial_pool.release(held_email, deduct=True)
            held_email = None
        elif (_generation_tasks.get(task_id) or {}).get("status") != "cancelled":
            print(f"[{worker_name}] ✗ 无返回数据: id={task_id}, 号 {held_email}")
            await trial_pool.release(held_email,
                                     cooldown_sec=NAI_BOOST_COOLDOWN_PER_ACCOUNT_SEC)
            held_email = None
            fallback_to_queue = True

    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        elapsed = time.time() - start_time
        msg = str(e)
        print(f"[{worker_name}] ✗ 异常: id={task_id}, user={user_id}, "
              f"错误={msg}, 耗时={elapsed:.1f}s")
        print(tb)
        cancelled = await _finish_cancel_if_requested(task_id)
        # 滑动窗口 403 熔断：最近 N 次任务里失败 ≥ 阈值 → 全局冷却。
        # 兜底，防止服务器 IP 被风控了仍然反复尝试浪费 trial / captcha 钱。
        # 其他类型失败（429 / 网络 / 解析）不入窗口，只统计 NAI 明确的 captcha/403 风控信号。
        is_403_or_captcha = (
            "403" in msg
            or "Recaptcha validation failed" in msg
            or "recaptcha validation failed" in msg.lower()
        )
        if is_403_or_captcha and not cancelled:
            _boost_recent_results.append(True)
            fail_count = _boost_recent_403_count()
            print(f"[{worker_name}] 窗口 403 计数 {fail_count}/{NAI_BOOST_403_THRESHOLD} "
                  f"(窗口大小 {len(_boost_recent_results)}/{NAI_BOOST_403_WINDOW})")
            if fail_count >= NAI_BOOST_403_THRESHOLD:
                _boost_global_cooldown_until = time.time() + NAI_BOOST_GLOBAL_COOLDOWN_SEC
                _boost_recent_results.clear()  # 进入冷却期，重置窗口
                print(f"[{worker_name}] 窗口内 403 ≥ {NAI_BOOST_403_THRESHOLD}，"
                      f"全局冷却 {NAI_BOOST_GLOBAL_COOLDOWN_SEC}s 到 "
                      f"{time.ctime(_boost_global_cooldown_until)}")
        # 分类：429 并发锁仅短冷却（NovelAI 在同账号下还在跑上一张），其它走标准冷却
        if "429" in msg or "Concurrent generation" in msg:
            cd = 5.0
            print(f"[{worker_name}] 429 并发锁，号 {held_email} 短冷却 5s")
        else:
            cd = NAI_BOOST_COOLDOWN_PER_ACCOUNT_SEC
        if held_email:
            await trial_pool.release(held_email, cooldown_sec=cd)
            held_email = None
        fallback_to_queue = not cancelled

    finally:
        # 兜底：万一持仓未释放
        if held_email:
            await trial_pool.release(held_email)

        persisted = await _cloud_jobs.get(task_id)
        provider_started = bool(persisted and persisted.provider_attempted)

        # boost 处理失败 → 任务塞回队列让 paid worker 接（不扣 user_pending，
        # 因为任务还在跑，等 paid worker 真的结束时再扣）
        if fallback_to_queue:
            t = _generation_tasks.get(task_id)
            if t and t.get("status") not in ("cancelled", "completed"):
                if provider_started:
                    t["status"] = "failed"
                    t["error"] = "boost 上游尝试失败"
                    await _notify_task_update(task_id, "failed", error=t["error"])
                    fallback_to_queue = False
                else:
                    t["status"] = "queued"
                    await _notify_task_update(task_id, "queued", 0, params.get("steps", 28))
                    try:
                        _image_queue.put_nowait((task_id, params, task_seq))
                        print(f"[{worker_name}] 回退到队列: id={task_id}")
                    except asyncio.QueueFull:
                        print(f"[{worker_name}] 回退入队失败: queue full")
                        t["status"] = "failed"
                        t["error"] = "boost 失败且回退队列已满"
                        await _notify_task_update(task_id, "failed", error=t["error"])
                        fallback_to_queue = False

        with _state_lock:
            _running_count -= 1

        # 用户 pending 计数 + WebSocket 清理：只在任务最终结束时做，回退时不动
        if not fallback_to_queue:
            t = _generation_tasks.get(task_id)
            if t and not t.get("_pending_decremented"):
                tu = t.get("user_id", "")
                if tu:
                    with _state_lock:
                        cnt = _user_pending.get(tu, 0)
                        if cnt > 0:
                            _user_pending[tu] = cnt - 1
            if t:
                t.pop("params", None)
            _generation_websockets.pop(task_id, None)

        await _settle_generation_quota(task_id)
        await _broadcast_queue_position_update()


def _all_paid_busy() -> bool:
    """所有可用付费 token 都 in_use 时返回 True。"""
    tokens = token_manager._tokens
    if not tokens:
        return True  # 没付费号 = 等同全忙
    return all(
        info.get("in_use") for info in tokens.values()
        if not info.get("disabled")
    )


def _boost_available_now() -> bool:
    """boost 通道当前是否可用：开关 + 不在全局冷却。"""
    if not (CAPSOLVER_CLIENT_KEY or NAI_RECAPTCHA_TOKEN_API_URL):
        return False
    if trial_pool is None:
        return False
    if time.time() < _boost_global_cooldown_until:
        return False
    return True


def _get_task_queue_position(task_id: str) -> int:
    """计算任务的真实队列位置（遍历所有排队任务按序列号排序）"""
    task = _generation_tasks.get(task_id)
    if not task or task.get("status") != "queued":
        return 0
    
    # 收集所有排队中的任务，按 task_seq 排序计算真实位置
    queued = sorted(
        [(tid, t) for tid, t in _generation_tasks.items() if t.get("status") == "queued"],
        key=lambda x: x[1].get("task_seq", 0)
    )
    for pos, (tid, _) in enumerate(queued, start=1):
        if tid == task_id:
            return pos
    
    # 降级：用 qsize，但至少返回 1
    return max(_image_queue.qsize() if _image_queue else 1, 1)


async def _broadcast_queue_position_update():
    """广播队列位置更新给所有排队中的任务"""
    # 按 task_seq 排序，确保位置计算正确
    queued_tasks = [(tid, task) for tid, task in _generation_tasks.items() 
                    if task.get("status") == "queued"]
    queued_tasks.sort(key=lambda x: x[1].get("task_seq", 0))
    
    for pos, (tid, task) in enumerate(queued_tasks, start=1):
        sockets = _generation_websockets.get(tid, set()).copy()
        for ws in sockets:
            try:
                await ws.send_json({
                    "action": "task_update",
                    "task_id": tid,
                    "status": "queued",
                    "queue_position": pos,
                })
            except Exception:
                subscribers = _generation_websockets.get(tid)
                if subscribers is not None:
                    subscribers.discard(ws)


class _NaiStreamError(Exception):
    """NovelAI 流内业务错误（code != 200），与 msgpack 解析失败区分，
    避免被 generate_novelai_image_stream 里捕获 msgpack 异常的兜底 except 吞掉。"""
    pass


def _humanize_nai_error(raw: Optional[str]) -> str:
    """把 NovelAI 抛出的原始异常文本归一化成对终端用户友好的中文短句。
    Why: 后端目前把 `请求失败: <status> <body>` / 流内英文 message 原样塞给前端，用户看不懂。
    How: 只识别 HTTP status 与少量 NovelAI 文案关键字；无法识别时原样返回（不丢信息）。
    幂等：已经是中文友好文案的输入会直接返回。"""
    if not raw:
        return "生成失败"
    text = str(raw).strip()
    if not text:
        return "生成失败"

    # 已是中文友好文案则直接返回（幂等）。
    # 用 humanizer 自身输出里的独占短语判定，避免误吞含 "Token"/"NovelAI" 的英文原文。
    _human_markers = (
        "请稍后重试", "请联系管理员", "请修改后重试", "请检查提示词", "请缩短后重试",
        "宽高需为", "未授权或已失效", "余额/订阅不足", "图像数据", "并发限制",
        "格式非法", "网络连接失败", "reCAPTCHA",
    )
    if any(m in text for m in _human_markers):
        return text

    # 超时类
    low = text.lower()
    if "超时" in text or "timeout" in low or "timed out" in low:
        return "生成超时，请稍后重试"

    # 解析形如 "请求失败: <status> <body?>"
    m = re.match(r"请求失败:\s*(\d{3})\s*(.*)", text, re.DOTALL)
    api_message = ""
    status: Optional[int] = None
    if m:
        status = int(m.group(1))
        body = m.group(2).strip()
        if body:
            try:
                obj = json.loads(body)
                api_message = str(obj.get("message") or obj.get("error") or "")
            except Exception:
                api_message = body[:200]

    if status is not None:
        amlow = api_message.lower()
        if status == 400:
            if "invalid content" in amlow or "forbidden" in amlow or "harmful" in amlow:
                return "提示词格式非法，请修改后重试"
            if ("too many" in amlow and ("word" in amlow or "token" in amlow)) or "exceed" in amlow:
                return "提示词过长，请缩短后重试"
            if "resolution" in amlow or "dimension" in amlow or "size" in amlow:
                return "图片尺寸非法（宽高需为 64 的倍数，且不超过订阅等级允许的上限）"
            if api_message:
                return f"请求参数错误：{api_message}"
            return "请求参数错误，请检查提示词与生成参数"
        if status == 401:
            return "NovelAI Token 未授权或已失效，请联系管理员"
        if status == 402:
            return "NovelAI 账号余额/订阅不足，请联系管理员"
        if status == 403:
            return "NovelAI 拒绝请求（触发风控或 reCAPTCHA 失败），请稍后重试"
        if status == 408:
            return "NovelAI 服务端处理超时，请稍后重试"
        if status == 409:
            return f"NovelAI 接口冲突：{api_message or '请稍后重试'}"
        if status == 429:
            return "NovelAI 并发限制（同账号同时只能生成一张），请稍后重试"
        if 500 <= status <= 599:
            return f"NovelAI 服务异常（{status}），请稍后重试"
        return f"NovelAI 接口错误（{status}）：{api_message or '请稍后重试'}"

    # 没有 status 前缀的兜底关键字（多见于流内英文 message / 网络层异常）
    if "invalid content" in low or "forbidden" in low or "harmful" in low:
        return "提示词格式非法，请修改后重试"
    if "concurrent" in low and "generation" in low:
        return "NovelAI 并发限制（同账号同时只能生成一张），请稍后重试"
    if "recaptcha" in low:
        return "NovelAI 拒绝请求（reCAPTCHA 验证失败），请稍后重试"
    if "无返回数据" in text or "no image" in low or "empty" in low:
        return "生成失败：服务器未返回图像数据，请稍后重试"
    if "connect" in low or "network" in low or "ssl" in low or "proxy" in low:
        return "网络连接失败，请稍后重试"

    return text


_LEGACY_TO_JOB_STATUS = {
    "queued": JobStatus.QUEUED,
    "generating": JobStatus.RUNNING,
    "cancelling": JobStatus.CANCELLING,
    "completed": JobStatus.SUCCEEDED,
    "failed": JobStatus.FAILED,
    "cancelled": JobStatus.CANCELLED,
    "interrupted": JobStatus.INTERRUPTED,
}
_JOB_TO_LEGACY_STATUS = {
    JobStatus.QUEUED: "queued",
    JobStatus.RUNNING: "generating",
    JobStatus.CANCELLING: "cancelling",
    JobStatus.SUCCEEDED: "completed",
    JobStatus.FAILED: "failed",
    JobStatus.CANCELLED: "cancelled",
    JobStatus.INTERRUPTED: "interrupted",
}


def _generation_request_hash(params: dict[str, Any]) -> str:
    encoded = json.dumps(
        params,
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _persistent_generation_payload(params: dict[str, Any]) -> dict[str, Any]:
    """Keep useful request metadata without copying base64 source images into SQLite."""
    prompt = str(params.get("input_text1") or params.get("positivePrompt") or "")
    negative = str(params.get("input_text2") or params.get("negativePrompt") or "")
    return {
        "image_backend": str(params.get("_image_backend") or params.get("image_backend") or "novelai"),
        "model": str(params.get("model") or ""),
        "width": int(params.get("width") or 0),
        "height": int(params.get("height") or 0),
        "steps": int(params.get("steps") or 0),
        "seed": int(params.get("seed") or 0),
        "prompt_sha256": hashlib.sha256(prompt.encode("utf-8")).hexdigest(),
        "negative_prompt_sha256": hashlib.sha256(negative.encode("utf-8")).hexdigest(),
    }


async def _ensure_cloud_job_storage() -> None:
    await _cloud_jobs.initialize()
    await _cloud_job_results.initialize()


async def _persist_task_update(
    task_id: str,
    status: str,
    *,
    step: int,
    total_steps: int,
    result: str | None,
    error: str | None,
    event_metadata: Mapping[str, Any] | None = None,
):
    await _ensure_cloud_job_storage()
    target = _LEGACY_TO_JOB_STATUS.get(status)
    if target is None:
        raise InvalidRequestError("legacy job status is invalid")
    job = await _cloud_jobs.get(task_id)
    if job is None:
        raise ResourceNotFoundError()
    # Terminal idempotency must short-circuit before touching the result store.
    # Otherwise a retry carrying different bytes could overwrite or orphan the
    # already-committed result before the repository rejects the transition.
    if job.status is target and job.terminal:
        return job, None
    if job.terminal:
        raise JobStateConflictError("terminal job status cannot change")
    result_metadata = None
    if result:
        result_metadata = await _cloud_job_results.save_base64(task_id, result)

    # A running job must pass through cancelling before cancelled.  request_cancel
    # performs the classification in one BEGIN IMMEDIATE transaction.
    if target is JobStatus.CANCELLED and job.status is JobStatus.RUNNING:
        job, _ = await _cloud_jobs.request_cancel(task_id)
    if target is JobStatus.RUNNING:
        kind = "progress" if step > 0 else "started"
    elif target is JobStatus.SUCCEEDED:
        kind = "succeeded"
    else:
        kind = target.value
    event_data = dict(event_metadata or {})
    if step > 0:
        event_data.update({"step": step, "total_steps": total_steps})
    return await _cloud_jobs.transition(
        task_id,
        target,
        kind=kind,
        step=step,
        total_steps=total_steps,
        result=result_metadata,
        error=error,
        data=event_data,
    )


async def _legacy_job_response(job: CloudJob) -> dict[str, Any]:
    image = None
    if job.result:
        try:
            image = await _cloud_job_results.load_base64(job.result)
        except ResourceNotFoundError:
            image = None
    status = _JOB_TO_LEGACY_STATUS[job.status]
    return {
        "task_id": job.id,
        "status": status,
        "step": job.step,
        "total_steps": job.total_steps,
        "result": {"type": "base64", "imageBase64": image} if image else None,
        "error": job.error,
        "queue_position": _get_task_queue_position(job.id) if status == "queued" else 0,
    }


async def _notify_task_update(task_id: str, status: str, step: int = 0, total_steps: int = 0,
                               result: str = None, preview: str = None, error: str = None):
    """Persist one job event, then best-effort mirror it to legacy WebSockets."""
    if error:
        error = _humanize_nai_error(error)
    job, event = await _persist_task_update(
        task_id,
        status,
        step=step,
        total_steps=total_steps,
        result=result,
        error=error,
    )
    sockets = _generation_websockets.get(task_id, set()).copy()

    if not sockets:
        return

    progress_msg = None
    if step > 0 and not result:
        progress_msg = {
            "action": "task_progress",
            "task_id": task_id,
            "step": step,
            "total_steps": total_steps,
        }
        if preview:
            progress_msg["preview"] = preview
    update_msg = {
        "action": "task_update",
        "task_id": task_id,
        "status": status,
        "queue_position": _get_task_queue_position(task_id) if status == "queued" else 0,
        "sequence": event.sequence if event else await _cloud_jobs.latest_sequence(task_id),
    }
    if result:
        update_msg["result"] = {"type": "base64", "imageBase64": result}
    if error:
        update_msg["error"] = error
    for ws in sockets:
        try:
            if progress_msg:
                await ws.send_json(progress_msg)
            await ws.send_json(update_msg)
        except Exception as e:
            print(f"[WebSocket] 发送任务更新失败: {e}")
            subscribers = _generation_websockets.get(task_id)
            if subscribers is not None:
                subscribers.discard(ws)


async def _finish_cancel_if_requested(task_id: str) -> bool:
    job = await _cloud_jobs.get(task_id)
    if job is None or job.status not in {JobStatus.CANCELLING, JobStatus.CANCELLED}:
        return False
    if job.status is JobStatus.CANCELLING:
        job, _ = await _cloud_jobs.transition(
            task_id,
            JobStatus.CANCELLED,
            kind="cancelled",
            error="用户取消",
        )
    task = _generation_tasks.get(task_id)
    if task:
        task["status"] = "cancelled"
        task["error"] = "用户取消"
    await _notify_task_update(task_id, "cancelled", error="用户取消")
    return True


async def _await_generation_upstream(task_id: str, factory):
    """Register a gated provider task before atomically claiming its cost boundary."""
    start_provider = asyncio.Event()

    async def gated_provider():
        await start_provider.wait()
        return await factory()

    upstream = asyncio.create_task(gated_provider())
    _generation_upstream_tasks[task_id] = upstream
    try:
        try:
            job, _ = await _cloud_jobs.mark_provider_attempted(task_id)
        except JobStateConflictError:
            upstream.cancel()
            await asyncio.gather(upstream, return_exceptions=True)
            if await _finish_cancel_if_requested(task_id):
                return None
            raise
        start_provider.set()
        if job.quota_reservation_id:
            principal = Principal.user(job.resource.owner_id, job.resource.tenant_id)
            record = {
                "tenant_id": job.resource.tenant_id,
                "owner_id": job.resource.owner_id,
                "quota_reservation_id": job.quota_reservation_id,
            }
            await _quota_ledger.settle(
                record,
                principal,
                succeeded=True,
                job_id=task_id,
            )
            await _cloud_jobs.mark_cost_committed(task_id)
        return await upstream
    except asyncio.CancelledError:
        if not await _finish_cancel_if_requested(task_id):
            raise
        return None
    except BaseException:
        if not upstream.done():
            upstream.cancel()
            await asyncio.gather(upstream, return_exceptions=True)
        raise
    finally:
        if _generation_upstream_tasks.get(task_id) is upstream:
            _generation_upstream_tasks.pop(task_id, None)


async def start_novelai_workers():
    """启动 NovelAI Workers"""
    global _workers_started, trial_pool
    if _workers_started:
        return

    # 注册所有 Token 到管理器
    await token_manager.register_all()

    tokens = get_novelai_tokens()
    if not tokens:
        print("[NovelAI] 没有配置 Token，无法启动 Worker")
        return

    for i, token in enumerate(tokens):
        asyncio.create_task(novelai_worker(i, token))

    print(f"[NovelAI] 启动 {len(tokens)} 个 Worker")

    # 启动 boost 通道（trial 账号池 + token 续期 task）
    if CAPSOLVER_CLIENT_KEY or NAI_RECAPTCHA_TOKEN_API_URL:
        try:
            pool = TrialAccountPool(
                Path(NAI_BOOST_ACCOUNTS_FILE),
                Path(NAI_BOOST_STATE_FILE),
                active_count=NAI_BOOST_ACTIVE_ACCOUNTS,
            )
            await pool.load()
            trial_pool = pool
            asyncio.create_task(boost_token_refresher())
            asyncio.create_task(trial_pool_full_refresh_loop())
            # 启动时铺满 active 队列 + 刷一次实际余额，省第一波请求的串行延迟。
            target_active = NAI_BOOST_ACTIVE_ACCOUNTS or 1
            asyncio.create_task(pool.prewarm_active(target_active))
            stats = await trial_pool.stats()
            print(f"[NAI/boost] 启用，active {stats['active']}/{stats['total']} 号，"
                  f"可用 {stats['eligible']}，active 剩余 {stats['total_image_left']} 张；"
                  f"启动时预热到 {target_active} 个号，"
                  f"每 {NAI_BOOST_QUOTA_REFRESH_SEC}s 全量刷新一次余额")
        except Exception as e:
            import traceback
            print(f"[NAI/boost] 初始化失败，禁用 boost: {e}")
            print(traceback.format_exc())
            trial_pool = None
    else:
        print("[NAI/boost] CAPSOLVER_CLIENT_KEY 未配置，boost 通道关闭")

    _workers_started = True


# 生成任务存储
_generation_tasks: Dict[str, Dict[str, Any]] = {}


class _DuplicateGenerationTaskError(RuntimeError):
    pass


def _principal_for_task_record(task: dict[str, Any]) -> Principal:
    resource = _task_access.owner_of(task)
    if resource.owner_id is None:
        raise ResourceNotFoundError()
    return Principal.user(resource.owner_id, resource.tenant_id)


async def _settle_generation_quota(task_id: str) -> None:
    """Settle by durable provider-attempt stage, never by optimistic memory state."""
    await _ensure_cloud_job_storage()
    job = await _cloud_jobs.get(task_id)
    if job is None or not job.terminal or job.quota_settled:
        return
    if _is_workshop_job(job):
        return
    task = _generation_tasks.get(task_id)
    if not job.quota_reservation_id:
        return
    if not _quota_ledger.enabled:
        print(f"[quota] task={task_id} reservation remains unsettled because ledger is disabled")
        return
    try:
        principal = Principal.user(job.resource.owner_id, job.resource.tenant_id)
        record = {
            "tenant_id": job.resource.tenant_id,
            "owner_id": job.resource.owner_id,
            "quota_reservation_id": job.quota_reservation_id,
        }
        await _quota_ledger.settle(
            record,
            principal,
            succeeded=job.provider_attempted,
            job_id=task_id,
        )
        if job.provider_attempted:
            await _cloud_jobs.mark_cost_committed(task_id)
        else:
            await _cloud_jobs.mark_quota_refunded(task_id)
        if task:
            task["_quota_settled"] = True
    except CloudBackendError as exc:
        # Keep the failure visible for operators without leaking credentials.
        print(f"[quota] task={task_id} settlement failed: {exc.code}")
    except Exception as exc:
        # A transient SQLite/disk failure must not terminate a long-lived worker.
        # Leave the record unsettled so cancellation/cleanup can retry safely.
        print(f"[quota] task={task_id} settlement unavailable: {type(exc).__name__}")


async def enqueue_generation(
    params: dict,
    user_id: str = "",
    allow_boost: bool = True,
    *,
    resource: ResourceOwner,
    task_id: str | None = None,
    task_metadata: dict[str, Any] | None = None,
    idempotency_key: str | None = None,
    request_hash: str | None = None,
) -> tuple[str, int, bool]:
    """
    将生成任务入队

    :param allow_boost: 是否允许走 trial 加速通道。默认 True；bot 端调用应传 False
        以避免把有限的 trial 配额耗在 bot 用户上，保留给前端 web 用户。
    :return: (task_id, queue_position, created) 或 ("", -1, False) 表示容量已满
    """
    global _task_counter, _generation_admitting
    
    await _ensure_queue()
    await start_novelai_workers()
    await _ensure_cloud_job_storage()

    task_id = task_id or secrets.token_hex(8)
    metadata = dict(task_metadata or {})
    with _state_lock:
        active_count = sum(
            1
            for record in _generation_tasks.values()
            if record.get("status") in {"queued", "generating", "cancelling"}
        )
        occupied = active_count + _generation_admitting
        if occupied >= _GENERATION_QUEUE_CAPACITY:
            print(f"[队列] 全局容量已满 ({occupied}/{_GENERATION_QUEUE_CAPACITY})")
            return "", -1, False
        if user_id:
            cnt = _user_pending.get(user_id, 0)
            if cnt >= 10:
                print(f"[队列] 用户 {user_id} 待处理任务已达上限 ({cnt})")
                return "", -1, False
        
        _task_counter += 1
        task_seq = _task_counter
        _generation_admitting += 1
        
        if user_id:
            _user_pending[user_id] = _user_pending.get(user_id, 0) + 1

    digest = request_hash or _generation_request_hash(params)
    try:
        created = await _cloud_jobs.create(
            job_id=task_id,
            resource=resource,
            request_hash=digest,
            payload=_persistent_generation_payload(params),
            idempotency_key=idempotency_key,
            quota_reservation_id=metadata.get("quota_reservation_id"),
            cost_units=int(metadata.get("quota_units", 0) or 0),
            total_steps=int(params.get("steps", 28) or 0),
        )
    except BaseException:
        if user_id:
            with _state_lock:
                _user_pending[user_id] = max(0, _user_pending.get(user_id, 1) - 1)
        raise
    finally:
        with _state_lock:
            _generation_admitting = max(0, _generation_admitting - 1)
    if not created.created:
        if user_id:
            with _state_lock:
                _user_pending[user_id] = max(0, _user_pending.get(user_id, 1) - 1)
        existing_status = _JOB_TO_LEGACY_STATUS[created.job.status]
        queue_pos = _get_task_queue_position(created.job.id) if existing_status == "queued" else 0
        return created.job.id, queue_pos, False

    if task_id in _generation_tasks:
        raise _DuplicateGenerationTaskError("generation task id already exists")
    
    # 提取关键参数用于日志
    width = params.get("width", 832)
    height = params.get("height", 1216)
    steps = params.get("steps", 28)
    prompt_preview = params.get("input_text1", "")[:50]
    
    # 创建任务记录
    task_record = {
        "task_id": task_id,
        "status": "queued",
        "params": params,
        "user_id": user_id,
        "created_at": time.time(),
        "step": 0,
        "total_steps": params.get("steps", 28),
        "result": None,
        "error": None,
        "task_seq": task_seq,
    }
    task_record.update(metadata)
    task_record["request_hash"] = digest
    task_record["idempotency_key"] = idempotency_key
    _task_access.bind_record(task_record, resource)
    _generation_tasks[task_id] = task_record

    # Anima has its own provider runner, but uses this exact admission/persistence
    # path so it cannot bypass global/user capacity, ownership, quota, or cancel.
    if params.get("_image_backend") == "anima":
        return task_id, active_count + 1, True

    # 激进调度：付费号全忙 + boost 可用 + 任务能 boost 处理 → 直接派 boost，不入队
    can_boost = False
    if (
        allow_boost
        and trial_pool is not None
        and _boost_available_now()
        and _boost_can_handle(params)
        and _all_paid_busy()
    ):
        can_boost = await trial_pool.has_eligible()

    if can_boost:
        asyncio.create_task(_boost_handle(task_id, params, task_seq))
        queue_pos = 0  # 不在队列里，直接处理中
        print(f"[队列/boost] 直派 boost: id={task_id}, seq={task_seq}, "
              f"size={width}x{height}, steps={steps}, prompt=\"{prompt_preview}...\"")
        return task_id, queue_pos, True

    # 正常路径：入队等付费 worker
    try:
        _image_queue.put_nowait((task_id, params, task_seq))
    except asyncio.QueueFull:
        task_record["status"] = "failed"
        task_record["error"] = "队列已满，请稍后再试"
        await _notify_task_update(task_id, "failed", error=task_record["error"])
        await _settle_generation_quota(task_id)
        return "", -1, True
    queue_pos = _image_queue.qsize()
    print(f"[队列] 新任务入队: id={task_id}, seq={task_seq}, pos={queue_pos}, "
          f"size={width}x{height}, steps={steps}, prompt=\"{prompt_preview}...\"")
    return task_id, queue_pos, True


def calculate_anlas_cost(width: int, height: int, steps: int, model: str,
                         img2img_strength: float = None, precise_ref_count: int = 0) -> int:
    """计算 Anlas 点数消耗"""
    pixels = width * height
    per_image = max(math.ceil(5.773e-7 * pixels * (steps + 5)), 2)
    if img2img_strength is not None and img2img_strength > 0:
        per_image = max(math.ceil(per_image * img2img_strength), 2)
    is_free = (steps <= 28 and pixels <= 1048576)
    base_cost = 0 if is_free else per_image
    pr_cost = 5 * precise_ref_count
    return base_cost + pr_cost

# 安全 JSON 存储实例
_artist_store = SafeJsonStore(BOT_DATA_DIR / "artist_strings.json")
_oc_store = SafeJsonStore(BOT_DATA_DIR / "oc_data.json")
_role_mapping_store = SafeJsonStore(BOT_DATA_DIR / "role_tag_mapping.json")
_cr_store = SafeJsonStore(BOT_DATA_DIR / "cr_data.json")


class QueueAction(str, Enum):
    JOIN = "join_queue"
    LEAVE = "leave_queue"
    DONE = "done"
    HEARTBEAT = "heartbeat"


class QueueStatus(str, Enum):
    WAITING = "waiting"
    YOUR_TURN = "your_turn"
    GENERATING = "generating"


@dataclass
class QueueItem:
    """队列中的一个任务"""
    user_id: str
    ticket: str
    token_hash: str
    websocket: WebSocket
    joined_at: float = field(default_factory=time.time)
    status: QueueStatus = QueueStatus.WAITING
    turn_notified_at: Optional[float] = None


class TokenQueue:
    """单个Token的排队队列"""
    
    def __init__(self, token_hash: str):
        self.token_hash = token_hash
        self.queue: list[QueueItem] = []
        self.current: Optional[QueueItem] = None
        self.lock = asyncio.Lock()
        
    async def add(self, item: QueueItem) -> int:
        """添加到队列，返回位置"""
        async with self.lock:
            self.queue.append(item)
            return len(self.queue)
    
    async def remove(self, ticket: str) -> bool:
        """从队列移除"""
        async with self.lock:
            if self.current and self.current.ticket == ticket:
                self.current = None
                return True
            for i, item in enumerate(self.queue):
                if item.ticket == ticket:
                    self.queue.pop(i)
                    return True
            return False
    
    async def get_position(self, ticket: str) -> int:
        """获取队列位置，-1表示不在队列中，0表示正在生成"""
        async with self.lock:
            if self.current and self.current.ticket == ticket:
                return 0
            for i, item in enumerate(self.queue):
                if item.ticket == ticket:
                    return i + 1
            return -1
    
    async def process_next(self) -> Optional[QueueItem]:
        """处理下一个，返回被通知的item"""
        async with self.lock:
            if self.current is not None:
                return None
            if not self.queue:
                return None
            self.current = self.queue.pop(0)
            self.current.status = QueueStatus.YOUR_TURN
            self.current.turn_notified_at = time.time()
            return self.current
    
    async def mark_done(self, ticket: str) -> bool:
        """标记完成"""
        async with self.lock:
            if self.current and self.current.ticket == ticket:
                self.current = None
                return True
            return False
    
    async def check_timeout(self, timeout_seconds: float = 60) -> Optional[QueueItem]:
        """检查超时，返回被超时的item"""
        async with self.lock:
            if self.current and self.current.turn_notified_at:
                if time.time() - self.current.turn_notified_at > timeout_seconds:
                    timed_out = self.current
                    self.current = None
                    return timed_out
            return None
    
    @property
    def size(self) -> int:
        return len(self.queue) + (1 if self.current else 0)


class QueueManager:
    """全局队列管理器"""
    
    def __init__(self):
        self.queues: dict[str, TokenQueue] = {}
        self.connections: dict[str, QueueItem] = {}  # ticket -> QueueItem
        self.lock = asyncio.Lock()
        
    def _get_or_create_queue(self, token_hash: str) -> TokenQueue:
        if token_hash not in self.queues:
            self.queues[token_hash] = TokenQueue(token_hash)
        return self.queues[token_hash]
    
    async def join(self, token_hash: str, user_id: str, websocket: WebSocket) -> tuple[str, int]:
        """加入队列，返回(ticket, position)"""
        ticket = str(uuid.uuid4())[:8]
        item = QueueItem(
            user_id=user_id,
            ticket=ticket,
            token_hash=token_hash,
            websocket=websocket
        )
        
        async with self.lock:
            queue = self._get_or_create_queue(token_hash)
            position = await queue.add(item)
            self.connections[ticket] = item
            
        return ticket, position
    
    async def leave(self, ticket: str) -> bool:
        """离开队列"""
        async with self.lock:
            item = self.connections.pop(ticket, None)
            if not item:
                return False
            queue = self.queues.get(item.token_hash)
            if queue:
                await queue.remove(ticket)
            return True
    
    async def done(self, ticket: str) -> bool:
        """完成生成"""
        async with self.lock:
            item = self.connections.pop(ticket, None)
            if not item:
                return False
            queue = self.queues.get(item.token_hash)
            if queue:
                return await queue.mark_done(ticket)
            return False
    
    async def get_position(self, ticket: str) -> int:
        """获取位置"""
        item = self.connections.get(ticket)
        if not item:
            return -1
        queue = self.queues.get(item.token_hash)
        if not queue:
            return -1
        return await queue.get_position(ticket)
    
    async def process_queues(self):
        """处理所有队列，通知下一个用户"""
        for token_hash, queue in list(self.queues.items()):
            # 检查超时
            timed_out = await queue.check_timeout()
            if timed_out:
                try:
                    await timed_out.websocket.send_json({
                        "action": "timeout",
                        "message": "生成超时，已从队列移除"
                    })
                except:
                    pass
                self.connections.pop(timed_out.ticket, None)
            
            # 处理下一个
            next_item = await queue.process_next()
            if next_item:
                try:
                    await next_item.websocket.send_json({
                        "action": "your_turn",
                        "ticket": next_item.ticket,
                        "message": "轮到你了，请开始生成"
                    })
                except:
                    # 连接断开，移除并继续
                    await queue.mark_done(next_item.ticket)
                    self.connections.pop(next_item.ticket, None)
    
    async def broadcast_positions(self, token_hash: str):
        """广播队列位置更新"""
        queue = self.queues.get(token_hash)
        if not queue:
            return
        
        for ticket, item in list(self.connections.items()):
            if item.token_hash != token_hash:
                continue
            position = await queue.get_position(ticket)
            if position > 0:  # 只通知等待中的
                try:
                    await item.websocket.send_json({
                        "action": "position_update",
                        "position": position,
                        "queue_size": queue.size
                    })
                except:
                    pass


# 全局实例
queue_manager = QueueManager()


# ==================== 在线人数管理（心跳统计） ====================

class OnlineManager:
    """在线人数管理器 - 基于心跳统计"""
    
    ONLINE_TIMEOUT = 180  # 3分钟内有心跳算在线
    
    def __init__(self):
        self.heartbeats: dict[str, float] = {}  # user_id -> last_heartbeat_time
    
    def heartbeat(self, user_id: str):
        """记录心跳"""
        self.heartbeats[user_id] = time.time()
    
    def get_online_count(self) -> int:
        """获取在线人数（3分钟内有心跳的用户数）"""
        now = time.time()
        # 清理过期的心跳记录
        expired = [uid for uid, ts in self.heartbeats.items() if now - ts > self.ONLINE_TIMEOUT]
        for uid in expired:
            del self.heartbeats[uid]
        return len(self.heartbeats)


# 全局在线管理器
online_manager = OnlineManager()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期管理"""
    # Jobs are interrupted first, then their durable provider-attempt stage
    # decides capture versus refund.  Never infer cost from a reservation alone.
    await _ensure_cloud_job_storage()
    succeeded_jobs = await _cloud_jobs.list_succeeded()
    missing_results, orphaned_results = await _cloud_job_results.reconcile(
        {job.id: job.result for job in succeeded_jobs}
    )
    for missing_job_id in missing_results:
        await _cloud_jobs.invalidate_missing_result(missing_job_id)
    if orphaned_results:
        print(f"[App] 已隔离 {len(orphaned_results)} 个无任务引用的生成结果")
    recovered_workshop_jobs = await _recover_workshop_jobs()
    recovered_jobs = await _cloud_jobs.recover_interrupted()
    await _quota_ledger.initialize()
    for recovered_job in await _cloud_jobs.list_recovery_settlements():
        if not _is_workshop_job(recovered_job):
            await _settle_generation_quota(recovered_job.id)
    await _workshop_quota.initialize()
    durable_workshop_jobs = {
        job.id
        for job in await _cloud_jobs.list_succeeded()
        if _is_workshop_job(job) and job.result is not None
    }
    workshop_captured, workshop_refunded = await _workshop_quota.recover_jobs(
        durable_workshop_jobs
    )
    if workshop_captured or workshop_refunded:
        print(
            "[App] Workshop 额度恢复: "
            f"captured={workshop_captured}, refunded={workshop_refunded}"
        )
    if recovered_jobs:
        print(f"[App] 已将 {len(recovered_jobs)} 个崩溃遗留任务标记为 interrupted")
    if recovered_workshop_jobs:
        print(f"[App] 已恢复 {len(recovered_workshop_jobs)} 个 Workshop 崩溃遗留任务")

    # 初始化图片生成队列
    await _ensure_queue()
    await start_novelai_workers()
    print("[App] NovelAI 图片生成队列已初始化")

    # 启动后台任务
    task = asyncio.create_task(queue_processor())

    # 启动点数定时更新
    anlas_task = asyncio.create_task(anlas_updater())

    # 启动 NovelAI 服务状态监控（status.io 公开 API，用于事故横幅提示）
    nai_status_task = asyncio.create_task(nai_status_updater())

    # 启动 anima cnb workspace 池巡检（空闲账户自动关 workspace 省 cnb 配额）
    try:
        from agent_router.anima_provider import start_anima_patrol
        start_anima_patrol()
        print("[App] anima cnb 池巡检已启动")
    except Exception as e:
        print(f"[App] anima 池巡检启动失败（非致命，anima 路径仍可用）: {e}")

    yield

    upstream_tasks = list(_generation_upstream_tasks.values())
    for upstream_task in upstream_tasks:
        upstream_task.cancel()
    if upstream_tasks:
        await asyncio.gather(*upstream_tasks, return_exceptions=True)
    workshop_tasks = list(_workshop_background_tasks.values())
    for workshop_task in workshop_tasks:
        workshop_task.cancel()
    if workshop_tasks:
        await asyncio.gather(*workshop_tasks, return_exceptions=True)

    # 关闭全局 NovelAI session
    await _close_nai_session()
    # 关闭全局 WD Tagger session
    global _wd_tagger_session
    if _wd_tagger_session and not _wd_tagger_session.closed:
        await _wd_tagger_session.close()
        _wd_tagger_session = None

    # 取消 anima 池后台任务（巡检 + 进行中的重启 runner）
    try:
        from agent_router.anima_provider import cancel_anima_background
        await asyncio.wait_for(cancel_anima_background(), timeout=15)
    except Exception as e:
        print(f"[App] anima 池关闭异常（继续）: {e}")

    # 关闭
    task.cancel()
    anlas_task.cancel()
    nai_status_task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    try:
        await anlas_task
    except asyncio.CancelledError:
        pass
    try:
        await nai_status_task
    except asyncio.CancelledError:
        pass


async def anlas_updater():
    """定时更新点数缓存"""
    while True:
        try:
            anlas = await fetch_novelai_anlas()
            if anlas > 0:
                _anlas_cache["anlas"] = anlas
                _anlas_cache["updated_at"] = time.time()
                print(f"[Anlas] 点数已更新: {anlas}")
        except Exception as e:
            print(f"[Anlas] 更新失败: {e}")
        await asyncio.sleep(60)  # 每分钟更新一次


# ==================== NovelAI 服务状态监控（status.io 公开 API） ====================
NAI_STATUSPAGE_ID = "654839612cedb404d4d5f578"
NAI_STATUS_API = f"https://api.status.io/1.0/status/{NAI_STATUSPAGE_ID}"
NAI_STATUS_PAGE_URL = "https://status.novelai.net/"
NAI_STATUS_INCIDENT_URL_TPL = (
    f"{NAI_STATUS_PAGE_URL.rstrip('/')}/pages/incident/{NAI_STATUSPAGE_ID}/{{incident_id}}"
)
# status.io status_code: 100=Operational, 200=Maintenance,
# 300=Degraded, 400=Partial Disruption, 500=Service Disruption, 600=Security Event
_NAI_STATUS_LABELS = {
    100: "Operational", 200: "Maintenance", 300: "Degraded Performance",
    400: "Partial Service Disruption", 500: "Service Disruption", 600: "Security Event",
}

_nai_status_cache: dict = {
    "data": None,           # 上次成功解析的简化结果
    "fetched_at": 0.0,      # 上次成功时间
    "last_error": "",       # 上次失败信息（用于调试）
}


def _summarize_nai_status(raw: dict) -> dict:
    """把 status.io 原始响应裁剪成前端只需要的最小字段。"""
    result = (raw or {}).get("result") or {}
    overall = result.get("status_overall") or {}
    components = []
    for c in result.get("status") or []:
        components.append({
            "id": c.get("id"),
            "name": c.get("name"),
            "status": c.get("status"),
            "code": c.get("status_code"),
        })
    incidents = []
    for inc in result.get("incidents") or []:
        inc_id = inc.get("_id") or inc.get("id")
        # 各家 status.io 字段命名略有差异，尽量兼容
        latest_msg = ""
        msgs = inc.get("messages") or []
        if isinstance(msgs, list) and msgs:
            last = msgs[-1] if isinstance(msgs[-1], dict) else {}
            latest_msg = last.get("details") or last.get("message") or ""
        affected = []
        for comp in inc.get("components_affected") or inc.get("components") or []:
            if isinstance(comp, dict):
                name = comp.get("name") or comp.get("component_name")
                if name:
                    affected.append(name)
            elif isinstance(comp, str):
                affected.append(comp)
        incidents.append({
            "id": inc_id,
            "name": inc.get("name") or inc.get("title"),
            "status": inc.get("current_status") or inc.get("status"),
            "code": inc.get("current_status_code") or inc.get("status_code"),
            "components": affected,
            "message": latest_msg,
            "url": NAI_STATUS_INCIDENT_URL_TPL.format(incident_id=inc_id) if inc_id else NAI_STATUS_PAGE_URL,
            "datetime": inc.get("datetime") or inc.get("created_at"),
        })
    return {
        "overall": {
            "status": overall.get("status") or _NAI_STATUS_LABELS.get(overall.get("status_code"), "Unknown"),
            "code": overall.get("status_code"),
            "updated_at": overall.get("updated"),
        },
        "components": components,
        "incidents": incidents,
        "page_url": NAI_STATUS_PAGE_URL,
    }


def _clean_nai_status_html_text(value: str) -> str:
    value = re.sub(r"<br\s*/?>", " ", value or "", flags=re.I)
    value = re.sub(r"<[^>]+>", "", value)
    value = html_lib.unescape(value)
    return re.sub(r"\s+", " ", value).strip()


def _nai_status_code_from_label(label: str | None) -> int:
    text = (label or "").strip().lower()
    if not text:
        return 100
    if "security" in text or "critical" in text:
        return 600
    if "service disruption" in text or "major outage" in text or "active incident" in text:
        return 500
    if "partial" in text or "outage" in text:
        return 400
    if "degraded" in text or "performance" in text or "issue detected" in text:
        return 300
    if "maintenance" in text:
        return 200
    if "operational" in text or "all systems" in text:
        return 100
    return 500


def _extract_first_html_text(pattern: str, source: str, default: str = "") -> str:
    match = re.search(pattern, source, flags=re.I | re.S)
    return _clean_nai_status_html_text(match.group(1)) if match else default


def _summarize_nai_status_page(html_text: str) -> dict:
    """Parse status.novelai.net HTML when the public JSON API is unavailable."""
    components = []
    for match in re.finditer(
        r'id="component_([^"]+)".*?<p class="component_name">(.*?)</p>.*?'
        r'<p class="pull-right component-status"[^>]*>(.*?)</p>',
        html_text,
        flags=re.I | re.S,
    ):
        status_label = _clean_nai_status_html_text(match.group(3))
        components.append({
            "id": match.group(1),
            "name": _clean_nai_status_html_text(match.group(2)),
            "status": status_label,
            "code": _nai_status_code_from_label(status_label),
        })

    incidents = []
    incident_section_match = re.search(
        r'id="section_incident_active"(.*?)(?=<div class="page_section" id="statusio_components")',
        html_text,
        flags=re.I | re.S,
    )
    incident_section = incident_section_match.group(1) if incident_section_match else ""
    incident_headers = list(re.finditer(
        r'id="statusio_incident_([^"]+)".*?<h5[^>]*>.*?<a href="([^"]+)"[^>]*>(.*?)</a>'
        r'.*?<span class="pull-right incident_status_description">(.*?)</span>',
        incident_section,
        flags=re.I | re.S,
    ))
    for idx, match in enumerate(incident_headers):
        start = match.start()
        end = incident_headers[idx + 1].start() if idx + 1 < len(incident_headers) else len(incident_section)
        block = incident_section[start:end]
        inc_id = match.group(1)
        status_label = _clean_nai_status_html_text(match.group(4))
        components_text = _extract_first_html_text(
            r"Components\s*</p>\s*</div>\s*<div[^>]*>\s*<p[^>]*>(.*?)</p>",
            block,
        )
        message = _extract_first_html_text(
            r'<span class="incident_message_details"[^>]*>(.*?)</span>',
            block,
        )
        incidents.append({
            "id": inc_id,
            "name": _clean_nai_status_html_text(match.group(3)),
            "status": status_label,
            "code": _nai_status_code_from_label(status_label),
            "components": [c.strip() for c in components_text.split(",") if c.strip()],
            "message": message,
            "url": NAI_STATUS_INCIDENT_URL_TPL.format(incident_id=inc_id),
            "datetime": _extract_first_html_text(r'<strong class="incident_time">(.*?)</strong>', block),
        })

    statusbar_text = _extract_first_html_text(r'id="statusbar_text"[^>]*>(.*?)</strong>', html_text)
    non_ok_codes = [c["code"] for c in components if c.get("code") and c["code"] != 100]
    incident_codes = [i["code"] for i in incidents if i.get("code")]
    overall_code = max(incident_codes or non_ok_codes or [_nai_status_code_from_label(statusbar_text)])
    overall_status = _NAI_STATUS_LABELS.get(overall_code, statusbar_text or "Unknown")

    return {
        "overall": {
            "status": overall_status,
            "code": overall_code,
            "updated_at": _extract_first_html_text(r'id="updated_ago"[^>]*>(.*?)</p>', html_text),
        },
        "components": components,
        "incidents": incidents,
        "page_url": NAI_STATUS_PAGE_URL,
    }


async def _fetch_nai_status_once() -> dict:
    """单次抓取（带超时与代理）。"""
    proxy_url = get_proxy_url()
    timeout = httpx.Timeout(15.0, connect=10.0)
    async with httpx.AsyncClient(
        proxy=proxy_url if proxy_url else None,
        timeout=timeout,
        headers={"Accept": "application/json", "User-Agent": "NaiWebUI-StatusMonitor/1.0"},
    ) as client:
        try:
            resp = await client.get(NAI_STATUS_API)
            resp.raise_for_status()
            return _summarize_nai_status(resp.json())
        except Exception as api_error:
            page_resp = await client.get(NAI_STATUS_PAGE_URL, headers={"Accept": "text/html"})
            page_resp.raise_for_status()
            data = _summarize_nai_status_page(page_resp.text)
            data["_source_error"] = f"{type(api_error).__name__}: {api_error}"
            return data


async def nai_status_updater():
    """定时刷新 NovelAI 状态缓存（60s）。失败时保留上次成功结果。"""
    while True:
        try:
            _nai_status_cache["data"] = await _fetch_nai_status_once()
            _nai_status_cache["fetched_at"] = time.time()
            _nai_status_cache["last_error"] = ""
        except Exception as e:
            _nai_status_cache["last_error"] = f"{type(e).__name__}: {e}"
            print(f"[NaiStatus] 抓取失败: {_nai_status_cache['last_error']}")
        await asyncio.sleep(60)


async def queue_processor():
    """后台队列处理器"""
    cleanup_counter = 0
    while True:
        try:
            await queue_manager.process_queues()
            # 每60次循环（约30秒）执行一次清理
            cleanup_counter += 1
            if cleanup_counter >= 60:
                cleanup_counter = 0
                bot_auth_manager.cleanup_expired()
                # 清理过期的生成任务（超过10分钟）
                now = time.time()
                expired_tasks = [k for k, v in _generation_tasks.items() 
                                if now - v.get("created_at", 0) > 600 and v.get("status") in ("completed", "failed", "cancelled")]
                for k in expired_tasks:
                    _generation_tasks.pop(k, None)
                # 清理过期的 wiki 缓存
                expired_wiki = [k for k, t in _wiki_cache_time.items() if now - t > WIKI_CACHE_TTL]
                for k in expired_wiki:
                    _wiki_cache.pop(k, None)
                    _wiki_cache_time.pop(k, None)
        except Exception as e:
            print(f"Queue processor error: {e}")
        await asyncio.sleep(0.5)


app = FastAPI(
    title="NovelAI Web UI Backend",
    version="1.0.0",
    lifespan=lifespan
)


def create_app() -> FastAPI:
    """Compatibility app factory for modern ASGI process managers."""
    return app


_DEFAULT_LEGACY_CORS_ORIGINS = (
    "http://127.0.0.1:1420",
    "http://localhost:1420",
    "http://127.0.0.1:5173",
    "http://localhost:5173",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "tauri://localhost",
)


def _configured_legacy_cors_origins() -> list[str]:
    """Return exact browser origins; wildcard/URL-like ambiguity fails closed."""

    configured = getattr(_appcfg, "LEGACY_CORS_ORIGINS", ())
    if isinstance(configured, str):
        candidates = configured.split(",")
    elif isinstance(configured, (list, tuple, set, frozenset)):
        candidates = configured
    else:
        raise RuntimeError("LEGACY_CORS_ORIGINS must be a string or a sequence of origins")

    origins = [str(value).strip() for value in candidates if str(value).strip()]
    if not origins:
        origins = list(_DEFAULT_LEGACY_CORS_ORIGINS)

    validated: list[str] = []
    for origin in origins:
        if "*" in origin or len(origin) > 2048:
            raise RuntimeError("LEGACY_CORS_ORIGINS must contain exact bounded origins")
        parsed = urlsplit(origin)
        try:
            parsed_port = parsed.port
        except ValueError as exc:
            raise RuntimeError(f"invalid CORS origin: {origin!r}") from exc
        if (
            parsed.scheme not in {"http", "https", "tauri"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path
            or parsed.query
            or parsed.fragment
            or parsed_port is not None
            and not (1 <= parsed_port <= 65535)
        ):
            raise RuntimeError(f"invalid CORS origin: {origin!r}")
        if origin not in validated:
            validated.append(origin)
    return validated


# Credentials are explicit headers/tokens, never ambient cookies. Keep credentials
# disabled and permit only configured desktop/development origins.
app.add_middleware(
    CORSMiddleware,
    allow_origins=_configured_legacy_cors_origins(),
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=[
        "Authorization",
        "Content-Type",
        "Idempotency-Key",
        "X-Admin-Token",
        "X-Bot-Secret",
        "X-Bot-Session",
    ],
    expose_headers=["Location", "Retry-After"],
)

# Gzip 压缩所有 ≥1KB 的 text/json 响应。
# Starlette 不会压缩已压缩的 media type（PNG/JPEG/zip 等），所以图片字节流不受影响。
# 收益：role_tag_mapping.json 这种大 JSON 6MB → ~800KB，所有 list/stats 接口也顺带变小。
from fastapi.middleware.gzip import GZipMiddleware
app.add_middleware(GZipMiddleware, minimum_size=1024)


# 为所有响应添加 Cross-Origin-Resource-Policy 头
# 解决 COEP (Cross-Origin-Embedder-Policy: require-corp) 环境下跨域图片加载问题
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request as StarletteRequest

class CORPMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: StarletteRequest, call_next):
        response = await call_next(request)
        response.headers["Cross-Origin-Resource-Policy"] = "cross-origin"
        if request.url.path.startswith(
            ("/api/user-vibes", "/api/user-artists/backup", "/api/user-tag-backup")
        ):
            # Private library URLs are identical across owners when the modern
            # session header is used. Shared caches must never reuse one owner's
            # JSON/image response for another owner.
            response.headers["Cache-Control"] = "private, no-cache"
            response.headers["Referrer-Policy"] = "no-referrer"
            response.headers["X-Content-Type-Options"] = "nosniff"
            vary = {
                item.strip()
                for item in response.headers.get("Vary", "").split(",")
                if item.strip()
            }
            vary.add("X-Bot-Session")
            response.headers["Vary"] = ", ".join(sorted(vary))
        return response

app.add_middleware(CORPMiddleware)

_MIB = 1024 * 1024
_LEGACY_DEFAULT_BODY_LIMIT = 72 * _MIB
_LEGACY_BODY_PATH_LIMITS = {
    # Credentials/control payloads never contain binary data.
    "/api/bot/auth": 64 * 1024,
    "/api/billing": 64 * 1024,
    "/api/online": 64 * 1024,
    # Text/context APIs remain well below the process-wide ceiling.
    "/api/bot/generate": 4 * _MIB,
    "/api/bot/task": 4 * _MIB,
    "/api/tags": 4 * _MIB,
    "/api/translate": 4 * _MIB,
    # Progress can carry a preview; Agent can carry one base64 reference image.
    "/api/bot/task/progress": 32 * _MIB,
    # A completed Bot update can carry one 32 MiB decoded result.  Base64 and
    # JSON framing fit inside this stricter-than-global wire budget.
    "/api/bot/task/update": 44 * _MIB,
    "/api/vibe/encode": 32 * _MIB,
    "/api/upscale": 32 * _MIB,
    "/api/agent": 28 * _MIB,
    # Legacy JSON asset uploads are base64 encoded. These wire limits are at
    # least as strict as the canonical 32 MiB per-asset policy.
    "/api/artists": 32 * _MIB,
    "/api/cr": 32 * _MIB,
    "/api/oc": 32 * _MIB,
    "/api/user-artists/backup": 32 * _MIB,
    "/api/user-tag-backup": 32 * _MIB,
    "/api/user-vibes": 32 * _MIB,
    "/api/vibes": 32 * _MIB,
}

# Count bytes from ASGI ``receive`` rather than trusting Content-Length. Base64
# generation requests retain the 72 MiB process ceiling; tighter prefixes above
# cover credentials, text/context and single-asset routes.
app.add_middleware(
    StreamingBodyLimitMiddleware,
    default_limit=_LEGACY_DEFAULT_BODY_LIMIT,
    path_limits=_LEGACY_BODY_PATH_LIMITS,
)

_RATE_LIMIT_ENABLED = bool(getattr(_appcfg, "RATE_LIMIT_ENABLED", True))
_RATE_LIMIT_DEFAULT_PER_MINUTE = int(
    getattr(_appcfg, "RATE_LIMIT_DEFAULT_PER_MINUTE", 0) or 600
)
_RATE_LIMIT_TRUSTED_PROXIES = tuple(
    str(entry).strip()
    for entry in (getattr(_appcfg, "RATE_LIMIT_TRUSTED_PROXIES", ()) or ())
    if str(entry).strip()
)

# Per-identity budgets by path class. The default allowance is deliberately
# generous because the desktop client polls task state every two seconds per
# active job; only routes that cost money, spend upstream capacity, or exchange
# credentials get a tight budget. Each class counts separately, so polling can
# never exhaust the allowance for generation.
_LEGACY_RATE_LIMIT_PATH_RULES = {
    # Paid or upstream-bound work, all of it human-paced in the real client.
    "/api/generate": RateLimitRule(limit=20, window_seconds=60),
    "/api/bot/generate": RateLimitRule(limit=30, window_seconds=60),
    "/api/upscale": RateLimitRule(limit=20, window_seconds=60),
    "/api/wd-tagger": RateLimitRule(limit=20, window_seconds=60),
    "/api/vibe/encode": RateLimitRule(limit=20, window_seconds=60),
    "/api/agent": RateLimitRule(limit=30, window_seconds=60),
    # Credential exchange, on top of the per-code attempt limits.
    "/api/bot/auth": RateLimitRule(limit=30, window_seconds=60),
    # Asset writes are size-bounded already but should not be scriptable in bulk.
    "/api/vibes/upload": RateLimitRule(limit=30, window_seconds=60),
    "/api/artists/create": RateLimitRule(limit=30, window_seconds=60),
    # Bot service progress/update traffic is server-to-server and legitimately
    # high volume; keep a ceiling without interfering with normal operation.
    "/api/bot/task": RateLimitRule(limit=1200, window_seconds=60),
}

# Rate limiting is the outermost layer so an abusive caller is rejected before
# the body limiter buffers anything. ``/health`` stays exempt for probes.
if _RATE_LIMIT_ENABLED:
    app.add_middleware(
        RateLimitMiddleware,
        default_rule=RateLimitRule(
            limit=_RATE_LIMIT_DEFAULT_PER_MINUTE,
            window_seconds=60,
        ),
        path_rules=_LEGACY_RATE_LIMIT_PATH_RULES,
        exempt_paths=("/health",),
        trusted_proxies=_RATE_LIMIT_TRUSTED_PROXIES,
    )


class HealthResponse(BaseModel):
    status: str
    version: str
    queue_count: int
    workers: int
    pending_tasks: int
    boost_enabled: bool = False
    boost_in_cooldown: bool = False
    boost_cooldown_remaining_sec: int = 0
    boost_403_recent_count: int = 0
    boost_403_window_size: int = 0
    boost_403_threshold: int = 0
    boost_accounts_total: int = 0
    boost_accounts_active: int = 0
    boost_accounts_eligible: int = 0
    boost_accounts_in_use: int = 0
    boost_total_image_left: int = 0


@app.get("/health", response_model=HealthResponse)
async def health_check():
    """健康检查"""
    boost_stats = {"total": 0, "active": 0, "eligible": 0, "in_use": 0, "total_image_left": 0}
    if trial_pool is not None:
        boost_stats = await trial_pool.stats()
    return HealthResponse(
        status="ok",
        version="2.0.0",  # 升级版本号，标识独立运行版
        queue_count=len(queue_manager.queues),
        workers=len(get_novelai_tokens()),
        pending_tasks=_image_queue.qsize() if _image_queue else 0,
        boost_enabled=bool(trial_pool is not None),
        boost_in_cooldown=time.time() < _boost_global_cooldown_until,
        boost_cooldown_remaining_sec=_boost_cooldown_remaining_sec(),
        boost_403_recent_count=_boost_recent_403_count(),
        boost_403_window_size=len(_boost_recent_results),
        boost_403_threshold=NAI_BOOST_403_THRESHOLD,
        boost_accounts_total=boost_stats["total"],
        boost_accounts_active=boost_stats.get("active", 0),
        boost_accounts_eligible=boost_stats["eligible"],
        boost_accounts_in_use=boost_stats["in_use"],
        boost_total_image_left=boost_stats["total_image_left"],
    )


@app.get("/api/nai-status")
async def nai_status():
    """NovelAI 官方服务状态（供前端横幅判断是否提示用户）。

    数据来自 status.io 公开 API，由后台任务 60s 缓存一次。
    若从未抓取成功，返回 unknown，让前端静默不弹横幅。
    """
    data = _nai_status_cache.get("data")
    fetched_at = _nai_status_cache.get("fetched_at") or 0
    if not data:
        return {
            "ok": False,
            "fetched_at": 0,
            "stale_seconds": None,
            "last_error": _nai_status_cache.get("last_error", ""),
            "data": None,
        }
    return {
        "ok": True,
        "fetched_at": fetched_at,
        "stale_seconds": max(0, int(time.time() - fetched_at)),
        "last_error": _nai_status_cache.get("last_error", ""),
        "data": data,
    }


# ==================== 直接生成 API ====================

class DirectGenerateRequest(BaseModel):
    """直接生成请求（不需要 Bot 授权）"""
    positivePrompt: str
    negativePrompt: str = ""
    width: int = 832
    height: int = 1216
    seed: int = 0
    steps: int = 28
    scale: float = 5
    sampler: str = "k_euler_ancestral"
    model: str = "v4.5-full"
    cfgRescale: float = 0
    noiseSchedule: str = "karras"
    varietyPlus: bool = False
    normalizeVibeStrength: bool = True
    qualityToggle: bool = False
    ucPreset: str = "heavy"
    characterPrompts: list = []
    vibeReferences: list = []
    preciseReferences: list = []
    img2img: Optional[Dict[str, Any]] = None
    inpaint: Optional[Dict[str, Any]] = None
    # 出图后端选择。"novelai"（默认）走原 NAI 队列；"anima" 走 cnb ComfyUI Anima 模型。
    # 由 bot 端按 ChatResponse.image_backend 透传过来（M4 实现）。
    image_backend: str = "novelai"


class DirectGenerateResponse(BaseModel):
    success: bool
    task_id: Optional[str] = None
    capability_token: Optional[str] = None
    queue_position: int = 0
    message: str = ""


async def _run_anima_task(task_id: str, req: DirectGenerateRequest):
    """后台跑 anima 出图,完成后写 _generation_tasks 复用现有轮询/WebSocket 机制。"""
    import base64 as _b64
    try:
        from agent_router.anima_provider import generate_anima_image

        job = await _cloud_jobs.get(task_id)
        if job is None or job.status is not JobStatus.QUEUED:
            return
        _generation_tasks[task_id]["status"] = "generating"
        _generation_tasks[task_id]["total_steps"] = 100
        await _notify_task_update(task_id, "generating", 0, 100)

        async def _report_anima_progress(fraction: float) -> None:
            # 粗粒度 0..1 → 现有 step/total 轮询/WebSocket 机制，单调且只在
            # generating 态推送；异常由 provider 侧吞掉（提示性信息）。
            task = _generation_tasks.get(task_id)
            if not task or task.get("status") != "generating":
                return
            step = max(0, min(99, int(fraction * 100)))
            if step <= int(task.get("step") or 0):
                return
            task["step"] = step
            await _notify_task_update(task_id, "generating", step, 100)

        image_bytes = await _await_generation_upstream(
            task_id,
            lambda: generate_anima_image(
                positive=req.positivePrompt or "",
                negative=req.negativePrompt or "",
                width=int(req.width or 0),
                height=int(req.height or 0),
                seed=int(req.seed or -1),
                task_id=task_id,
                on_progress=_report_anima_progress,
            ),
        )
        if image_bytes is None:
            return
        result_b64 = _b64.b64encode(image_bytes).decode("ascii")

        _generation_tasks[task_id]["result"] = result_b64
        _generation_tasks[task_id]["status"] = "completed"
        _generation_tasks[task_id]["step"] = 100
        await _notify_task_update(task_id, "completed", 100, 100, result_b64)
        print(f"[anima] 任务完成: id={task_id}")
    except asyncio.CancelledError:
        raise
    except Exception as e:
        err = str(e) or repr(e)
        current = _generation_tasks.get(task_id)
        cancelled = await _finish_cancel_if_requested(task_id)
        if current and current.get("status") != "cancelled" and not cancelled:
            current["status"] = "failed"
            current["error"] = err
            await _notify_task_update(task_id, "failed", error=err)
        print(f"[anima] 任务失败: id={task_id} err={err}")
    finally:
        task = _generation_tasks.get(task_id)
        if task and not task.get("_pending_decremented"):
            user_id = task.get("user_id", "")
            if user_id:
                with _state_lock:
                    _user_pending[user_id] = max(0, _user_pending.get(user_id, 1) - 1)
            task["_pending_decremented"] = True
            task.pop("params", None)
        await _settle_generation_quota(task_id)
        await _broadcast_queue_position_update()


@app.post("/api/generate", response_model=DirectGenerateResponse)
async def direct_generate(req: DirectGenerateRequest):
    """
    直接提交生成任务（不需要 Bot 授权）
    返回 task_id，可通过 WebSocket 订阅进度或轮询 /api/task/{task_id}

    按 req.image_backend 分发：
      novelai (默认) → 原 NovelAI 队列（带 trial boost 调度）
      anima         → cnb ComfyUI Anima 后端（agent_router.anima_provider）
    """
    backend = (req.image_backend or "novelai").strip().lower()
    task_id = secrets.token_hex(8)
    grant = _task_access.issue_anonymous(
        job_id=task_id,
        tenant_id=_DIRECT_TASK_TENANT_ID,
    )

    if backend == "anima":
        params = req.model_dump()
        params["_image_backend"] = "anima"
        params["steps"] = 1
        queued_task_id, queue_pos, created = await enqueue_generation(
            params,
            "direct",
            allow_boost=False,
            resource=grant.resource,
            task_id=task_id,
            request_hash=_generation_request_hash(req.model_dump()),
        )
        if queue_pos == -1:
            return DirectGenerateResponse(success=False, message="队列已满，请稍后再试")
        if created:
            asyncio.create_task(_run_anima_task(queued_task_id, req))
        print(
            f"[anima] 任务已入队: id={queued_task_id} "
            f"size={req.width}x{req.height} seed={req.seed} "
            f"prompt=\"{(req.positivePrompt or '')[:50]}...\""
        )
        return DirectGenerateResponse(
            success=True,
            task_id=queued_task_id,
            capability_token=grant.capability_token,
            queue_position=queue_pos,
            message="anima 任务已提交",
        )

    # 原 NovelAI 路径不变
    params = req.model_dump()
    stream_params = convert_web_params_to_stream(params)

    task_id, queue_pos, _ = await enqueue_generation(
        stream_params,
        "direct",
        allow_boost=False,
        resource=grant.resource,
        task_id=task_id,
    )

    if queue_pos == -1:
        return DirectGenerateResponse(success=False, message="队列已满，请稍后再试")

    return DirectGenerateResponse(
        success=True,
        task_id=task_id,
        capability_token=grant.capability_token,
        queue_position=queue_pos,
        message=f"任务已提交，队列位置: {queue_pos}"
    )


def _principal_from_bot_session(session_id: str) -> Principal:
    session = bot_auth_manager.get_session(session_id) if session_id else None
    if not session:
        raise HTTPException(status_code=401, detail="未登录或会话已过期")
    return Principal.user(str(session.bot_user_id), _BOT_TASK_TENANT_ID)


def _library_principal_from_request(request: Request, compat_session_id: str = "") -> Principal:
    """Authenticate one public/private library caller during the compat window.

    New clients use ``X-Bot-Session``. Existing body/query credentials remain
    accepted only when they are the sole credential or exactly match the header;
    conflicting identities are rejected instead of choosing one implicitly.
    """
    header_values = request.headers.getlist("X-Bot-Session")
    if len(header_values) > 1:
        raise HTTPException(status_code=401, detail="未登录或会话已过期")
    header_session = header_values[0].strip() if header_values else ""
    legacy_session = compat_session_id.strip()
    if header_session and legacy_session and not _secure_eq(header_session, legacy_session):
        raise HTTPException(status_code=401, detail="未登录或会话已过期")
    return _principal_from_bot_session(header_session or legacy_session)


def _require_library_record_owner(
    principal: Principal,
    record: Dict[str, Any],
    *,
    legacy_owner_fields: Tuple[str, ...],
) -> None:
    """Authorize a contributed public record and obscure cross-owner mutation."""
    try:
        _library_ownership.require_record(
            principal,
            record,
            legacy_owner_fields=legacy_owner_fields,
            legacy_tenant_id=_BOT_TASK_TENANT_ID,
        )
    except ResourceNotFoundError as exc:
        raise HTTPException(status_code=404, detail="资源不存在") from exc


async def _authorize_generation_task(
    task_id: str,
    *,
    session_id: str = "",
    authorization: str = "",
) -> CloudJob:
    await _ensure_cloud_job_storage()
    job = await _cloud_jobs.get(task_id)
    record = (
        {"tenant_id": job.resource.tenant_id, "owner_id": job.resource.owner_id}
        if job is not None
        else None
    )
    try:
        if session_id and authorization:
            raise HTTPException(status_code=400, detail="请勿同时提供两种任务凭据")
        if session_id:
            _task_access.require_principal(record, _principal_from_bot_session(session_id))
        else:
            token = bearer_token(authorization)
            _task_access.require_capability(record, job_id=task_id, token=token)
    except ResourceNotFoundError as exc:
        # Missing and cross-owner resources are intentionally indistinguishable.
        raise HTTPException(status_code=404, detail="任务不存在") from exc
    except InvalidCapabilityError as exc:
        raise HTTPException(status_code=401, detail="任务凭据无效或已过期") from exc
    if job is None:  # guarded above; keeps the return type explicit
        raise HTTPException(status_code=404, detail="任务不存在")
    return job


@app.get("/api/task/{task_id}")
async def get_task_status(
    task_id: str,
    session_id: str = "",
    authorization: str = Header(default=""),
):
    """获取任务状态（GET 方式，方便轮询）"""
    job = await _authorize_generation_task(
        task_id,
        session_id=session_id,
        authorization=authorization,
    )
    
    return await _legacy_job_response(job)


@app.delete("/api/task/{task_id}")
async def cancel_task(
    task_id: str,
    session_id: str = "",
    authorization: str = Header(default=""),
):
    """取消排队中的任务"""
    job = await _authorize_generation_task(
        task_id,
        session_id=session_id,
        authorization=authorization,
    )
    
    try:
        job, _ = await _cloud_jobs.request_cancel(task_id)
    except JobStateConflictError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"任务状态为 {_JOB_TO_LEGACY_STATUS[job.status]}，无法取消",
        ) from exc

    task = _generation_tasks.get(task_id)
    if task:
        task["status"] = _JOB_TO_LEGACY_STATUS[job.status]
        task["error"] = "用户取消"
    
    # 减少用户待处理计数，并标记已减，防止 Worker 重复减
    task_user_id = task.get("user_id", "") if task else ""
    if task_user_id and job.status is JobStatus.CANCELLED:
        with _state_lock:
            cnt = _user_pending.get(task_user_id, 0)
            if cnt > 0:
                _user_pending[task_user_id] = cnt - 1
    if task and job.status is JobStatus.CANCELLED:
        task["_pending_decremented"] = True

    if job.status is JobStatus.CANCELLING:
        upstream = _generation_upstream_tasks.get(task_id)
        if upstream is not None:
            upstream.cancel()

    # 通知前端
    await _notify_task_update(
        task_id,
        _JOB_TO_LEGACY_STATUS[job.status],
        error="用户取消",
    )
    await _settle_generation_quota(task_id)
    
    print(f"[队列] 任务已取消: id={task_id}")
    
    return {"success": True, "message": "任务已取消"}


@app.websocket("/ws/task/{task_id}")
async def websocket_generation_task(
    websocket: WebSocket,
    task_id: str,
    after_sequence: int = 0,
):
    """Single-task progress stream authenticated before accepting the socket.

    Browser WebSocket APIs cannot set Authorization.  The capability is therefore
    carried in ``Sec-WebSocket-Protocol: job-capability.<token>`` rather than a URL
    query (which is commonly logged by reverse proxies).
    """
    offered = [
        value.strip()
        for value in websocket.headers.get("sec-websocket-protocol", "").split(",")
        if value.strip()
    ]
    selected = next((value for value in offered if value.startswith("job-capability.")), "")
    token = selected.removeprefix("job-capability.") if selected else ""
    if after_sequence == 0:
        try:
            after_sequence = max(0, int(websocket.headers.get("last-event-id", "0")))
        except (TypeError, ValueError):
            after_sequence = 0
    await _ensure_cloud_job_storage()
    try:
        snapshot = await _cloud_jobs.snapshot_with_watermark(task_id)
    except InvalidRequestError:
        snapshot = None
    job = snapshot[0] if snapshot is not None else None
    record = (
        {"tenant_id": job.resource.tenant_id, "owner_id": job.resource.owner_id}
        if job is not None
        else None
    )
    try:
        _task_access.require_capability(record, job_id=task_id, token=token)
    except ResourceNotFoundError:
        await websocket.close(code=4404, reason="not found")
        return
    except InvalidCapabilityError:
        await websocket.close(code=4401, reason="authentication required")
        return

    await websocket.accept(subprotocol=selected)
    try:
        if job is None:
            await websocket.close(code=4404, reason="not found")
            return
        if snapshot is None:  # guarded with ``job`` above; keeps types explicit
            await websocket.close(code=4404, reason="not found")
            return
        job, snapshot_sequence = snapshot
        legacy_snapshot = await _legacy_job_response(job)
        await websocket.send_json(
            {
                "type": "job_snapshot",
                "sequence": snapshot_sequence,
                "job": job.to_dict(),
            }
        )
        await websocket.send_json(
            {
                "action": "task_update",
                "sequence": snapshot_sequence,
                **legacy_snapshot,
            }
        )
        # The fresh snapshot supersedes any client cursor, including an invalidly
        # high one that would otherwise starve all real future events.
        cursor = snapshot_sequence
        async for event in _cloud_jobs.watch_events(task_id, after_sequence=cursor):
            await websocket.send_json({"type": "job_event", "event": event.to_dict()})
            cursor = event.sequence
            if event.status in {
                JobStatus.SUCCEEDED,
                JobStatus.FAILED,
                JobStatus.CANCELLED,
                JobStatus.INTERRUPTED,
            }:
                terminal = await _cloud_jobs.get(task_id)
                if terminal is not None:
                    await websocket.send_json(
                        {
                            "action": "task_update",
                            "sequence": cursor,
                            **(await _legacy_job_response(terminal)),
                        }
                    )
    except WebSocketDisconnect:
        pass


# ==================== Anima CNB 池管理 API ====================
# bot 端 cnb状态 / 重启cnb / 重启全部cnb 指令调这几个 endpoint。
# 直接复用 agent_router.anima_provider 暴露的 get_anima_pool() 单例。

class AnimaAccountStatus(BaseModel):
    name: Optional[str] = None
    repo: Optional[str] = None
    branch: Optional[str] = None
    url: Optional[str] = None
    url_healthy: bool = False
    workspace_status: Optional[str] = None
    business_id: Optional[str] = None
    sn: Optional[str] = None
    create_time: Optional[Any] = None
    restarting: bool = False
    error: Optional[str] = None
    running_seconds: Optional[int] = None
    running_count: int = 0
    pending_count: int = 0
    completed_count: int = 0
    active: bool = False
    active_task_id: Optional[str] = None
    active_since: Optional[float] = None


class AnimaStatusResponse(BaseModel):
    ok: bool
    local_queue_count: int = 0
    accounts: list[dict] = []
    error: Optional[str] = None


class AnimaRestartResponse(BaseModel):
    ok: bool
    message: str = ""
    triggered: list[str] = []


@app.get("/api/anima/status", response_model=AnimaStatusResponse)
async def anima_status_endpoint():
    """返回 anima cnb 池所有账户状态 + 本地等待队列长度。"""
    try:
        from agent_router.anima_provider import get_anima_pool
        pool = get_anima_pool()
        accounts = await pool.get_account_statuses()
        local_queue_count = await pool.get_local_queue_count()
        return AnimaStatusResponse(
            ok=True,
            local_queue_count=local_queue_count,
            accounts=accounts,
        )
    except Exception as e:
        return AnimaStatusResponse(ok=False, error=f"{type(e).__name__}: {e}")


@app.post("/api/anima/restart/{account_name}", response_model=AnimaRestartResponse)
async def anima_restart_one_endpoint(account_name: str):
    """触发指定账户的 workspace 强制重启（后台 async runner，立即返回）。"""
    try:
        from agent_router.anima_provider import get_anima_pool
        pool = get_anima_pool()
        accounts = pool.get_accounts()
        target_lower = (account_name or "").strip().lower()
        target = None
        for acc in accounts:
            key = pool.get_account_key(acc).lower()
            name = (acc.get("name") or "").lower()
            repo = (acc.get("repo") or "").lower()
            if target_lower in (key, name, repo):
                target = acc
                break
        if not target:
            return AnimaRestartResponse(
                ok=False, message=f"未找到 anima 账户: {account_name}",
            )
        await pool.ensure_account_restarting(target)
        key = pool.get_account_key(target)
        return AnimaRestartResponse(
            ok=True, message=f"已开始重启 {key}", triggered=[key],
        )
    except Exception as e:
        return AnimaRestartResponse(ok=False, message=f"{type(e).__name__}: {e}")


@app.post("/api/anima/restart-all", response_model=AnimaRestartResponse)
async def anima_restart_all_endpoint():
    """触发全部账户的 workspace 强制重启。"""
    try:
        from agent_router.anima_provider import get_anima_pool
        pool = get_anima_pool()
        accounts = pool.get_accounts()
        if not accounts:
            return AnimaRestartResponse(ok=False, message="未配置 anima 账户")
        triggered = []
        for acc in accounts:
            try:
                await pool.ensure_account_restarting(acc)
                triggered.append(pool.get_account_key(acc))
            except Exception as e:
                print(f"[anima] restart-all 子任务异常 {pool.get_account_key(acc)}: {e}")
        return AnimaRestartResponse(
            ok=True,
            message=f"已开始重启 {len(triggered)} 个 anima 账户",
            triggered=triggered,
        )
    except Exception as e:
        return AnimaRestartResponse(ok=False, message=f"{type(e).__name__}: {e}")


# ==================== 在线人数 API ====================

class HeartbeatRequest(BaseModel):
    user_id: str


@app.post("/api/online/heartbeat")
async def online_heartbeat(req: HeartbeatRequest):
    """用户心跳（前端定期调用）"""
    online_manager.heartbeat(req.user_id)
    return {"success": True, "count": online_manager.get_online_count()}


@app.get("/api/online/count")
async def get_online_count():
    """获取当前在线人数"""
    return {"count": online_manager.get_online_count()}


@app.websocket("/ws/queue")
async def websocket_queue(websocket: WebSocket):
    """排队WebSocket连接"""
    await websocket.accept()
    
    current_ticket: Optional[str] = None
    current_token_hash: Optional[str] = None
    
    try:
        while True:
            data = await websocket.receive_json()
            action = data.get("action")
            
            if action == QueueAction.JOIN:
                # 加入队列
                token_hash = data.get("token_hash")
                user_id = data.get("user_id", "anonymous")
                
                if not token_hash:
                    await websocket.send_json({
                        "action": "error",
                        "message": "缺少token_hash"
                    })
                    continue
                
                # 如果已在队列中，先离开
                if current_ticket:
                    await queue_manager.leave(current_ticket)
                
                ticket, position = await queue_manager.join(token_hash, user_id, websocket)
                current_ticket = ticket
                current_token_hash = token_hash
                
                await websocket.send_json({
                    "action": "joined",
                    "ticket": ticket,
                    "position": position,
                    "message": f"已加入队列，当前位置: {position}"
                })
                
                # 广播位置更新
                await queue_manager.broadcast_positions(token_hash)
                
            elif action == QueueAction.LEAVE:
                # 离开队列
                if current_ticket:
                    await queue_manager.leave(current_ticket)
                    if current_token_hash:
                        await queue_manager.broadcast_positions(current_token_hash)
                    current_ticket = None
                    current_token_hash = None
                
                await websocket.send_json({
                    "action": "left",
                    "message": "已离开队列"
                })
                
            elif action == QueueAction.DONE:
                # 完成生成
                ticket = data.get("ticket") or current_ticket
                if ticket:
                    success = await queue_manager.done(ticket)
                    if success and current_token_hash:
                        await queue_manager.broadcast_positions(current_token_hash)
                    current_ticket = None
                    
                    await websocket.send_json({
                        "action": "done_ack",
                        "success": success
                    })
                    
            elif action == QueueAction.HEARTBEAT:
                # 心跳
                position = -1
                if current_ticket:
                    position = await queue_manager.get_position(current_ticket)
                
                await websocket.send_json({
                    "action": "heartbeat_ack",
                    "position": position,
                    "ticket": current_ticket
                })
                
    except WebSocketDisconnect:
        # 断开连接，清理
        if current_ticket:
            await queue_manager.leave(current_ticket)
            if current_token_hash:
                await queue_manager.broadcast_positions(current_token_hash)
    except Exception as e:
        print(f"WebSocket error: {e}")
        if current_ticket:
            await queue_manager.leave(current_ticket)


# ==================== Bot 授权系统 ====================

@dataclass
class BotSession:
    """Bot会话"""
    session_id: str
    auth_code: str
    bot_user_id: str
    created_at: float
    last_active: float
    websocket: Optional[WebSocket] = None


@dataclass
class BotGenerateTask:
    """Bot生成任务"""
    task_id: str
    session_id: str
    params: Dict[str, Any]
    created_at: float
    status: str = "pending"  # pending, queued, generating, completed, failed
    result: Optional[Dict[str, Any]] = None
    queue_position: int = 0


class _JsonSocketSender(Protocol):
    async def send_json(self, data: Any) -> None: ...


class _LockedWebSocketSender:
    def __init__(self, websocket: WebSocket, lock: asyncio.Lock) -> None:
        self._websocket = websocket
        self._lock = lock

    async def send_json(self, data: Any) -> None:
        async with self._lock:
            await self._websocket.send_json(data)


class BotAuthManager:
    """Bot授权管理器"""
    
    AUTH_CODE_EXPIRE = 300  # 授权码5分钟过期
    SESSION_EXPIRE = 7 * 24 * 60 * 60  # 会话7天过期
    SESSIONS_FILE = Path(
        getattr(_appcfg, "BOT_SESSIONS_FILE", BOT_DATA_DIR / "sessions.json")
    )
    
    def __init__(self, sessions_file: Path | None = None):
        self.pairing = PairingCodeRegistry(ttl_seconds=self.AUTH_CODE_EXPIRE)
        self.sessions: Dict[str, BotSession] = {}
        self.tasks: Dict[str, BotGenerateTask] = {}
        self.session_websockets: Dict[str, _JsonSocketSender] = {}
        self.lock = asyncio.Lock()
        self._state_lock = threading.RLock()
        self._session_store = SecureJsonObjectStore(sessions_file or self.SESSIONS_FILE)
        self._load_sessions()
    
    def _load_sessions(self):
        """从文件加载会话"""
        data = self._session_store.load()
        now = time.time()
        expired = False
        for sid, value in data.items():
            if not isinstance(sid, str) or not isinstance(value, dict):
                raise StorageIntegrityError("Bot session store contains an invalid record")
            stored_id = value.get("session_id")
            bot_user_id = value.get("bot_user_id")
            created_at = value.get("created_at")
            last_active = value.get("last_active")
            if (
                not re.fullmatch(r"[0-9a-f]{32}", sid)
                or stored_id != sid
                or not isinstance(bot_user_id, str)
                or not bot_user_id
                or len(bot_user_id) > 128
                or not isinstance(created_at, (int, float))
                or not isinstance(last_active, (int, float))
                or not math.isfinite(created_at)
                or not math.isfinite(last_active)
                or created_at < 0
                or last_active < created_at
            ):
                raise StorageIntegrityError("Bot session store contains an invalid record")
            if now - last_active > self.SESSION_EXPIRE:
                expired = True
                continue
            self.sessions[sid] = BotSession(
                session_id=sid,
                # Pairing codes are ephemeral and are never persisted.
                auth_code="",
                bot_user_id=bot_user_id,
                created_at=float(created_at),
                last_active=float(last_active),
            )
        if expired:
            self._save_sessions()
        if data:
            print(f"[BotAuth] 已加载 {len(self.sessions)} 个会话")
    
    def _save_sessions(self):
        """保存会话到文件（同步版本，内部使用）"""
        with self._state_lock:
            data = {}
            for sid, session in self.sessions.items():
                data[sid] = {
                    "session_id": session.session_id,
                    "bot_user_id": session.bot_user_id,
                    "created_at": session.created_at,
                    "last_active": session.last_active,
                }
            self._session_store.save(data)

    def generate_auth_code(self):
        """生成展示码及仅签发浏览器持有的高熵轮询凭据。"""
        return self.pairing.issue()
    
    async def verify_auth_code(self, code: str, bot_user_id: str) -> Optional[str]:
        """验证授权码，返回session_id"""
        async with self.lock:
            session_id = secrets.token_hex(16)
            if not self.pairing.bind(code, session_id):
                return None

            session = BotSession(
                session_id=session_id,
                auth_code="",
                bot_user_id=bot_user_id,
                created_at=time.time(),
                last_active=time.time()
            )
            with self._state_lock:
                self.sessions[session_id] = session
                try:
                    self._save_sessions()
                except BaseException:
                    self.sessions.pop(session_id, None)
                    self.pairing.rollback_bind(code, session_id)
                    raise

            return session_id
    
    def get_session(self, session_id: str) -> Optional[BotSession]:
        """获取会话，自动续期"""
        with self._state_lock:
            session = self.sessions.get(session_id)
            if not session:
                return None
            # 连续7天未活跃才过期
            if time.time() - session.last_active > self.SESSION_EXPIRE:
                del self.sessions[session_id]
                self._save_sessions()
                return None
            # 自动续期：更新最后活跃时间（每小时最多保存一次，避免频繁写文件）
            now = time.time()
            if now - session.last_active > 3600:  # 超过1小时才更新
                session.last_active = now
                self._save_sessions()
            return session

    def check_auth_code_status(self, code: str, poll_token: str) -> Optional[str]:
        """仅向签发该挑战的浏览器一次性返回绑定后的 session。"""
        return self.pairing.consume(code, poll_token)

    async def create_task(
        self,
        session_id: str,
        params: Dict[str, Any],
        *,
        task_id: str,
    ) -> Optional[BotGenerateTask]:
        """Mirror an existing owner-bound cloud job for legacy Bot polling."""

        session = self.get_session(session_id)
        if not session:
            return None
        await _ensure_cloud_job_storage()
        job = await _cloud_jobs.get(task_id)
        if job is None:
            raise ResourceNotFoundError()
        principal = Principal.user(str(session.bot_user_id), _BOT_TASK_TENANT_ID)
        _task_access.policy.require_access(principal, job.resource)

        with self._state_lock:
            session = self.get_session(session_id)
            if not session:
                return None

            task = BotGenerateTask(
                task_id=task_id,
                session_id=session_id,
                params=params,
                created_at=time.time()
            )
            self.tasks[task_id] = task
            session.last_active = time.time()
            return task
    
    def get_task(self, task_id: str) -> Optional[BotGenerateTask]:
        """获取任务"""
        with self._state_lock:
            return self.tasks.get(task_id)

    async def update_task(
        self,
        task_id: str,
        status: str,
        result: Optional[Dict] = None,
        queue_position: int = 0,
        error: str | None = None,
    ):
        """更新任务状态"""
        ws: _JsonSocketSender | None = None
        with self._state_lock:
            task = self.tasks.get(task_id)
            if task:
                task.status = status
                task.queue_position = queue_position
                if result is not None:
                    task.result = result
                ws = self.session_websockets.get(task.session_id)
        if task:
            # 通知WebSocket客户端
            if ws:
                try:
                    message = {
                        "action": "task_update",
                        "task_id": task_id,
                        "status": status,
                        "queue_position": queue_position,
                        "result": result,
                    }
                    if error is not None:
                        message["error"] = error
                    await ws.send_json(message)
                except:
                    pass
    
    def cleanup_expired(self):
        """清理过期数据"""
        now = time.time()
        self.pairing.prune()
        with self._state_lock:
            # 清理过期会话（连续7天未活跃）
            expired_sessions = [k for k, v in self.sessions.items() if now - v.last_active > self.SESSION_EXPIRE]
            for k in expired_sessions:
                del self.sessions[k]
            if expired_sessions:
                self._save_sessions()
            # 清理旧任务（1小时）
            expired_tasks = [k for k, v in self.tasks.items() if now - v.created_at > 3600]
            for k in expired_tasks:
                del self.tasks[k]
            # 释放已完成任务的 result 数据（5分钟后），减少内存占用
            for v in self.tasks.values():
                if v.status in ("completed", "failed") and v.result and now - v.created_at > 300:
                    v.result = None


# 全局Bot授权管理器
bot_auth_manager = BotAuthManager()


# ==================== 访问控制（管理员 / 计费自查 / Bot 密钥）====================
# 均为可选、向后兼容：老 config.py 未定义这些字段时取安全默认。
#   ADMIN_USER_IDS   : 管理员 QQ 号列表（可查全站报表 / 任意用户），默认空 = 无人。
#   ADMIN_TOKEN      : 后台/curl 用的管理员密钥（请求头 X-Admin-Token），默认空 = 不启用。
#   BOT_SHARED_SECRET: Bot 服务端凭据（请求头 X-Bot-Secret）；默认空会使相关端点返回 503。

def _admin_user_ids() -> set:
    return {str(x) for x in (getattr(_appcfg, "ADMIN_USER_IDS", None) or [])}


def _admin_token_value() -> str:
    return str(getattr(_appcfg, "ADMIN_TOKEN", "") or "")


def _bot_shared_secret_value() -> str:
    return str(getattr(_appcfg, "BOT_SHARED_SECRET", "") or "")


def _secure_eq(provided: str, expected: str) -> bool:
    """Constant-time string compare that tolerates any (incl. non-ASCII) input."""
    try:
        return secrets.compare_digest(str(provided).encode("utf-8"), str(expected).encode("utf-8"))
    except Exception:
        return False


def _is_admin(session_id: str, admin_token: str) -> bool:
    """管理员 = 持有效 ADMIN_TOKEN，或会话的 bot_user_id ∈ ADMIN_USER_IDS。"""
    tok = _admin_token_value()
    if tok and admin_token and _secure_eq(admin_token, tok):
        return True
    if session_id:
        session = bot_auth_manager.get_session(session_id)
        if session and str(session.bot_user_id) in _admin_user_ids():
            return True
    return False


def _require_admin(session_id: str = "", x_admin_token: str = Header(default="")) -> None:
    """全站/管理端点依赖：需管理员会话或有效 ADMIN_TOKEN，否则 403。默认无管理员即锁死。"""
    if not _is_admin(session_id, x_admin_token):
        raise HTTPException(status_code=403, detail="需要管理员权限")


def _resolve_billing_target(session_id: str, requested_user_id: str, admin_token: str) -> str:
    """普通用户只能查自己（user_id 强制取会话）；管理员可查任意 user_id。未登录且非管理员 → 401。"""
    if _is_admin(session_id, admin_token):
        return requested_user_id
    session = bot_auth_manager.get_session(session_id) if session_id else None
    if not session:
        raise HTTPException(status_code=401, detail="未登录或会话已过期")
    return str(session.bot_user_id)


def _require_bot_secret(x_bot_secret: str = Header(default="")) -> None:
    """Bot 服务端点必须使用独立服务凭据，缺配置时失败关闭。"""
    secret = _bot_shared_secret_value()
    if not secret:
        if bool(getattr(_appcfg, "ALLOW_UNAUTHENTICATED_BOT_SERVICE", False)):
            return
        raise HTTPException(status_code=503, detail="Bot 服务鉴权尚未配置")
    if not _secure_eq(x_bot_secret, secret):
        raise HTTPException(status_code=401, detail="bot unauthorized")


def _require_session(session_id: str = "") -> None:
    """需要有效登录会话（不要求管理员）。用于聚合但非公开的端点，如全平台统计。"""
    if not session_id or not bot_auth_manager.get_session(session_id):
        raise HTTPException(status_code=401, detail="未登录或会话已过期")


def _agent_not_found() -> HTTPException:
    """Keep missing, invalid, and cross-owner Agent credentials indistinguishable."""
    return HTTPException(status_code=404, detail="resource was not found")


def _agent_header(request: Request, name: str) -> str:
    values = request.headers.getlist(name)
    if len(values) > 1:
        raise _agent_not_found()
    return values[0].strip() if values else ""


def _agent_session_credential(request: Request) -> str:
    candidates: list[str] = []
    header_session = _agent_header(request, "X-Bot-Session")
    if header_session:
        candidates.append(header_session)
    authorization = _agent_header(request, "Authorization")
    if authorization:
        try:
            candidates.append(bearer_token(authorization))
        except InvalidCapabilityError as exc:
            raise _agent_not_found() from exc
    query_sessions = [value.strip() for value in request.query_params.getlist("session_id")]
    if any(not value for value in query_sessions) or len(query_sessions) > 1:
        raise _agent_not_found()
    candidates.extend(query_sessions)
    if len(candidates) > 1:
        # Never let two adapters interpret an ambiguous request differently, even
        # when the supplied values happen to be identical.
        raise _agent_not_found()
    return candidates[0] if candidates else ""


async def _authenticate_agent_request(request: Request) -> AgentAccess:
    """Map verified deployment credentials to one transport-neutral Principal."""
    admin_token = _agent_header(request, "X-Admin-Token")
    bot_secret = _agent_header(request, "X-Bot-Secret")
    session_id = _agent_session_credential(request)
    credential_families = sum(bool(value) for value in (admin_token, bot_secret, session_id))
    if credential_families != 1:
        raise _agent_not_found()

    if admin_token:
        if not _is_admin("", admin_token):
            raise _agent_not_found()
        try:
            return AgentAccess(
                Principal.admin("agent-admin-token", _BOT_TASK_TENANT_ID),
                administrator=True,
            )
        except InvalidRequestError as exc:
            raise _agent_not_found() from exc

    if bot_secret:
        expected = _bot_shared_secret_value()
        if not expected or not _secure_eq(bot_secret, expected):
            raise _agent_not_found()
        try:
            return AgentAccess(
                Principal.bot("legacy-agent-bot", _BOT_TASK_TENANT_ID),
                trusted_service=True,
            )
        except InvalidRequestError as exc:
            raise _agent_not_found() from exc

    session = bot_auth_manager.get_session(session_id)
    if session is None:
        raise _agent_not_found()
    owner_id = str(session.bot_user_id)
    try:
        if owner_id in _admin_user_ids():
            return AgentAccess(
                Principal.admin(owner_id, _BOT_TASK_TENANT_ID),
                administrator=True,
            )
        return AgentAccess(Principal.user(owner_id, _BOT_TASK_TENANT_ID))
    except InvalidRequestError as exc:
        raise _agent_not_found() from exc


async def _authorize_agent_paid(access: AgentAccess) -> bool:
    """Require an internal Bot caller, an admin, or a user with live quota.

    Intent (not a bug): the Agent LLM assistant is gated on the owner holding live
    image quota but is deliberately NOT metered. Unlike the image path — which
    reserves and captures workshop quota units (see ``_workshop_quota.reserve`` /
    ``capture``) — agent chat/prompt calls neither reserve nor decrement quota.
    Images are the metered paid unit; the LLM helper stays free for any user who
    already has quota, so the absence of a reserve/capture here is by design and
    not a metering bypass. If unbounded agent LLM use ever needs bounding, add a
    per-owner rate limit rather than repurposing the image quota ledger.
    """
    if access.administrator or access.trusted_service:
        return True
    owner_id = access.owner_id
    if owner_id is None:
        return False
    try:
        await _workshop_quota.initialize()
        quota_date = datetime.now(_BEIJING_TZ).strftime("%Y-%m-%d")
        balance = await _workshop_quota.balance(owner_id, quota_date=quota_date)
    except ResourceNotFoundError:
        return False
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail="Agent quota validation is unavailable",
        ) from exc
    return balance.total_available > 0


# Agent routes are mounted only after the concrete identity/quota adapters exist.
# The router itself also has a fail-closed dependency, so mounting it in another
# process without these state hooks returns 503 rather than exposing a paid route.
app.state.agent_authenticator = _authenticate_agent_request
app.state.agent_paid_authorizer = _authorize_agent_paid
try:
    from agent_router.router import router as agent_router

    app.include_router(agent_router)
    print("[agent_router] PydanticAI 路由组已挂载: /api/agent/*")
except Exception as _agent_router_error:
    print(f"[agent_router] 加载失败，跳过挂载: {_agent_router_error}")


# 授权码校验限速：只统计"失败"尝试的滑动窗口，防止对短授权码（6 位十六进制）的暴力爆破。
# 合法 Bot 用有效码校验会成功、不计入失败，故正常登录（哪怕都来自 Bot 同一 IP）永不被限流。
# 按 bot_user_id 分桶：单个用户手滑不会拖累其他人；全局上限兜住"轮换 user_id"的分布式爆破。
# 配合可选的 X-Bot-Secret 可在部署侧彻底关闭该向量。
_VERIFY_FAIL_WINDOW_SEC = 60.0
_VERIFY_FAIL_MAX_PER_USER = 20
_VERIFY_FAIL_MAX_GLOBAL = 100
_verify_fails: dict = collections.defaultdict(collections.deque)


def _verify_blocked(user_key: str) -> bool:
    now = time.time()
    cutoff = now - _VERIFY_FAIL_WINDOW_SEC
    gq = _verify_fails.get("*")
    if gq:
        while gq and gq[0] < cutoff:
            gq.popleft()
    uq = _verify_fails.get(user_key)
    if uq:
        while uq and uq[0] < cutoff:
            uq.popleft()
        if not uq:
            _verify_fails.pop(user_key, None)
    g = len(_verify_fails.get("*") or ())
    u = len(_verify_fails.get(user_key) or ())
    return g >= _VERIFY_FAIL_MAX_GLOBAL or u >= _VERIFY_FAIL_MAX_PER_USER


def _verify_record_failure(user_key: str) -> None:
    now = time.time()
    _verify_fails["*"].append(now)
    _verify_fails[user_key].append(now)


# ==================== Bot API 端点 ====================

class GenerateAuthCodeResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str
    poll_token: str
    expires_in: int


@app.post("/api/bot/auth/generate", response_model=GenerateAuthCodeResponse)
async def generate_auth_code():
    """生成授权码"""
    try:
        challenge = bot_auth_manager.generate_auth_code()
    except PairingCapacityError as exc:
        raise HTTPException(status_code=429, detail="授权请求过多，请稍后重试") from exc
    return GenerateAuthCodeResponse(
        code=challenge.code,
        poll_token=challenge.poll_token,
        expires_in=challenge.expires_in,
    )


class CheckAuthCodeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str = Field(min_length=6, max_length=6, pattern=r"^[0-9A-Fa-f]{6}$")
    poll_token: str = Field(min_length=32, max_length=256, pattern=r"^\S+$")


class CheckAuthCodeResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    verified: bool
    session_id: Optional[str] = None


@app.post("/api/bot/auth/check", response_model=CheckAuthCodeResponse)
async def check_auth_code(req: CheckAuthCodeRequest):
    """检查授权码状态"""
    session_id = bot_auth_manager.check_auth_code_status(req.code, req.poll_token)
    return CheckAuthCodeResponse(verified=session_id is not None, session_id=session_id)


class VerifyAuthCodeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str = Field(min_length=6, max_length=6, pattern=r"^[0-9A-Fa-f]{6}$")
    bot_user_id: str = Field(min_length=1, max_length=128)


class VerifyAuthCodeResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    success: bool
    session_id: Optional[str] = None
    message: str


@app.post("/api/bot/auth/verify", response_model=VerifyAuthCodeResponse, dependencies=[Depends(_require_bot_secret)])
async def verify_auth_code(req: VerifyAuthCodeRequest):
    """Bot验证授权码（由Bot调用）"""
    user_key = req.bot_user_id or "unknown"
    if _verify_blocked(user_key):
        raise HTTPException(status_code=429, detail="验证失败次数过多，请稍后再试")
    session_id = await bot_auth_manager.verify_auth_code(req.code, req.bot_user_id)
    if session_id:
        return VerifyAuthCodeResponse(success=True, session_id=session_id, message="授权成功")
    _verify_record_failure(user_key)
    return VerifyAuthCodeResponse(success=False, message="授权码无效或已过期")

class ValidateSessionRequest(BaseModel):
    session_id: str


class ValidateSessionResponse(BaseModel):
    valid: bool
    bot_user_id: Optional[str] = None
    # 基于 last_active 的滑动窗口过期时间（毫秒时间戳），供前端同步本地缓存
    expires_at_ms: Optional[int] = None


@app.post("/api/bot/auth/validate", response_model=ValidateSessionResponse)
async def validate_bot_session(req: ValidateSessionRequest):
    """验证Bot session是否有效（轻量级，不走生成逻辑）"""
    session = bot_auth_manager.get_session(req.session_id)
    if session:
        expires_at_ms = int((session.last_active + BotAuthManager.SESSION_EXPIRE) * 1000)
        return ValidateSessionResponse(
            valid=True,
            bot_user_id=session.bot_user_id,
            expires_at_ms=expires_at_ms,
        )
    return ValidateSessionResponse(valid=False)


class BotGenerateRequest(BaseModel):
    session_id: str
    params: Dict[str, Any]


class BotGenerateResponse(BaseModel):
    success: bool
    task_id: Optional[str] = None
    capability_token: Optional[str] = None
    message: str


def convert_web_params_to_stream(web_params: dict) -> dict:
    """将 Web 端参数转换为流式生成参数格式"""
    positive_prompt = web_params.get("positivePrompt", "")
    negative_prompt = web_params.get("negativePrompt", "")
    width = web_params.get("width", 832)
    height = web_params.get("height", 1216)
    seed = web_params.get("seed", 0)
    steps = web_params.get("steps", 28)
    scale = web_params.get("scale", 5)
    sampler = web_params.get("sampler", "k_euler_ancestral")
    cfg_rescale = web_params.get("cfgRescale", 0)
    noise_schedule = web_params.get("noiseSchedule", "karras")
    variety_plus = web_params.get("varietyPlus", False)
    normalize_vibe_strength = web_params.get("normalizeVibeStrength", True)
    quality_toggle = web_params.get("qualityToggle", False)
    uc_preset = web_params.get("ucPreset", 4)
    
    # 模型处理：支持前端已转换的 API 内部名，也支持显示名
    model_id = web_params.get("model", "nai-diffusion-4-5-full")
    model_map = {
        "v4.5-full": "nai-diffusion-4-5-full",
        "v4.5-curated": "nai-diffusion-4-5-curated",
        "v4-full": "nai-diffusion-4-full",
        "v4-curated-preview": "nai-diffusion-4-curated-preview",
        "v3": "nai-diffusion-3",
    }
    # 如果已经是 API 内部名则直接使用，否则尝试映射
    model = model_map.get(model_id, model_id)
    
    # ucPreset 处理：支持数字和字符串
    uc_preset_map = {"heavy": 4, "light": 3, "humanFocus": 2, "none": 0}
    if isinstance(uc_preset, int):
        uc_preset_value = uc_preset
    else:
        uc_preset_value = uc_preset_map.get(uc_preset, 4)
    
    # 角色提示词转换
    character_prompts = web_params.get("characterPrompts", [])
    stream_character_prompts = []
    
    position_to_center = {}
    for col_idx, col in enumerate(['A', 'B', 'C', 'D', 'E']):
        for row in range(1, 6):
            position_to_center[f"{col}{row}"] = {
                "x": (col_idx + 0.5) / 5,
                "y": (row - 0.5) / 5
            }
    
    for idx, cp in enumerate(character_prompts):
        if cp.get("enabled") and cp.get("positive"):
            position = cp.get("position", "")
            if position and position in position_to_center:
                center = position_to_center[position]
            else:
                auto_positions = [
                    {"x": 0.3, "y": 0.5}, {"x": 0.7, "y": 0.5},
                    {"x": 0.5, "y": 0.3}, {"x": 0.5, "y": 0.7},
                    {"x": 0.3, "y": 0.3}, {"x": 0.7, "y": 0.7},
                ]
                center = auto_positions[idx % len(auto_positions)]
            
            stream_character_prompts.append({
                "prompt": cp.get("positive", ""),
                "uc": cp.get("negative", ""),
                "center": center,
                "enabled": True
            })
    
    stream_params = {
        "input_text1": positive_prompt,
        "input_text2": negative_prompt,
        "seed": seed,
        "width": width,
        "height": height,
        "steps": steps,
        "scale": scale,
        "model": model,
        "sampler": sampler,
        "cfg_rescale": cfg_rescale,
        "noise_schedule": noise_schedule,
        "skip_cfg_above_sigma": 58 if variety_plus else None,
        "quality_toggle": quality_toggle,
        "uc_preset": uc_preset_value,
        "normalize_reference_strength_multiple": normalize_vibe_strength,
        "character_prompts": stream_character_prompts,
    }
    
    # Vibe 参数
    vibe_refs = web_params.get("vibeReferences", [])
    if vibe_refs:
        stream_params["reference_image_multiple"] = [v.get("encodedVibe") for v in vibe_refs]
        stream_params["reference_strength_multiple"] = [v.get("strength", 0.5) for v in vibe_refs]
        stream_params["reference_information_extracted_multiple"] = [v.get("informationExtracted", 1) for v in vibe_refs]
    
    # Precise Reference 参数
    precise_refs = web_params.get("preciseReferences", [])
    if precise_refs:
        stream_params["director_reference_images"] = [pr.get("imageBase64") for pr in precise_refs]
        stream_params["director_reference_descriptions"] = [{
            "caption": {"base_caption": pr.get("mode", "character&style"), "char_captions": []},
            "legacy_uc": False
        } for pr in precise_refs]
        stream_params["director_reference_information_extracted"] = [1 for _ in precise_refs]
        stream_params["director_reference_strength_values"] = [pr.get("strength", 1) for pr in precise_refs]
        stream_params["director_reference_secondary_strength_values"] = [1 - pr.get("informationExtracted", 1) for pr in precise_refs]
    
    # 图生图参数
    img2img = web_params.get("img2img")
    if img2img:
        stream_params["image"] = img2img.get("imageBase64")
        stream_params["strength"] = img2img.get("strength", 0.6)
        stream_params["noise"] = img2img.get("noise", 0.1)
    
    # 局部重绘参数
    inpaint = web_params.get("inpaint")
    if inpaint:
        stream_params["action"] = "infill"
        stream_params["image"] = inpaint.get("imageBase64")
        stream_params["mask"] = inpaint.get("maskBase64")
        stream_params["strength"] = inpaint.get("strength", 0.7)
        stream_params["noise"] = inpaint.get("noise", 0)
        # inpaint 需要使用 inpainting 模型
        base_model = stream_params.get("model", "nai-diffusion-4-5-full")
        if base_model == "nai-diffusion-3":
            stream_params["model"] = "nai-diffusion-3-inpainting"
        else:
            stream_params["model"] = f"{base_model}-inpainting"
    
    return stream_params


@app.post("/api/bot/generate", response_model=BotGenerateResponse)
async def bot_generate(
    req: BotGenerateRequest,
    idempotency_key: str = Header(default="", alias="Idempotency-Key"),
):
    """提交生成任务（直接使用内置队列，不再依赖 Bot 轮询）"""
    principal = _principal_from_bot_session(req.session_id)
    session = bot_auth_manager.get_session(req.session_id)
    if session is None:  # kept explicit for the type checker and defensive races
        raise HTTPException(status_code=401, detail="会话无效或已过期")
    resource = ResourceOwner(_BOT_TASK_TENANT_ID, principal.subject_id)
    
    # 转换参数。image_backend 由 agent router 的 ChatResponse 决定、bot 端原样
    # 透传进 params;anima 不走 NAI 参数转换,复用 direct_generate 的分发形状。
    backend = str((req.params or {}).get("image_backend") or "novelai").strip().lower()
    anima_request: DirectGenerateRequest | None = None
    if backend == "anima":
        try:
            anima_request = DirectGenerateRequest.model_validate(req.params)
        except Exception as exc:
            raise HTTPException(status_code=400, detail="anima 生成参数无效") from exc
        queue_params = anima_request.model_dump()
        queue_params["_image_backend"] = "anima"
        queue_params["steps"] = 1
    else:
        queue_params = convert_web_params_to_stream(req.params)
    stream_params = queue_params
    request_hash = _generation_request_hash(stream_params)
    normalized_key = idempotency_key.strip()
    if _quota_ledger.enabled and not normalized_key:
        raise HTTPException(status_code=400, detail="启用额度账本时必须提供 Idempotency-Key")
    if len(normalized_key) > 200:
        raise HTTPException(status_code=400, detail="Idempotency-Key 无效")
    task_id = (
        hashlib.sha256(
            f"{resource.tenant_id}\0{resource.owner_id}\0{normalized_key}".encode("utf-8")
        ).hexdigest()[:32]
        if normalized_key
        else secrets.token_hex(8)
    )

    def replay_response(existing: dict[str, Any]) -> BotGenerateResponse:
        try:
            _task_access.require_principal(existing, principal)
        except ResourceNotFoundError as exc:
            raise HTTPException(status_code=404, detail="任务不存在") from exc
        if existing.get("request_hash") != request_hash:
            raise HTTPException(status_code=409, detail="Idempotency-Key 已用于不同请求")
        capability = _task_access.capabilities.issue(
            principal,
            job_id=task_id,
            resource=resource,
        )
        queue_position = (
            _get_task_queue_position(task_id) if existing.get("status") == "queued" else 0
        )
        return BotGenerateResponse(
            success=True,
            task_id=task_id,
            capability_token=capability,
            message=f"任务已存在，队列位置: {queue_position}",
        )

    existing = _generation_tasks.get(task_id)
    if existing is not None:
        return replay_response(existing)
    await _ensure_cloud_job_storage()
    persistent_existing = await _cloud_jobs.get(task_id)
    if persistent_existing is not None:
        if persistent_existing.resource != resource:
            raise HTTPException(status_code=404, detail="任务不存在")
        if persistent_existing.request_hash != request_hash:
            raise HTTPException(status_code=409, detail="Idempotency-Key 已用于不同请求")
        capability = _task_access.capabilities.issue(
            principal,
            job_id=task_id,
            resource=resource,
        )
        return BotGenerateResponse(
            success=True,
            task_id=task_id,
            capability_token=capability,
            message="任务已存在",
        )

    if backend == "anima":
        # anima 走 CNB 算力,不烧 Anlas;账本按「一张图」记最小单位,
        # 防免费通道被拿来无限刷额度外的产出。
        quota_units = 1
    else:
        quota_units = calculate_anlas_cost(
            int(stream_params.get("width", 832)),
            int(stream_params.get("height", 1216)),
            int(stream_params.get("steps", 28)),
            str(stream_params.get("model", "")),
            stream_params.get("strength") if stream_params.get("image") else None,
            len(stream_params.get("director_reference_images", []) or []),
        )
    task_metadata: dict[str, Any] = {
        "request_hash": request_hash,
        "idempotency_key": normalized_key or None,
        "bot_user_id": session.bot_user_id,
        "quota_units": max(1, quota_units),
    }
    _task_access.bind_record(task_metadata, resource)
    try:
        await _quota_ledger.reserve(
            task_metadata,
            principal,
            units=quota_units,
            idempotency_key=normalized_key or f"job:{task_id}:reserve",
        )
    except CloudBackendError as exc:
        status = 402 if exc.code == "quota_exceeded" else 409
        if exc.code == "not_found":
            status = 503
        raise HTTPException(status_code=status, detail=exc.message) from exc
    
    # 入队生成。这是 web 前端的真实用户（bot 授权后登录 web），保留加速。
    user_id = f"web_{session.bot_user_id}"
    try:
        queued_task_id, queue_pos, created = await enqueue_generation(
            stream_params,
            user_id,
            resource=resource,
            task_id=task_id,
            task_metadata=task_metadata,
            idempotency_key=normalized_key or None,
            request_hash=request_hash,
        )
    except _DuplicateGenerationTaskError:
        # Two concurrent retries can both reserve the same ledger row before one
        # publishes the deterministic task id.  Never refund the shared active
        # reservation; return the winner exactly like a normal replay.
        existing = _generation_tasks.get(task_id)
        if existing is not None:
            return replay_response(existing)
        await _quota_ledger.settle(
            task_metadata,
            principal,
            succeeded=False,
            job_id=task_id,
        )
        raise
    except Exception:
        await _quota_ledger.settle(
            task_metadata,
            principal,
            succeeded=False,
            job_id=task_id,
        )
        raise
    
    if queue_pos == -1:
        await _quota_ledger.settle(
            task_metadata,
            principal,
            succeeded=False,
            job_id=task_id,
        )
        return BotGenerateResponse(success=False, message="队列已满，请稍后再试")
    task_id = queued_task_id
    if not created:
        capability = _task_access.capabilities.issue(
            principal,
            job_id=task_id,
            resource=resource,
        )
        return BotGenerateResponse(
            success=True,
            task_id=task_id,
            capability_token=capability,
            message="任务已存在",
        )

    if backend == "anima" and anima_request is not None:
        # anima 有自己的 provider runner;准入/配额/幂等已经走完共享路径。
        asyncio.create_task(_run_anima_task(task_id, anima_request))

    # 同时在 bot_auth_manager 中创建任务记录（用于兼容现有的状态查询接口）
    await bot_auth_manager.create_task(
        req.session_id,
        req.params,
        task_id=task_id,
    )

    capability = _task_access.capabilities.issue(
        principal,
        job_id=task_id,
        resource=resource,
    )
    return BotGenerateResponse(
        success=True,
        task_id=task_id,
        capability_token=capability,
        message=f"任务已提交，队列位置: {queue_pos}",
    )


class GetTaskRequest(BaseModel):
    task_id: str
    session_id: str


class GetTaskResponse(BaseModel):
    success: bool
    status: Optional[str] = None
    queue_position: int = 0
    result: Optional[Dict[str, Any]] = None
    step: int = 0
    total_steps: int = 0
    error: Optional[str] = None


@app.post("/api/bot/task", response_model=GetTaskResponse)
async def get_task(req: GetTaskRequest):
    """从持久任务权威读取；旧 Bot 记录只作为升级期回退。"""
    principal = _principal_from_bot_session(req.session_id)
    await _ensure_cloud_job_storage()
    job = await _cloud_jobs.get(req.task_id)
    if job:
        try:
            _task_access.policy.require_access(principal, job.resource)
        except ResourceNotFoundError as exc:
            raise HTTPException(status_code=404, detail="任务不存在") from exc
        payload = await _legacy_job_response(job)
        return GetTaskResponse(
            success=True,
            status=payload["status"],
            queue_position=payload["queue_position"],
            result=payload["result"],
            step=payload["step"],
            total_steps=payload["total_steps"],
            error=payload["error"],
        )
    
    # 回退到 bot_auth_manager 查询（兼容旧任务）
    bot_task = bot_auth_manager.get_task(req.task_id)
    if bot_task:
        if bot_task.session_id != req.session_id:
            raise HTTPException(status_code=404, detail="任务不存在")
        return GetTaskResponse(
            success=True,
            status=bot_task.status,
            queue_position=bot_task.queue_position,
            result=bot_task.result
        )
    
    raise HTTPException(status_code=404, detail="任务不存在")


class PendingTasksResponse(BaseModel):
    tasks: list


@app.get("/api/bot/tasks/pending", response_model=PendingTasksResponse, dependencies=[Depends(_require_bot_secret)])
async def get_pending_tasks():
    """获取待处理任务（由Bot轮询调用）"""
    pending = []
    for t in bot_auth_manager.tasks.values():
        if t.status == "pending":
            session = bot_auth_manager.get_session(t.session_id)
            pending.append({
                "task_id": t.task_id,
                "session_id": t.session_id,
                "params": t.params,
                "created_at": t.created_at,
                "bot_user_id": session.bot_user_id if session else None,
            })
    return PendingTasksResponse(tasks=pending)


class BotTaskResult(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    type: Literal["base64"]
    image_base64: str = Field(
        alias="imageBase64",
        min_length=1,
        max_length=44 * _MIB,
        strict=True,
    )

    @field_validator("image_base64")
    @classmethod
    def validate_image(cls, value: str) -> str:
        try:
            return normalize_image_base64(value, max_decoded_bytes=MAX_PAID_RESULT_BYTES)
        except InvalidRequestError as exc:
            raise ValueError(exc.message) from exc


class UpdateTaskRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    task_id: str = Field(
        min_length=1,
        max_length=200,
        pattern=r"^[A-Za-z0-9_-]+$",
        strict=True,
    )
    status: Literal[
        "queued",
        "generating",
        "cancelling",
        "completed",
        "failed",
        "cancelled",
        "interrupted",
    ]
    queue_position: int = Field(default=0, ge=0, le=100_000, strict=True)
    result: BotTaskResult | None = None
    error: str | None = Field(default=None, min_length=1, max_length=2_000, strict=True)

    @model_validator(mode="after")
    def validate_result_state(self) -> "UpdateTaskRequest":
        if self.status == "completed" and self.result is None:
            raise ValueError("completed task update requires a result")
        if self.status != "completed" and self.result is not None:
            raise ValueError("task result is only valid for a completed update")
        if self.error is not None and self.status not in {
            "failed",
            "cancelled",
            "interrupted",
        }:
            raise ValueError("task error is only valid for a failed terminal update")
        return self


class TaskProgressRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    task_id: str = Field(
        min_length=1,
        max_length=200,
        pattern=r"^[A-Za-z0-9_-]+$",
        strict=True,
    )
    step: int = Field(ge=0, le=100_000, strict=True)
    total_steps: int = Field(ge=1, le=100_000, strict=True)
    preview: str | None = Field(
        default=None,
        min_length=1,
        max_length=28 * _MIB,
        strict=True,
    )

    @field_validator("preview")
    @classmethod
    def validate_preview(cls, value: str | None) -> str | None:
        if value is None:
            return None
        try:
            return normalize_image_base64(value)
        except InvalidRequestError as exc:
            raise ValueError(exc.message) from exc

    @model_validator(mode="after")
    def validate_progress(self) -> "TaskProgressRequest":
        if self.step > self.total_steps:
            raise ValueError("step cannot exceed total_steps")
        return self


class BotTaskMutationResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    success: Literal[True] = True


async def _authorize_bot_adapter_job(task_id: str) -> tuple[BotGenerateTask, CloudJob]:
    """Resolve the legacy task-to-owner binding without exposing other jobs."""

    task = bot_auth_manager.get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    session = bot_auth_manager.get_session(task.session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    await _ensure_cloud_job_storage()
    try:
        job = await _cloud_jobs.get(task_id)
        if job is None:
            raise ResourceNotFoundError()
        principal = Principal.user(str(session.bot_user_id), _BOT_TASK_TENANT_ID)
        _task_access.policy.require_access(principal, job.resource)
    except (InvalidRequestError, ResourceNotFoundError) as exc:
        raise HTTPException(status_code=404, detail="任务不存在") from exc
    return task, job


@app.post(
    "/api/bot/task/update",
    response_model=BotTaskMutationResponse,
    dependencies=[Depends(_require_bot_secret)],
)
async def update_task(req: UpdateTaskRequest):
    """Commit one Bot state transition, then mirror its legacy action once."""

    _task, current = await _authorize_bot_adapter_job(req.task_id)
    encoded_result = req.result.image_base64 if req.result is not None else None
    try:
        # The compatibility Bot adapter only reports a successfully billable
        # provider boundary together with the completed result.  Failed terminal
        # updates therefore refund, while completed ones capture exactly once.
        if req.status == "completed" and not current.provider_attempted:
            current, _ = await _cloud_jobs.mark_provider_attempted(req.task_id)
        _job, event = await _persist_task_update(
            req.task_id,
            req.status,
            step=current.step,
            total_steps=current.total_steps,
            result=encoded_result,
            error=req.error,
            event_metadata={
                "adapter": "bot",
                "legacy_update_direct": True,
                "queue_position": req.queue_position,
            },
        )
    except ResourceNotFoundError as exc:
        raise HTTPException(status_code=404, detail="任务不存在") from exc
    except JobStateConflictError as exc:
        raise HTTPException(status_code=409, detail="任务状态冲突") from exc
    except InvalidRequestError as exc:
        raise HTTPException(status_code=422, detail=exc.message) from exc
    if event is not None:
        legacy_result = req.result.model_dump(by_alias=True) if req.result is not None else None
        await bot_auth_manager.update_task(
            req.task_id,
            req.status,
            legacy_result,
            req.queue_position,
            req.error,
        )
    if req.status in {"completed", "failed", "cancelled", "interrupted"}:
        await _settle_generation_quota(req.task_id)
    return BotTaskMutationResponse()


@app.post(
    "/api/bot/task/progress",
    response_model=BotTaskMutationResponse,
    dependencies=[Depends(_require_bot_secret)],
)
async def update_task_progress(req: TaskProgressRequest):
    """Persist Bot progress and mirror the existing preview action once."""

    task, _current = await _authorize_bot_adapter_job(req.task_id)
    try:
        _job, event = await _persist_task_update(
            req.task_id,
            "generating",
            step=req.step,
            total_steps=req.total_steps,
            result=None,
            error=None,
            event_metadata={"adapter": "bot", "legacy_progress_direct": True},
        )
    except ResourceNotFoundError as exc:
        raise HTTPException(status_code=404, detail="任务不存在") from exc
    except JobStateConflictError as exc:
        raise HTTPException(status_code=409, detail="任务状态冲突") from exc
    except InvalidRequestError as exc:
        raise HTTPException(status_code=422, detail=exc.message) from exc

    if event is not None:
        with bot_auth_manager._state_lock:
            ws = bot_auth_manager.session_websockets.get(task.session_id)
        if ws:
            try:
                await ws.send_json(
                    {
                        "action": "task_progress",
                        "task_id": req.task_id,
                        "step": req.step,
                        "total_steps": req.total_steps,
                        "preview": req.preview,
                    }
                )
            except Exception:
                pass
    return BotTaskMutationResponse()


@app.websocket("/ws/bot")
async def websocket_bot(websocket: WebSocket):
    """Bot task stream authenticated before accepting the socket.

    Browser WebSocket APIs cannot set ``Authorization``.  Carry the Bot session
    in a negotiated subprotocol instead of accepting an anonymous connection and
    trusting a later message to bind its identity.
    """
    offered = [
        value.strip()
        for value in websocket.headers.get("sec-websocket-protocol", "").split(",")
        if value.strip()
    ]
    session_protocols = [value for value in offered if value.startswith("bot-session.")]
    selected = session_protocols[0] if len(session_protocols) == 1 else ""
    session_id = selected.removeprefix("bot-session.") if selected else ""
    session = bot_auth_manager.get_session(session_id)
    if session is None:
        await websocket.close(code=4401, reason="authentication required")
        return

    await websocket.accept(subprotocol=selected)
    send_lock = asyncio.Lock()
    sender = _LockedWebSocketSender(websocket, send_lock)
    bot_auth_manager.session_websockets[session_id] = sender

    async def forward_event(task_id: str, event: Mapping[str, Any]) -> None:
        await sender.send_json({"type": "job_event", "event": dict(event)})
        event_data = event.get("data")
        if (
            event.get("kind") == "progress"
            and isinstance(event_data, dict)
            and not event_data.get("legacy_progress_direct")
        ):
            await sender.send_json(
                {
                    "action": "task_progress",
                    "task_id": task_id,
                    "step": int(event_data.get("step", 0) or 0),
                    "total_steps": int(event_data.get("total_steps", 0) or 0),
                }
            )
        if isinstance(event_data, dict) and event_data.get("legacy_update_direct"):
            return
        event_status = JobStatus(str(event.get("status", "")))
        update: dict[str, Any] = {
            "action": "task_update",
            "task_id": task_id,
            "status": _JOB_TO_LEGACY_STATUS[event_status],
            "sequence": int(event.get("sequence", 0) or 0),
            "step": int(event_data.get("step", 0) or 0) if isinstance(event_data, dict) else 0,
            "total_steps": (
                int(event_data.get("total_steps", 0) or 0)
                if isinstance(event_data, dict)
                else 0
            ),
            "queue_position": _get_task_queue_position(task_id)
            if event_status is JobStatus.QUEUED
            else 0,
        }
        if event_status in {
            JobStatus.SUCCEEDED,
            JobStatus.FAILED,
            JobStatus.CANCELLED,
            JobStatus.INTERRUPTED,
        }:
            terminal = await _cloud_jobs.get(task_id)
            if terminal is not None and terminal.status is event_status:
                terminal_payload = await _legacy_job_response(terminal)
                update["result"] = terminal_payload["result"]
                update["error"] = terminal_payload["error"]
        await sender.send_json(update)

    async def subscription_error(task_id: str) -> None:
        await sender.send_json(
            {
                "action": "subscription_error",
                "task_id": task_id,
                "error": "event_stream_unavailable",
            }
        )

    subscriptions = JobEventSubscriptionSet(
        _cloud_jobs,
        forward_event,
        on_error=subscription_error,
    )

    try:
        # Keep the established client contract: authentication is now performed
        # during the handshake, but the first application event still confirms it.
        await sender.send_json({
            "action": "session_bound",
            "success": True,
            "bot_user_id": session.bot_user_id,
        })
        while True:
            data = await websocket.receive_json()
            action = data.get("action")

            if action == "bind_session":
                # Identity is immutable for the lifetime of the connection.
                await websocket.close(code=4403, reason="session rebinding is not allowed")
                return

            elif action == "subscribe_task":
                # Missing and cross-owner tasks remain indistinguishable.
                task_id = data.get("task_id")
                after_sequence = data.get("after_sequence", 0)
                if (
                    not isinstance(after_sequence, int)
                    or isinstance(after_sequence, bool)
                    or after_sequence < 0
                ):
                    await sender.send_json(
                        {
                            "action": "subscribed",
                            "task_id": task_id,
                            "success": False,
                            "error": "invalid_request",
                        }
                    )
                    continue
                await _ensure_cloud_job_storage()
                try:
                    snapshot = (
                        await _cloud_jobs.snapshot_with_watermark(task_id)
                        if isinstance(task_id, str)
                        else None
                    )
                except InvalidRequestError:
                    snapshot = None
                try:
                    if snapshot is None:
                        raise ResourceNotFoundError()
                    job, sequence = snapshot
                    principal = _principal_from_bot_session(session_id)
                    _task_access.policy.require_access(principal, job.resource)
                except (ResourceNotFoundError, HTTPException):
                    await sender.send_json({
                        "action": "subscribed",
                        "task_id": task_id,
                        "success": False,
                        "error": "not_found",
                    })
                    continue

                await subscriptions.unsubscribe(task_id)

                await sender.send_json({
                    "type": "job_snapshot",
                    "sequence": sequence,
                    "job": job.to_dict(),
                })
                await sender.send_json({
                    "action": "task_update",
                    "sequence": sequence,
                    **(await _legacy_job_response(job)),
                })
                # This fresh snapshot covers all prior events and supersedes the
                # client cursor.  Never trust a cursor above the server watermark:
                # it would starve real future transitions indefinitely.
                cursor = sequence
                for event in await _cloud_jobs.list_events(
                    task_id,
                    after_sequence=cursor,
                ):
                    await forward_event(task_id, event.to_dict())
                    cursor = event.sequence
                await sender.send_json({
                    "action": "subscribed",
                    "task_id": task_id,
                    "success": True,
                })
                # Any transition committed after replay is durable and will be
                # observed from the final cursor when this watcher starts.
                await subscriptions.replace(task_id, after_sequence=cursor)

            elif action == "unsubscribe_task":
                task_id = data.get("task_id")
                removed = await subscriptions.unsubscribe(task_id) if isinstance(task_id, str) else False
                await sender.send_json(
                    {
                        "action": "unsubscribed",
                        "task_id": task_id,
                        "success": removed,
                    }
                )

            elif action == "heartbeat":
                await sender.send_json({"action": "heartbeat_ack"})

    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"Bot WebSocket error: {e}")
    finally:
        await subscriptions.close()
        if bot_auth_manager.session_websockets.get(session_id) is sender:
            bot_auth_manager.session_websockets.pop(session_id, None)


# ==================== 点数系统 ====================

# 全局点数缓存
_anlas_cache = {
    "anlas": 0,
    "updated_at": 0.0
}


class UpdateAnlasRequest(BaseModel):
    anlas: int


@app.post("/api/bot/anlas/update", dependencies=[Depends(_require_bot_secret)])
async def update_anlas(req: UpdateAnlasRequest):
    """更新点数（由Bot调用）"""
    _anlas_cache["anlas"] = req.anlas
    _anlas_cache["updated_at"] = time.time()
    return {"success": True}


async def fetch_novelai_anlas() -> int:
    """直接从 NovelAI API 获取点数，同时更新 TokenManager 中每个 Token 的点数"""
    tokens = get_novelai_tokens()
    if not tokens:
        return 0
    
    total_anlas = 0
    timeout = aiohttp.ClientTimeout(total=15, sock_connect=10, sock_read=10)
    connector = aiohttp.TCPConnector(enable_cleanup_closed=True, force_close=True)
    async with aiohttp.ClientSession(timeout=timeout, connector=connector) as session:
        for token in tokens:
            last_err = None
            for attempt in range(2):  # 最多重试1次
                try:
                    async with session.get(
                        "https://api.novelai.net/user/subscription",
                        headers={"Authorization": f"Bearer {token}"},
                    ) as resp:
                        if resp.status == 200:
                            data = await resp.json()
                            # trainingStepsLeft 是 Anlas 点数（免费 + 付费）
                            steps = data.get("trainingStepsLeft", {})
                            anlas = steps.get("fixedTrainingStepsLeft", 0) + steps.get("purchasedTrainingSteps", 0)
                            await token_manager.update_anlas(token, anlas)
                            total_anlas += anlas
                        else:
                            print(f"[Anlas] Token {hashlib.sha256(token.encode()).hexdigest()[:8]} 查询失败: HTTP {resp.status}")
                    last_err = None
                    break  # 成功，跳出重试循环
                except (aiohttp.ClientConnectionError, asyncio.TimeoutError) as e:
                    last_err = e
                    if attempt == 0:
                        await asyncio.sleep(1)  # 重试前等待1秒
                except Exception as e:
                    last_err = e
                    break  # 非网络错误不重试
            if last_err is not None:
                print(f"[Anlas] Token {hashlib.sha256(token.encode()).hexdigest()[:8]} 获取点数失败: {last_err}")
    
    return total_anlas


class GetAnlasResponse(BaseModel):
    anlas: int
    updated_at: float
    fresh: bool  # 数据是否新鲜（5分钟内更新）


@app.get("/api/anlas", response_model=GetAnlasResponse)
async def get_anlas():
    """获取点数（优先使用缓存，超过5分钟则重新获取）"""
    now = time.time()
    fresh = now - _anlas_cache["updated_at"] < 300
    
    # 如果缓存过期，尝试直接获取
    if not fresh:
        try:
            anlas = await fetch_novelai_anlas()
            if anlas > 0:
                _anlas_cache["anlas"] = anlas
                _anlas_cache["updated_at"] = now
                fresh = True
        except Exception:
            pass
    
    return GetAnlasResponse(
        anlas=_anlas_cache["anlas"],
        updated_at=_anlas_cache["updated_at"],
        fresh=fresh
    )


# ==================== 用户统计 ====================

import sys
import aiosqlite
from datetime import datetime, timedelta, timezone


async def _record_web_stats(bot_user_id: str, params: dict):
    """Web 端生成完成后，将 image_call 和 points_spent 写入统计数据库"""
    if not bot_user_id:
        return
    try:
        stats_key = f"user_{bot_user_id}"
        now = datetime.now(_BEIJING_TZ).replace(tzinfo=None).isoformat()

        async with aiosqlite.connect(str(_STATS_DB)) as db:
            # 记录一次 image_call
            await db.execute(
                "INSERT INTO calls(timestamp, stats_key, user_id, group_id, type) VALUES(?,?,?,?,?)",
                (now, stats_key, str(bot_user_id), None, "image_call"),
            )

            # 计算并记录 Anlas 点数消耗
            width = params.get("width", 832)
            height = params.get("height", 1216)
            steps = params.get("steps", 28)
            model = params.get("model", "nai-diffusion-4-5-full")
            img2img_strength = params.get("strength") if params.get("image") else None
            pr_count = len(params.get("director_reference_images", []) or [])
            anlas_cost = calculate_anlas_cost(width, height, steps, model, img2img_strength, pr_count)

            if anlas_cost > 0:
                reasons = []
                base_cost = anlas_cost - 5 * pr_count
                if base_cost > 0:
                    reasons.append(f"生图{width}x{height}_{steps}步={base_cost}")
                if pr_count > 0:
                    reasons.append(f"角色参考x{pr_count}={5 * pr_count}")
                reason = "web生图(" + ", ".join(reasons) + ")"

                await db.execute(
                    "INSERT INTO points_spent(timestamp, stats_key, user_id, group_id, points, reason) VALUES(?,?,?,?,?,?)",
                    (now, stats_key, str(bot_user_id), None, anlas_cost, reason),
                )

            await db.commit()
        print(f"[统计] Web生成统计已记录: user={bot_user_id}, anlas={anlas_cost}")
    except Exception as e:
        print(f"[统计] 记录Web生成统计失败: {e}")


async def _record_generation_duration(bot_user_id: str, duration_seconds: float):
    """记录一次生成的耗时"""
    if not bot_user_id or duration_seconds <= 0:
        return
    try:
        stats_key = f"user_{bot_user_id}"
        now = datetime.now(_BEIJING_TZ).replace(tzinfo=None).isoformat()
        async with aiosqlite.connect(str(_STATS_DB)) as db:
            await db.execute(
                "INSERT INTO generation_durations(timestamp, stats_key, user_id, duration_seconds) VALUES(?,?,?,?)",
                (now, stats_key, str(bot_user_id), round(duration_seconds, 2)),
            )
            await db.commit()
    except Exception as e:
        print(f"[统计] 记录生成耗时失败: {e}")


async def _record_web_stats_custom(bot_user_id: str, points: int, reason: str):
    """记录自定义点数消耗（vibe 编码、超分辨率等非生图操作）"""
    if not bot_user_id or points <= 0:
        return
    stats_key = f"user_{bot_user_id}"
    now = datetime.now(_BEIJING_TZ).replace(tzinfo=None).isoformat()

    # This recorder participates in the paid-operation success boundary.  A DB
    # failure must propagate so callers cannot report a successful, accounted
    # operation when no durable usage row exists.
    async with aiosqlite.connect(str(_STATS_DB)) as db:
        await db.execute(
            "INSERT INTO points_spent(timestamp, stats_key, user_id, group_id, points, reason) VALUES(?,?,?,?,?,?)",
            (now, stats_key, str(bot_user_id), None, points, f"web_{reason}"),
        )
        await db.commit()
    print(f"[统计] Web自定义统计已记录: user={bot_user_id}, points={points}, reason={reason}")


_paid_operations = PaidOperationService(_record_web_stats_custom)


_BEIJING_TZ = timezone(timedelta(hours=8))
_STATS_DB = BOT_DATA_DIR / "stats_data.db"
_workshop_quota = SQLiteWorkshopQuotaRepository(_STATS_DB)

# ---------- 27日结算周期工具函数 ----------
# 计费参数集中维护于 novelai_web_ui/server/config.py（BILLING_*）


def _billing_period(ref: "datetime | None" = None):
    """
    返回 ref 所处的计费周期 (start, end)，均为 naive datetime（北京时间）。
    周期：上月27日 00:00 ~ 本月27日 00:00
    """
    now = ref or datetime.now(_BEIJING_TZ).replace(tzinfo=None)
    d = BILLING_CYCLE_DAY
    if now.day >= d:
        start = now.replace(day=d, hour=0, minute=0, second=0, microsecond=0)
        # end: 下月27日
        if now.month == 12:
            end = now.replace(year=now.year + 1, month=1, day=d, hour=0, minute=0, second=0, microsecond=0)
        else:
            end = now.replace(month=now.month + 1, day=d, hour=0, minute=0, second=0, microsecond=0)
    else:
        # end: 本月27日
        end = now.replace(day=d, hour=0, minute=0, second=0, microsecond=0)
        # start: 上月27日
        if now.month == 1:
            start = now.replace(year=now.year - 1, month=12, day=d, hour=0, minute=0, second=0, microsecond=0)
        else:
            start = now.replace(month=now.month - 1, day=d, hour=0, minute=0, second=0, microsecond=0)
    return start, end


def _prev_billing_period(ref: "datetime | None" = None):
    """返回 ref 的上一个计费周期 (start, end)"""
    cur_start, _ = _billing_period(ref)
    # 上个周期的 end 就是本周期的 start
    # 用 start - 1天 去拿再上一个周期
    prev_ref = cur_start - timedelta(days=1)
    return _billing_period(prev_ref)


def _period_label(start: "datetime", end: "datetime") -> str:
    """返回周期显示标签，如 '02/27 - 03/27'"""
    return f"{start.month:02d}/{start.day:02d} - {end.month:02d}/{end.day:02d}"


def _stats_key(user_id: str) -> str:
    return f"user_{user_id}"


def _time_bounds(time_range: str):
    """计算时间范围边界（北京时间，naive datetime）"""
    now = datetime.now(_BEIJING_TZ).replace(tzinfo=None)
    if time_range == "today":
        s = now.replace(hour=0, minute=0, second=0, microsecond=0)
        e = s + timedelta(days=1)
    elif time_range == "week":
        dow = now.weekday()
        s = (now - timedelta(days=dow)).replace(hour=0, minute=0, second=0, microsecond=0)
        e = s + timedelta(days=7)
    elif time_range == "month":
        s = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        e = s.replace(month=s.month + 1) if s.month < 12 else s.replace(year=s.year + 1, month=1)
    else:
        return None, None
    return s, e


@app.get("/api/user/stats")
async def get_user_stats(session_id: str, time_range: str = "today"):
    """获取用户统计摘要"""
    session = bot_auth_manager.get_session(session_id)
    if not session:
        raise HTTPException(status_code=401, detail="会话无效")
    key = _stats_key(session.bot_user_id)
    s, e = _time_bounds(time_range)
    where_t = ""
    params_t: list = []
    if s and e:
        where_t = " AND timestamp >= ? AND timestamp < ?"
        params_t = [s.isoformat(), e.isoformat()]
    async with aiosqlite.connect(str(_STATS_DB)) as db:
        async with db.execute(f"SELECT COUNT(*) FROM calls WHERE type='ai_call' AND stats_key=?{where_t}", [key] + params_t) as cur:
            ai = (await cur.fetchone())[0]
        async with db.execute(f"SELECT COUNT(*) FROM calls WHERE type='image_call' AND stats_key=?{where_t}", [key] + params_t) as cur:
            img = (await cur.fetchone())[0]
        async with db.execute(f"SELECT COALESCE(SUM(points),0) FROM points_spent WHERE stats_key=?{where_t}", [key] + params_t) as cur:
            pts = (await cur.fetchone())[0]
    return {"ai_calls": ai, "image_calls": img, "points_spent": pts, "total_calls": ai + img}


@app.get("/api/user/stats/daily")
async def get_user_stats_daily(session_id: str, time_range: str = "week"):
    """按天聚合统计（柱状图），今日按3小时分割"""
    session = bot_auth_manager.get_session(session_id)
    if not session:
        raise HTTPException(status_code=401, detail="会话无效")
    key = _stats_key(session.bot_user_id)
    s, e = _time_bounds(time_range)
    where = " AND stats_key=?"
    params: list = [key]
    if s and e:
        where += " AND timestamp >= ? AND timestamp < ?"
        params += [s.isoformat(), e.isoformat()]
    
    async with aiosqlite.connect(str(_STATS_DB)) as db:
        if time_range == "today":
            # 今日按3小时分割
            time_slots = []
            for hour in range(0, 24, 3):
                slot_start = s.replace(hour=hour)
                slot_end = s.replace(hour=hour + 3) if hour + 3 < 24 else e
                time_slots.append((f"{hour:02d}:00", slot_start.isoformat(), slot_end.isoformat()))
            
            ai_by_slot = {}
            img_by_slot = {}
            pts_by_slot = {}
            
            for slot_label, slot_s, slot_e in time_slots:
                slot_params = [key, slot_s, slot_e]
                async with db.execute("SELECT COUNT(*) FROM calls WHERE type='ai_call' AND stats_key=? AND timestamp >= ? AND timestamp < ?", slot_params) as cur:
                    ai_by_slot[slot_label] = (await cur.fetchone())[0]
                async with db.execute("SELECT COUNT(*) FROM calls WHERE type='image_call' AND stats_key=? AND timestamp >= ? AND timestamp < ?", slot_params) as cur:
                    img_by_slot[slot_label] = (await cur.fetchone())[0]
                async with db.execute("SELECT COALESCE(SUM(points),0) FROM points_spent WHERE stats_key=? AND timestamp >= ? AND timestamp < ?", slot_params) as cur:
                    pts_by_slot[slot_label] = (await cur.fetchone())[0]
            
            data = [{"date": slot, "ai_calls": ai_by_slot.get(slot, 0), "image_calls": img_by_slot.get(slot, 0), "points_spent": pts_by_slot.get(slot, 0)} for slot, _, _ in time_slots]
        else:
            # 其他时间范围按天聚合
            async with db.execute(f"SELECT DATE(timestamp) as d, COUNT(*) FROM calls WHERE type='ai_call'{where} GROUP BY d ORDER BY d", params) as cur:
                ai_by_day = {r[0]: r[1] async for r in cur}
            async with db.execute(f"SELECT DATE(timestamp) as d, COUNT(*) FROM calls WHERE type='image_call'{where} GROUP BY d ORDER BY d", params) as cur:
                img_by_day = {r[0]: r[1] async for r in cur}
            async with db.execute(f"SELECT DATE(timestamp) as d, COALESCE(SUM(points),0) FROM points_spent WHERE 1=1{where} GROUP BY d ORDER BY d", params) as cur:
                pts_by_day = {r[0]: r[1] async for r in cur}
            all_days = sorted(set(list(ai_by_day) + list(img_by_day) + list(pts_by_day)))
            data = [{"date": d, "ai_calls": ai_by_day.get(d, 0), "image_calls": img_by_day.get(d, 0), "points_spent": pts_by_day.get(d, 0)} for d in all_days]
    
    return {"data": data, "time_range": time_range}


@app.get("/api/user/stats/points")
async def get_user_stats_points(session_id: str, time_range: str = "month"):
    """点数消耗明细"""
    session = bot_auth_manager.get_session(session_id)
    if not session:
        raise HTTPException(status_code=401, detail="会话无效")
    key = _stats_key(session.bot_user_id)
    s, e = _time_bounds(time_range)
    where = " AND stats_key=?"
    params: list = [key]
    if s and e:
        where += " AND timestamp >= ? AND timestamp < ?"
        params += [s.isoformat(), e.isoformat()]
    async with aiosqlite.connect(str(_STATS_DB)) as db:
        async with db.execute(f"SELECT timestamp, points, reason FROM points_spent WHERE 1=1{where} ORDER BY timestamp DESC LIMIT 50", params) as cur:
            records = [{"timestamp": r[0], "points": r[1], "reason": r[2] or ""} async for r in cur]
    return {"records": records, "time_range": time_range}


# ==================== 全平台统计 API ====================

@app.get("/api/platform/stats", dependencies=[Depends(_require_session)])
async def get_platform_stats(time_range: str = "today"):
    """全平台统计摘要（不限用户）"""
    s, e = _time_bounds(time_range)
    where_t = ""
    params_t: list = []
    if s and e:
        where_t = " AND timestamp >= ? AND timestamp < ?"
        params_t = [s.isoformat(), e.isoformat()]
    async with aiosqlite.connect(str(_STATS_DB)) as db:
        async with db.execute(f"SELECT COUNT(*) FROM calls WHERE type='ai_call'{where_t}", params_t) as cur:
            ai = (await cur.fetchone())[0]
        async with db.execute(f"SELECT COUNT(*) FROM calls WHERE type='image_call'{where_t}", params_t) as cur:
            img = (await cur.fetchone())[0]
        async with db.execute(f"SELECT COALESCE(SUM(points),0) FROM points_spent WHERE 1=1{where_t}", params_t) as cur:
            pts = (await cur.fetchone())[0]
        async with db.execute(f"SELECT COUNT(DISTINCT stats_key) FROM calls WHERE 1=1{where_t}", params_t) as cur:
            users = (await cur.fetchone())[0]
    return {"ai_calls": ai, "image_calls": img, "points_spent": pts, "total_calls": ai + img, "active_users": users}


@app.get("/api/platform/stats/daily", dependencies=[Depends(_require_session)])
async def get_platform_stats_daily(time_range: str = "week"):
    """全平台按天聚合统计，today 按3小时分割"""
    s, e = _time_bounds(time_range)
    where = ""
    params: list = []
    if s and e:
        where = " AND timestamp >= ? AND timestamp < ?"
        params = [s.isoformat(), e.isoformat()]

    async with aiosqlite.connect(str(_STATS_DB)) as db:
        if time_range == "today":
            time_slots = []
            for hour in range(0, 24, 3):
                slot_start = s.replace(hour=hour)
                slot_end = s.replace(hour=hour + 3) if hour + 3 < 24 else e
                time_slots.append((f"{hour:02d}:00", slot_start.isoformat(), slot_end.isoformat()))

            data = []
            for slot_label, slot_s, slot_e in time_slots:
                sp = [slot_s, slot_e]
                async with db.execute("SELECT COUNT(*) FROM calls WHERE type='ai_call' AND timestamp >= ? AND timestamp < ?", sp) as cur:
                    ai = (await cur.fetchone())[0]
                async with db.execute("SELECT COUNT(*) FROM calls WHERE type='image_call' AND timestamp >= ? AND timestamp < ?", sp) as cur:
                    img = (await cur.fetchone())[0]
                async with db.execute("SELECT COALESCE(SUM(points),0) FROM points_spent WHERE timestamp >= ? AND timestamp < ?", sp) as cur:
                    pts = (await cur.fetchone())[0]
                data.append({"date": slot_label, "ai_calls": ai, "image_calls": img, "points_spent": pts})
        else:
            async with db.execute(f"SELECT DATE(timestamp) as d, COUNT(*) FROM calls WHERE type='ai_call'{where} GROUP BY d ORDER BY d", params) as cur:
                ai_by_day = {r[0]: r[1] async for r in cur}
            async with db.execute(f"SELECT DATE(timestamp) as d, COUNT(*) FROM calls WHERE type='image_call'{where} GROUP BY d ORDER BY d", params) as cur:
                img_by_day = {r[0]: r[1] async for r in cur}
            async with db.execute(f"SELECT DATE(timestamp) as d, COALESCE(SUM(points),0) FROM points_spent WHERE 1=1{where} GROUP BY d ORDER BY d", params) as cur:
                pts_by_day = {r[0]: r[1] async for r in cur}
            all_days = sorted(set(list(ai_by_day) + list(img_by_day) + list(pts_by_day)))
            data = [{"date": d, "ai_calls": ai_by_day.get(d, 0), "image_calls": img_by_day.get(d, 0), "points_spent": pts_by_day.get(d, 0)} for d in all_days]

    return {"data": data, "time_range": time_range}


@app.get("/api/platform/stats/all", dependencies=[Depends(_require_session)])
async def get_platform_stats_all():
    """全平台历史全量统计"""
    async with aiosqlite.connect(str(_STATS_DB)) as db:
        async with db.execute("SELECT COUNT(*) FROM calls WHERE type='ai_call'") as cur:
            ai = (await cur.fetchone())[0]
        async with db.execute("SELECT COUNT(*) FROM calls WHERE type='image_call'") as cur:
            img = (await cur.fetchone())[0]
        async with db.execute("SELECT COALESCE(SUM(points),0) FROM points_spent") as cur:
            pts = (await cur.fetchone())[0]
        async with db.execute("SELECT COUNT(DISTINCT stats_key) FROM calls") as cur:
            users = (await cur.fetchone())[0]
        # 最早和最晚记录
        async with db.execute("SELECT MIN(timestamp), MAX(timestamp) FROM calls") as cur:
            row = await cur.fetchone()
            first_ts, last_ts = row[0], row[1]
    return {
        "ai_calls": ai, "image_calls": img, "points_spent": pts,
        "total_calls": ai + img, "total_users": users,
        "first_record": first_ts, "last_record": last_ts,
    }


@app.get("/api/platform/stats/hourly-heatmap", dependencies=[Depends(_require_session)])
async def get_platform_hourly_heatmap(days: int = 30):
    """全平台按小时聚合负载热力图，仅统计最近 N 天（默认 30 天）"""
    cutoff = (datetime.now() - timedelta(days=days)).isoformat()
    async with aiosqlite.connect(str(_STATS_DB)) as db:
        # 按小时聚合 image_call 次数（仅最近 N 天）
        async with db.execute("""
            SELECT CAST(STRFTIME('%H', timestamp) AS INTEGER) AS hour,
                   COUNT(*) AS cnt
            FROM calls WHERE type='image_call' AND timestamp >= ?
            GROUP BY hour ORDER BY hour
        """, (cutoff,)) as cur:
            calls_by_hour = {r[0]: r[1] async for r in cur}
        # 实际覆盖天数（最近 N 天内有记录的天数）
        async with db.execute(
            "SELECT COUNT(DISTINCT DATE(timestamp)) FROM calls WHERE timestamp >= ?",
            (cutoff,)
        ) as cur:
            total_days = max((await cur.fetchone())[0], 1)

    heatmap = []
    for h in range(24):
        total = calls_by_hour.get(h, 0)
        heatmap.append({
            "hour": h,
            "label": f"{h:02d}:00",
            "total_calls": total,
            "avg_calls": round(total / total_days, 1),
        })
    return {"heatmap": heatmap, "total_days": total_days, "days_range": days}


@app.get("/api/platform/stats/hourly-duration", dependencies=[Depends(_require_session)])
async def get_platform_hourly_duration(days: int = 30):
    """全平台按小时聚合平均生成耗时热力图"""
    cutoff = (datetime.now() - timedelta(days=days)).isoformat()
    async with aiosqlite.connect(str(_STATS_DB)) as db:
        async with db.execute("""
            SELECT CAST(STRFTIME('%H', timestamp) AS INTEGER) AS hour,
                   AVG(duration_seconds) AS avg_dur,
                   COUNT(*) AS cnt
            FROM generation_durations WHERE timestamp >= ?
            GROUP BY hour ORDER BY hour
        """, (cutoff,)) as cur:
            dur_by_hour = {r[0]: {"avg_duration": round(r[1], 1), "count": r[2]} async for r in cur}
        async with db.execute(
            "SELECT COUNT(DISTINCT DATE(timestamp)) FROM generation_durations WHERE timestamp >= ?",
            (cutoff,)
        ) as cur:
            total_days = max((await cur.fetchone())[0], 1)

    heatmap = []
    for h in range(24):
        info = dur_by_hour.get(h, {"avg_duration": 0, "count": 0})
        heatmap.append({
            "hour": h,
            "label": f"{h:02d}:00",
            "avg_duration": info["avg_duration"],
            "count": info["count"],
        })
    return {"heatmap": heatmap, "total_days": total_days, "days_range": days}


@app.get("/api/platform/stats/hourly-users", dependencies=[Depends(_require_session)])
async def get_platform_hourly_users(days: int = 30):
    """全平台按小时聚合活跃用户热力图，统计每小时去重用户数"""
    cutoff = (datetime.now() - timedelta(days=days)).isoformat()
    async with aiosqlite.connect(str(_STATS_DB)) as db:
        # 按小时聚合去重用户数（仅最近 N 天）
        async with db.execute("""
            SELECT CAST(STRFTIME('%H', timestamp) AS INTEGER) AS hour,
                   COUNT(DISTINCT stats_key) AS user_cnt
            FROM calls WHERE timestamp >= ?
            GROUP BY hour ORDER BY hour
        """, (cutoff,)) as cur:
            users_by_hour = {r[0]: r[1] async for r in cur}
        # 实际覆盖天数
        async with db.execute(
            "SELECT COUNT(DISTINCT DATE(timestamp)) FROM calls WHERE timestamp >= ?",
            (cutoff,)
        ) as cur:
            total_days = max((await cur.fetchone())[0], 1)

    heatmap = []
    for h in range(24):
        total = users_by_hour.get(h, 0)
        heatmap.append({
            "hour": h,
            "label": f"{h:02d}:00",
            "total_users": total,
            "avg_users": round(total / total_days, 1),
        })
    return {"heatmap": heatmap, "total_days": total_days, "days_range": days}


# ==================== 计费分摊系统 ====================
# 计费参数集中维护于 novelai_web_ui/server/config.py（BILLING_*）


def _compute_billing(user_data: list[dict], *,
                     total_cost_override: float | None = None,
                     anlas_threshold_override: int | None = None) -> dict:
    """
    核心分摊算法。
    user_data: [{"user_id": str, "image_calls": int, "anlas_used": int}, ...]
    total_cost_override: 覆盖总金额（默认使用 BILLING_TOTAL_COST）
    anlas_threshold_override: 覆盖 Anlas 附加费阈值（默认使用 BILLING_ANLAS_THRESHOLD）
    返回完整的计费结果，包含阶梯边界、每用户费用等。
    """
    def _percentile(sorted_data: list, pct: float) -> float:
        """纯 Python 百分位计算（线性插值，与 numpy 默认行为一致）"""
        if not sorted_data:
            return 0.0
        k = (len(sorted_data) - 1) * (pct / 100.0)
        f = int(k)
        c = f + 1
        if c >= len(sorted_data):
            return float(sorted_data[f])
        d = k - f
        return float(sorted_data[f]) + d * (sorted_data[c] - sorted_data[f])

    total_cost = total_cost_override if total_cost_override is not None else BILLING_TOTAL_COST
    anlas_threshold = anlas_threshold_override if anlas_threshold_override is not None else BILLING_ANLAS_THRESHOLD
    free_threshold = BILLING_FREE_THRESHOLD

    # 仅统计有生图记录的用户
    active_users = [u for u in user_data if u["image_calls"] > 0]
    if not active_users:
        return {
            "tiers": {"free": free_threshold, "t1": 0, "t2": 0},
            "tier_weights": BILLING_TIER_WEIGHTS,
            "total_cost": total_cost,
            "free_threshold": free_threshold,
            "anlas_total_surcharge": 0,
            "image_pool": total_cost,
            "users": [],
            "active_user_count": 0,
            "total_image_calls": 0,
            "total_anlas": 0,
        }

    # --- Step 1: 计算 Anlas 附加费 ---
    for u in active_users:
        u["anlas_fee"] = BILLING_ANLAS_SURCHARGE if u["anlas_used"] > anlas_threshold else 0.0
    anlas_total_surcharge = sum(u["anlas_fee"] for u in active_users)

    # --- Step 2: 生图分摊池 ---
    image_pool = max(total_cost - anlas_total_surcharge, 0)

    # --- Step 3: 固定免费线 + 付费用户内百分位分阶 ---
    # 先按固定阈值分出免费用户
    for u in active_users:
        if u["image_calls"] <= free_threshold:
            u["tier"] = 0
            u["tier_name"] = "免费"
            u["weight"] = BILLING_TIER_WEIGHTS[0]

    # 筛出超过免费阈值的付费用户
    above_free = [u for u in active_users if u["image_calls"] > free_threshold]

    if not above_free:
        # 所有人都在免费线以下，无人付费
        paying_users = []
        t1_bound = 0
        t2_bound = 0
        for u in active_users:
            u["image_fee"] = 0
    elif len(above_free) <= 2:
        # 付费用户太少，均摊
        t1_bound = 0
        t2_bound = 0
        for u in above_free:
            u["tier"] = 1
            u["tier_name"] = "均摊"
            u["weight"] = 1
        paying_users = above_free
        weight_sum = len(paying_users)
        for u in paying_users:
            u["image_fee"] = round(image_pool / weight_sum)
        # 免费用户费用为0
        for u in active_users:
            if u["image_calls"] <= free_threshold:
                u["image_fee"] = 0
    else:
        # 在付费用户中按 P50/P80 分阶梯
        paid_counts = sorted([u["image_calls"] for u in above_free])
        t1_bound = _percentile(paid_counts, 50)  # 付费用户内中位数
        t2_bound = _percentile(paid_counts, 80)  # 付费用户内 P80

        for u in above_free:
            ic = u["image_calls"]
            if ic <= t1_bound:
                u["tier"] = 1
                u["tier_name"] = "一阶"
                u["weight"] = BILLING_TIER_WEIGHTS[1]
            elif ic <= t2_bound:
                u["tier"] = 2
                u["tier_name"] = "二阶"
                u["weight"] = BILLING_TIER_WEIGHTS[2]
            else:
                u["tier"] = 3
                u["tier_name"] = "三阶"
                u["weight"] = BILLING_TIER_WEIGHTS[3]

        paying_users = above_free
        weight_sum = sum(u["weight"] for u in paying_users)

        for u in active_users:
            if u.get("weight", 0) > 0 and weight_sum > 0:
                u["image_fee"] = round((u["weight"] / weight_sum) * image_pool)
            else:
                u["image_fee"] = 0

    # --- Step 4: 计算总费用（取整到元）---
    for u in active_users:
        u["total_fee"] = round(u["image_fee"] + u["anlas_fee"])

    # 取整后实际总额（不强制凑360，避免不公平地把差额加给单个用户）
    actual_total = sum(u["total_fee"] for u in active_users)

    # 统计阶梯分布
    tier_distribution = {}
    for u in active_users:
        tn = u["tier_name"]
        if tn not in tier_distribution:
            tier_distribution[tn] = {"count": 0, "total_images": 0, "total_fee": 0}
        tier_distribution[tn]["count"] += 1
        tier_distribution[tn]["total_images"] += u["image_calls"]
        tier_distribution[tn]["total_fee"] = tier_distribution[tn]["total_fee"] + u["total_fee"]

    return {
        "tiers": {
            "free": free_threshold,
            "t1": round(t1_bound) if above_free else 0,
            "t2": round(t2_bound) if above_free else 0,
        },
        "tier_weights": BILLING_TIER_WEIGHTS,
        "total_cost": total_cost,
        "actual_total": actual_total,
        "free_threshold": free_threshold,
        "anlas_threshold": anlas_threshold,
        "anlas_surcharge": BILLING_ANLAS_SURCHARGE,
        "anlas_total_surcharge": anlas_total_surcharge,
        "image_pool": round(image_pool),
        "users": sorted(active_users, key=lambda u: u["image_calls"], reverse=True),
        "tier_distribution": tier_distribution,
        "active_user_count": len(active_users),
        "total_image_calls": sum(u["image_calls"] for u in active_users),
        "total_anlas": sum(u["anlas_used"] for u in active_users),
    }


async def _fetch_period_user_data(start: "datetime", end: "datetime") -> list[dict]:
    """从数据库获取指定时间范围内所有用户的生图数和Anlas消耗"""
    s_iso = start.isoformat()
    e_iso = end.isoformat()

    async with aiosqlite.connect(str(_STATS_DB)) as db:
        # 按 user_id 统计 image_call 次数
        async with db.execute("""
            SELECT user_id, COUNT(*) FROM calls
            WHERE type='image_call' AND timestamp >= ? AND timestamp < ?
            GROUP BY user_id
        """, (s_iso, e_iso)) as cur:
            img_by_user = {r[0]: r[1] async for r in cur}

        # 按 user_id 统计 Anlas 消耗
        async with db.execute("""
            SELECT user_id, COALESCE(SUM(points), 0) FROM points_spent
            WHERE timestamp >= ? AND timestamp < ?
            GROUP BY user_id
        """, (s_iso, e_iso)) as cur:
            anlas_by_user = {r[0]: r[1] async for r in cur}

        # 获取昵称映射
        async with db.execute("SELECT user_id, nickname FROM user_names") as cur:
            name_map = {r[0]: r[1] async for r in cur}

    all_users = set(img_by_user.keys()) | set(anlas_by_user.keys())
    user_data = []
    for uid in all_users:
        user_data.append({
            "user_id": uid,
            "nickname": name_map.get(uid, uid),
            "image_calls": img_by_user.get(uid, 0),
            "anlas_used": anlas_by_user.get(uid, 0),
        })
    return user_data


async def _fetch_month_user_data(year: int, month: int) -> list[dict]:
    """兼容旧接口：按自然月获取数据（内部转为时间范围查询）"""
    month_start = datetime(year, month, 1)
    if month == 12:
        month_end = datetime(year + 1, 1, 1)
    else:
        month_end = datetime(year, month + 1, 1)
    return await _fetch_period_user_data(month_start, month_end)


@app.get("/api/billing/report", dependencies=[Depends(_require_admin)])
async def get_billing_report(year: int = 0, month: int = 0,
                             period_start: str = "", period_end: str = "",
                             total_cost: float = 0, anlas_threshold: int = -1):
    """获取指定计费周期的完整报告。
    优先使用 period_start/period_end，否则按 year/month，否则默认上个27日周期。
    total_cost: 自定义总金额（0 = 使用默认值 180）
    anlas_threshold: 自定义 Anlas 附加费阈值（-1 = 使用默认值 2000）
    """
    now = datetime.now(_BEIJING_TZ).replace(tzinfo=None)
    if period_start and period_end:
        start = datetime.fromisoformat(period_start)
        end = datetime.fromisoformat(period_end)
    elif year > 0 and month > 0:
        # 兼容: year/month 指定时，取该月27日开始的周期
        start = datetime(year, month, BILLING_CYCLE_DAY)
        if month == 12:
            end = datetime(year + 1, 1, BILLING_CYCLE_DAY)
        else:
            end = datetime(year, month + 1, BILLING_CYCLE_DAY)
    else:
        start, end = _prev_billing_period(now)

    user_data = await _fetch_period_user_data(start, end)
    overrides = {}
    if total_cost > 0:
        overrides["total_cost_override"] = total_cost
    if anlas_threshold >= 0:
        overrides["anlas_threshold_override"] = anlas_threshold
    result = _compute_billing(user_data, **overrides)
    result["billing_month"] = _period_label(start, end)
    result["period_start"] = start.isoformat()
    result["period_end"] = end.isoformat()
    return result


@app.get("/api/billing/user")
async def get_billing_user(user_id: str = "", year: int = 0, month: int = 0,
                           session_id: str = "", x_admin_token: str = Header(default="")):
    """查询用户在指定计费周期的费用（默认上个27日周期）。普通用户仅限本人，管理员可查任意 user_id。"""
    user_id = _resolve_billing_target(session_id, user_id, x_admin_token)
    now = datetime.now(_BEIJING_TZ).replace(tzinfo=None)
    if year == 0 or month == 0:
        start, end = _prev_billing_period(now)
    else:
        start = datetime(year, month, BILLING_CYCLE_DAY)
        if month == 12:
            end = datetime(year + 1, 1, BILLING_CYCLE_DAY)
        else:
            end = datetime(year, month + 1, BILLING_CYCLE_DAY)

    user_data = await _fetch_period_user_data(start, end)
    result = _compute_billing(user_data)

    # 查找目标用户
    target = None
    for u in result["users"]:
        if u["user_id"] == user_id:
            target = u
            break

    if not target:
        # 用户在该月无记录
        target = {
            "user_id": user_id,
            "nickname": user_id,
            "image_calls": 0,
            "anlas_used": 0,
            "tier": 0,
            "tier_name": "免费",
            "weight": 0,
            "image_fee": 0,
            "anlas_fee": 0,
            "total_fee": 0,
        }

    # 计算排名
    rank = 0
    for i, u in enumerate(result["users"]):
        if u["user_id"] == user_id:
            rank = i + 1
            break

    return {
        "billing_month": _period_label(start, end),
        "period_start": start.isoformat(),
        "period_end": end.isoformat(),
        "user": target,
        "rank": rank,
        "tiers": result["tiers"],
        "tier_weights": result["tier_weights"],
        "total_cost": result["total_cost"],
        "active_user_count": result["active_user_count"],
        "total_image_calls": result["total_image_calls"],
    }


@app.get("/api/billing/user/details")
async def get_billing_user_details(user_id: str = "", year: int = 0, month: int = 0,
                                    period_start: str = "", period_end: str = "",
                                    period: str = "prev",
                                    session_id: str = "", x_admin_token: str = Header(default="")):
    """获取用户在指定计费周期的使用详情。普通用户仅限本人，管理员可查任意 user_id。
    优先使用 period_start/period_end，否则按 year/month，否则按 period='current'|'prev'。
    """
    user_id = _resolve_billing_target(session_id, user_id, x_admin_token)
    now = datetime.now(_BEIJING_TZ).replace(tzinfo=None)
    if period_start and period_end:
        start = datetime.fromisoformat(period_start)
        end = datetime.fromisoformat(period_end)
    elif year > 0 and month > 0:
        start = datetime(year, month, BILLING_CYCLE_DAY)
        if month == 12:
            end = datetime(year + 1, 1, BILLING_CYCLE_DAY)
        else:
            end = datetime(year, month + 1, BILLING_CYCLE_DAY)
    elif period == "current":
        start, end = _billing_period(now)
    else:
        start, end = _prev_billing_period(now)

    s_iso = start.isoformat()
    e_iso = end.isoformat()
    stats_key = f"user_{user_id}"

    async with aiosqlite.connect(str(_STATS_DB)) as db:
        # 1. 每日 image_call 次数
        async with db.execute("""
            SELECT DATE(timestamp) as d, COUNT(*) FROM calls
            WHERE type='image_call' AND user_id=? AND timestamp >= ? AND timestamp < ?
            GROUP BY d ORDER BY d
        """, (str(user_id), s_iso, e_iso)) as cur:
            img_by_day = {r[0]: r[1] async for r in cur}

        # 2. 每日 points_spent
        async with db.execute("""
            SELECT DATE(timestamp) as d, COALESCE(SUM(points), 0) FROM points_spent
            WHERE user_id=? AND timestamp >= ? AND timestamp < ?
            GROUP BY d ORDER BY d
        """, (str(user_id), s_iso, e_iso)) as cur:
            pts_by_day = {r[0]: r[1] async for r in cur}

        # 3. 按 reason 分组统计消耗
        async with db.execute("""
            SELECT reason, COALESCE(SUM(points), 0), COUNT(*) FROM points_spent
            WHERE user_id=? AND timestamp >= ? AND timestamp < ?
            GROUP BY reason ORDER BY SUM(points) DESC
        """, (str(user_id), s_iso, e_iso)) as cur:
            type_breakdown = [
                {"reason": r[0] or "未知", "total_points": r[1], "count": r[2]}
                async for r in cur
            ]

        # 4. 最近 50 条 points_spent 明细
        async with db.execute("""
            SELECT timestamp, points, reason FROM points_spent
            WHERE user_id=? AND timestamp >= ? AND timestamp < ?
            ORDER BY timestamp DESC LIMIT 50
        """, (str(user_id), s_iso, e_iso)) as cur:
            recent_records = [
                {"timestamp": r[0], "points": r[1], "reason": r[2] or ""}
                async for r in cur
            ]

    # 合并每日数据
    all_days = sorted(set(list(img_by_day.keys()) + list(pts_by_day.keys())))
    daily_data = [
        {
            "date": d,
            "image_calls": img_by_day.get(d, 0),
            "points_spent": pts_by_day.get(d, 0),
        }
        for d in all_days
    ]

    return {
        "user_id": user_id,
        "billing_month": _period_label(start, end),
        "period_start": start.isoformat(),
        "period_end": end.isoformat(),
        "daily_data": daily_data,
        "type_breakdown": type_breakdown,
        "recent_records": recent_records,
        "total_image_calls": sum(img_by_day.values()),
        "total_points": sum(pts_by_day.values()),
    }


@app.get("/api/billing/estimate")
async def get_billing_estimate(session_id: str = ""):
    """实时预估当前27日周期费用（基于周期进度或生图量切换策略）"""
    now = datetime.now(_BEIJING_TZ).replace(tzinfo=None)
    cur_start, cur_end = _billing_period(now)
    user_data = await _fetch_period_user_data(cur_start, cur_end)
    total_images = sum(u["image_calls"] for u in user_data)

    # 计算周期已过天数
    days_elapsed = (now - cur_start).days

    # 策略：周期过半（≥15天）或总生图大于10000，使用实时计价
    if days_elapsed >= 15 or total_images >= 10000:
        result = _compute_billing(user_data)
        result["estimate_mode"] = "realtime"
    else:
        # 早鸟策略：使用上周期基准
        prev_start, prev_end = _prev_billing_period(now)
        lm_data = await _fetch_period_user_data(prev_start, prev_end)
        lm_result = _compute_billing(lm_data)

        lm_tiers = lm_result["tiers"]
        tier_fee = {}
        for tn, td in lm_result["tier_distribution"].items():
            tier_fee[tn] = round(td["total_fee"] / td["count"]) if td["count"] > 0 else 0

        result: dict = {
            "tiers": lm_tiers,
            "tier_weights": lm_result["tier_weights"],
            "total_cost": BILLING_TOTAL_COST,
            "actual_total": 0,
            "free_threshold": BILLING_FREE_THRESHOLD,
            "anlas_threshold": BILLING_ANLAS_THRESHOLD,
            "anlas_surcharge": BILLING_ANLAS_SURCHARGE,
            "anlas_total_surcharge": 0,
            "image_pool": 0,
            "users": [],
            "tier_distribution": lm_result["tier_distribution"],
            "active_user_count": len(user_data),
            "total_image_calls": total_images,
            "total_anlas": sum(u["anlas_used"] for u in user_data),
            "estimate_mode": "early"
        }

        for u in user_data:
            ic = u["image_calls"]
            if ic <= BILLING_FREE_THRESHOLD:
                t = 0
                tn = "免费"
            elif ic <= lm_tiers["t1"]:
                t = 1
                tn = "一阶"
            elif ic <= lm_tiers["t2"]:
                t = 2
                tn = "二阶"
            else:
                t = 3
                tn = "三阶"

            anlas_used = u["anlas_used"]
            anlas_fee = BILLING_ANLAS_SURCHARGE if anlas_used > BILLING_ANLAS_THRESHOLD else 0
            image_fee = tier_fee.get(tn, 0)

            result["users"].append({
                "user_id": u["user_id"],
                "nickname": u["nickname"],
                "image_calls": ic,
                "anlas_used": anlas_used,
                "tier": t,
                "tier_name": tn,
                "weight": lm_result["tier_weights"][t],
                "image_fee": float(image_fee),
                "anlas_fee": float(anlas_fee),
                "total_fee": float(image_fee + anlas_fee)
            })

        result["users"].sort(key=lambda x: x["image_calls"], reverse=True)
        result["actual_total"] = sum(x["total_fee"] for x in result["users"])

    result["billing_month"] = _period_label(cur_start, cur_end)
    result["period_start"] = cur_start.isoformat()
    result["period_end"] = cur_end.isoformat()
    result["is_estimate"] = True
    result["estimate_time"] = now.isoformat()

    # 如果有 session_id，定位当前用户
    current_user = None
    if session_id:
        session = bot_auth_manager.get_session(session_id)
        if session:
            for u in result["users"]:
                if u["user_id"] == session.bot_user_id:
                    current_user = u
                    break
    result["current_user"] = current_user
    return result



# ==================== 结算弹窗系统 ====================

_BILLING_PAYMENTS_DB = BOT_DATA_DIR / "stats_data.db"


async def _ensure_billing_payments_table():
    """确保 billing_payments 表存在"""
    async with aiosqlite.connect(str(_BILLING_PAYMENTS_DB)) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS billing_payments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL,
                period_start TEXT NOT NULL,
                period_end TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'unpaid',
                dismissed INTEGER NOT NULL DEFAULT 0,
                marked_at TEXT,
                UNIQUE(user_id, period_start)
            )
        """)
        await db.commit()


@app.get("/api/billing/settlement")
async def get_latest_settlement(session_id: str = ""):
    """获取上个周期的结算信息 + 当前用户的支付/弹窗状态"""
    if not session_id:
        raise HTTPException(status_code=400, detail="需要 session_id")
    session = bot_auth_manager.get_session(session_id)
    if not session:
        raise HTTPException(status_code=401, detail="会话无效")

    await _ensure_billing_payments_table()
    now = datetime.now(_BEIJING_TZ).replace(tzinfo=None)
    prev_start, prev_end = _prev_billing_period(now)

    # 获取上周期的计费报告
    user_data = await _fetch_period_user_data(prev_start, prev_end)
    report = _compute_billing(user_data)
    report["billing_month"] = _period_label(prev_start, prev_end)
    report["period_start"] = prev_start.isoformat()
    report["period_end"] = prev_end.isoformat()

    # 查找当前用户
    bot_user_id = session.bot_user_id
    current_user = None
    for u in report["users"]:
        if u["user_id"] == bot_user_id:
            current_user = u
            break
    report["current_user"] = current_user
    # 结算弹窗是"每用户"视图：不向普通用户泄露全站用户明细列表，只保留本人行。
    # 管理员需要全站数据请走已鉴权的 /api/billing/report。
    report["users"] = [current_user] if current_user else []

    # 查支付状态：以"自最近一次结算日（= 当前周期起点 = prev_end）以来是否有 mark_paid 记录"为准。
    # 不再以 period_start 作为查找键，这样调整 BILLING_* 参数后已付款用户不会被错误地重新弹窗；
    # 弹窗的重置完全由真实日历上结算日的推进自然触发。
    cps_iso = prev_end.isoformat()
    async with aiosqlite.connect(str(_BILLING_PAYMENTS_DB)) as db:
        async with db.execute(
            "SELECT marked_at FROM billing_payments "
            "WHERE user_id=? AND status='paid' AND marked_at IS NOT NULL "
            "ORDER BY marked_at DESC LIMIT 1",
            (bot_user_id,)
        ) as cur:
            paid_row = await cur.fetchone()

    if paid_row and paid_row[0] >= cps_iso:
        report["payment_status"] = "paid"
        report["dismissed"] = True
    else:
        report["payment_status"] = "unpaid"
        report["dismissed"] = False

    # 免费用户/无生图记录不需要支付
    if not current_user or current_user["total_fee"] <= 0:
        report["payment_status"] = "free"
        report["dismissed"] = True

    return report


@app.post("/api/billing/dismiss")
async def dismiss_settlement(session_id: str = ""):
    """标记结算弹窗已关闭（不再自动弹出）"""
    if not session_id:
        raise HTTPException(status_code=400, detail="需要 session_id")
    session = bot_auth_manager.get_session(session_id)
    if not session:
        raise HTTPException(status_code=401, detail="会话无效")

    await _ensure_billing_payments_table()
    now = datetime.now(_BEIJING_TZ).replace(tzinfo=None)
    prev_start, prev_end = _prev_billing_period(now)
    bot_user_id = session.bot_user_id
    s_iso = prev_start.isoformat()
    e_iso = prev_end.isoformat()

    async with aiosqlite.connect(str(_BILLING_PAYMENTS_DB)) as db:
        await db.execute("""
            INSERT INTO billing_payments (user_id, period_start, period_end, status, dismissed)
            VALUES (?, ?, ?, 'unpaid', 1)
            ON CONFLICT(user_id, period_start) DO UPDATE SET dismissed=1
        """, (bot_user_id, s_iso, e_iso))
        await db.commit()

    return {"ok": True}


@app.post("/api/billing/mark_paid")
async def mark_paid(session_id: str = ""):
    """用户自行标记已支付"""
    if not session_id:
        raise HTTPException(status_code=400, detail="需要 session_id")
    session = bot_auth_manager.get_session(session_id)
    if not session:
        raise HTTPException(status_code=401, detail="会话无效")

    await _ensure_billing_payments_table()
    now = datetime.now(_BEIJING_TZ).replace(tzinfo=None)
    prev_start, prev_end = _prev_billing_period(now)
    bot_user_id = session.bot_user_id
    s_iso = prev_start.isoformat()
    e_iso = prev_end.isoformat()
    marked_at = now.isoformat()

    async with aiosqlite.connect(str(_BILLING_PAYMENTS_DB)) as db:
        await db.execute("""
            INSERT INTO billing_payments (user_id, period_start, period_end, status, dismissed, marked_at)
            VALUES (?, ?, ?, 'paid', 1, ?)
            ON CONFLICT(user_id, period_start) DO UPDATE SET status='paid', dismissed=1, marked_at=?
        """, (bot_user_id, s_iso, e_iso, marked_at, marked_at))
        await db.commit()

    return {"ok": True, "status": "paid"}


@app.get("/api/billing/qrcode")
async def get_payment_qrcode(
    request: Request,
    type: str = "wechat",
    session_id: str = "",  # v0 compatibility; new clients use X-Bot-Session
):
    """返回收款二维码图片。type: wechat | alipay
    文件命名：payment_qr_wechat.png / payment_qr_alipay.png
    兼容旧命名：payment_qr.png 作为微信的 fallback
    """
    # 收款码是运营者配置的私有图片，只发给已登录用户：与同组 dismiss/mark_paid
    # 一样要求有效会话，不再匿名可取。
    _library_principal_from_request(request, session_id)
    # 清洗 type，杜绝 ../ 之类的路径穿越读取（正常取值 wechat/alipay）。
    safe_type = re.sub(r"[^a-z0-9_]", "", (type or "").lower()) or "wechat"
    name = f"payment_qr_{safe_type}"
    qr_path = BOT_DATA_DIR / f"{name}.png"
    if not qr_path.exists():
        qr_path = BOT_DATA_DIR / f"{name}.jpg"
    # fallback: 旧命名 payment_qr.png（仅微信）
    if not qr_path.exists() and safe_type == "wechat":
        qr_path = BOT_DATA_DIR / "payment_qr.png"
        if not qr_path.exists():
            qr_path = BOT_DATA_DIR / "payment_qr.jpg"
    if not qr_path.exists():
        raise HTTPException(status_code=404, detail=f"收款码未配置，请将图片放到 data/{name}.png")
    media = "image/jpeg" if qr_path.suffix == ".jpg" else "image/png"
    return FileResponse(str(qr_path), media_type=media)


# 允许访问的数据文件白名单
ALLOWED_DATA_FILES = {
    "NAI_Common.json",
    "NAI_NSFW.json",
    "role_tag_mapping.json",
    "oc_data.json",  # 新格式OC数据
}


# ==================== 缩略图协商缓存（ETag）工具 ====================
# 给图片/缩略图接口加 ETag，让浏览器二次请求只回 304（~200B）而不是全量重传 body。
# 用 mtime_ns + size 算 hash —— 文件被覆盖（哪怕 size 不变）mtime 必变，无需读文件内容。
def _file_etag(path: Path) -> str:
    s = path.stat()
    return hashlib.md5(f"{s.st_mtime_ns}-{s.st_size}".encode()).hexdigest()


def _check_not_modified(request: StarletteRequest, etag: str):
    """If-None-Match 命中返回 304 响应；否则返回 None 由调用方走 200 路径。"""
    from fastapi.responses import Response as _Resp
    quoted = f'"{etag}"'
    if request.headers.get("if-none-match") == quoted:
        return _Resp(status_code=304, headers={"ETag": quoted, "Cache-Control": "no-cache"})
    return None


@app.get("/api/oc/list")
async def get_oc_list(request: Request, session_id: str = ""):
    """获取公共OC列表（需要Bot授权）"""
    _library_principal_from_request(request, session_id)
    
    try:
        oc_data = await _load_oc_data()
        
        ocs = []
        for en_name, data in oc_data.items():
            if not isinstance(data, dict):
                continue
            
            # 构建预览图URL（仅使用纯净版 preview，不再回退带名字版 labeled）
            preview_path = (data.get("images") or {}).get("preview")
            preview_url = f"/api/oc/preview/{en_name}" if preview_path else None
            
            ocs.append({
                "id": en_name,
                "en_name": en_name,
                "zh_name": data.get("zh_name"),
                "zh_aliases": data.get("zh_aliases") or [],
                "tag_group": data.get("tag_group"),
                "negative_prompt": data.get("negative_prompt") or "",
                "preview_url": preview_url,
                "created_by": data.get("created_by"),
                "created_at": data.get("created_at"),
            })
        
        return {"ocs": ocs, "total": len(ocs)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"读取OC数据失败: {e}")


@app.get("/api/oc/preview/{oc_name}")
async def get_oc_preview(oc_name: str, request: StarletteRequest):
    """获取OC预览图"""
    oc_data = await _load_oc_data()

    oc_entry = oc_data.get(oc_name)
    if not oc_entry:
        raise HTTPException(status_code=404, detail="OC不存在")

    preview_path = (oc_entry.get("images") or {}).get("preview")
    if not preview_path:
        raise HTTPException(status_code=404, detail="预览图不存在")

    # 相对路径转绝对路径
    full_path = BOT_DATA_DIR / preview_path
    if not full_path.exists():
        raise HTTPException(status_code=404, detail="预览图文件不存在")

    # ETag 协商缓存：作者覆盖图片 → mtime 变 → etag 变 → 浏览器自动拉新；
    # 没变则回 304 ~200B，比之前的 no-store 三连每次全量重传省得多。
    etag = _file_etag(full_path)
    cached = _check_not_modified(request, etag)
    if cached:
        return cached
    return FileResponse(
        full_path,
        media_type="image/jpeg",
        headers={"ETag": f'"{etag}"', "Cache-Control": "no-cache"},
    )


# ==================== 公共 OC 增删改 API ====================

class CreateOCRequest(BaseModel):
    en_name: Optional[str] = None  # 可选，不传则由服务端根据zh_name自动生成
    zh_name: Optional[str] = None
    zh_aliases: Optional[list] = None
    tag_group: str
    negative_prompt: Optional[str] = None  # 负面提示词 (bot 端目前仅消费 tag_group)
    preview_base64: Optional[str] = None  # base64编码的预览图
    created_by: Optional[str] = None  # 创建者ID（QQ号等）
    session_id: str = ""  # v0 compatibility; new clients use X-Bot-Session


class UpdateOCRequest(BaseModel):
    zh_name: Optional[str] = None
    zh_aliases: Optional[list] = None
    tag_group: Optional[str] = None
    negative_prompt: Optional[str] = None
    preview_base64: Optional[str] = None
    created_by: Optional[str] = None
    created_at: Optional[int] = None
    session_id: str = ""  # v0 compatibility; new clients use X-Bot-Session


async def _load_oc_data() -> dict:
    """加载OC数据（安全读取，带备份恢复）"""
    return await _oc_store.load()


async def _save_oc_data(data: dict) -> bool:
    """保存OC数据（原子写入，带备份）"""
    return await _oc_store.save(data)


async def _load_role_tag_mapping() -> dict:
    """加载角色标签映射（安全读取，带备份恢复）"""
    return await _role_mapping_store.load()


async def _save_role_tag_mapping(data: dict) -> bool:
    """保存角色标签映射（原子写入，带备份）"""
    return await _role_mapping_store.save(data)


# 注意：_sync_oc_to_role_mapping 和 _remove_oc_from_role_mapping 已移除
# OC的中文名映射现在直接从 oc_data.json 读取，不再同步到 role_tag_mapping.json


def _regenerate_labeled_image(en_name: str, clean_path: str, zh_name: str = "", zh_aliases: list = None) -> str:
    """根据现有的纯净预览图重新生成带名字的预览图
    用于中文名变化但没有上传新预览图的情况
    """
    from PIL import Image, ImageDraw, ImageFont
    
    labeled_dir = BOT_DATA_DIR / "oc_images"
    labeled_dir.mkdir(parents=True, exist_ok=True)
    font_path = BOT_DATA_DIR.parent / "config" / "MiSans-Semibold.ttf"
    
    try:
        # 读取纯净版图片
        clean_full_path = BOT_DATA_DIR / clean_path
        if not clean_full_path.exists():
            print(f"纯净预览图不存在: {clean_full_path}")
            return None
        
        img = Image.open(clean_full_path)
        if img.mode in ('RGBA', 'LA'):
            bg = Image.new('RGB', img.size, (255, 255, 255))
            bg.paste(img, mask=img.split()[-1] if img.mode == 'RGBA' else None)
            img = bg
        
        # 选择最短的中文名作为标签
        label = None
        candidates = []
        if zh_name:
            candidates.append(zh_name)
        if zh_aliases:
            candidates.extend([a for a in zh_aliases if a])
        if candidates:
            label = sorted(candidates, key=lambda s: len(s))[0]
        else:
            label = en_name
            if label.lower().startswith("oc_"):
                label = label[3:]
        
        # 统一缩放到竖图尺寸
        target_w, target_h = 832, 1216
        if img.size != (target_w, target_h):
            img = img.resize((target_w, target_h), Image.Resampling.LANCZOS)
        
        # 创建拓展画布
        left_margin_w = 256
        canvas_size = (target_w + left_margin_w, target_h)
        bg_color = (245, 150, 170)
        canvas = Image.new('RGB', canvas_size, bg_color)
        canvas.paste(img, (left_margin_w, 0))
        
        # 绘制竖排文字
        try:
            text_clean = str(label or "").strip().replace(" ", "")
            n = max(1, len(text_clean))
            top_bottom_margin = 60
            available_h = canvas_size[1] - 2 * top_bottom_margin
            shrink_ratio = 0.9
            font_size = max(48, min(220, int((available_h / n) * shrink_ratio)))
            
            try:
                font = ImageFont.truetype(str(font_path), font_size)
            except Exception:
                font = ImageFont.load_default()
            
            draw = ImageDraw.Draw(canvas)
            spacing = max(6, int(font_size * 0.15))
            
            total_h = 0
            for ch in text_clean:
                bbox = draw.textbbox((0, 0), ch, font=font)
                total_h += (bbox[3] - bbox[1])
            total_h += spacing * (n - 1)
            
            start_y = (canvas_size[1] - total_h) // 2
            start_y -= spacing // 2
            start_y -= max(2, int(font_size * 0.18))
            start_y = max(0, start_y)
            center_x = left_margin_w // 2
            
            for ch in text_clean:
                bbox = draw.textbbox((0, 0), ch, font=font)
                ch_w = bbox[2] - bbox[0]
                ch_h = bbox[3] - bbox[1]
                x = center_x - ch_w // 2
                draw.text((x, start_y), ch, fill=(255, 255, 255), font=font)
                start_y += ch_h + spacing
                
        except Exception as e:
            print(f"竖向文字绘制失败: {e}")
        
        # 上采样2倍
        try:
            new_w = int(canvas_size[0] * 2.0)
            new_h = int(canvas_size[1] * 2.0)
            canvas = canvas.resize((new_w, new_h), Image.Resampling.LANCZOS)
        except Exception:
            pass
        
        # 保存带名字版
        labeled_filename = f"{en_name}_labeled.jpg"
        labeled_filepath = labeled_dir / labeled_filename
        canvas.save(labeled_filepath, 'JPEG', quality=95)
        return f"oc_images/{labeled_filename}"
        
    except Exception as e:
        print(f"重新生成带名字预览图失败: {e}")
        return None


def _save_preview_image(en_name: str, base64_data: str, zh_name: str = "", zh_aliases: list = None) -> Optional[str]:
    """保存纯净预览图到 oc_images_clean，返回相对路径（不再生成带名字版）。
    zh_name / zh_aliases 仅为兼容旧签名，已不再使用。
    """
    import base64

    # 确保目录存在
    clean_dir = BOT_DATA_DIR / "oc_images_clean"
    clean_dir.mkdir(parents=True, exist_ok=True)

    try:
        # 移除 data:image/xxx;base64, 前缀
        if "," in base64_data:
            base64_data = base64_data.split(",", 1)[1]

        image_data = base64.b64decode(base64_data)

        # 保存纯净版到 oc_images_clean（清洗文件名，杜绝 ../ 之类的路径穿越写入）
        import re as _re
        safe_en_name = _re.sub(r"[^A-Za-z0-9_-]", "_", en_name) or "oc"
        clean_filename = f"{safe_en_name}_preview.jpg"
        clean_filepath = clean_dir / clean_filename
        with open(clean_filepath, "wb") as f:
            f.write(image_data)
        return f"oc_images_clean/{clean_filename}"
    except Exception as e:
        print(f"保存预览图失败: {e}")
        return None


@app.post("/api/oc/create")
async def create_oc(req: CreateOCRequest, request: Request):
    """创建新OC"""
    import time
    import re as _re

    principal = _library_principal_from_request(request, req.session_id)
    ownership = _library_ownership.stamp(principal)
    
    oc_data = await _load_oc_data()
    
    # 生成 en_name：如果前端没传，则用和 bot 端一样的拼音逻辑生成
    en_name = req.en_name
    if not en_name and req.zh_name:
        try:
            from pypinyin import lazy_pinyin
            pinyin_parts = lazy_pinyin(req.zh_name)
            en_name = "OC_" + "_".join(pinyin_parts)
        except ImportError:
            import hashlib
            en_name = "OC_" + hashlib.md5(req.zh_name.encode()).hexdigest()[:8]
        # 规范化：只保留字母数字下划线，与 bot 端一致
        en_name = _re.sub(r"[^A-Za-z0-9_]", "", en_name)
        if not en_name.startswith("OC_"):
            en_name = "OC_" + en_name
    
    if not en_name:
        raise HTTPException(status_code=400, detail="必须提供 en_name 或 zh_name")
    
    # 检查是否已存在
    if en_name in oc_data:
        raise HTTPException(status_code=400, detail=f"OC '{en_name}' 已存在")
    
    # 构建OC数据
    new_oc = {
        "zh_name": req.zh_name or "",
        "zh_aliases": req.zh_aliases or [],
        "tag_group": req.tag_group,
        "negative_prompt": req.negative_prompt or "",
        "images": {},
        "created_at": int(time.time()),  # 创建时间戳
        "created_by": ownership["owner_id"],
        **ownership,
    }
    
    # 保存预览图（仅纯净版，不再生成带名字版）
    if req.preview_base64:
        clean_path = _save_preview_image(
            en_name, req.preview_base64,
            req.zh_name or "", req.zh_aliases or []
        )
        if clean_path:
            new_oc["images"]["preview"] = clean_path
    
    oc_data[en_name] = new_oc
    
    if not await _save_oc_data(oc_data):
        raise HTTPException(status_code=500, detail="保存OC数据失败")
    
    # 注意：不再同步到role_tag_mapping.json
    # OC的中文名映射现在直接从 oc_data.json 读取
    
    return {
        "success": True,
        "message": f"OC '{en_name}' 创建成功",
        "oc": {
            "id": en_name,
            "en_name": en_name,
            **new_oc,
            "preview_url": f"/api/oc/preview/{en_name}" if new_oc["images"].get("preview") else None
        }
    }


@app.put("/api/oc/{oc_name}")
async def update_oc(oc_name: str, req: UpdateOCRequest, request: Request):
    """更新OC"""
    principal = _library_principal_from_request(request, req.session_id)
    oc_data = await _load_oc_data()
    
    if oc_name not in oc_data:
        raise HTTPException(status_code=404, detail="OC不存在")
    
    oc_entry = oc_data[oc_name]
    _require_library_record_owner(
        principal,
        oc_entry,
        # created_by was historically accepted from an anonymous request body,
        # so it is not valid authorization evidence for pre-migration records.
        legacy_owner_fields=(),
    )
    
    # 记录旧的中文名，用于判断是否需要重新生成带名字的预览图
    old_zh_name = oc_entry.get("zh_name", "")
    old_zh_aliases = oc_entry.get("zh_aliases", [])
    
    # 更新字段
    if req.zh_name is not None:
        oc_entry["zh_name"] = req.zh_name
    if req.zh_aliases is not None:
        oc_entry["zh_aliases"] = req.zh_aliases
    if req.tag_group is not None:
        oc_entry["tag_group"] = req.tag_group
    if req.negative_prompt is not None:
        oc_entry["negative_prompt"] = req.negative_prompt
    # created_by/created_at remain accepted for v0 decoding only. Ownership and
    # creation time are immutable server-derived fields.
    
    # 获取当前或更新后的中文名
    zh_name = oc_entry.get("zh_name", "")
    zh_aliases = oc_entry.get("zh_aliases", [])
    
    # 判断中文名是否变化
    zh_name_changed = (zh_name != old_zh_name) or (zh_aliases != old_zh_aliases)
    
    # 更新预览图（仅纯净版，不再生成/维护带名字版）
    if req.preview_base64:
        # 上传了新预览图，直接保存
        clean_path = _save_preview_image(oc_name, req.preview_base64, zh_name, zh_aliases)
        if clean_path:
            if "images" not in oc_entry:
                oc_entry["images"] = {}
            oc_entry["images"]["preview"] = clean_path
    
    oc_data[oc_name] = oc_entry
    
    if not await _save_oc_data(oc_data):
        raise HTTPException(status_code=500, detail="保存OC数据失败")
    
    # 注意：不再同步到role_tag_mapping.json
    # OC的中文名映射现在直接从 oc_data.json 读取
    
    return {
        "success": True,
        "message": f"OC '{oc_name}' 更新成功",
        "oc": {
            "id": oc_name,
            "en_name": oc_name,
            **oc_entry,
            "preview_url": f"/api/oc/preview/{oc_name}" if oc_entry.get("images", {}).get("preview") else None
        }
    }


@app.delete("/api/oc/{oc_name}")
async def delete_oc(oc_name: str, request: Request, session_id: str = ""):
    """删除OC"""
    import os

    principal = _library_principal_from_request(request, session_id)
    
    oc_data = await _load_oc_data()
    
    if oc_name not in oc_data:
        raise HTTPException(status_code=404, detail="OC不存在")
    
    oc_entry = oc_data[oc_name]
    _require_library_record_owner(
        principal,
        oc_entry,
        legacy_owner_fields=(),
    )
    images = oc_entry.get("images") or {}
    
    # 删除 oc_images_clean/ 目录下的纯净预览图
    preview_path = images.get("preview")
    if preview_path:
        full_path = BOT_DATA_DIR / preview_path
        if full_path.exists():
            try:
                os.remove(full_path)
                print(f"已删除纯净预览图: {full_path}")
            except Exception as e:
                print(f"删除纯净预览图失败: {e}")
    
    # 删除 oc_images/ 目录下的labeled图
    labeled_path = images.get("labeled")
    if labeled_path and labeled_path != preview_path:
        full_path = BOT_DATA_DIR / labeled_path
        if full_path.exists():
            try:
                os.remove(full_path)
                print(f"已删除labeled预览图: {full_path}")
            except Exception as e:
                print(f"删除labeled预览图失败: {e}")
    
    # 从数据中删除
    del oc_data[oc_name]
    
    if not await _save_oc_data(oc_data):
        raise HTTPException(status_code=500, detail="保存OC数据失败")
    
    # 注意：不再从role_tag_mapping.json中移除
    # OC的中文名映射现在直接从 oc_data.json 读取
    
    return {
        "success": True,
        "message": f"OC '{oc_name}' 已删除"
    }


@app.get("/api/data/{filename}")
async def get_data_file(filename: str, request: StarletteRequest):
    """获取Bot端data目录下的JSON文件"""
    if filename not in ALLOWED_DATA_FILES:
        raise HTTPException(status_code=404, detail="文件不存在或不允许访问")

    file_path = BOT_DATA_DIR / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="文件不存在")

    # ETag 协商缓存：role_tag_mapping.json 这种 6MB 大文件二次请求只回 304 ~200B。
    # Starlette FileResponse 自动设 ETag 头但不会自动响应 304，所以这里手动判断。
    etag = _file_etag(file_path)
    cached = _check_not_modified(request, etag)
    if cached:
        return cached
    return FileResponse(
        file_path,
        media_type="application/json",
        headers={"ETag": f'"{etag}"', "Cache-Control": "no-cache"},
    )


# NOTE: 旧 /api/prompts/web 已迁移到 /api/agent/prompts/{tier}（见 agent_router/router.py）。
# Web 前端不再直接拉 prompts；统一由后端 agent_router 在 server 进程内加载并喂给 PydanticAI Agent。


@app.get("/api/data")
async def list_data_files():
    """列出可用的数据文件"""
    available = []
    for filename in ALLOWED_DATA_FILES:
        file_path = BOT_DATA_DIR / filename
        if file_path.exists():
            available.append({
                "filename": filename,
                "size": file_path.stat().st_size,
                "modified": file_path.stat().st_mtime
            })
    return {"files": available, "data_dir": str(BOT_DATA_DIR)}


@app.get("/api/tags/autocomplete")
async def tags_autocomplete(query: str, limit: int = 10):
    """Danbooru 标签自动补全代理（复用全局 Session）"""
    if not query or len(query) < 2:
        return []
    
    def _fetch():
        session = _get_danbooru_session()
        search_url = f"https://danbooru.donmai.us/autocomplete.json?search%5Bquery%5D={query}&search%5Btype%5D=tag_query&limit={limit}"
        resp = session.get(search_url, timeout=10)
        if resp.status_code == 200:
            return resp.json()
        return []
    
    try:
        return await asyncio.to_thread(_fetch)
    except Exception as e:
        print(f"Danbooru API error: {e}")
        return []


@app.post("/api/tags/verify")
async def tags_verify(req: dict):
    """批量验证标签是否在 Danbooru 上存在，返回存在的标签及其 post_count（复用全局 Session）"""
    tags = req.get("tags", [])
    if not tags:
        return {}

    # 最多验证 20 个标签
    tags = [t.strip().lower().replace(" ", "_").replace("-", "_") for t in tags[:20] if t.strip()]
    if not tags:
        return {}

    def _fetch():
        session = _get_danbooru_session()
        # Danbooru tags.json 支持用逗号分隔的名称精确查询
        names_param = ",".join(tags)
        url = f"https://danbooru.donmai.us/tags.json?search[name_comma]={names_param}&limit={len(tags)}"
        resp = session.get(url, timeout=10)
        if resp.status_code == 200:
            data = resp.json()
            result = {}
            for item in data:
                name = item.get("name", "")
                post_count = item.get("post_count", 0)
                if name:
                    result[name] = post_count
            return result
        return {}

    try:
        return await asyncio.to_thread(_fetch)
    except Exception as e:
        print(f"Danbooru tags verify error: {e}")
        return {}


# Wiki 中文名缓存
# ==================== 关联推荐（DanbooruSearch 共现） ====================
# 转发到 sakizuki-danboorusearch HF Space，加 LRU 缓存。

DANBOORU_SEARCH_BASE = "https://sakizuki-danboorusearch.hf.space"
_related_cache: dict[tuple, tuple[float, list]] = {}
_RELATED_CACHE_TTL = 86400
_RELATED_CACHE_MAX = 1000

_RELATED_FALLBACK_SYS = (
    "You are a Danbooru tag co-occurrence engine. "
    "Given anchor tags, output a JSON array of 12 General-category Danbooru tags "
    "that commonly appear with the anchor in image illustrations. "
    "Only output General tags. Use canonical lowercase underscore tag names. "
    "Each item must be {\"tag\": <english_tag>, \"cn_name\": <short Chinese name>}. "
    "Do not repeat anchor tags. Output a single JSON array only."
)


def _parse_ds_fallback_results(content: str) -> list[dict]:
    if not content:
        return []
    text = content.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    start = text.find("[")
    end = text.rfind("]")
    if start == -1 or end == -1 or end <= start:
        return []
    try:
        arr = json.loads(text[start : end + 1])
    except Exception:
        return []
    if not isinstance(arr, list):
        return []

    cleaned: list[dict] = []
    seen: set[str] = set()
    for item in arr:
        if not isinstance(item, dict):
            continue
        tag = str(item.get("tag", "")).strip().lower().replace(" ", "_")
        if not tag or tag in seen:
            continue
        seen.add(tag)
        cn = item.get("cn_name") or item.get("zh") or ""
        cn = cn.split(",")[0].split("，")[0].strip() if isinstance(cn, str) else ""
        cleaned.append({"tag": tag, "cn_name": cn, "category": "General", "npmi": 0.0})
    return cleaned


async def _ds_fallback_related(anchor_tags: list[str], limit: int) -> list[dict]:
    cfg = _get_translate_en2zh_config()
    if not cfg.get("base_url") or not cfg.get("api_key"):
        return []
    payload = {
        "model": cfg["model"],
        "messages": [
            {"role": "system", "content": _RELATED_FALLBACK_SYS},
            {"role": "user", "content": "Anchor tags: " + ", ".join(anchor_tags)},
        ],
        "temperature": 0.3,
        "max_tokens": 1500,
    }
    if cfg.get("extra_payload"):
        payload.update(cfg["extra_payload"])

    try:
        response = await _safe_outbound_json.post_json(
            f"{cfg['base_url'].rstrip('/')}/chat/completions",
            headers={
                "Authorization": f"Bearer {cfg['api_key']}",
                "Content-Type": "application/json",
            },
            payload=payload,
            timeout=30,
        )
        if response.status != 200:
            return []
        data = response.json()
        content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
        return _parse_ds_fallback_results(content)[:limit]
    except Exception as e:
        print(f"[tags_related] DS fallback error: {e}")
        return []


class TagsRelatedRequest(BaseModel):
    tags: list[str]
    limit: int = 30
    show_nsfw: bool = True
    categories: Optional[list[str]] = None


@app.post("/api/tags/related")
async def tags_related(req: TagsRelatedRequest):
    if not req.tags:
        return {"results": []}

    norm_tags = tuple(sorted(t.lower().strip().replace(" ", "_") for t in req.tags if t.strip()))
    if not norm_tags:
        return {"results": []}
    norm_categories = tuple(sorted(req.categories)) if req.categories else None
    safe_limit = max(1, min(req.limit, 100))
    cache_key = (norm_tags, req.show_nsfw, safe_limit, norm_categories)

    now = time.time()
    if cache_key in _related_cache:
        ts, cached_results = _related_cache[cache_key]
        if now - ts < _RELATED_CACHE_TTL:
            return {"results": cached_results, "cached": True}

    upstream_limit = max(safe_limit * 4, 100) if norm_categories else safe_limit
    results: list[dict] = []
    upstream_error: str | None = None
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{DANBOORU_SEARCH_BASE}/api/related",
                json={"tags": list(norm_tags), "limit": upstream_limit, "show_nsfw": req.show_nsfw},
                timeout=aiohttp.ClientTimeout(total=90),
            ) as resp:
                if resp.status != 200:
                    upstream_error = f"upstream_{resp.status}"
                else:
                    data = await resp.json()
                    if isinstance(data, list):
                        results = data
                    elif isinstance(data, dict):
                        results = data.get("results", [])
    except asyncio.TimeoutError:
        upstream_error = "timeout"
    except Exception as e:
        print(f"[tags_related] fetch error: {e}")
        upstream_error = "fetch_failed"

    if norm_categories:
        cat_set = set(norm_categories)
        results = [r for r in results if isinstance(r, dict) and r.get("category") in cat_set]
    results = results[:safe_limit]

    fallback_used = False
    if not results:
        ds_results = await _ds_fallback_related(list(norm_tags), safe_limit)
        if norm_categories:
            cat_set = set(norm_categories)
            ds_results = [r for r in ds_results if r.get("category") in cat_set]
        if ds_results:
            results = ds_results[:safe_limit]
            fallback_used = True

    _related_cache[cache_key] = (now, results)
    if len(_related_cache) > _RELATED_CACHE_MAX:
        oldest_key = min(_related_cache, key=lambda k: _related_cache[k][0])
        del _related_cache[oldest_key]

    body: dict = {"results": results}
    if fallback_used:
        body["fallback"] = "ds"
    if upstream_error and not results:
        body["error"] = upstream_error
    return body


# ==================== 语义搜索 (DanbooruSearch /search) ====================
# 转发上游 DanbooruSearch HF Space 的 /api/search。

_search_cache: dict[tuple, tuple[float, list]] = {}
_SEARCH_CACHE_TTL = 1800
_SEARCH_CACHE_MAX = 500


class TagsSearchRequest(BaseModel):
    query: str
    limit: int = 30
    top_k: int = 50
    show_nsfw: bool = True


@app.post("/api/tags/search")
async def tags_search(req: TagsSearchRequest):
    query = (req.query or "").strip()
    if not query:
        return {"results": []}

    safe_limit = max(1, min(req.limit, 200))
    safe_top_k = max(1, min(req.top_k, 50))
    cache_key = (query, req.show_nsfw, safe_limit, safe_top_k)
    now = time.time()
    if cache_key in _search_cache:
        ts, cached = _search_cache[cache_key]
        if now - ts < _SEARCH_CACHE_TTL:
            return {"results": cached, "cached": True}

    payload = {
        "query": query,
        "limit": safe_limit,
        "top_k": safe_top_k,
        "show_nsfw": req.show_nsfw,
        "target_categories": ["General"],
    }
    results: list[dict] = []
    upstream_error: str | None = None
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"{DANBOORU_SEARCH_BASE}/api/search",
                json=payload,
                timeout=aiohttp.ClientTimeout(total=30),
            ) as resp:
                if resp.status != 200:
                    upstream_error = f"upstream_{resp.status}"
                else:
                    data = await resp.json()
                    raw_results = data.get("results", []) if isinstance(data, dict) else []
                    for item in raw_results:
                        if not isinstance(item, dict):
                            continue
                        tag = str(item.get("tag", "") or "").strip()
                        if not tag:
                            continue
                        results.append({
                            "tag": tag,
                            "cn_name": item.get("cn_name", "") or "",
                            "category": item.get("category", "") or "",
                            "nsfw": item.get("nsfw", "") or "",
                            "count": int(item.get("count", 0) or 0),
                            "score": float(item.get("final_score", 0.0) or 0.0),
                        })
    except asyncio.TimeoutError:
        upstream_error = "timeout"
    except Exception as e:
        print(f"[tags_search] fetch error: {e}")
        upstream_error = "fetch_failed"

    _search_cache[cache_key] = (now, results)
    if len(_search_cache) > _SEARCH_CACHE_MAX:
        oldest_key = min(_search_cache, key=lambda k: _search_cache[k][0])
        del _search_cache[oldest_key]

    body: dict = {"results": results}
    if upstream_error and not results:
        body["error"] = upstream_error
    return body


_wiki_cache: Dict[str, list] = {}
_wiki_cache_time: Dict[str, float] = {}
WIKI_CACHE_TTL = 3600  # 缓存1小时


# ==================== 标签翻译映射库 ====================

# 映射库文件路径
_TAG_TRANS_PATH = Path(__file__).parent.parent.parent / "data" / "tag_translations.json"
_tag_trans_store = SafeJsonStore(_TAG_TRANS_PATH)
# 内存缓存（启动时加载）
_tag_trans_cache: Dict[str, dict] = {}
_tag_trans_loaded = False


async def _ensure_tag_trans_loaded():
    """确保映射库已加载到内存"""
    global _tag_trans_cache, _tag_trans_loaded
    if not _tag_trans_loaded:
        _tag_trans_cache = await _tag_trans_store.load()
        _tag_trans_loaded = True


def _normalize_tag(tag: str) -> str:
    """标准化 tag key：小写 + 下划线"""
    return tag.strip().lower().replace(" ", "_")


_wiki_exists_cache: Dict[str, bool] = {}
_wiki_exists_cache_time: Dict[str, float] = {}
_wiki_preview_cache: Dict[str, dict] = {}
_wiki_preview_cache_time: Dict[str, float] = {}
_wiki_summary_zh_cache: Dict[str, str] = {}
_wiki_summary_zh_cache_time: Dict[str, float] = {}


def _normalize_danbooru_tag(tag: str) -> str:
    return tag.strip().lower().replace(" ", "_")


def _wiki_cache_fresh(ts: float) -> bool:
    return (time.time() - ts) < WIKI_CACHE_TTL


def _wiki_example_refs(body: str) -> List[Tuple[str, int]]:
    refs: List[Tuple[str, int]] = []
    for match in re.finditer(r"!(post|asset)\s+#(\d+)", body or "", flags=re.IGNORECASE):
        refs.append((match.group(1).lower(), int(match.group(2))))
    return refs


def _strip_wiki_markup(text: str) -> str:
    cleaned = (text or "").replace("\r\n", "\n")
    cleaned = re.sub(r"h\d\.\s*", "", cleaned)
    cleaned = re.sub(r"\[\[(?:[^|\]]+\|)?([^\]]+)\]\]", r"\1", cleaned)
    cleaned = re.sub(r"!(?:post|asset)\s+#\d+:[^\n]*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"^\*\s*", "", cleaned, flags=re.MULTILINE)
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned.strip()


def _build_wiki_summary(body: str, limit: int = 320) -> str:
    text = re.split(r"\nh\d\.\s+(?:Examples|See also)\b", body or "", maxsplit=1, flags=re.IGNORECASE)[0]
    text = _strip_wiki_markup(text)
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= limit:
        return text
    clipped = text[:limit].rsplit(" ", 1)[0].strip()
    return f"{clipped}..." if clipped else text[:limit]


def _limit_chinese_preview_text(text: str, limit: int = 140) -> str:
    text = re.sub(r"\s+", " ", text or "").strip()
    if len(text) <= limit:
        return text
    return text[:limit].rstrip("，。；、,. ") + "..."


def _absolute_danbooru_url(url: Optional[str]) -> Optional[str]:
    if not url:
        return None
    if url.startswith("//"):
        return f"https:{url}"
    if url.startswith("/"):
        return f"https://danbooru.donmai.us{url}"
    return url


def _fetch_wiki_page(tag: str) -> Optional[dict]:
    session = _get_danbooru_session()
    resp = session.get(
        "https://danbooru.donmai.us/wiki_pages.json",
        params={"search[title]": tag},
        timeout=5,
    )
    if resp.status_code != 200:
        return None
    data = resp.json()
    if not data:
        return None
    page = data[0] if isinstance(data, list) else data
    if not isinstance(page, dict) or page.get("is_deleted"):
        return None
    return page


def _check_wiki_page_exists(tag: str) -> Tuple[bool, bool]:
    """Return (request_ok, has_wiki), keeping network failures out of negative cache."""
    try:
        session = _get_danbooru_session()
        resp = session.get(
            "https://danbooru.donmai.us/wiki_pages.json",
            params={"search[title]": tag},
            timeout=5,
        )
        if resp.status_code != 200:
            return False, False
        data = resp.json()
        if not data:
            return True, False
        page = data[0] if isinstance(data, list) else data
        return True, isinstance(page, dict) and not page.get("is_deleted")
    except Exception as e:
        print(f"Wiki exists check request error for {tag}: {e}")
        return False, False


def _fetch_wiki_example(session, ref_type: str, ref_id: int) -> Optional[dict]:
    if ref_type == "post":
        resp = session.get(f"https://danbooru.donmai.us/posts/{ref_id}.json", timeout=8)
        if resp.status_code != 200:
            return None
        data = resp.json()
        if not isinstance(data, dict):
            return None
        preview_url = _absolute_danbooru_url(
            data.get("large_file_url") or data.get("file_url") or data.get("preview_file_url")
        )
        return {
            "type": "post",
            "id": ref_id,
            "previewUrl": preview_url,
            "pageUrl": f"https://danbooru.donmai.us/posts/{ref_id}",
            "width": data.get("image_width"),
            "height": data.get("image_height"),
        }

    if ref_type == "asset":
        resp = session.get(f"https://danbooru.donmai.us/media_assets/{ref_id}.json", timeout=8)
        if resp.status_code != 200:
            return None
        data = resp.json()
        if not isinstance(data, dict):
            return None
        preview_url = _absolute_danbooru_url(
            data.get("file_url") or data.get("large_file_url") or data.get("image_url") or data.get("preview_file_url")
        )
        variants = data.get("variants") or []
        if not preview_url and isinstance(variants, list):
            variant_candidates = [
                variant for variant in variants
                if isinstance(variant, dict) and variant.get("url")
            ]
            variant_candidates.sort(
                key=lambda variant: (variant.get("width") or 0) * (variant.get("height") or 0),
                reverse=True,
            )
            for variant in variant_candidates:
                candidate = _absolute_danbooru_url(variant.get("url"))
                if candidate:
                    preview_url = candidate
                    break
        return {
            "type": "asset",
            "id": ref_id,
            "previewUrl": preview_url,
            "pageUrl": f"https://danbooru.donmai.us/media_assets/{ref_id}",
            "width": data.get("image_width") or data.get("width"),
            "height": data.get("image_height") or data.get("height"),
        }

    return None


# 匿名 Danbooru 搜索最多 2 个 tag，character_tag + rating 过滤刚好用满；
# 用 rating:g,s 排除 questionable/explicit，避免预览弹出露骨图
_POST_EXAMPLE_RATING = "rating:g,s"
_POST_EXAMPLE_IMAGE_EXTS = {"jpg", "jpeg", "png", "webp", "gif"}


def _fetch_posts_examples(session, tag: str, limit: int = 4) -> List[dict]:
    """wiki 正文无示例图时的回退：取该标签 posts 的若干预览图。"""
    try:
        resp = session.get(
            "https://danbooru.donmai.us/posts.json",
            params={"tags": f"{tag} {_POST_EXAMPLE_RATING}", "limit": limit * 4},
            timeout=8,
        )
        if resp.status_code != 200:
            return []
        data = resp.json()
    except Exception as e:
        print(f"Wiki posts fallback fetch error for {tag}: {e}")
        return []

    if not isinstance(data, list):
        return []

    examples: List[dict] = []
    for post in data:
        if not isinstance(post, dict) or post.get("is_deleted") or post.get("is_banned"):
            continue
        if (post.get("file_ext") or "").lower() not in _POST_EXAMPLE_IMAGE_EXTS:
            continue
        post_id = post.get("id")
        preview_url = _absolute_danbooru_url(
            post.get("large_file_url") or post.get("file_url") or post.get("preview_file_url")
        )
        if not post_id or not preview_url:
            continue
        examples.append({
            "type": "post",
            "id": post_id,
            "previewUrl": preview_url,
            "pageUrl": f"https://danbooru.donmai.us/posts/{post_id}",
            "width": post.get("image_width"),
            "height": post.get("image_height"),
        })
        if len(examples) >= limit:
            break
    return examples


@app.post("/api/tags/wiki-exists-batch")
async def tags_wiki_exists_batch(req: dict):
    """Batch-check whether tags have Danbooru wiki pages."""
    raw_tags = req.get("tags", [])
    if not raw_tags:
        return {}

    tags = []
    seen = set()
    for raw_tag in raw_tags[:50]:
        tag = _normalize_danbooru_tag(str(raw_tag))
        if tag and tag not in seen:
            seen.add(tag)
            tags.append(tag)

    if not tags:
        return {}

    result: Dict[str, bool] = {}
    tags_to_fetch: List[str] = []
    now = time.time()

    for tag in tags:
        if tag in _wiki_preview_cache and _wiki_cache_fresh(_wiki_preview_cache_time.get(tag, 0)):
            result[tag] = True
        elif tag in _wiki_exists_cache and _wiki_cache_fresh(_wiki_exists_cache_time.get(tag, 0)):
            result[tag] = _wiki_exists_cache[tag]
        else:
            tags_to_fetch.append(tag)

    def _check(tag: str) -> Tuple[str, Optional[bool]]:
        ok, has_wiki = _check_wiki_page_exists(tag)
        return tag, has_wiki if ok else None

    if tags_to_fetch:
        import concurrent.futures

        def _fetch_all():
            with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
                return list(executor.map(_check, tags_to_fetch))

        for tag, has_wiki in await asyncio.to_thread(_fetch_all):
            if has_wiki is None:
                continue
            _wiki_exists_cache[tag] = has_wiki
            _wiki_exists_cache_time[tag] = now
            result[tag] = has_wiki

    return result


@app.get("/api/tags/wiki-preview")
async def tags_wiki_preview(tag: str):
    """Return a compact wiki preview and wiki example images."""
    normalized = _normalize_danbooru_tag(tag)
    if not normalized:
        return {"hasWiki": False}

    if normalized in _wiki_preview_cache and _wiki_cache_fresh(_wiki_preview_cache_time.get(normalized, 0)):
        cached = _wiki_preview_cache[normalized]
        if normalized in _wiki_summary_zh_cache and _wiki_cache_fresh(_wiki_summary_zh_cache_time.get(normalized, 0)):
            cached["summaryZh"] = _wiki_summary_zh_cache[normalized]
        return cached

    def _fetch():
        page = _fetch_wiki_page(normalized)
        if not page:
            return {"hasWiki": False}

        body = page.get("body") or ""
        session = _get_danbooru_session()
        examples = []
        seen_examples = set()
        for ref_type, ref_id in _wiki_example_refs(body):
            key = (ref_type, ref_id)
            if key in seen_examples:
                continue
            seen_examples.add(key)
            try:
                example = _fetch_wiki_example(session, ref_type, ref_id)
            except Exception as e:
                print(f"Wiki example fetch error for {normalized} {ref_type}#{ref_id}: {e}")
            if example:
                examples.append(example)
            if len(examples) >= 6:
                break

        # wiki 正文没有示例图时，回退到该标签的 posts 取几张
        if not examples:
            try:
                examples = _fetch_posts_examples(session, normalized, limit=4)
            except Exception as e:
                print(f"Wiki posts fallback error for {normalized}: {e}")

        return {
            "hasWiki": True,
            "title": page.get("title") or normalized,
            "otherNames": page.get("other_names") or [],
            "summary": _build_wiki_summary(body),
            "body": body,
            "example": examples[0] if examples else None,
            "examples": examples,
        }

    try:
        payload = await asyncio.to_thread(_fetch)
        now = time.time()
        _wiki_exists_cache[normalized] = bool(payload.get("hasWiki"))
        _wiki_exists_cache_time[normalized] = now
        if payload.get("hasWiki"):
            if normalized in _wiki_summary_zh_cache and _wiki_cache_fresh(_wiki_summary_zh_cache_time.get(normalized, 0)):
                payload["summaryZh"] = _wiki_summary_zh_cache[normalized]
            _wiki_preview_cache[normalized] = payload
            _wiki_preview_cache_time[normalized] = now
        return payload
    except Exception as e:
        print(f"Wiki preview fetch error for {normalized}: {e}")
        return {"hasWiki": False}


@app.get("/api/tags/wiki-preview-summary-zh")
async def tags_wiki_preview_summary_zh(tag: str):
    """Translate/summarize a wiki preview body to Chinese without blocking the image preview."""
    normalized = _normalize_danbooru_tag(tag)
    if not normalized:
        return {"hasWiki": False, "summaryZh": ""}

    if normalized in _wiki_summary_zh_cache and _wiki_cache_fresh(_wiki_summary_zh_cache_time.get(normalized, 0)):
        return {"hasWiki": True, "summaryZh": _wiki_summary_zh_cache[normalized]}

    body = ""
    summary = ""
    cached = _wiki_preview_cache.get(normalized)
    if cached and _wiki_cache_fresh(_wiki_preview_cache_time.get(normalized, 0)):
        body = cached.get("body") or ""
        summary = cached.get("summary") or ""
    else:
        def _fetch_page_for_translation():
            page = _fetch_wiki_page(normalized)
            if not page:
                return None
            return page.get("body") or ""

        body = await asyncio.to_thread(_fetch_page_for_translation) or ""
        summary = _build_wiki_summary(body) if body else ""

    if not body and not summary:
        return {"hasWiki": False, "summaryZh": ""}

    summary_zh = await _translate_wiki_preview_summary(normalized, body, summary)
    now = time.time()
    if summary_zh:
        _wiki_summary_zh_cache[normalized] = summary_zh
        _wiki_summary_zh_cache_time[normalized] = now
        if cached:
            cached["summaryZh"] = summary_zh
            _wiki_preview_cache[normalized] = cached

    return {"hasWiki": True, "summaryZh": summary_zh}


@app.post("/api/tags/translations/lookup")
async def tags_translations_lookup(req: dict):
    """批量查询标签翻译映射"""
    await _ensure_tag_trans_loaded()
    tags = req.get("tags", [])
    result = {}
    for tag in tags:
        key = _normalize_tag(tag)
        if key in _tag_trans_cache:
            result[key] = _tag_trans_cache[key]["zh"]
    return result


@app.post("/api/tags/translations/submit")
async def tags_translations_submit(req: dict):
    """批量提交标签翻译结果到映射库
    body: { entries: [{ tag: "long_hair", zh: "长发", source: "ai"|"wiki" }] }
    """
    await _ensure_tag_trans_loaded()
    entries = req.get("entries", [])
    if not entries:
        return {"added": 0}

    added = 0
    for entry in entries:
        tag = entry.get("tag", "")
        zh = entry.get("zh", "")
        source = entry.get("source", "ai")
        if not tag or not zh:
            continue

        key = _normalize_tag(tag)
        existing = _tag_trans_cache.get(key)

        # 已存在且来源是 wiki → 不覆盖（wiki 优先）
        if existing and existing.get("source") == "wiki" and source != "wiki":
            continue

        _tag_trans_cache[key] = {"zh": zh, "source": source}
        added += 1

    if added > 0:
        await _tag_trans_store.save(_tag_trans_cache)

    return {"added": added, "total": len(_tag_trans_cache)}


@app.get("/api/tags/wiki")
async def tags_wiki(tags: str):
    """批量获取标签的中文别名（先查本地映射库，再查 Danbooru wiki）"""
    import re
    
    tag_list = [t.strip() for t in tags.split(",") if t.strip()]
    if not tag_list:
        return {}
    
    # 限制最多10个
    tag_list = tag_list[:10]
    
    CJK_RANGE = r"\u4e00-\u9fff"
    result = {}
    tags_to_fetch = []
    
    # 确保翻译映射库已加载
    await _ensure_tag_trans_loaded()
    
    # 先检查内存缓存 → 翻译映射库 → 待获取列表
    now = time.time()
    for tag in tag_list:
        # 1. 内存 wiki 缓存（TTL 1小时）
        if tag in _wiki_cache and (now - _wiki_cache_time.get(tag, 0)) < WIKI_CACHE_TTL:
            if _wiki_cache[tag]:
                result[tag] = _wiki_cache[tag]
            continue
        
        # 2. 查 tag_translations.json 持久化映射库
        trans_key = _normalize_tag(tag)
        trans_entry = _tag_trans_cache.get(trans_key)
        if trans_entry and trans_entry.get("zh"):
            zh_name = trans_entry["zh"]
            result[tag] = [zh_name]
            # 回填到内存缓存，避免重复查映射库
            _wiki_cache[tag] = [zh_name]
            _wiki_cache_time[tag] = now
            continue
        
        # 3. 都没有，需要从 Danbooru 获取
        tags_to_fetch.append(tag)
    
    if not tags_to_fetch:
        return result
    
    def _fetch_wiki_chinese(tag: str) -> tuple:
        """同步获取单个标签的中文名（复用全局 Session）"""
        try:
            session = _get_danbooru_session()
            url = f"https://danbooru.donmai.us/wiki_pages.json?search[title]={tag}"
            resp = session.get(url, timeout=5)
            if resp.status_code != 200:
                return tag, []
            
            data = resp.json()
            if not data:
                return tag, []
            
            page = data[0] if isinstance(data, list) else data
            other_names = page.get("other_names") or []
            
            # 筛选中文名
            chinese_names = []
            for name in other_names:
                if isinstance(name, str) and re.search(f"[{CJK_RANGE}]", name):
                    # 排除含日文假名的
                    if not re.search(r"[\u30a0-\u30ff\u3040-\u309f]", name):
                        chinese_names.append(name.strip())
            
            return tag, chinese_names[:3]
        except Exception as e:
            print(f"Wiki fetch error for {tag}: {e}")
            return tag, []
    
    # 用线程池并发获取，避免阻塞事件循环
    import concurrent.futures
    
    def _fetch_all():
        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
            return list(executor.map(_fetch_wiki_chinese, tags_to_fetch))
    
    fetch_results = await asyncio.to_thread(_fetch_all)
    
    for r in fetch_results:
        if isinstance(r, Exception):
            continue
        tag, chinese_names = r
        _wiki_cache[tag] = chinese_names
        _wiki_cache_time[tag] = now
        if chinese_names:
            result[tag] = chinese_names
    
    return result


# ==================== Vibe 编码 API ====================

class EncodeVibeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    image: str = Field(min_length=1, max_length=28 * 1024 * 1024, strict=True)
    information_extracted: float = Field(default=0.5, ge=0, le=1, strict=True)
    model: str = Field(
        default="nai-diffusion-4-5-full",
        min_length=1,
        max_length=128,
        strict=True,
    )
    session_id: str | None = Field(default=None, max_length=200, strict=True)

    @field_validator("image")
    @classmethod
    def validate_image(cls, value: str) -> str:
        try:
            return normalize_image_base64(value)
        except InvalidRequestError as exc:
            raise ValueError(exc.message) from exc


def _get_anlas_only_token() -> Optional[str]:
    """返回专用于 Vibe 编码 / 超分 的纯点数 Token；未配置时返回 None。

    若 config.NOVELAI_ANLAS_ONLY_TOKEN 有值，所有非生图的 Anlas 消费类操作
    （vibe 编码 / 超分）都强制走该 Token，把生图压力留给主 Token 池。
    """
    t = (NOVELAI_ANLAS_ONLY_TOKEN or "").strip()
    return t or None


async def _get_first_novelai_token() -> str:
    """获取第一个可用的 NovelAI Token（用于非生成类 API）"""
    # 优先通过 TokenManager 选取最佳 Token
    best = await token_manager.get_best_token(need_anlas=True)
    if best:
        return best
    tokens = get_novelai_tokens()
    return tokens[0] if tokens else ""


async def _read_paid_response(response: Any, *, max_bytes: int) -> bytes:
    payload = bytearray()
    async for chunk in response.content.iter_chunked(64 * 1024):
        if not isinstance(chunk, bytes):
            raise HTTPException(status_code=502, detail="上游返回了无效数据")
        payload.extend(chunk)
        if len(payload) > max_bytes:
            raise HTTPException(status_code=502, detail="上游响应超过安全限制")
    return bytes(payload)


async def _encode_vibe_upstream(token: str, req: EncodeVibeRequest) -> str:
    print(
        f"[Vibe Encode] Model: {req.model}, Image length: {len(req.image)}, "
        f"Token: {hashlib.sha256(token.encode()).hexdigest()[:8]}"
    )
    headers = {
        "accept": "*/*",
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    payload = {
        "image": req.image,
        "information_extracted": req.information_extracted,
        "model": req.model,
    }
    async with aiohttp.ClientSession() as session:
        async with session.post(
            "https://image.novelai.net/ai/encode-vibe",
            headers=headers,
            json=payload,
            timeout=aiohttp.ClientTimeout(total=300),
        ) as response:
            if response.status != 200:
                error = await _read_paid_response(response, max_bytes=2048)
                raise HTTPException(
                    status_code=response.status,
                    detail=f"NovelAI API 错误: {error.decode('utf-8', errors='replace')}",
                )
            content = await _read_paid_response(response, max_bytes=MAX_PAID_RESULT_BYTES)
            if not content:
                raise HTTPException(status_code=502, detail="NovelAI 返回了空编码")
    return base64.b64encode(content).decode("ascii")


@app.post("/api/vibe/encode")
async def encode_vibe(req: EncodeVibeRequest, request: Request):
    """Encode one image for an authenticated Bot owner (fixed 2-Anlas usage)."""

    principal = _library_principal_from_request(request, req.session_id or "")
    token = _get_anlas_only_token() or await token_manager.get_best_token(need_anlas=True)
    if not token:
        raise HTTPException(status_code=503, detail="NovelAI Token 未配置或全部禁用")
    try:
        vibe_base64 = await _paid_operations.execute(
            principal,
            lambda: _encode_vibe_upstream(token, req),
            charge=UsageCharge(2, "vibe编码"),
        )
    except aiohttp.ClientError as exc:
        raise HTTPException(status_code=502, detail="NovelAI 网络请求失败") from exc
    except UsageRecordingError as exc:
        raise HTTPException(
            status_code=503,
            detail="上游操作已完成但用量记录失败，请勿自动重试并联系管理员核对用量",
        ) from exc
    asyncio.create_task(
        _try_cache_public_vibe_encoding(
            req.image,
            req.information_extracted,
            req.model,
            vibe_base64,
        )
    )
    return {"encoding": vibe_base64}


# ==================== 公共 Vibe 编码缓存 ====================

BOT_VIBES_DIR = BOT_DATA_DIR / "vibes"

# 内存缓存：vibe_id -> 文件路径，避免每次编码都扫描目录
_public_vibe_id_cache: dict[str, Path] = {}
_public_vibe_cache_time: float = 0.0

def _refresh_public_vibe_id_cache():
    """刷新公共 vibe ID -> 文件路径 的缓存（每 60 秒最多刷新一次）"""
    global _public_vibe_id_cache, _public_vibe_cache_time
    import time as _time
    now = _time.time()
    if _public_vibe_id_cache and (now - _public_vibe_cache_time) < 60:
        return
    if not BOT_VIBES_DIR.exists():
        return
    cache = {}
    for vibe_file in BOT_VIBES_DIR.glob("*.naiv4vibe"):
        try:
            with open(vibe_file, "r", encoding="utf-8") as f:
                data = json.load(f)
            vibe_id = data.get("id")
            if vibe_id:
                cache[vibe_id] = vibe_file
        except Exception:
            continue
    _public_vibe_id_cache = cache
    _public_vibe_cache_time = now

def _is_multiple_of_005(value: float) -> bool:
    """检查值是否为 0.05 的倍数（允许浮点误差）"""
    remainder = round(value % 0.05, 6)
    return remainder < 0.001 or (0.05 - remainder) < 0.001

async def _try_cache_public_vibe_encoding(image_b64: str, information_extracted: float, model: str, encoding_b64: str):
    """尝试将编码结果缓存到公共 vibe 文件中"""
    if not _is_multiple_of_005(information_extracted):
        return

    # 计算 vibe ID
    vibe_id = hashlib.sha256(image_b64.encode("utf-8")).hexdigest()

    _refresh_public_vibe_id_cache()

    vibe_file = _public_vibe_id_cache.get(vibe_id)
    if not vibe_file or not vibe_file.exists():
        return

    try:
        async with aiofiles.open(vibe_file, "r", encoding="utf-8") as f:
            data = json.loads(await f.read())

        # 确定 encoding key
        if "4-5-full" in model or "4-5full" in model:
            enc_key = "v4-5full"
        elif "4-5-curated" in model or "4-5curated" in model:
            enc_key = "v4-5curated"
        elif "4-full" in model or "4full" in model:
            enc_key = "v4full"
        elif "4-curated" in model or "4curated" in model:
            enc_key = "v4curated"
        else:
            return

        enc_digest = hashlib.sha256(f"information_extracted:{information_extracted}".encode()).hexdigest()

        encodings = data.get("encodings", {})
        if enc_key not in encodings:
            encodings[enc_key] = {}

        # 已有则跳过
        if enc_digest in encodings[enc_key]:
            return

        encodings[enc_key][enc_digest] = {
            "encoding": encoding_b64,
            "params": {
                "information_extracted": information_extracted
            }
        }
        data["encodings"] = encodings

        async with aiofiles.open(vibe_file, "w", encoding="utf-8") as f:
            await f.write(json.dumps(data, ensure_ascii=False))

        print(f"[Vibe Cache] 已缓存公共 vibe 编码: {vibe_file.stem} model={enc_key} IE={information_extracted}")
    except Exception as e:
        print(f"[Vibe Cache] 缓存失败: {e}")


# ==================== 公共 Vibe API ====================


@app.get("/api/vibes/encoding/{filename}")
async def get_vibe_encoding(filename: str, model: str, ie: float):
    """轻量接口：查询公共 vibe 中是否已有特定 model+IE 的编码缓存"""
    if not filename.endswith(".naiv4vibe"):
        raise HTTPException(status_code=400, detail="无效的文件类型")
    if ".." in filename or "/" in filename or "\\" in filename:
        raise HTTPException(status_code=400, detail="无效的文件名")

    vibe_path = BOT_VIBES_DIR / filename
    if not vibe_path.exists():
        raise HTTPException(status_code=404, detail="Vibe文件不存在")

    # 确定 encoding key
    if "4-5-full" in model or "4-5full" in model:
        enc_key = "v4-5full"
    elif "4-5-curated" in model or "4-5curated" in model:
        enc_key = "v4-5curated"
    elif "4-full" in model or "4full" in model:
        enc_key = "v4full"
    elif "4-curated" in model or "4curated" in model:
        enc_key = "v4curated"
    else:
        raise HTTPException(status_code=400, detail="不支持的模型")

    try:
        async with aiofiles.open(vibe_path, "r", encoding="utf-8") as f:
            data = json.loads(await f.read())

        encodings = data.get("encodings", {})
        model_encodings = encodings.get(enc_key)
        if not model_encodings:
            return {"found": False}

        # 按 information_extracted 匹配
        for entry in model_encodings.values():
            if entry and entry.get("params"):
                if abs(entry["params"].get("information_extracted", -1) - ie) < 0.001:
                    return {"found": True, "encoding": entry["encoding"]}

        return {"found": False}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"读取失败: {e}")


@app.get("/api/vibes/list")
async def get_public_vibes(request: Request, session_id: str = ""):
    """获取公共Vibe列表（需要Bot授权）"""
    _library_principal_from_request(request, session_id)
    
    import json
    
    if not BOT_VIBES_DIR.exists():
        return {"vibes": [], "total": 0}
    
    vibes = []
    for vibe_file in BOT_VIBES_DIR.glob("*.naiv4vibe"):
        try:
            with open(vibe_file, "r", encoding="utf-8") as f:
                data = json.load(f)
            
            # 提取必要信息（不包含完整的 image 和 encoding 数据）
            # 直接使用文件名作为 id，确保唯一性（文件名在文件系统中必然唯一）
            # thumbnail 改为 URL 形式，按需加载
            vibe_info = {
                "id": vibe_file.stem,  # 使用文件名（不含扩展名）作为唯一 id
                "name": data.get("name") or vibe_file.stem,
                "filename": vibe_file.name,
                "thumbnail": f"/api/vibes/thumbnail/{vibe_file.name}",  # 改为 URL
                "supportedModels": list(data.get("encodings", {}).keys()),
                "defaultStrength": (data.get("importInfo") or {}).get("strength"),
                "defaultInfoExtracted": (data.get("importInfo") or {}).get("information_extracted"),
                "createdAt": data.get("createdAt", 0),
                "hasImage": bool(data.get("image")),
                "uploaderId": data.get("uploader_id"),  # 上传者 bot_user_id（旧 vibe 为 None）
                "uploadedAt": data.get("uploaded_at"),
            }
            vibes.append(vibe_info)
        except Exception as e:
            print(f"Error reading vibe file {vibe_file}: {e}")
            continue
    
    # 按创建时间倒序排列
    vibes.sort(key=lambda x: x.get("createdAt", 0), reverse=True)
    
    return {"vibes": vibes, "total": len(vibes)}


@app.get("/api/vibes/thumbnail/{filename}")
async def get_vibe_thumbnail(filename: str, request: StarletteRequest):
    """获取Vibe缩略图"""
    import json
    import base64
    from fastapi.responses import Response

    # 安全检查
    if not filename.endswith(".naiv4vibe"):
        raise HTTPException(status_code=400, detail="无效的文件类型")
    if ".." in filename or "/" in filename or "\\" in filename:
        raise HTTPException(status_code=400, detail="无效的文件名")

    vibe_path = BOT_VIBES_DIR / filename
    if not vibe_path.exists():
        raise HTTPException(status_code=404, detail="Vibe文件不存在")

    # ETag 协商缓存：缩略图嵌在 .naiv4vibe 里，文件 mtime 即缩略图版本
    etag = _file_etag(vibe_path)
    cached = _check_not_modified(request, etag)
    if cached:
        return cached
    quoted_etag = f'"{etag}"'

    try:
        with open(vibe_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        # 优先使用 thumbnail，没有则尝试用 image
        thumbnail = data.get("thumbnail", "") or data.get("image", "")
        if not thumbnail:
            # 没有缩略图，返回 404 让前端显示占位图标
            raise HTTPException(status_code=404, detail="无缩略图")

        # 解析 data URL
        if thumbnail.startswith("data:"):
            # 格式: data:image/jpeg;base64,xxxxx
            header, b64data = thumbnail.split(",", 1)
            media_type = header.split(":")[1].split(";")[0]
            image_data = base64.b64decode(b64data)
            return Response(content=image_data, media_type=media_type,
                            headers={"ETag": quoted_etag, "Cache-Control": "no-cache"})
        else:
            # 纯 base64
            image_data = base64.b64decode(thumbnail)
            return Response(content=image_data, media_type="image/jpeg",
                            headers={"ETag": quoted_etag, "Cache-Control": "no-cache"})
    except HTTPException:
        raise
    except Exception as e:
        # 解析出错，返回 404
        raise HTTPException(status_code=404, detail="缩略图解析失败")


@app.get("/api/vibes/file/{filename}")
async def get_vibe_file(filename: str):
    """获取完整的Vibe文件内容"""
    import json
    
    # 安全检查：只允许 .naiv4vibe 文件
    if not filename.endswith(".naiv4vibe"):
        raise HTTPException(status_code=400, detail="无效的文件类型")
    
    # 防止路径遍历攻击
    if ".." in filename or "/" in filename or "\\" in filename:
        raise HTTPException(status_code=400, detail="无效的文件名")
    
    vibe_path = BOT_VIBES_DIR / filename
    if not vibe_path.exists():
        raise HTTPException(status_code=404, detail="Vibe文件不存在")
    
    try:
        with open(vibe_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"读取Vibe文件失败: {e}")


@app.get("/api/vibes/download/{filename}")
async def download_vibe_file(filename: str):
    """下载Vibe文件（直接返回文件流）"""
    from fastapi.responses import FileResponse
    
    # 安全检查：只允许 .naiv4vibe 文件
    if not filename.endswith(".naiv4vibe"):
        raise HTTPException(status_code=400, detail="无效的文件类型")
    
    # 防止路径遍历攻击
    if ".." in filename or "/" in filename or "\\" in filename:
        raise HTTPException(status_code=400, detail="无效的文件名")
    
    vibe_path = BOT_VIBES_DIR / filename
    if not vibe_path.exists():
        raise HTTPException(status_code=404, detail="Vibe文件不存在")
    
    return FileResponse(
        path=vibe_path,
        filename=filename,
        media_type="application/json"
    )


@app.delete("/api/vibes/file/{filename}")
async def delete_vibe_file(filename: str, request: Request, session_id: str = ""):
    """删除Vibe文件（仅上传者本人可删除）"""
    import os

    # 安全检查：只允许 .naiv4vibe 文件
    if not filename.endswith(".naiv4vibe"):
        raise HTTPException(status_code=400, detail="无效的文件类型")

    # 防止路径遍历攻击
    if ".." in filename or "/" in filename or "\\" in filename:
        raise HTTPException(status_code=400, detail="无效的文件名")

    principal = _library_principal_from_request(request, session_id)

    vibe_path = BOT_VIBES_DIR / filename
    if not vibe_path.exists():
        raise HTTPException(status_code=404, detail="Vibe文件不存在")

    # 校验所有者：仅上传者本人可删除
    try:
        with open(vibe_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"读取Vibe文件失败: {e}")

    _require_library_record_owner(
        principal,
        data,
        legacy_owner_fields=("uploader_id",),
    )

    try:
        os.remove(vibe_path)
        # 失效列表/编码缓存
        global _public_vibe_id_cache, _public_vibe_cache_time
        _public_vibe_id_cache = {}
        _public_vibe_cache_time = 0
        return {"success": True, "message": f"已删除 {filename}"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"删除Vibe文件失败: {e}")


class UploadVibeRequest(BaseModel):
    vibe_data: Dict[str, Any]  # 完整的vibe JSON数据
    name: Optional[str] = None  # 可选的自定义名称
    session_id: str = ""  # v0 compatibility; new clients use X-Bot-Session


@app.post("/api/vibes/upload")
async def upload_vibe_to_public(req: UploadVibeRequest, request: Request):
    """上传Vibe到公共目录（需 Bot 授权，自动记录上传者）"""
    import json

    principal = _library_principal_from_request(request, req.session_id)
    ownership = _library_ownership.stamp(principal)

    # 确保目录存在
    BOT_VIBES_DIR.mkdir(parents=True, exist_ok=True)

    vibe_data = dict(req.vibe_data)

    # 确定文件名
    name = req.name or vibe_data.get("name") or f"vibe_{int(time.time())}"
    # 清理文件名中的非法字符
    safe_name = "".join(c for c in name if c.isalnum() or c in "._- ").strip()
    if not safe_name:
        safe_name = f"vibe_{int(time.time())}"

    filename = f"{safe_name}.naiv4vibe"
    vibe_path = BOT_VIBES_DIR / filename

    # 检查是否已存在
    if vibe_path.exists():
        # 添加时间戳避免冲突
        safe_name = f"{safe_name}_{int(time.time())}"
        filename = f"{safe_name}.naiv4vibe"
        vibe_path = BOT_VIBES_DIR / filename

    # 更新vibe数据中的名称 + 注入上传者元数据
    vibe_data["name"] = safe_name
    vibe_data["uploader_id"] = ownership["owner_id"]
    vibe_data.update(ownership)
    vibe_data["uploaded_at"] = int(time.time())

    try:
        with open(vibe_path, "w", encoding="utf-8") as f:
            json.dump(vibe_data, ensure_ascii=False, indent=2, fp=f)

        # 失效列表/编码缓存
        global _public_vibe_id_cache, _public_vibe_cache_time
        _public_vibe_id_cache = {}
        _public_vibe_cache_time = 0

        return {
            "success": True,
            "message": f"已上传到公共Vibe: {safe_name}",
            "filename": filename,
            "name": safe_name
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"上传Vibe失败: {e}")


class UpdatePublicVibeRequest(BaseModel):
    session_id: str = ""  # v0 compatibility; new clients use X-Bot-Session
    name: Optional[str] = None
    default_strength: Optional[float] = None
    default_info_extracted: Optional[float] = None


@app.put("/api/vibes/file/{filename}")
async def update_public_vibe_meta(
    filename: str,
    req: UpdatePublicVibeRequest,
    request: Request,
):
    """更新公共Vibe元数据（仅上传者本人可改）"""
    import json

    # 安全检查
    if not filename.endswith(".naiv4vibe"):
        raise HTTPException(status_code=400, detail="无效的文件类型")
    if ".." in filename or "/" in filename or "\\" in filename:
        raise HTTPException(status_code=400, detail="无效的文件名")

    principal = _library_principal_from_request(request, req.session_id)

    vibe_path = BOT_VIBES_DIR / filename
    if not vibe_path.exists():
        raise HTTPException(status_code=404, detail="Vibe文件不存在")

    try:
        with open(vibe_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"读取Vibe文件失败: {e}")

    _require_library_record_owner(
        principal,
        data,
        legacy_owner_fields=("uploader_id",),
    )

    # 更新字段
    if req.name is not None:
        data["name"] = req.name
    import_info = data.get("importInfo") or {}
    if req.default_strength is not None:
        import_info["strength"] = req.default_strength
    if req.default_info_extracted is not None:
        import_info["information_extracted"] = req.default_info_extracted
    if import_info:
        data["importInfo"] = import_info
    data["updated_at"] = int(time.time())

    try:
        # 原子写入
        temp_path = vibe_path.with_suffix(".naiv4vibe.tmp")
        with open(temp_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        temp_path.replace(vibe_path)

        # 失效缓存
        global _public_vibe_id_cache, _public_vibe_cache_time
        _public_vibe_id_cache = {}
        _public_vibe_cache_time = 0

        return {
            "success": True,
            "message": "已更新",
            "filename": filename,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"更新Vibe文件失败: {e}")


# ==================== 用户 Vibe 云同步 API ====================
# 按 bot_user_id 隔离存储，仅本人可见可改

USER_VIBES_DIR = BOT_DATA_DIR / "user_vibes"
_library_ownership = LibraryOwnershipService()
_private_library = OwnerScopedLibraryStorage(USER_VIBES_DIR, _library_ownership)


def _user_vibes_dir_for(principal: Principal) -> Path:
    """Resolve a private library namespace from verified owner/tenant identity."""
    return _private_library.namespace(principal)


def _validate_vibe_filename(filename: str) -> None:
    """校验 vibe 文件名，禁止路径遍历"""
    if not filename.endswith(".naiv4vibe"):
        raise HTTPException(status_code=400, detail="无效的文件类型")
    if ".." in filename or "/" in filename or "\\" in filename:
        raise HTTPException(status_code=400, detail="无效的文件名")


@app.get("/api/user-vibes/list")
async def get_user_vibes(request: Request, session_id: str = ""):
    """列出当前用户云端所有 vibe 的元数据"""
    principal = _library_principal_from_request(request, session_id)
    user_dir = _user_vibes_dir_for(principal)
    thumbnail_credential = (
        "" if request.headers.get("X-Bot-Session") else f"?session_id={session_id}"
    )

    vibes = []
    for vibe_file in user_dir.glob("*.naiv4vibe"):
        try:
            with open(vibe_file, "r", encoding="utf-8") as f:
                data = json.load(f)
            image_hash, meta_hash = _compute_vibe_hashes(data)
            vibes.append({
                "id": data.get("id") or vibe_file.stem,
                "name": data.get("name") or vibe_file.stem,
                "filename": vibe_file.name,
                "thumbnail": (
                    f"/api/user-vibes/thumbnail/{vibe_file.name}{thumbnail_credential}"
                ),
                "supportedModels": list(data.get("encodings", {}).keys()),
                "defaultStrength": (data.get("importInfo") or {}).get("strength"),
                "defaultInfoExtracted": (data.get("importInfo") or {}).get("information_extracted"),
                "createdAt": data.get("createdAt", 0),
                "updatedAt": data.get("updated_at", 0),
                "tags": data.get("tags") or [],
                "hasImage": bool(data.get("image")),
                "image_hash": image_hash,
                "meta_hash": meta_hash,
            })
        except Exception as e:
            print(f"[user-vibes] 读取 {vibe_file} 失败: {e}")
            continue

    vibes.sort(key=lambda x: x.get("updatedAt", 0) or x.get("createdAt", 0), reverse=True)
    return {"vibes": vibes, "total": len(vibes)}


@app.get("/api/user-vibes/state")
async def get_user_vibes_state(request: Request, session_id: str = ""):
    """返回用户云端 vibe 的统计信息（用于增量轮询）"""
    principal = _library_principal_from_request(request, session_id)
    user_dir = _user_vibes_dir_for(principal)

    count = 0
    latest_updated = 0
    for vibe_file in user_dir.glob("*.naiv4vibe"):
        count += 1
        try:
            mtime = int(vibe_file.stat().st_mtime)
            if mtime > latest_updated:
                latest_updated = mtime
        except Exception:
            continue

    return {"count": count, "updated_at": latest_updated}


@app.get("/api/user-vibes/file/{filename}")
async def get_user_vibe_file(filename: str, request: Request, session_id: str = ""):
    """获取完整的用户 vibe 文件"""
    _validate_vibe_filename(filename)
    principal = _library_principal_from_request(request, session_id)
    user_dir = _user_vibes_dir_for(principal)

    vibe_path = user_dir / filename
    if not vibe_path.exists():
        raise HTTPException(status_code=404, detail="Vibe文件不存在")

    try:
        with open(vibe_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"读取Vibe文件失败: {e}")


@app.get("/api/user-vibes/thumbnail/{filename}")
async def get_user_vibe_thumbnail(filename: str, request: StarletteRequest, session_id: str = ""):
    """获取用户 vibe 的缩略图"""
    import base64 as _b64
    from fastapi.responses import Response

    _validate_vibe_filename(filename)
    principal = _library_principal_from_request(request, session_id)
    user_dir = _user_vibes_dir_for(principal)

    vibe_path = user_dir / filename
    if not vibe_path.exists():
        raise HTTPException(status_code=404, detail="Vibe文件不存在")

    # ETag 协商缓存：缩略图嵌在 .naiv4vibe 里，文件 mtime 即缩略图版本
    etag = _file_etag(vibe_path)
    cached = _check_not_modified(request, etag)
    if cached:
        return cached
    quoted_etag = f'"{etag}"'

    try:
        with open(vibe_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        thumbnail = data.get("thumbnail", "") or data.get("image", "")
        if not thumbnail:
            raise HTTPException(status_code=404, detail="无缩略图")

        if thumbnail.startswith("data:"):
            header, b64data = thumbnail.split(",", 1)
            media_type = header.split(":")[1].split(";")[0]
            image_data = _b64.b64decode(b64data)
            return Response(content=image_data, media_type=media_type,
                            headers={"ETag": quoted_etag, "Cache-Control": "no-cache"})
        else:
            image_data = _b64.b64decode(thumbnail)
            return Response(content=image_data, media_type="image/jpeg",
                            headers={"ETag": quoted_etag, "Cache-Control": "no-cache"})
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=404, detail="缩略图解析失败")


class UploadUserVibeRequest(BaseModel):
    session_id: str = ""  # v0 compatibility; new clients use X-Bot-Session
    vibe_data: Dict[str, Any]
    tags: Optional[List[str]] = None
    filename: Optional[str] = None  # 客户端可指定文件名（覆盖更新）


@app.post("/api/user-vibes/upload")
async def upload_user_vibe(req: UploadUserVibeRequest, request: Request):
    """推送本地 vibe 到用户云端目录"""
    principal = _library_principal_from_request(request, req.session_id)
    user_dir = _user_vibes_dir_for(principal)

    vibe_data = dict(req.vibe_data)
    name = vibe_data.get("name") or f"vibe_{int(time.time())}"
    safe_name = "".join(c for c in str(name) if c.isalnum() or c in "._- ").strip()
    if not safe_name:
        safe_name = f"vibe_{int(time.time())}"

    if req.filename:
        # 客户端指定文件名（更新场景）
        _validate_vibe_filename(req.filename)
        filename = req.filename
    else:
        filename = f"{safe_name}.naiv4vibe"
        vibe_path_check = user_dir / filename
        # 同名文件已存在则改名
        if vibe_path_check.exists():
            existing_id = None
            try:
                with open(vibe_path_check, "r", encoding="utf-8") as f:
                    existing_id = json.load(f).get("id")
            except Exception:
                pass
            # 若 id 相同视为同一 vibe，覆盖更新；否则加时间戳
            if existing_id != vibe_data.get("id"):
                safe_name = f"{safe_name}_{int(time.time())}"
                filename = f"{safe_name}.naiv4vibe"

    vibe_path = user_dir / filename

    # 注入元数据
    vibe_data["name"] = safe_name if not req.filename else vibe_data.get("name", safe_name)
    if req.tags is not None:
        vibe_data["tags"] = req.tags
    elif "tags" not in vibe_data:
        vibe_data["tags"] = []
    vibe_data["updated_at"] = int(time.time())
    vibe_data.setdefault("createdAt", int(time.time() * 1000))

    try:
        # 原子写入
        temp_path = vibe_path.with_suffix(".naiv4vibe.tmp")
        with open(temp_path, "w", encoding="utf-8") as f:
            json.dump(vibe_data, f, ensure_ascii=False)
        temp_path.replace(vibe_path)

        image_hash, meta_hash = _compute_vibe_hashes(vibe_data)
        return {
            "success": True,
            "filename": filename,
            "name": vibe_data["name"],
            "updated_at": vibe_data["updated_at"],
            "image_hash": image_hash,
            "meta_hash": meta_hash,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"保存云端 Vibe 失败: {e}")


class UpdateUserVibeRequest(BaseModel):
    session_id: str = ""  # v0 compatibility; new clients use X-Bot-Session
    name: Optional[str] = None
    tags: Optional[List[str]] = None
    default_strength: Optional[float] = None
    default_info_extracted: Optional[float] = None


@app.put("/api/user-vibes/file/{filename}")
async def update_user_vibe_meta(
    filename: str,
    req: UpdateUserVibeRequest,
    request: Request,
):
    """更新用户云端 vibe 的元数据（标签/名称/默认参数）"""
    _validate_vibe_filename(filename)
    principal = _library_principal_from_request(request, req.session_id)
    user_dir = _user_vibes_dir_for(principal)

    vibe_path = user_dir / filename
    if not vibe_path.exists():
        raise HTTPException(status_code=404, detail="Vibe文件不存在")

    try:
        with open(vibe_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"读取Vibe文件失败: {e}")

    if req.name is not None:
        data["name"] = req.name
    if req.tags is not None:
        data["tags"] = req.tags
    import_info = data.get("importInfo") or {}
    if req.default_strength is not None:
        import_info["strength"] = req.default_strength
    if req.default_info_extracted is not None:
        import_info["information_extracted"] = req.default_info_extracted
    if import_info:
        data["importInfo"] = import_info
    data["updated_at"] = int(time.time())

    try:
        temp_path = vibe_path.with_suffix(".naiv4vibe.tmp")
        with open(temp_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        temp_path.replace(vibe_path)
        image_hash, meta_hash = _compute_vibe_hashes(data)
        return {
            "success": True,
            "updated_at": data["updated_at"],
            "image_hash": image_hash,
            "meta_hash": meta_hash,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"更新Vibe文件失败: {e}")


@app.delete("/api/user-vibes/file/{filename}")
async def delete_user_vibe(filename: str, request: Request, session_id: str = ""):
    """删除用户云端 vibe"""
    import os as _os
    _validate_vibe_filename(filename)
    principal = _library_principal_from_request(request, session_id)
    user_dir = _user_vibes_dir_for(principal)

    vibe_path = user_dir / filename
    if not vibe_path.exists():
        raise HTTPException(status_code=404, detail="Vibe文件不存在")

    try:
        _os.remove(vibe_path)
        return {"success": True, "message": f"已删除 {filename}"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"删除Vibe文件失败: {e}")


# ==================== 云同步 v2 基础设施 ====================
# 阶段 1：版本检查 + 墓碑 + 标签池 + content_hash

# 同步协议版本：客户端必须支持的最低后端版本
SYNC_PROTOCOL_VERSION = 2
# 墓碑过期时间（秒）
TOMBSTONE_TTL_SECONDS = 30 * 24 * 60 * 60


def _tombstones_path(principal: Principal) -> Path:
    return _user_vibes_dir_for(principal) / "tombstones.json"


def _tag_pool_path(principal: Principal) -> Path:
    return _user_vibes_dir_for(principal) / "tag_pool.json"


def _atomic_write_json(path: Path, data: Any) -> None:
    """原子写 JSON 文件：temp + rename，避免中途崩溃留下损坏文件"""
    temp_path = path.with_suffix(path.suffix + ".tmp")
    with open(temp_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    temp_path.replace(path)


def _load_tombstones(principal: Principal) -> List[dict]:
    """读取墓碑列表，自动过滤过期项；解析失败抛 500，绝不返回错误数据"""
    path = _tombstones_path(principal)
    if not path.exists():
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, list):
            raise ValueError("tombstones.json 不是数组")
        now = int(time.time())
        active = [
            t for t in data
            if isinstance(t, dict)
            and isinstance(t.get("id"), str)
            and isinstance(t.get("deleted_at"), (int, float))
            and (now - int(t["deleted_at"])) < TOMBSTONE_TTL_SECONDS
        ]
        return active
    except Exception as e:
        # 严格：解析失败 → 拒绝 sync，不返回错误墓碑数据
        raise HTTPException(status_code=500, detail=f"墓碑文件损坏: {e}")


def _save_tombstones(principal: Principal, tombstones: List[dict]) -> None:
    _atomic_write_json(_tombstones_path(principal), tombstones)


def _compute_vibe_hashes(data: dict) -> Tuple[str, str]:
    """
    为一个 vibe 计算两个 hash：
    - image_hash：仅 image+encodings（用来判断要不要重传 image）
    - meta_hash：所有元数据（用来判断要不要拉新版本）
    """
    import hashlib
    image_payload = json.dumps(
        {
            "image": data.get("image", ""),
            "encodings": data.get("encodings", {}),
        },
        sort_keys=True,
        ensure_ascii=False,
    ).encode("utf-8")
    image_hash = hashlib.sha256(image_payload).hexdigest()

    meta_payload = json.dumps(
        {
            "id": data.get("id", ""),
            "name": data.get("name", ""),
            "tags": sorted(data.get("tags") or []),
            "importInfo": data.get("importInfo") or {},
            "image_hash": image_hash,
        },
        sort_keys=True,
        ensure_ascii=False,
    ).encode("utf-8")
    meta_hash = hashlib.sha256(meta_payload).hexdigest()

    return image_hash, meta_hash


@app.get("/api/sync/version")
async def get_sync_version():
    """返回云同步协议版本号，前端用于兼容性检查"""
    return {"version": SYNC_PROTOCOL_VERSION}


# ── 墓碑 ──────────────────────────────────────────────────────────────────────

class AddTombstoneRequest(BaseModel):
    session_id: str = ""  # v0 compatibility; new clients use X-Bot-Session
    vibe_id: str


@app.get("/api/user-vibes/tombstones")
async def get_tombstones(request: Request, session_id: str = ""):
    """获取当前用户活跃墓碑列表（已自动过滤 30 天前的）"""
    principal = _library_principal_from_request(request, session_id)
    tombstones = _load_tombstones(principal)
    return {"tombstones": tombstones}


@app.post("/api/user-vibes/tombstones")
async def add_tombstone(req: AddTombstoneRequest, request: Request):
    """追加一条墓碑（用户主动删除 vibe 时调用），同时清理过期项"""
    principal = _library_principal_from_request(request, req.session_id)
    if not req.vibe_id:
        raise HTTPException(status_code=400, detail="vibe_id 不能为空")

    # 读取时已自动过滤过期项 → 写回时顺便清理一次
    tombstones = _load_tombstones(principal)
    # 去重：同 id 只保留最新
    tombstones = [t for t in tombstones if t.get("id") != req.vibe_id]
    tombstones.append({"id": req.vibe_id, "deleted_at": int(time.time())})
    try:
        _save_tombstones(principal, tombstones)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"写墓碑失败: {e}")
    return {"success": True, "active_count": len(tombstones)}


# ── 标签池 ────────────────────────────────────────────────────────────────────

class PutTagPoolRequest(BaseModel):
    session_id: str = ""  # v0 compatibility; new clients use X-Bot-Session
    tags: List[str]


def _load_tag_pool(principal: Principal) -> List[str]:
    path = _tag_pool_path(principal)
    if not path.exists():
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, list):
            return []
        # 严格过滤：只保留非空字符串
        return [t for t in data if isinstance(t, str) and t]
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"标签池文件损坏: {e}")


@app.get("/api/user-vibes/tag-pool")
async def get_tag_pool(request: Request, session_id: str = ""):
    """获取当前用户的云端标签池"""
    principal = _library_principal_from_request(request, session_id)
    return {"tags": _load_tag_pool(principal)}


@app.put("/api/user-vibes/tag-pool")
async def put_tag_pool(req: PutTagPoolRequest, request: Request):
    """整体覆盖云端标签池（云端为真相策略）"""
    principal = _library_principal_from_request(request, req.session_id)
    # 严格过滤
    cleaned = sorted(set(t for t in req.tags if isinstance(t, str) and t))
    try:
        _atomic_write_json(_tag_pool_path(principal), cleaned)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"写标签池失败: {e}")
    return {"success": True, "count": len(cleaned)}


# ── 备份记录 ──────────────────────────────────────────────────────────────────

BACKUP_LOG_MAX = 20  # 最多保留 20 条记录


def _backup_log_path(principal: Principal) -> Path:
    return _user_vibes_dir_for(principal) / "backup_log.json"


def _load_backup_log(principal: Principal) -> List[dict]:
    path = _backup_log_path(principal)
    if not path.exists():
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, list):
            return []
        return data
    except Exception:
        return []


class RecordBackupRequest(BaseModel):
    session_id: str = ""  # v0 compatibility; new clients use X-Bot-Session
    device: str = "未知设备"
    action: str = "backup"  # "backup" | "restore"
    vibe_count: int = 0
    detail: str = ""


@app.get("/api/user-vibes/backup-log")
async def get_backup_log(request: Request, session_id: str = ""):
    """获取备份/恢复操作记录"""
    principal = _library_principal_from_request(request, session_id)
    return {"log": _load_backup_log(principal)}


@app.post("/api/user-vibes/backup-log")
async def record_backup(req: RecordBackupRequest, request: Request):
    """记录一次备份/恢复操作"""
    principal = _library_principal_from_request(request, req.session_id)
    log = _load_backup_log(principal)
    log.insert(0, {
        "device": req.device[:50],  # 限制长度
        "action": req.action,
        "time": int(time.time()),
        "vibe_count": req.vibe_count,
        "detail": req.detail[:200],
    })
    log = log[:BACKUP_LOG_MAX]
    try:
        _atomic_write_json(_backup_log_path(principal), log)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"写备份记录失败: {e}")
    return {"success": True}


# ── 画师串个人备份 ─────────────────────────────────────────────────────────────

def _user_artists_backup_path(principal: Principal) -> Path:
    return _user_vibes_dir_for(principal) / "artists_backup.json"


class UploadArtistsBackupRequest(BaseModel):
    session_id: str = ""  # v0 compatibility; new clients use X-Bot-Session
    artists: List[Dict[str, Any]]


@app.get("/api/user-artists/backup")
async def get_artists_backup(request: Request, session_id: str = ""):
    """获取用户云端画师串备份"""
    principal = _library_principal_from_request(request, session_id)
    path = _user_artists_backup_path(principal)
    if not path.exists():
        return {"artists": [], "updated_at": 0}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return {
            "artists": data.get("artists", []),
            "updated_at": data.get("updated_at", 0),
            "count": len(data.get("artists", [])),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"读取画师串备份失败: {e}")


@app.post("/api/user-artists/backup")
async def upload_artists_backup(req: UploadArtistsBackupRequest, request: Request):
    """上传画师串备份（整体覆盖）

    向后兼容: 旧客户端 (ArtistCloudManageModal) 仍走此接口。
    为避免与新统一备份 (tag_manager_backup.json) 不同步,这里同时把
    artist-style 槽位写回新文件,保留其它分类数据。
    """
    principal = _library_principal_from_request(request, req.session_id)
    now_ts = int(time.time())
    data = {
        "artists": req.artists,
        "updated_at": now_ts,
        "count": len(req.artists),
    }
    try:
        _atomic_write_json(_user_artists_backup_path(principal), data)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"保存画师串备份失败: {e}")
    # 同步到新统一备份文件的 artist-style 槽位
    try:
        new_path = _user_tag_backup_path(principal)
        if new_path.exists():
            with open(new_path, "r", encoding="utf-8") as f:
                existing = json.load(f)
            categories = existing.get("categories") or _empty_tag_categories()
            for cat in _TAG_BACKUP_CATEGORIES:
                if cat not in categories or not isinstance(categories[cat], list):
                    categories[cat] = []
        else:
            categories = _empty_tag_categories()
        categories["artist-style"] = req.artists
        _atomic_write_json(new_path, {
            "categories": categories,
            "updated_at": now_ts,
        })
    except Exception:
        # 同步失败不影响主流程; 新模态下次打开会通过迁移逻辑读到旧文件作为兜底
        pass
    return {"success": True, "count": len(req.artists), "updated_at": now_ts}


# ── tag-manager 4 类统一云端备份 ───────────────────────────────────────────────
# 一次性备份/恢复 character / artist-style / scene / other 四类本地数据
# 落盘文件 tag_manager_backup.json,结构: {categories: {...}, updated_at}
# 兼容旧 artists_backup.json: 若新文件不存在 + 旧文件存在,把旧画风数据并入返回

_TAG_BACKUP_CATEGORIES = ("character", "artist-style", "scene", "other")


def _user_tag_backup_path(principal: Principal) -> Path:
    return _user_vibes_dir_for(principal) / "tag_manager_backup.json"


def _empty_tag_categories() -> Dict[str, List[Dict[str, Any]]]:
    return {cat: [] for cat in _TAG_BACKUP_CATEGORIES}


class UploadTagBackupRequest(BaseModel):
    session_id: str = ""  # v0 compatibility; new clients use X-Bot-Session
    categories: Dict[str, List[Dict[str, Any]]]


@app.get("/api/user-tag-backup")
async def get_tag_backup(request: Request, session_id: str = ""):
    """获取用户云端 tag-manager 备份(全 4 类)"""
    principal = _library_principal_from_request(request, session_id)
    path = _user_tag_backup_path(principal)
    if not path.exists():
        # 兼容: 把旧画风备份并入返回,首次写入时会自动迁移
        legacy = _user_artists_backup_path(principal)
        if legacy.exists():
            try:
                with open(legacy, "r", encoding="utf-8") as f:
                    legacy_data = json.load(f)
                categories = _empty_tag_categories()
                categories["artist-style"] = legacy_data.get("artists", []) or []
                return {
                    "categories": categories,
                    "updated_at": legacy_data.get("updated_at", 0),
                    "counts": {k: len(v) for k, v in categories.items()},
                }
            except Exception:
                pass
        empty = _empty_tag_categories()
        return {"categories": empty, "updated_at": 0, "counts": {k: 0 for k in empty}}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        raw_categories = data.get("categories") or {}
        categories = _empty_tag_categories()
        for cat in _TAG_BACKUP_CATEGORIES:
            items = raw_categories.get(cat)
            if isinstance(items, list):
                categories[cat] = items
        return {
            "categories": categories,
            "updated_at": data.get("updated_at", 0),
            "counts": {k: len(v) for k, v in categories.items()},
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"读取 tag 备份失败: {e}")


@app.post("/api/user-tag-backup")
async def upload_tag_backup(req: UploadTagBackupRequest, request: Request):
    """上传 tag-manager 备份(整体覆盖 4 类)"""
    principal = _library_principal_from_request(request, req.session_id)
    categories = _empty_tag_categories()
    for cat in _TAG_BACKUP_CATEGORIES:
        items = req.categories.get(cat)
        if isinstance(items, list):
            categories[cat] = items
    data = {
        "categories": categories,
        "updated_at": int(time.time()),
    }
    try:
        _atomic_write_json(_user_tag_backup_path(principal), data)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"保存 tag 备份失败: {e}")
    # 同步把画风数据写到旧 artists_backup.json,保持向后兼容 (老代码仍能读到)
    try:
        artist_items = categories["artist-style"]
        _atomic_write_json(_user_artists_backup_path(principal), {
            "artists": artist_items,
            "updated_at": data["updated_at"],
            "count": len(artist_items),
        })
    except Exception:
        pass
    return {
        "success": True,
        "updated_at": data["updated_at"],
        "counts": {k: len(v) for k, v in categories.items()},
    }


# ==================== 公共画师串 API ====================

# 画师串数据文件路径
ARTIST_STRINGS_PATH = BOT_DATA_DIR / "artist_strings.json"
ARTIST_IMAGES_DIR = BOT_DATA_DIR / "artist_images"


async def _load_artist_data() -> dict:
    """加载画师串数据（安全读取，带备份恢复）"""
    return await _artist_store.load()


async def _save_artist_data(data: dict) -> bool:
    """保存画师串数据（原子写入，带备份）"""
    return await _artist_store.save(data)


@app.get("/api/artists/list")
async def get_public_artists(request: Request, session_id: str = ""):
    """获取公共画师串列表（需要Bot授权）"""
    _library_principal_from_request(request, session_id)
    
    artist_data = await _load_artist_data()
    
    artists = []
    for name, record in artist_data.items():
        preview_image = record.get("preview_image", "")
        # 构建预览图URL
        preview_url = None
        if preview_image:
            # 提取文件名
            preview_filename = Path(preview_image).name
            preview_url = f"/api/artists/preview/{preview_filename}"
        
        artists.append({
            "id": name,
            "name": name,
            "artist_string": record.get("artist_string", ""),
            "negative": record.get("negative", ""),
            "preview_url": preview_url,
            "usage_count": record.get("usage_count", 0),
            "created_time": record.get("created_time", 0),
            "created_time_str": record.get("created_time_str", ""),
            "added_by": record.get("added_by"),
        })
    
    # 按名称排序
    artists.sort(key=lambda x: x["name"])
    
    return {"artists": artists, "total": len(artists)}


@app.get("/api/artists/preview/{filename}")
async def get_artist_preview(filename: str, request: StarletteRequest):
    """获取画师串预览图"""
    # 防止路径遍历攻击
    if ".." in filename or "/" in filename or "\\" in filename:
        raise HTTPException(status_code=400, detail="无效的文件名")

    # 在artist_images目录中查找
    preview_path = ARTIST_IMAGES_DIR / filename
    if not preview_path.exists():
        raise HTTPException(status_code=404, detail="预览图不存在")

    # 根据扩展名确定媒体类型
    suffix = preview_path.suffix.lower()
    media_type = "image/jpeg" if suffix in [".jpg", ".jpeg"] else "image/png"

    # ETag 协商缓存：二次请求只回 304 ~200B
    etag = _file_etag(preview_path)
    cached = _check_not_modified(request, etag)
    if cached:
        return cached
    return FileResponse(
        preview_path,
        media_type=media_type,
        headers={"ETag": f'"{etag}"', "Cache-Control": "no-cache"},
    )


@app.get("/api/artists/{artist_name}")
async def get_artist(artist_name: str):
    """获取单个画师串详情"""
    artist_data = await _load_artist_data()
    
    if artist_name not in artist_data:
        raise HTTPException(status_code=404, detail="画师串不存在")
    
    record = artist_data[artist_name]
    preview_image = record.get("preview_image", "")
    preview_url = None
    if preview_image:
        preview_filename = Path(preview_image).name
        preview_url = f"/api/artists/preview/{preview_filename}"
    
    return {
        "id": artist_name,
        "name": artist_name,
        "artist_string": record.get("artist_string", ""),
        "negative": record.get("negative", ""),
        "preview_url": preview_url,
        "usage_count": record.get("usage_count", 0),
        "created_time": record.get("created_time", 0),
        "created_time_str": record.get("created_time_str", ""),
        "added_by": record.get("added_by"),
    }


class CreateArtistRequest(BaseModel):
    name: Optional[str] = None  # 可选，不提供则自动生成
    artist_string: str
    negative: Optional[str] = None  # 画风负面提示词（可选）
    preview_base64: Optional[str] = None
    added_by: Optional[str] = None
    session_id: str = ""  # v0 compatibility; new clients use X-Bot-Session


class UpdateArtistRequest(BaseModel):
    artist_string: Optional[str] = None
    negative: Optional[str] = None  # 画风负面提示词（可选）
    preview_base64: Optional[str] = None
    added_by: Optional[str] = None  # 用于转让所有者:传入新用户 ID
    session_id: str = ""  # v0 compatibility; new clients use X-Bot-Session


def _get_next_artist_name(artist_data: dict) -> str:
    """获取下一个可用的画师串名称（A1-A9, B1-B9...）"""
    existing_names = set(artist_data.keys())
    
    # 按字母顺序生成名称
    for letter_ord in range(ord('A'), ord('Z') + 1):
        letter = chr(letter_ord)
        for number in range(1, 10):
            name = f"{letter}{number}"
            if name not in existing_names:
                return name
    
    # 如果A-Z都用完了，继续用AA1-AA9, AB1-AB9...
    for first_letter_ord in range(ord('A'), ord('Z') + 1):
        for second_letter_ord in range(ord('A'), ord('Z') + 1):
            first_letter = chr(first_letter_ord)
            second_letter = chr(second_letter_ord)
            for number in range(1, 10):
                name = f"{first_letter}{second_letter}{number}"
                if name not in existing_names:
                    return name
    
    # 理论上不应该到这里
    import time as t
    return f"CUSTOM_{int(t.time())}"


def _save_artist_preview_image(name: str, base64_data: str) -> Optional[str]:
    """保存画师串预览图"""
    import base64
    
    # 确保目录存在
    ARTIST_IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    
    try:
        # 移除 data:image/xxx;base64, 前缀
        if "," in base64_data:
            base64_data = base64_data.split(",", 1)[1]
        
        image_data = base64.b64decode(base64_data)

        # 保存为jpg（清洗文件名，杜绝路径穿越写入）
        import re as _re
        safe_name = _re.sub(r"[^A-Za-z0-9_-]", "_", name) or "artist"
        timestamp = int(time.time() * 1000)
        filename = f"artist_preview_{safe_name}_{timestamp}.jpg"
        filepath = ARTIST_IMAGES_DIR / filename
        
        with open(filepath, "wb") as f:
            f.write(image_data)
        
        return str(filepath)
    except Exception as e:
        print(f"保存画师串预览图失败: {e}")
        return None


@app.post("/api/artists/create")
async def create_artist(req: CreateArtistRequest, request: Request):
    """创建新画师串"""
    principal = _library_principal_from_request(request, req.session_id)
    ownership = _library_ownership.stamp(principal)
    artist_data = await _load_artist_data()
    
    # 确定名称
    if req.name:
        name = req.name.upper()
        if name in artist_data:
            raise HTTPException(status_code=400, detail=f"画师串 '{name}' 已存在")
    else:
        name = _get_next_artist_name(artist_data)

    # 内容查重：仅当存在“完全相同（内容与顺序一模一样）”的画师串时才拒绝，其余不做任何相似度判断
    new_norm = (req.artist_string or "").strip()
    dup_names = [n for n, rec in artist_data.items()
                 if isinstance(rec, dict) and (rec.get("artist_string") or "").strip() == new_norm]
    if dup_names:
        raise HTTPException(status_code=400, detail=f"已存在完全相同的画师串：{', '.join(dup_names)}")

    # 保存预览图
    preview_path = None
    if req.preview_base64:
        preview_path = _save_artist_preview_image(name, req.preview_base64)
    
    # 创建记录
    artist_record = {
        "name": name,
        "artist_string": req.artist_string,
        "negative": req.negative or "",
        "preview_image": preview_path,
        "created_time": int(time.time()),
        "created_time_str": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime()),
        "usage_count": 0,
        "last_used": None,
        "added_by": ownership["owner_id"],
        **ownership,
    }
    
    artist_data[name] = artist_record
    
    if not await _save_artist_data(artist_data):
        raise HTTPException(status_code=500, detail="保存画师串数据失败")
    
    preview_url = None
    if preview_path:
        preview_filename = Path(preview_path).name
        preview_url = f"/api/artists/preview/{preview_filename}"
    
    return {
        "success": True,
        "message": f"画师串 '{name}' 创建成功",
        "artist": {
            "id": name,
            "name": name,
            "artist_string": req.artist_string,
            "negative": artist_record["negative"],
            "preview_url": preview_url,
            "usage_count": 0,
            "created_time": artist_record["created_time"],
            "created_time_str": artist_record["created_time_str"],
            "added_by": artist_record["added_by"],
        }
    }


@app.put("/api/artists/{artist_name}")
async def update_artist(artist_name: str, req: UpdateArtistRequest, request: Request):
    """更新画师串"""
    principal = _library_principal_from_request(request, req.session_id)
    artist_data = await _load_artist_data()
    
    if artist_name not in artist_data:
        raise HTTPException(status_code=404, detail="画师串不存在")
    
    record = artist_data[artist_name]
    _require_library_record_owner(
        principal,
        record,
        # added_by was historically client supplied and cannot establish owner.
        legacy_owner_fields=(),
    )
    
    # 更新字段
    if req.artist_string is not None:
        record["artist_string"] = req.artist_string
    if req.negative is not None:
        record["negative"] = req.negative
    # added_by remains accepted for v0 decoding only; ownership is immutable.

    # 更新预览图
    if req.preview_base64:
        # 删除旧预览图
        old_preview = record.get("preview_image")
        if old_preview and Path(old_preview).exists():
            try:
                import os
                os.remove(old_preview)
            except:
                pass
        
        preview_path = _save_artist_preview_image(artist_name, req.preview_base64)
        if preview_path:
            record["preview_image"] = preview_path
    
    artist_data[artist_name] = record
    
    if not await _save_artist_data(artist_data):
        raise HTTPException(status_code=500, detail="保存画师串数据失败")
    
    preview_url = None
    if record.get("preview_image"):
        preview_filename = Path(record["preview_image"]).name
        preview_url = f"/api/artists/preview/{preview_filename}"
    
    return {
        "success": True,
        "message": f"画师串 '{artist_name}' 更新成功",
        "artist": {
            "id": artist_name,
            "name": artist_name,
            "artist_string": record.get("artist_string", ""),
            "negative": record.get("negative", ""),
            "preview_url": preview_url,
            "usage_count": record.get("usage_count", 0),
            "created_time": record.get("created_time", 0),
            "created_time_str": record.get("created_time_str", ""),
            "added_by": record.get("added_by"),
        }
    }


@app.delete("/api/artists/{artist_name}")
async def delete_artist_api(artist_name: str, request: Request, session_id: str = ""):
    """删除画师串"""
    import os

    principal = _library_principal_from_request(request, session_id)
    
    artist_data = await _load_artist_data()
    
    if artist_name not in artist_data:
        raise HTTPException(status_code=404, detail="画师串不存在")
    
    record = artist_data[artist_name]
    _require_library_record_owner(
        principal,
        record,
        legacy_owner_fields=(),
    )
    
    # 删除预览图文件
    preview_image = record.get("preview_image")
    if preview_image and Path(preview_image).exists():
        try:
            os.remove(preview_image)
        except Exception as e:
            print(f"删除预览图失败: {e}")
    
    # 从数据中删除
    del artist_data[artist_name]
    
    if not await _save_artist_data(artist_data):
        raise HTTPException(status_code=500, detail="保存画师串数据失败")
    
    return {
        "success": True,
        "message": f"画师串 '{artist_name}' 已删除"
    }


@app.post("/api/artists/{artist_name}/use")
async def use_artist(artist_name: str, request: Request, session_id: str = ""):
    """记录画师串使用（增加使用次数）"""
    _library_principal_from_request(request, session_id)
    artist_data = await _load_artist_data()
    
    if artist_name not in artist_data:
        raise HTTPException(status_code=404, detail="画师串不存在")
    
    record = artist_data[artist_name]
    record["usage_count"] = record.get("usage_count", 0) + 1
    record["last_used"] = int(time.time())
    
    artist_data[artist_name] = record
    await _save_artist_data(artist_data)
    
    return {"success": True, "usage_count": record["usage_count"]}


if __name__ == "__main__":
    import uvicorn
    # Secure default: bind to loopback. Use run.py --host 0.0.0.0 to expose on the LAN.
    uvicorn.run(app, host="127.0.0.1", port=8765)


# ==================== 公共 CR 管理 API ====================

CR_DATA_FILE = BOT_DATA_DIR / "cr_data.json"
CR_IMAGES_DIR = BOT_DATA_DIR / "cr_images"


async def _load_cr_data() -> dict:
    """加载CR数据（安全读取，带备份恢复）"""
    return await _cr_store.load()


async def _save_cr_data(data: dict) -> bool:
    """保存CR数据（原子写入，带备份）"""
    return await _cr_store.save(data)


@app.get("/api/cr/list")
async def get_cr_list():
    """获取公共CR列表"""
    cr_data = await _load_cr_data()
    
    crs = []
    for cr_id, record in cr_data.items():
        preview_url = f"/api/cr/preview/{cr_id}" if record.get("image_file") else None
        crs.append({
            "id": cr_id,
            "name": record.get("name", cr_id),
            "zh_names": record.get("zh_names", []),  # 中文名称列表（用于匹配）
            "preview_url": preview_url,
            "created_time": record.get("created_time", 0),
        })
    
    # 按创建时间倒序
    crs.sort(key=lambda x: x["created_time"], reverse=True)
    
    return {"crs": crs, "total": len(crs)}


@app.get("/api/cr/preview/{cr_id}")
async def get_cr_preview(cr_id: str, request: StarletteRequest):
    """获取CR预览图"""
    cr_data = await _load_cr_data()

    if cr_id not in cr_data:
        raise HTTPException(status_code=404, detail="CR不存在")

    record = cr_data[cr_id]
    image_file = record.get("image_file")

    if not image_file:
        raise HTTPException(status_code=404, detail="预览图不存在")

    full_path = CR_IMAGES_DIR / image_file
    if not full_path.exists():
        raise HTTPException(status_code=404, detail="预览图文件不存在")

    # ETag 协商缓存：二次请求只回 304 ~200B
    etag = _file_etag(full_path)
    cached = _check_not_modified(request, etag)
    if cached:
        return cached
    return FileResponse(
        full_path,
        media_type="image/png",
        headers={"ETag": f'"{etag}"', "Cache-Control": "no-cache"},
    )


class CreateCRRequest(BaseModel):
    name: str
    image_base64: str  # base64编码的图片
    zh_names: list[str] = Field(default_factory=list)  # 中文名称列表（用于Bot匹配）
    session_id: str = ""  # v0 compatibility; new clients use X-Bot-Session


@app.post("/api/cr/create")
async def create_cr(req: CreateCRRequest, request: Request):
    """创建新的公共CR"""
    import base64
    import os

    principal = _library_principal_from_request(request, req.session_id)
    ownership = _library_ownership.stamp(principal)
    
    cr_data = await _load_cr_data()
    
    # 生成唯一ID
    cr_id = f"cr_{int(time.time() * 1000)}"
    
    # 确保图片目录存在
    CR_IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    
    # 保存图片
    image_filename = f"{cr_id}.png"
    image_path = CR_IMAGES_DIR / image_filename
    
    try:
        # 解码base64图片
        image_data = req.image_base64
        if image_data.startswith("data:"):
            image_data = image_data.split(",", 1)[1]
        
        with open(image_path, "wb") as f:
            f.write(base64.b64decode(image_data))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"图片保存失败: {e}")
    
    # 保存记录（包含中文名称）
    cr_data[cr_id] = {
        "name": req.name,
        "zh_names": req.zh_names,  # 中文名称列表
        "image_file": image_filename,
        "created_time": int(time.time()),
        **ownership,
    }
    
    if not await _save_cr_data(cr_data):
        # 清理已保存的图片
        if image_path.exists():
            os.remove(image_path)
        raise HTTPException(status_code=500, detail="保存CR数据失败")
    
    return {
        "success": True,
        "message": f"CR '{req.name}' 创建成功",
        "cr": {
            "id": cr_id,
            "name": req.name,
            "zh_names": req.zh_names,
            "preview_url": f"/api/cr/preview/{cr_id}",
            "created_time": cr_data[cr_id]["created_time"],
        }
    }


@app.delete("/api/cr/{cr_id}")
async def delete_cr_api(cr_id: str, request: Request, session_id: str = ""):
    """删除公共CR"""
    import os

    principal = _library_principal_from_request(request, session_id)
    
    cr_data = await _load_cr_data()
    
    if cr_id not in cr_data:
        raise HTTPException(status_code=404, detail="CR不存在")
    
    record = cr_data[cr_id]
    _require_library_record_owner(principal, record, legacy_owner_fields=())
    
    # 删除图片文件
    image_file = record.get("image_file")
    if image_file:
        image_path = CR_IMAGES_DIR / image_file
        if image_path.exists():
            try:
                os.remove(image_path)
            except Exception as e:
                print(f"删除CR图片失败: {e}")
    
    # 从数据中删除
    del cr_data[cr_id]
    
    if not await _save_cr_data(cr_data):
        raise HTTPException(status_code=500, detail="保存CR数据失败")
    
    return {
        "success": True,
        "message": f"CR已删除"
    }


class UpdateCRRequest(BaseModel):
    name: str | None = None
    zh_names: list[str] | None = None
    session_id: str = ""  # v0 compatibility; new clients use X-Bot-Session


@app.put("/api/cr/{cr_id}")
async def update_cr(cr_id: str, req: UpdateCRRequest, request: Request):
    """更新CR信息（名称、中文名称）"""
    principal = _library_principal_from_request(request, req.session_id)
    cr_data = await _load_cr_data()
    
    if cr_id not in cr_data:
        raise HTTPException(status_code=404, detail="CR不存在")
    
    record = cr_data[cr_id]
    _require_library_record_owner(principal, record, legacy_owner_fields=())
    
    # 更新字段
    if req.name is not None:
        record["name"] = req.name
    if req.zh_names is not None:
        record["zh_names"] = req.zh_names
    
    cr_data[cr_id] = record
    
    if not await _save_cr_data(cr_data):
        raise HTTPException(status_code=500, detail="保存CR数据失败")
    
    return {
        "success": True,
        "message": "CR更新成功",
        "cr": {
            "id": cr_id,
            "name": record.get("name"),
            "zh_names": record.get("zh_names", []),
            "preview_url": f"/api/cr/preview/{cr_id}",
            "created_time": record.get("created_time", 0),
        }
    }


@app.get("/api/cr/search")
async def search_cr(q: str):
    """根据中文名称搜索CR（用于Bot匹配）"""
    cr_data = await _load_cr_data()
    
    results = []
    q_lower = q.lower().strip()
    
    for cr_id, record in cr_data.items():
        # 匹配名称
        name = record.get("name", "")
        zh_names = record.get("zh_names", [])
        
        matched = False
        if q_lower in name.lower():
            matched = True
        else:
            for zh in zh_names:
                if q_lower == zh.lower() or q_lower in zh.lower():
                    matched = True
                    break
        
        if matched:
            results.append({
                "id": cr_id,
                "name": name,
                "zh_names": zh_names,
                "image_file": record.get("image_file"),
                "preview_url": f"/api/cr/preview/{cr_id}",
            })
    
    return {"results": results, "total": len(results)}


# ==================== 翻译代理 API ====================

class TranslateProxyRequest(BaseModel):
    """翻译代理请求"""
    base_url: str
    api_key: str
    model: str
    messages: list
    temperature: float = 0.3
    max_tokens: int = 4000


@app.post("/api/translate/proxy")
async def translate_proxy(req: TranslateProxyRequest):
    """
    翻译代理接口
    用于解决 HTTPS 页面无法直接请求 HTTP 翻译服务的问题
    """
    target_url = f"{req.base_url.rstrip('/')}/chat/completions"
    
    headers = {
        "Authorization": f"Bearer {req.api_key}",
        "Content-Type": "application/json"
    }
    
    payload = {
        "model": req.model,
        "messages": req.messages,
        "temperature": req.temperature,
        "max_tokens": req.max_tokens
    }
    
    try:
        response = await _safe_outbound_json.post_json(
            target_url,
            headers=headers,
            payload=payload,
            timeout=60,
        )
        if response.status != 200:
            error_text = response.body[:2048].decode("utf-8", errors="replace")
            raise HTTPException(
                status_code=response.status,
                detail=f"翻译服务返回错误: {error_text}",
            )
        try:
            return response.json()
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise HTTPException(status_code=502, detail="翻译服务返回了无效 JSON") from exc
    except InvalidRequestError as exc:
        raise HTTPException(status_code=400, detail=exc.message) from exc
    except aiohttp.ClientError as e:
        raise HTTPException(status_code=502, detail=f"无法连接翻译服务: {str(e)}")
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="翻译服务响应超时")


def _get_translate_en2zh_config() -> dict:
    """返回英译中翻译API配置（从 server/config.py 读取）"""
    return {
        "base_url": TRANSLATE_EN2ZH_BASE_URL,
        "api_key": TRANSLATE_EN2ZH_API_KEY,
        "model": TRANSLATE_EN2ZH_MODEL,
        "proxy": TRANSLATE_EN2ZH_PROXY,
        "extra_payload": TRANSLATE_EN2ZH_EXTRA_PAYLOAD,
    }


async def _call_translate_en2zh_chat(messages: list, temperature: float = 0.2, max_tokens: int = 500) -> dict:
    cfg = _get_translate_en2zh_config()
    if not cfg["base_url"] or not cfg["api_key"]:
        raise HTTPException(status_code=500, detail="服务端英译中翻译API未配置")

    target_url = f"{cfg['base_url'].rstrip('/')}/chat/completions"
    headers = {
        "Authorization": f"Bearer {cfg['api_key']}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": cfg["model"],
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    if cfg.get("extra_payload"):
        payload.update(cfg["extra_payload"])

    try:
        response = await _safe_outbound_json.post_json(
            target_url,
            payload=payload,
            headers=headers,
            timeout=60,
        )
    except InvalidRequestError as exc:
        raise HTTPException(status_code=503, detail="英译中翻译服务地址不安全") from exc
    if response.status != 200:
        error_text = response.body[:2048].decode("utf-8", errors="replace")
        raise HTTPException(
            status_code=response.status,
            detail=f"英译中翻译服务返回错误: {error_text}",
        )
    try:
        return response.json()
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=502, detail="英译中翻译服务返回无效 JSON") from exc


def _extract_chat_completion_text(result: dict) -> str:
    try:
        message = result.get("choices", [{}])[0].get("message", {})
        content = message.get("content")
        if isinstance(content, str):
            return content.strip()
        if isinstance(content, list):
            parts = []
            for item in content:
                if isinstance(item, dict):
                    text = item.get("text") or item.get("content")
                    if isinstance(text, str):
                        parts.append(text)
            return "\n".join(parts).strip()
    except Exception:
        return ""
    return ""


async def _translate_wiki_preview_summary(tag: str, body: str, fallback_summary: str) -> str:
    source = _build_wiki_summary(body, limit=1200) or fallback_summary
    if not source:
        return ""

    messages = [
        {
            "role": "system",
            "content": (
                "你是 Danbooru 标签 wiki 的中文预览摘要助手。"
                "请根据用户提供的 tag 和 wiki 内容，输出一段自然中文说明，120字以内。"
                "选择性忽略 Examples、See also、链接格式、编辑说明、无关引用和过细的历史信息。"
                "重点说明这个标签的含义、使用场景、容易混淆点。"
                "不要使用 Markdown，不要逐字翻译，不要输出英文原文。"
            ),
        },
        {
            "role": "user",
            "content": f"Tag: {tag}\nWiki内容:\n{source}",
        },
    ]
    try:
        result = await _call_translate_en2zh_chat(messages, temperature=0.2, max_tokens=300)
        return _limit_chinese_preview_text(_extract_chat_completion_text(result), 140)
    except Exception as e:
        print(f"Wiki summary translation error for {tag}: {e}")
        return ""


class TranslateMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: Literal["system", "developer", "user", "assistant"]
    content: str = Field(
        min_length=1,
        max_length=MAX_TRANSLATE_CONTEXT_BYTES,
        strict=True,
    )


class PublicTranslateEn2ZhRequest(BaseModel):
    """Authenticated server-key translation request."""

    model_config = ConfigDict(extra="forbid")

    messages: list[TranslateMessage] = Field(min_length=1, max_length=64)
    temperature: float = Field(default=0.3, ge=0, le=2, strict=True)
    max_tokens: int = Field(default=4000, ge=1, le=8192, strict=True)
    session_id: str | None = Field(default=None, max_length=200, strict=True)

    @model_validator(mode="after")
    def validate_context_budget(self) -> "PublicTranslateEn2ZhRequest":
        try:
            validate_translate_context(
                [message.model_dump() for message in self.messages],
            )
        except InvalidRequestError as exc:
            raise ValueError(exc.message) from exc
        return self


@app.post("/api/translate/en2zh")
async def translate_en2zh(req: PublicTranslateEn2ZhRequest, request: Request):
    """Use the server translation key for one authenticated Bot owner."""

    principal = _library_principal_from_request(request, req.session_id or "")
    messages = [message.model_dump() for message in req.messages]
    try:
        return await _paid_operations.execute(
            principal,
            lambda: _call_translate_en2zh_chat(
                messages,
                req.temperature,
                req.max_tokens,
            ),
        )
    except aiohttp.ClientError as e:
        raise HTTPException(status_code=502, detail=f"无法连接英译中翻译服务: {str(e)}")
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="英译中翻译服务响应超时")

# ==================== Agent 代理与公共 API ====================
# 旧 /api/agent/public 与 /api/agent/proxy 已下线。
# 所有 AI 对话/绘图规划现在统一走 PydanticAI 路由组（见 agent_router/router.py）:
#   - Bot 端 → POST /api/agent/chat
#   - Web 端 → POST /api/agent/web/generate-prompt (SSE)
#   - prompts 读取 → GET /api/agent/prompts/{tier}
#   - 健康检查 → GET /api/agent/health


# ==================== 超分辨率 API ====================

class UpscaleRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    image: str = Field(min_length=1, max_length=28 * 1024 * 1024, strict=True)
    width: int = Field(ge=64, le=4096, strict=True)
    height: int = Field(ge=64, le=4096, strict=True)
    scale: Literal[2, 4] = 4
    session_id: str | None = Field(default=None, max_length=200, strict=True)

    @field_validator("image")
    @classmethod
    def validate_image(cls, value: str) -> str:
        try:
            return normalize_image_base64(value)
        except InvalidRequestError as exc:
            raise ValueError(exc.message) from exc


class UpscaleResponse(BaseModel):
    success: bool
    image: Optional[str] = None  # base64 编码的结果图片
    message: str = ""


def _extract_upscale_result(payload: bytes) -> str:
    import zipfile
    import io

    try:
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            members = archive.infolist()
            if len(members) > 128:
                raise InvalidRequestError("upscale archive contains too many members")
            candidates = [
                member
                for member in members
                if not member.is_dir()
                and member.filename.lower().endswith((".png", ".jpg", ".jpeg", ".webp"))
            ]
            if not candidates:
                raise InvalidRequestError("upscale archive contains no image")
            member = candidates[0]
            if (
                member.flag_bits & 0x1
                or member.file_size <= 0
                or member.file_size > MAX_PAID_RESULT_BYTES
            ):
                raise InvalidRequestError("upscale image exceeds the result budget")
            image = bytearray()
            with archive.open(member) as source:
                while chunk := source.read(64 * 1024):
                    image.extend(chunk)
                    if len(image) > MAX_PAID_RESULT_BYTES:
                        raise InvalidRequestError("upscale image exceeds the result budget")
    except zipfile.BadZipFile as exc:
        raise InvalidRequestError("upscale response is not a valid ZIP") from exc
    return normalize_image_base64(
        base64.b64encode(image).decode("ascii"),
        max_decoded_bytes=MAX_PAID_RESULT_BYTES,
    )


async def _upscale_upstream(token: str, req: UpscaleRequest) -> UpscaleResponse:
    headers = {
        "accept": "application/zip",
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    payload = {
        "image": req.image,
        "height": req.height,
        "width": req.width,
        "scale": req.scale,
    }
    async with aiohttp.ClientSession() as session:
        async with session.post(
            "https://api.novelai.net/ai/upscale",
            headers=headers,
            json=payload,
            timeout=aiohttp.ClientTimeout(total=300),
        ) as response:
            if response.status != 200:
                error = await _read_paid_response(response, max_bytes=2048)
                return UpscaleResponse(
                    success=False,
                    message=(
                        f"NAI API 错误 ({response.status}): "
                        f"{error.decode('utf-8', errors='replace')}"
                    ),
                )
            archive = await _read_paid_response(response, max_bytes=MAX_PAID_RESULT_BYTES)
    try:
        image = _extract_upscale_result(archive)
    except InvalidRequestError as exc:
        return UpscaleResponse(success=False, message=exc.message)
    return UpscaleResponse(success=True, image=image, message="超分完成")


@app.post("/api/upscale", response_model=UpscaleResponse)
async def upscale_image(req: UpscaleRequest, request: Request):
    """Upscale one image for an authenticated Bot owner."""

    principal = _library_principal_from_request(request, req.session_id or "")
    allowed_resolutions = {(832, 1216), (1216, 832), (1024, 1024)}
    if (req.width, req.height) not in allowed_resolutions:
        return UpscaleResponse(
            success=False,
            message=(
                "NAI 超分仅支持以下分辨率: 832×1216, 1216×832, 1024×1024\n"
                f"当前: {req.width}×{req.height}"
            ),
        )
    token = _get_anlas_only_token() or await _get_first_novelai_token()
    if not token:
        raise HTTPException(status_code=503, detail="NovelAI Token 未配置或全部禁用")
    cost = 6 if req.scale == 4 else 4
    try:
        return await _paid_operations.execute(
            principal,
            lambda: _upscale_upstream(token, req),
            charge=UsageCharge(
                cost,
                f"超分辨率({req.width}x{req.height}, {req.scale}x)",
            ),
            account_when=lambda result: result.success,
        )
    except UsageRecordingError as exc:
        raise HTTPException(
            status_code=503,
            detail="上游操作已完成但用量记录失败，请勿自动重试并联系管理员核对用量",
        ) from exc
    except (aiohttp.ClientError, asyncio.TimeoutError):
        return UpscaleResponse(success=False, message="NovelAI 网络请求失败")


# ==================== 香蕉重绘 API ====================

class BananaRepaintRequest(BaseModel):
    image_base64: str  # base64 编码的图片（不含 data:image 前缀）
    prompt: str  # 用户描述


class BananaRepaintResponse(BaseModel):
    success: bool
    task_id: Optional[str] = None
    message: str = ""
    estimated_seconds: int = 60


class BananaEstimateResponse(BaseModel):
    estimated_seconds: int
    provider: str
    failure_rate: float = 0.0  # 近期失败率 0.0-1.0


class BananaRepaintStatusResponse(BaseModel):
    success: bool
    status: str = "pending"  # pending, generating, completed, failed
    image_base64: Optional[str] = None  # 生成完成后的图片
    step: int = 0
    total_steps: int = 0
    preview_base64: Optional[str] = None  # 流式预览图
    message: str = ""
    quota_info: Optional[Dict[str, Any]] = None


# 香蕉重绘任务存储
_banana_tasks: Dict[str, Dict[str, Any]] = {}


def _get_banana_estimate() -> tuple:
    """获取香蕉重绘预估时间和失败率"""
    # Flowith 渠道已移除，返回默认值
    return 60, "disabled", 1.0


@app.get("/api/banana/estimate", response_model=BananaEstimateResponse)
async def get_banana_estimate():
    """获取香蕉重绘预估时间"""
    estimated_seconds, provider, failure_rate = _get_banana_estimate()
    return BananaEstimateResponse(
        estimated_seconds=estimated_seconds,
        provider=provider,
        failure_rate=failure_rate
    )


@app.post("/api/banana/repaint", response_model=BananaRepaintResponse)
async def banana_repaint(req: BananaRepaintRequest):
    """
    提交香蕉重绘任务
    注意：Flowith 渠道已移除，此功能暂时不可用
    """
    return BananaRepaintResponse(
        success=False,
        task_id="",
        message="香蕉重绘功能暂时不可用（Flowith 渠道已移除）"
    )


async def _process_banana_repaint(task_id: str):
    """处理香蕉重绘任务 - 已禁用"""
    task = _banana_tasks.get(task_id)
    if task:
        task["status"] = "failed"
        task["error"] = "香蕉重绘功能暂时不可用"


@app.get("/api/banana/status/{task_id}", response_model=BananaRepaintStatusResponse)
async def get_banana_repaint_status(task_id: str):
    """获取香蕉重绘任务状态"""
    task = _banana_tasks.get(task_id)
    
    if not task:
        return BananaRepaintStatusResponse(
            success=False,
            status="failed",
            message="任务不存在"
        )
    
    response = BananaRepaintStatusResponse(
        success=True,
        status=task["status"],
        step=task.get("step", 0),
        total_steps=task.get("total_steps", 0),
        preview_base64=task.get("preview"),
        quota_info=task.get("quota_info"),
    )
    
    if task["status"] == "completed":
        response.image_base64 = task.get("result_image")
        response.message = "生成完成"
        # 清理任务
        del _banana_tasks[task_id]
    elif task["status"] == "failed":
        response.message = task.get("error", "生成失败")
        # 清理任务
        del _banana_tasks[task_id]
    elif task["status"] == "generating":
        response.message = "生成中..."
    else:
        response.message = "等待处理..."
    
    return response


# ==================== 图像工坊 API ====================

# --- 异步任务存储 ---
# task_id -> { session_id, model, prompt, aspect_ratio, status, image_url, mime_type, error, elapsed, created_at, completed_at }
_workshop_tasks: Dict[str, Dict[str, Any]] = {}
_workshop_background_tasks: Dict[str, asyncio.Task] = {}
_WORKSHOP_TASK_TTL = 600  # 完成后保留 10 分钟
_WORKSHOP_JOB_KIND = "workshop"
_WORKSHOP_JOB_LIST_LIMIT = 200
_WORKSHOP_MAX_RESULT_BYTES = 32 * 1024 * 1024


# ==================== Workshop provider 注册表（家族 B 接缝） ====================
# model_id → provider 的封闭路由。配额/持久化/取消/恢复由宿主统一处理，
# provider 只实现「拿请求、还结果」。新后端（MiniMax / Seedance / Grok …）在此注册。

async def _run_big_gpt_provider(request: WorkshopProviderRequest) -> dict:
    # 经模块属性晚绑定调用，保持既有测试对 _workshop_call_big_gpt 的 monkeypatch 有效。
    return await _workshop_call_big_gpt(
        model_id=request.model,
        prompt=request.prompt,
        aspect_ratio=request.aspect_ratio,
        images=request.images,
    )


def _build_workshop_providers() -> WorkshopProviderRegistry:
    registry = WorkshopProviderRegistry()
    registry.register(
        FunctionWorkshopProvider(
            name="big_gpt",
            models=("gpt-image", "gpt-image-4k"),
            run=_run_big_gpt_provider,
        )
    )
    modal_models = tuple(
        str(m).strip()
        for m in (getattr(_appcfg, "MODAL_COMFY_MODEL_IDS", ()) or ())
        if str(m).strip()
    )
    if modal_models:
        registry.register(
            ModalComfyProvider(
                name="modal_comfy",
                models=modal_models,
                endpoint=str(getattr(_appcfg, "MODAL_COMFY_ENDPOINT", "") or ""),
                token_id=str(getattr(_appcfg, "MODAL_COMFY_TOKEN_ID", "") or ""),
                token_secret=str(getattr(_appcfg, "MODAL_COMFY_TOKEN_SECRET", "") or ""),
                http=_safe_outbound_large_json,
            )
        )
    return registry


_workshop_providers = _build_workshop_providers()

def _cleanup_workshop_tasks():
    """Drop only stale memory mirrors; durable jobs/results are never auto-deleted."""

    now = time.time()
    expired = [
        tid for tid, t in _workshop_tasks.items()
        if t.get("completed_at") and now - t["completed_at"] > _WORKSHOP_TASK_TTL
    ]
    for tid in expired:
        _workshop_tasks.pop(tid, None)


def _is_workshop_job(job: CloudJob) -> bool:
    return job.payload.get("kind") == _WORKSHOP_JOB_KIND


def _workshop_request_payload(
    req: "WorkshopGenerateRequest",
    *,
    task_id: str,
    quota_cost: int,
) -> dict[str, Any]:
    references: list[dict[str, Any]] = []
    for image in req.images or []:
        encoded = image.encode("utf-8")
        references.append(
            {
                "sha256": hashlib.sha256(encoded).hexdigest(),
                "encoded_size": len(encoded),
            }
        )
    return {
        "kind": _WORKSHOP_JOB_KIND,
        "model": req.model,
        "prompt": req.prompt,
        "aspect_ratio": req.aspect_ratio,
        "reference_images": references,
        "quota": {"reservation_id": task_id, "units": quota_cost},
    }


def _workshop_status(job: CloudJob) -> str:
    if job.status in {JobStatus.QUEUED, JobStatus.RUNNING, JobStatus.CANCELLING}:
        return "generating"
    if job.status is JobStatus.SUCCEEDED:
        return "success"
    if job.status is JobStatus.CANCELLED:
        return "cancelled"
    return "error"


def _mirror_workshop_job(job: CloudJob, *, session_id: str | None = None) -> dict[str, Any]:
    payload = job.payload
    result = job.result or {}
    filename = result.get("path") if isinstance(result.get("path"), str) else None
    record = _workshop_tasks.setdefault(job.id, {})
    record.update(
        {
            "model": str(payload.get("model") or ""),
            "prompt": str(payload.get("prompt") or ""),
            "aspect_ratio": str(payload.get("aspect_ratio") or "auto"),
            "status": _workshop_status(job),
            "image_url": f"/api/workshop/images/{filename}" if filename else None,
            "mime_type": result.get("mime_type"),
            "error": job.error,
            "elapsed": result.get("elapsed"),
            "created_at": job.created_at.timestamp(),
            "completed_at": job.finished_at.timestamp() if job.finished_at else None,
            "result_filename": filename,
        }
    )
    if session_id is not None:
        record["session_id"] = session_id
    _task_access.bind_record(record, job.resource)
    return record


def _workshop_job_response(job: CloudJob, principal: Principal) -> dict[str, Any]:
    payload = job.payload
    result = job.result or {}
    response = {
        "task_id": job.id,
        "model": str(payload.get("model") or ""),
        "prompt": str(payload.get("prompt") or ""),
        "aspect_ratio": str(payload.get("aspect_ratio") or "auto"),
        "status": _workshop_status(job),
        "error": job.error,
        "elapsed": result.get("elapsed"),
        "created_at": job.created_at.timestamp(),
    }
    if job.status is JobStatus.SUCCEEDED and job.result:
        filename = job.result.get("path")
        if isinstance(filename, str):
            capability = _task_access.capabilities.issue(
                principal,
                job_id=job.id,
                resource=job.resource,
            )
            response["image_url"] = (
                f"/api/workshop/images/{filename}?job_id={job.id}&capability={capability}"
            )
            response["mime_type"] = job.result.get("mime_type", "image/png")
    return response


async def _authorize_workshop_job(task_id: str, session_id: str) -> tuple[CloudJob, Principal]:
    principal = _principal_from_bot_session(session_id)
    await _ensure_cloud_job_storage()
    try:
        job = await _cloud_jobs.get(task_id)
    except InvalidRequestError as exc:
        raise HTTPException(status_code=404, detail="任务不存在") from exc
    record = (
        {"tenant_id": job.resource.tenant_id, "owner_id": job.resource.owner_id}
        if job is not None
        else None
    )
    try:
        _task_access.require_principal(record, principal)
    except ResourceNotFoundError as exc:
        raise HTTPException(status_code=404, detail="任务不存在") from exc
    if job is None or not _is_workshop_job(job):
        raise HTTPException(status_code=404, detail="任务不存在")
    return job, principal


async def _recover_workshop_jobs() -> list[CloudJob]:
    """Recover Workshop jobs before the generic active-job recovery pass."""

    recovered: list[CloudJob] = []
    for job in await _cloud_jobs.list_active():
        if not _is_workshop_job(job):
            continue
        if job.status is JobStatus.QUEUED:
            updated, _ = await _cloud_jobs.transition(
                job.id,
                JobStatus.CANCELLED,
                kind="cancelled_on_restart",
                error="服务器重启前任务尚未开始",
                data={"reason": "process_restart"},
            )
        else:
            updated, _ = await _cloud_jobs.transition(
                job.id,
                JobStatus.INTERRUPTED,
                kind="interrupted",
                error="服务器重启中断了生成任务",
                data={"reason": "process_restart"},
            )
        recovered.append(updated)
    return recovered


class WorkshopGenerateRequest(BaseModel):
    session_id: str = Field(min_length=1, max_length=200)
    model: str = Field(min_length=1, max_length=80)  # gpt-image (2K) | gpt-image-4k (4K)
    prompt: str = Field(min_length=1, max_length=32_000)
    aspect_ratio: str = Field(default="auto", min_length=1, max_length=80)
    images: list[str] | None = Field(default=None, max_length=8)  # base64 data URI 格式的参考图

class WorkshopGenerateResponse(BaseModel):
    success: bool
    task_id: Optional[str] = None
    image_base64: Optional[str] = None
    mime_type: Optional[str] = None
    error: Optional[str] = None
    elapsed: Optional[float] = None


async def _workshop_call_genspark(
    model_id: str,
    prompt: str,
    aspect_ratio: str = "auto",
    images: list[str] | None = None,
) -> dict:
    """
    独立调用 Genspark API 生成图片，不依赖 Bot 进程。
    返回 {"success": bool, "image_base64": str, "mime_type": str, "error": str}
    """
    model_config = GENSPARK_MODEL_MAP.get(model_id)
    if not model_config:
        return {"success": False, "error": f"未知模型: {model_id}"}

    api_base = GENSPARK_API_BASE
    api_key = GENSPARK_API_KEY
    if not api_key:
        return {"success": False, "error": "未配置 Genspark API Key"}

    genspark_model = model_config["model"]
    image_size = model_config["image_size"]
    style = GENSPARK_STYLE
    gs_cookie = GENSPARK_COOKIE

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }

    payload = {
        "model": genspark_model,
        "prompt": prompt.strip() if prompt else "",
        "style": style,
        "image_size": image_size,
        "aspect_ratio": aspect_ratio,
    }

    if images:
        payload["images"] = images

    t0 = time.time()
    print(f"[Workshop] Genspark 请求: model={genspark_model}, aspect_ratio={aspect_ratio}, images={len(images or [])}")

    try:
        response = await _safe_outbound_large_json.post_json(
            f"{api_base.rstrip('/')}/images/generations",
            headers=headers,
            payload=payload,
            timeout=180,
        )
        status_code = response.status
        resp_text = response.body.decode("utf-8", errors="replace")

        if status_code != 200:
            print(f"[Workshop] Genspark 请求失败: status={status_code}")
            err_msg = f"服务异常: {status_code}"
            try:
                err_data = json.loads(resp_text) if resp_text else {}
                if err_data.get("error", {}).get("message"):
                    err_msg = err_data["error"]["message"]
            except Exception:
                pass
            return {"success": False, "error": err_msg}

        try:
            data = json.loads(resp_text) if resp_text else {}
        except Exception:
            data = {}

        data_list = data.get("data") or []
        if not data_list:
            return {"success": False, "error": "响应为空"}

        first_item = data_list[0]
        image_url_result = first_item.get("url")
        b64_json = first_item.get("b64_json")

        img_bytes = None
        mime_type = "image/webp"

        # 优先处理 base64
        if b64_json:
            try:
                b64_data = b64_json
                if "base64," in b64_data:
                    parts = b64_data.split("base64,")
                    b64_data = parts[1]
                    if parts[0]:
                        m = re.search(r"data:([^;]+)", parts[0])
                        if m:
                            mime_type = m.group(1)
                img_bytes = base64.b64decode(b64_data)
            except Exception as e:
                print(f"[Workshop] 解析 base64 失败: {e}")

        # 如果没有 base64，尝试下载 URL
        if not img_bytes and image_url_result:
            try:
                dl_headers = {
                    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
                    "Referer": "https://www.genspark.ai/",
                }
                if gs_cookie:
                    dl_headers["Cookie"] = gs_cookie
                img_resp = await _safe_outbound_binary.get(
                    image_url_result,
                    headers=dl_headers,
                    timeout=60,
                    max_bytes=32 * 1024 * 1024,
                )
                if img_resp.status == 200:
                    img_bytes = img_resp.body
                    ct = next(
                        (
                            value
                            for key, value in img_resp.headers.items()
                            if key.lower() == "content-type"
                        ),
                        "",
                    ).split(";", 1)[0].strip().lower()
                    if ct:
                        mime_type = ct
                else:
                    print(f"[Workshop] 下载图片失败: status={img_resp.status}")
            except Exception as e:
                print(f"[Workshop] 下载图片异常: {e}")

        if not img_bytes:
            return {"success": False, "error": "未获取到图片数据"}

        elapsed = time.time() - t0
        img_b64 = base64.b64encode(img_bytes).decode("utf-8")
        print(f"[Workshop] 生成完成: model={genspark_model}, elapsed={elapsed:.1f}s, size={len(img_bytes)}")
        return {"success": True, "image_base64": img_b64, "mime_type": mime_type, "elapsed": elapsed}

    except asyncio.TimeoutError:
        return {"success": False, "error": "生成超时"}
    except Exception as e:
        print(f"[Workshop] 异常: {e}")
        return {"success": False, "error": f"生成错误: {e}"}


def _encode_workshop_multipart(
    fields: dict[str, Any],
    files: list[tuple[bytes, str]],
) -> tuple[bytes, str]:
    boundary = f"ultimate-novelai-{secrets.token_hex(16)}"
    chunks: list[bytes] = []
    for name, value in fields.items():
        chunks.extend(
            [
                f"--{boundary}\r\n".encode("ascii"),
                f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode("ascii"),
                str(value).encode("utf-8"),
                b"\r\n",
            ]
        )
    for index, (payload, mime_type) in enumerate(files):
        extension = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}[
            mime_type
        ]
        chunks.extend(
            [
                f"--{boundary}\r\n".encode("ascii"),
                (
                    'Content-Disposition: form-data; name="image[]"; '
                    f'filename="ref_{index}.{extension}"\r\n'
                ).encode("ascii"),
                f"Content-Type: {mime_type}\r\n\r\n".encode("ascii"),
                payload,
                b"\r\n",
            ]
        )
    chunks.append(f"--{boundary}--\r\n".encode("ascii"))
    body = b"".join(chunks)
    if len(body) > 64 * 1024 * 1024:
        raise InvalidRequestError("workshop multipart request is too large")
    return body, f"multipart/form-data; boundary={boundary}"


async def _workshop_call_big_gpt(
    model_id: str,
    prompt: str,
    aspect_ratio: str = "auto",
    images: list[str] | None = None,
) -> dict:
    """
    调用大GPT（OpenAI 标准 Images API：无参考图走 /v1/images/generations，有参考图走 /v1/images/edits）。
    返回 {"success": bool, "image_base64": str, "mime_type": str, "elapsed": float, "error": str}
    """
    if not BIG_GPT_BASE_URL or not BIG_GPT_API_KEY:
        return {"success": False, "error": "未配置 BIG_GPT_BASE_URL / BIG_GPT_API_KEY"}

    # model_id 后缀决定 4K / 2K
    resolution = "4k" if model_id.endswith("-4k") else "2k"
    # auto / 未识别比例 → 默认按 1:1，保证 2K/4K 档仍然生效
    ratio_row = BIG_GPT_RATIO_TABLE.get(aspect_ratio) or BIG_GPT_RATIO_TABLE["1:1"]
    size = ratio_row.get(resolution) or ratio_row.get("2k") or "auto"

    # 前端 data URI → 解码为 (bytes, mime) 给 multipart 用
    ref_files: list[tuple[bytes, str]] = []
    for u in (images or []):
        if not (isinstance(u, str) and u.startswith("data:") and "base64," in u):
            continue
        try:
            header, b64 = u.split("base64,", 1)
            mime = "image/png"
            if ":" in header and ";" in header:
                mime = header.split(":")[1].split(";")[0]
            if mime not in {"image/jpeg", "image/png", "image/webp"}:
                continue
            decoded = base64.b64decode(b64, validate=True)
            if len(decoded) > 20 * 1024 * 1024:
                continue
            ref_files.append((decoded, mime))
        except Exception as e:
            print(f"[Workshop] 大GPT 参考图解码失败: {e}")

    common_fields = {
        "model": BIG_GPT_MODEL,
        "prompt": prompt or "",
        "size": size,
        "quality": BIG_GPT_QUALITY,
        "background": BIG_GPT_BACKGROUND,
        "moderation": BIG_GPT_MODERATION,
        "n": "1",
    }
    headers = {"Authorization": f"Bearer {BIG_GPT_API_KEY}"}
    base_url = BIG_GPT_BASE_URL.rstrip("/")

    url = f"{base_url}/images/edits" if ref_files else f"{base_url}/images/generations"

    t0 = time.time()
    print(f"[Workshop] 大GPT 请求: model={BIG_GPT_MODEL}, size={size}, aspect_ratio={aspect_ratio}, refs={len(ref_files)}, endpoint={url.rsplit('/', 1)[-1]}")

    raw_bytes = b""
    resp_status = 0
    max_attempts = 3  # 400 / 408 / 5xx 自动重试

    try:
        multipart_body = None
        multipart_type = None
        if ref_files:
            multipart_body, multipart_type = _encode_workshop_multipart(
                common_fields,
                ref_files,
            )
        for attempt in range(1, max_attempts + 1):
            if multipart_body is not None and multipart_type is not None:
                response = await _safe_outbound_bytes.post(
                    url,
                    headers={**headers, "Content-Type": multipart_type},
                    body=multipart_body,
                    timeout=BIG_GPT_TIMEOUT,
                )
            else:
                response = await _safe_outbound_large_json.post_json(
                    url,
                    headers={**headers, "Content-Type": "application/json"},
                    payload=common_fields,
                    timeout=BIG_GPT_TIMEOUT,
                )
            raw_bytes = response.body
            resp_status = response.status
            if resp_status == 200:
                break
            retryable = resp_status in (400, 408) or 500 <= resp_status < 600
            if retryable and attempt < max_attempts:
                err_preview = raw_bytes[:300].decode("utf-8", errors="replace")
                print(f"[Workshop] 大GPT {resp_status} 错误第{attempt}次重试: {err_preview}")
                await asyncio.sleep(1.0)
                continue
            break

        if resp_status != 200:
            err_preview = raw_bytes[:500].decode("utf-8", errors="replace")
            print(f"[Workshop] 大GPT 请求失败: status={resp_status} body={err_preview}")
            return {"success": False, "error": f"服务异常: status={resp_status}"}

        try:
            data = json.loads(raw_bytes.decode("utf-8", errors="replace")) if raw_bytes else {}
        except Exception:
            data = {}

        items = data.get("data") or []
        if not items or not isinstance(items[0], dict):
            err_msg = (data.get("error") or {}).get("message") if isinstance(data, dict) else None
            return {"success": False, "error": (err_msg or "未返回图片")[:200]}

        b64_data = items[0].get("b64_json") or ""
        if not b64_data:
            return {"success": False, "error": "未获取到图片数据"}

        try:
            img_bytes = base64.b64decode(b64_data)
        except Exception as e:
            return {"success": False, "error": f"图片解码失败: {e}"}

        elapsed = time.time() - t0
        print(f"[Workshop] 大GPT 完成: size={size}, elapsed={elapsed:.1f}s, bytes={len(img_bytes)}")
        return {"success": True, "image_base64": b64_data, "mime_type": "image/png", "elapsed": elapsed}

    except asyncio.TimeoutError:
        return {"success": False, "error": "生成超时"}
    except Exception as e:
        print(f"[Workshop] 大GPT 异常: {e}")
        return {"success": False, "error": f"生成错误: {e}"}




# ==================== Workshop 模型耗时统计 ====================
# 内存缓存每个模型最近 N 次生成耗时，用于前端显示预估时间
_WORKSHOP_MODEL_HISTORY: dict[str, list[float]] = {}
_WORKSHOP_HISTORY_MAX = 20  # 每个模型保留最近 20 条记录


def _record_workshop_elapsed(model_id: str, elapsed: float):
    """记录一次生成耗时"""
    if model_id not in _WORKSHOP_MODEL_HISTORY:
        _WORKSHOP_MODEL_HISTORY[model_id] = []
    history = _WORKSHOP_MODEL_HISTORY[model_id]
    history.append(elapsed)
    if len(history) > _WORKSHOP_HISTORY_MAX:
        _WORKSHOP_MODEL_HISTORY[model_id] = history[-_WORKSHOP_HISTORY_MAX:]


def _get_workshop_model_avg(model_id: str) -> float | None:
    """获取模型平均耗时，无记录返回 None"""
    history = _WORKSHOP_MODEL_HISTORY.get(model_id)
    if not history:
        return None
    return sum(history) / len(history)


@app.get("/api/workshop/models/stats")
async def workshop_models_stats():
    """返回各模型的平均生成耗时"""
    result: dict[str, dict] = {}
    for model_id, history in _WORKSHOP_MODEL_HISTORY.items():
        if history:
            result[model_id] = {
                "avg_seconds": round(sum(history) / len(history), 1),
                "samples": len(history),
            }
    return result


@app.get("/api/workshop/quota")
async def workshop_quota(session_id: str = ""):
    """查询当前用户的剩余额度"""
    if not session_id:
        raise HTTPException(status_code=400, detail="缺少 session_id")
    session = bot_auth_manager.get_session(session_id)
    if not session:
        raise HTTPException(status_code=401, detail="未登录或会话已过期")

    today_str = datetime.now(_BEIJING_TZ).strftime("%Y-%m-%d")
    try:
        await _workshop_quota.initialize()
        balance = await _workshop_quota.balance(session.bot_user_id, quota_date=today_str)
        return {
            "daily_limit": balance.daily_limit,
            "daily_balance": balance.daily_balance,
            "extra_balance": balance.extra_balance,
            "total_available": balance.total_available,
        }
    except ResourceNotFoundError:
        return {"daily_limit": 0, "daily_balance": 0, "extra_balance": 0, "total_available": 0}
    except Exception as e:
        print(f"[Workshop] 额度查询失败: {e}")
        return {"daily_limit": 0, "daily_balance": 0, "extra_balance": 0, "total_available": 0}


@app.post("/api/workshop/generate", response_model=WorkshopGenerateResponse)
async def workshop_generate(req: WorkshopGenerateRequest):
    """Persist a user-owned Workshop job before starting provider work."""

    session = bot_auth_manager.get_session(req.session_id)
    if not session:
        raise HTTPException(status_code=401, detail="未登录或会话已过期")

    bot_user_id = session.bot_user_id
    principal = Principal.user(str(bot_user_id), _BOT_TASK_TENANT_ID)
    resource = ResourceOwner(_BOT_TASK_TENANT_ID, principal.subject_id)
    task_id = f"ws_{int(time.time())}_{uuid.uuid4().hex[:8]}"
    quota_cost = 2 if req.model.endswith("-4k") else 1
    today_str = datetime.now(_BEIJING_TZ).strftime("%Y-%m-%d")
    payload = _workshop_request_payload(req, task_id=task_id, quota_cost=quota_cost)
    request_digest = _generation_request_hash(
        {key: value for key, value in payload.items() if key != "quota"}
    )

    try:
        await _ensure_cloud_job_storage()
        await _workshop_quota.initialize()
        await _workshop_quota.reserve(
            bot_user_id,
            job_id=task_id,
            units=quota_cost,
            quota_date=today_str,
            result_filename=f"{task_id}.png",
        )
    except ResourceNotFoundError:
        return WorkshopGenerateResponse(
            success=False,
            error="未找到额度信息，请先通过 Bot 使用一次以激活账户",
        )
    except CloudBackendError as e:
        available = e.details.get("available_units", 0)
        return WorkshopGenerateResponse(
            success=False,
            error=f"额度不足（需要{quota_cost}次，剩余{available}次），请明日再试",
        )
    except Exception as e:
        print(f"[Workshop] 额度检查失败: {e}")
        return WorkshopGenerateResponse(success=False, error="额度检查失败，请稍后重试")

    try:
        created = await _cloud_jobs.create(
            job_id=task_id,
            resource=resource,
            request_hash=request_digest,
            payload=payload,
            idempotency_key=None,
            total_steps=1,
        )
    except BaseException:
        await _workshop_quota.refund(task_id)
        raise
    if not created.created:  # pragma: no cover - task ids include fresh randomness
        await _workshop_quota.refund(task_id)
        raise HTTPException(status_code=409, detail="任务编号冲突")

    _cleanup_workshop_tasks()
    task_record = _mirror_workshop_job(created.job, session_id=req.session_id)
    task_record["bot_user_id"] = bot_user_id

    try:
        background = asyncio.create_task(
            _workshop_process_task(task_id, req, bot_user_id, quota_cost)
        )
        _workshop_background_tasks[task_id] = background

        def remove_background(done_task, *, completed_task_id=task_id):
            if _workshop_background_tasks.get(completed_task_id) is done_task:
                _workshop_background_tasks.pop(completed_task_id, None)

        background.add_done_callback(remove_background)
    except BaseException:
        await _cloud_jobs.transition(
            task_id,
            JobStatus.CANCELLED,
            kind="launch_failed",
            error="任务启动失败",
        )
        await _workshop_quota.refund(task_id)
        _workshop_tasks.pop(task_id, None)
        raise

    return WorkshopGenerateResponse(success=True, task_id=task_id)


async def _commit_workshop_success(
    task_id: str,
    *,
    encoded: str,
    mime_type: str,
    elapsed: float | None,
) -> CloudJob:
    """Finish the atomic result/status/quota boundary even if cancellation races it."""

    async def commit() -> CloudJob:
        padding = 2 if encoded.endswith("==") else int(encoded.endswith("="))
        decoded_size = (len(encoded) // 4) * 3 - padding if len(encoded) % 4 == 0 else 0
        if decoded_size <= 0 or decoded_size > _WORKSHOP_MAX_RESULT_BYTES:
            raise InvalidRequestError("workshop result is empty or too large")
        metadata = await _cloud_job_results.save_base64(
            task_id,
            encoded,
            mime_type=mime_type,
        )
        if elapsed is not None:
            metadata["elapsed"] = elapsed
        job, _ = await _cloud_jobs.transition(
            task_id,
            JobStatus.SUCCEEDED,
            kind="succeeded",
            step=1,
            total_steps=1,
            result=metadata,
        )
        await _workshop_quota.capture(task_id)
        return job

    critical = asyncio.create_task(commit())
    try:
        return await asyncio.shield(critical)
    except asyncio.CancelledError:
        # ``to_thread`` cannot be stopped once the atomic replace begins.  Let the
        # authoritative commit win and expose its result instead of refunding a
        # file that may appear moments later.
        return await critical


async def _refund_workshop_quota(task_id: str) -> None:
    try:
        await _workshop_quota.refund(task_id)
    except CloudBackendError as exc:
        print(f"[Workshop] 额度退款待恢复: task={task_id} code={exc.code}")
    except Exception as exc:
        print(f"[Workshop] 额度退款暂不可用: task={task_id} error={type(exc).__name__}")


async def _workshop_process_task(
    task_id: str,
    req: WorkshopGenerateRequest,
    bot_user_id: str,
    quota_cost: int,
) -> None:
    """Run one persisted Workshop job and durably publish every transition."""

    try:
        job, _ = await _cloud_jobs.transition(
            task_id,
            JobStatus.RUNNING,
            kind="started",
            total_steps=1,
        )
        _mirror_workshop_job(job, session_id=req.session_id)

        provider = _workshop_providers.resolve(req.model)
        await _cloud_jobs.transition(
            task_id,
            JobStatus.RUNNING,
            kind="provider_started",
            data={"provider": provider.name if provider else "unknown"},
        )
        if provider is not None:
            result = await provider.run(WorkshopProviderRequest(
                model=req.model,
                prompt=req.prompt,
                aspect_ratio=req.aspect_ratio,
                images=req.images if req.images else None,
            ))
        else:
            result = {"success": False, "error": f"模型已停用: {req.model}"}

        if result.get("success"):
            elapsed_raw = result.get("elapsed")
            elapsed = float(elapsed_raw) if elapsed_raw is not None else None
            job = await _commit_workshop_success(
                task_id,
                encoded=str(result["image_base64"]),
                mime_type=str(result.get("mime_type") or "image/png"),
                elapsed=elapsed,
            )
            _mirror_workshop_job(job, session_id=req.session_id)

            try:
                async with aiosqlite.connect(str(_STATS_DB)) as db:
                    now_iso = datetime.now(_BEIJING_TZ).replace(tzinfo=None).isoformat()
                    stats_key = f"user_{bot_user_id}"
                    for _ in range(quota_cost):
                        await db.execute(
                            "INSERT INTO banana_calls(timestamp, stats_key, user_id, group_id) VALUES(?,?,?,?)",
                            (now_iso, stats_key, str(bot_user_id), None)
                        )
                    await db.commit()
            except Exception as e:
                print(f"[Workshop] 调用统计记录失败: {e}")

            if elapsed is not None:
                _record_workshop_elapsed(req.model, elapsed)
        else:
            error = str(result.get("error") or "生成失败")[:2_000]
            job, _ = await _cloud_jobs.transition(
                task_id,
                JobStatus.FAILED,
                kind="failed",
                error=error,
            )
            # Refund before mirroring the terminal state: the mirror is what marks
            # the task complete to clients, so the quota must already be restored
            # once they can observe the failure (avoids a refund-lags-completion race).
            await _refund_workshop_quota(task_id)
            _mirror_workshop_job(job, session_id=req.session_id)
    except asyncio.CancelledError:
        job = await _cloud_jobs.get(task_id)
        if job is not None and job.status is JobStatus.SUCCEEDED:
            try:
                await _workshop_quota.capture(task_id)
            except CloudBackendError as exc:
                print(f"[Workshop] 成功任务额度待恢复: task={task_id} code={exc.code}")
            _mirror_workshop_job(job, session_id=req.session_id)
            return
        if job is not None and not job.terminal:
            if job.status in {JobStatus.QUEUED, JobStatus.RUNNING}:
                job, _ = await _cloud_jobs.request_cancel(task_id)
            if job.status is JobStatus.CANCELLING:
                job, _ = await _cloud_jobs.transition(
                    task_id,
                    JobStatus.CANCELLED,
                    kind="cancelled",
                    error="用户取消",
                )
            # Refund before the completion mirror (see the failed-branch note).
            await _refund_workshop_quota(task_id)
            _mirror_workshop_job(job, session_id=req.session_id)
        else:
            await _refund_workshop_quota(task_id)
        raise
    except Exception as e:
        print(f"[Workshop] 任务异常: {e}")
        job = await _cloud_jobs.get(task_id)
        if job is not None and job.status is JobStatus.SUCCEEDED:
            _mirror_workshop_job(job, session_id=req.session_id)
            return
        if job is not None and job.status in {JobStatus.CANCELLING, JobStatus.CANCELLED}:
            if job.status is JobStatus.CANCELLING:
                job, _ = await _cloud_jobs.transition(
                    task_id,
                    JobStatus.CANCELLED,
                    kind="cancelled",
                    error="用户取消",
                )
            # Refund before the completion mirror (see the failed-branch note).
            await _refund_workshop_quota(task_id)
            _mirror_workshop_job(job, session_id=req.session_id)
            return
        if job is not None and not job.terminal:
            job, _ = await _cloud_jobs.transition(
                task_id,
                JobStatus.FAILED,
                kind="failed",
                error=f"生成异常: {e}"[:2_000],
            )
            # Refund before the completion mirror (see the failed-branch note).
            await _refund_workshop_quota(task_id)
            _mirror_workshop_job(job, session_id=req.session_id)
        else:
            await _refund_workshop_quota(task_id)


@app.delete("/api/workshop/tasks/{task_id}")
async def workshop_cancel_task(task_id: str, session_id: str):
    job, _principal = await _authorize_workshop_job(task_id, session_id)
    if job.terminal:
        if job.status is not JobStatus.SUCCEEDED:
            await _refund_workshop_quota(task_id)
        return {"success": True, "status": _workshop_status(job)}
    try:
        job, _ = await _cloud_jobs.request_cancel(task_id)
    except JobStateConflictError:
        current = await _cloud_jobs.get(task_id)
        if current is None or not _is_workshop_job(current):
            raise HTTPException(status_code=404, detail="任务不存在") from None
        return {"success": True, "status": _workshop_status(current)}
    _mirror_workshop_job(job)

    background = _workshop_background_tasks.get(task_id)
    if background is not None and not background.done():
        background.cancel()
        await asyncio.gather(background, return_exceptions=True)

    current = await _cloud_jobs.get(task_id)
    if current is None:
        raise HTTPException(status_code=404, detail="任务不存在")
    if current.status is JobStatus.CANCELLING:
        current, _ = await _cloud_jobs.transition(
            task_id,
            JobStatus.CANCELLED,
            kind="cancelled",
            error="用户取消",
        )
    if current.status is JobStatus.CANCELLED:
        await _refund_workshop_quota(task_id)
    _mirror_workshop_job(current)
    return {"success": True, "status": _workshop_status(current)}


@app.get("/api/workshop/tasks")
async def workshop_get_tasks(session_id: str):
    """Return the persistent owner view used to recover after refresh/restart."""

    principal = _principal_from_bot_session(session_id)
    await _ensure_cloud_job_storage()
    _cleanup_workshop_tasks()
    resource = ResourceOwner(_BOT_TASK_TENANT_ID, principal.subject_id)
    jobs = await _cloud_jobs.list_for_owner(
        resource,
        limit=_WORKSHOP_JOB_LIST_LIMIT,
        payload_kind=_WORKSHOP_JOB_KIND,
    )
    tasks = [_workshop_job_response(job, principal) for job in jobs]
    return {"tasks": tasks}


@app.get("/api/workshop/images/{filename}")
async def workshop_serve_image(filename: str, capability: str = "", job_id: str = ""):
    """Serve a verified result only through its job-bound capability."""

    # Content-addressed result filenames no longer encode their owning job.  The
    # explicit id is non-secret and is still authenticated by the job-bound
    # capability.  Keep the old stem fallback for pre-migration metadata/URLs.
    task_id = job_id or Path(filename).stem
    await _ensure_cloud_job_storage()
    try:
        job = await _cloud_jobs.get(task_id)
    except InvalidRequestError as exc:
        raise HTTPException(status_code=404, detail="图片不存在") from exc
    record = (
        {"tenant_id": job.resource.tenant_id, "owner_id": job.resource.owner_id}
        if job is not None
        else None
    )
    try:
        _task_access.require_capability(
            record,
            job_id=task_id,
            token=capability,
        )
    except (InvalidCapabilityError, ResourceNotFoundError) as exc:
        raise HTTPException(status_code=404, detail="图片不存在") from exc
    if (
        job is None
        or not _is_workshop_job(job)
        or job.status is not JobStatus.SUCCEEDED
        or job.result is None
        or job.result.get("path") != filename
    ):
        raise HTTPException(status_code=404, detail="图片不存在")
    try:
        payload = await _cloud_job_results.load_bytes(job.result)
    except ResourceNotFoundError as exc:
        raise HTTPException(status_code=404, detail="图片不存在") from exc
    return Response(
        content=payload,
        media_type=str(job.result.get("mime_type") or "application/octet-stream"),
        headers={"Cache-Control": "private, max-age=600"},
    )


# ==================== WD Tagger 反推接口 ====================

_wd_tagger_session: aiohttp.ClientSession | None = None


def _get_wd_tagger_session() -> aiohttp.ClientSession:
    """获取或创建 WD Tagger 专用的全局 aiohttp Session"""
    global _wd_tagger_session
    if _wd_tagger_session is None or _wd_tagger_session.closed:
        connector = None
        if WD_TAGGER_PROXY and ProxyConnector:
            connector = ProxyConnector.from_url(WD_TAGGER_PROXY, rdns=True)
        timeout = aiohttp.ClientTimeout(total=120, sock_connect=30, sock_read=90)
        _wd_tagger_session = aiohttp.ClientSession(connector=connector, timeout=timeout)
    return _wd_tagger_session


class WDTaggerRequest(BaseModel):
    image: str  # base64 encoded image data (不含 data:image/xxx;base64, 前缀)


@app.post("/api/wd-tagger")
async def wd_tagger_predict(req: WDTaggerRequest):
    """调用 pixai-labs/pixai-tagger-demo Space 进行图片标签反推。"""

    try:
        approved_tagger = PublicEndpointPolicy().validate(WD_TAGGER_SPACE_URL)
        if (
            approved_tagger.scheme != "https"
            or approved_tagger.host != "pixai-labs-pixai-tagger-demo.hf.space"
            or approved_tagger.port != 443
            or approved_tagger.url.rstrip("/")
            != "https://pixai-labs-pixai-tagger-demo.hf.space"
        ):
            return {"success": False, "error": "WD Tagger 地址不在受信服务列表"}
        # 1. 解码 base64 图片
        image_bytes = base64.b64decode(req.image, validate=True)
        if not image_bytes or len(image_bytes) > 20 * 1024 * 1024:
            return {"success": False, "error": "图片为空或过大"}

        try:
            from gradio_client import Client, handle_file
        except ImportError:
            return {"success": False, "error": "缺少 gradio_client 依赖，请运行 uv sync --frozen"}

        loop = asyncio.get_event_loop()

        def _predict(file_path: str):
            client = Client(
                approved_tagger.url.rstrip("/"),
                httpx_kwargs={"trust_env": False, "timeout": 120},
                verbose=False,
            )
            return client.predict(
                handle_file(file_path), # image
                "",                     # url
                0.30,                   # general_threshold
                0.75,                   # character_threshold，与 Bot 端保持一致
                "threshold",            # mode
                100,                    # topk_general
                100,                    # topk_character
                False,                  # include_scores
                False,                  # underscore_mode
                api_name="/predict_image",
            )

        with tempfile.NamedTemporaryFile(delete=False, suffix=".png") as temp_file:
            temp_file.write(image_bytes)
            temp_path = temp_file.name
        try:
            data = await loop.run_in_executor(None, lambda: _predict(temp_path))
        finally:
            try:
                os.unlink(temp_path)
            except OSError:
                pass

        # data = [features_out, characters_out, ip_out, combined_out, meta_out, raw_out]
        if not data or not isinstance(data, (list, tuple)) or len(data) < 6:
            return {"success": False, "error": f"Unexpected tagger result: {data}"}

        # 5. 解析结果
        def _norm(s):
            return "" if (not isinstance(s, str) or s == "—") else s

        tags_string = _norm(data[3])  # combined：character → ip → general
        character = _norm(data[1])

        # confidence：从 raw_out 的 character_scores 取
        confidence = {}
        raw_out = data[5] if isinstance(data[5], dict) else {}
        char_scores = raw_out.get("character_scores") or {}
        if isinstance(char_scores, dict):
            for k, v in char_scores.items():
                try:
                    confidence[str(k).replace("_", " ")] = float(v)
                except (TypeError, ValueError):
                    pass

        return {
            "success": True,
            "tags": tags_string,
            "character": character,
            "rating": "",   # pixai 模型无 rating 头
            "confidence": confidence,
        }

    except asyncio.TimeoutError:
        return {"success": False, "error": "Tagger 请求超时"}
    except Exception as e:
        print(f"[Tagger] Error: {e}")
        return {"success": False, "error": str(e)}
