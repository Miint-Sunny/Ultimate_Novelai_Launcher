"""
Anima 出图后端 —— 走 cnb 托管的 ComfyUI workspace 出二次元图。

业务流程（基于通用 CNBComfyPool）:
    1. enqueue_local_task(task_id) 入本地等待队列(提示进度) + 触发动态扩容
    2. acquire_local_account(task_id) 阻塞等到分到一个空闲账户
    3. ensure_account_ready_url(account) 同步等到 ComfyUI 在该账户的 cnb workspace 健康
    4. 把模板 anima_base_api.json 按 positive/negative/width/height/seed patch 节点字段
    5. POST {comfy_url}/prompt 提交 → 拿 prompt_id
    6. 轮询 /history/{prompt_id} 直到 outputs["46"] 有图(超时则中断)
    7. GET /view?filename=...&subfolder=...&type=output 下载 PNG bytes
    8. release_local_account 解锁账户给下一个任务

入口:
    generate_anima_image(positive, negative, width, height, seed, task_id) -> bytes
    start_anima_patrol()      # app.py startup 钩
    cancel_anima_background() # app.py shutdown 钩
    get_anima_pool()          # 状态查询接口取池子实例(给管理 endpoint 用)
"""
from __future__ import annotations

import asyncio
import json
import logging
import random
import string
import time
from pathlib import Path
from typing import Optional
from urllib.parse import urlencode

import aiohttp

from .cnb_comfy_pool import CNBComfyPool, CNBComfyTimeoutError


logger = logging.getLogger("anima_provider")


# ============================================================
# 单例 anima_pool
# ============================================================

_anima_pool: Optional[CNBComfyPool] = None
_anima_payload_template: Optional[dict] = None
_anima_defaults: dict = {}


def _init_pool() -> CNBComfyPool:
    """惰性初始化 anima_pool 单例。"""
    global _anima_pool, _anima_payload_template, _anima_defaults
    if _anima_pool is not None:
        return _anima_pool

    try:
        from config import (  # type: ignore
            ANIMA_CNB_ACCOUNTS,
            ANIMA_ACCOUNT_STORE,
            ANIMA_PAYLOAD_PATH,
            ANIMA_DEFAULT_PROMPT,
            ANIMA_DEFAULT_NEGATIVE_PROMPT,
            ANIMA_DEFAULT_WIDTH,
            ANIMA_DEFAULT_HEIGHT,
            ANIMA_CNB_REQUEST_TIMEOUT,
            ANIMA_CNB_DETAIL_POLL_INTERVAL,
            ANIMA_CNB_READY_TIMEOUT,
            ANIMA_PATROL_INTERVAL_SECONDS,
            ANIMA_IDLE_SHUTDOWN_SECONDS,
            ANIMA_ACCOUNT_MAX_RUNNING_SECONDS,
            ANIMA_LOCAL_ACTIVE_STALE_SECONDS,
            ANIMA_SCALE_QUEUE_PER_ACCOUNT,
            ANIMA_POLL_INTERVAL,
            ANIMA_RUNNING_TIMEOUT_SECONDS,
        )
    except ImportError as e:
        raise RuntimeError(f"anima_provider: 无法加载 ANIMA_* 配置: {e}") from e

    _anima_pool = CNBComfyPool(
        name="anima",
        accounts=ANIMA_CNB_ACCOUNTS,
        store_path=ANIMA_ACCOUNT_STORE,
        request_timeout=ANIMA_CNB_REQUEST_TIMEOUT,
        detail_poll_interval=ANIMA_CNB_DETAIL_POLL_INTERVAL,
        ready_timeout=ANIMA_CNB_READY_TIMEOUT,
        patrol_interval=ANIMA_PATROL_INTERVAL_SECONDS,
        idle_shutdown_seconds=ANIMA_IDLE_SHUTDOWN_SECONDS,
        account_max_running_seconds=ANIMA_ACCOUNT_MAX_RUNNING_SECONDS,
        local_active_stale_seconds=ANIMA_LOCAL_ACTIVE_STALE_SECONDS,
        scale_queue_per_account=ANIMA_SCALE_QUEUE_PER_ACCOUNT,
        running_timeout_seconds=ANIMA_RUNNING_TIMEOUT_SECONDS,
        logger=logger,
    )

    payload_path = Path(str(ANIMA_PAYLOAD_PATH))
    if not payload_path.is_file():
        raise RuntimeError(f"anima_provider: payload 模板不存在: {payload_path}")
    try:
        _anima_payload_template = json.loads(payload_path.read_text(encoding="utf-8"))
    except Exception as e:
        raise RuntimeError(f"anima_provider: 解析 payload 模板失败 {payload_path}: {e}") from e

    _anima_defaults = {
        "positive": str(ANIMA_DEFAULT_PROMPT or ""),
        "negative": str(ANIMA_DEFAULT_NEGATIVE_PROMPT or ""),
        "width": int(ANIMA_DEFAULT_WIDTH or 832),
        "height": int(ANIMA_DEFAULT_HEIGHT or 1216),
        "poll_interval": float(ANIMA_POLL_INTERVAL or 3),
        "running_timeout": int(ANIMA_RUNNING_TIMEOUT_SECONDS or 300),
    }

    return _anima_pool


def get_anima_pool() -> CNBComfyPool:
    return _init_pool()


# ============================================================
# 业务函数：patch payload + ComfyUI 调用
# ============================================================

def _patch_anima_payload(
    template: dict,
    *,
    positive: str,
    negative: str,
    width: int,
    height: int,
    seed: int,
) -> dict:
    """
    按 amina_base_api.json 的节点 id 契约填字段。
        node 11 正向 CLIPTextEncode.inputs.text
        node 12 负向 CLIPTextEncode.inputs.text
        node 28 EmptyLatentImage.inputs.width / height
        node 19 KSampler.inputs.seed
        node 46 SaveImage（输出节点，不改）
    """
    payload = json.loads(json.dumps(template))  # 深拷贝，避免污染模板
    prompt = payload.get("prompt") or {}
    if "11" in prompt:
        prompt["11"].setdefault("inputs", {})["text"] = positive
    if "12" in prompt:
        prompt["12"].setdefault("inputs", {})["text"] = negative
    if "28" in prompt:
        node28 = prompt["28"].setdefault("inputs", {})
        node28["width"] = int(width)
        node28["height"] = int(height)
    if "19" in prompt:
        prompt["19"].setdefault("inputs", {})["seed"] = int(seed)
    payload["prompt"] = prompt
    return payload


async def _submit_prompt(comfy_url: str, payload: dict) -> str:
    request_body = {
        "prompt": payload.get("prompt") or {},
        "client_id": f"anima-{int(time.time())}",
    }
    timeout = aiohttp.ClientTimeout(total=60)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.post(f"{comfy_url}/prompt", json=request_body) as resp:
            text = await resp.text()
            if resp.status != 200:
                raise Exception(f"anima 提交任务失败: {resp.status} {text[:300]}")
            data = json.loads(text) if text else {}
    prompt_id = data.get("prompt_id")
    if not prompt_id:
        raise Exception(f"anima 未返回 prompt_id: {data}")
    return str(prompt_id)


async def _wait_history(
    pool: CNBComfyPool,
    comfy_url: str,
    prompt_id: str,
    poll_interval: float,
    running_timeout_seconds: int,
) -> dict:
    """轮询 /history/{prompt_id} 直到 outputs 出现，或超时。"""
    submit_started_at = time.time()
    missing_timeout_seconds = running_timeout_seconds + 60
    running_started_at: float | None = None
    missing_started_at: float | None = None
    timeout = aiohttp.ClientTimeout(total=60)
    history_consecutive_failures = 0
    max_history_failure_seconds = 60

    async with aiohttp.ClientSession(timeout=timeout) as session:
        while True:
            if (time.time() - submit_started_at) > running_timeout_seconds:
                raise CNBComfyTimeoutError(
                    f"anima 出图执行超时（提交后超过 {running_timeout_seconds}s）"
                )
            try:
                async with session.get(f"{comfy_url}/history/{prompt_id}") as resp:
                    text = await resp.text()
                    if resp.status != 200:
                        raise Exception(f"查询历史失败: {resp.status} {text[:200]}")
                    data = json.loads(text) if text else {}
                history_consecutive_failures = 0
            except CNBComfyTimeoutError:
                raise
            except Exception as e:
                history_consecutive_failures += 1
                failure_duration = history_consecutive_failures * poll_interval
                if failure_duration > max_history_failure_seconds:
                    raise Exception(f"查询历史连续失败超过 {max_history_failure_seconds}s: {e}")
                logger.warning(f"anima 查询历史临时失败 (连续{history_consecutive_failures}次): {e}")
                await asyncio.sleep(poll_interval)
                continue

            job = data.get(prompt_id)
            if job and job.get("outputs"):
                return job
            if job:
                missing_started_at = None

            try:
                async with session.get(f"{comfy_url}/queue") as resp:
                    queue_text = await resp.text()
                    if resp.status == 200:
                        queue_data = json.loads(queue_text) if queue_text else {}
                        running_ids = pool.extract_queue_prompt_ids(
                            queue_data.get("queue_running") or []
                        )
                        pending_ids = pool.extract_queue_prompt_ids(
                            queue_data.get("queue_pending") or []
                        )
                        if prompt_id in running_ids:
                            missing_started_at = None
                            if running_started_at is None:
                                running_started_at = time.time()
                                logger.info(f"anima 任务进入 running: {prompt_id}")
                            running_elapsed = time.time() - running_started_at
                            if running_elapsed > running_timeout_seconds:
                                raise CNBComfyTimeoutError(
                                    f"anima 出图超时（running 超过 {running_timeout_seconds}s）"
                                )
                        elif prompt_id in pending_ids:
                            running_started_at = None
                            missing_started_at = None
                        else:
                            running_started_at = None
                            if missing_started_at is None:
                                missing_started_at = time.time()
                            elif (time.time() - missing_started_at) > missing_timeout_seconds:
                                raise CNBComfyTimeoutError(
                                    f"anima 任务状态丢失（连续 {missing_timeout_seconds}s 不在 history/queue）"
                                )
            except CNBComfyTimeoutError:
                raise
            except Exception as e:
                logger.warning(f"anima 查询队列状态失败 {prompt_id}: {e}")

            await asyncio.sleep(poll_interval)


def _pick_image_output(history_job: dict) -> dict:
    """从 history outputs 里挑第一张图（优先 node 46，否则任意输出节点的 images）。"""
    outputs = history_job.get("outputs") or {}
    preferred = ["46"]
    for node_id in preferred:
        node = outputs.get(node_id) or {}
        for item in node.get("images") or []:
            if isinstance(item, dict) and item.get("filename"):
                return item
    for node in outputs.values():
        for item in (node or {}).get("images") or []:
            if isinstance(item, dict) and item.get("filename"):
                return item
    raise Exception("anima 未找到输出图片")


async def _download_image(comfy_url: str, result_meta: dict) -> bytes:
    query = urlencode({
        "filename": result_meta["filename"],
        "subfolder": result_meta.get("subfolder", ""),
        "type": result_meta.get("type", "output"),
    })
    timeout = aiohttp.ClientTimeout(total=None, sock_connect=30, sock_read=180)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.get(f"{comfy_url}/view?{query}") as resp:
            if resp.status != 200:
                text = await resp.text()
                raise Exception(f"anima 下载结果失败: {resp.status} {text[:200]}")
            return await resp.read()


# ============================================================
# 主入口
# ============================================================

async def generate_anima_image(
    *,
    positive: str = "",
    negative: str = "",
    width: int = 0,
    height: int = 0,
    seed: int = -1,
    task_id: str = "",
) -> bytes:
    """
    生成一张 anima 图，同步等到完成，返回 PNG bytes。

    Args:
        positive: 正向 prompt（空 → 用 ANIMA_DEFAULT_PROMPT 兜底）
        negative: 负向 prompt（空 → 用 ANIMA_DEFAULT_NEGATIVE_PROMPT 兜底）
        width / height: 0 / 负数 → 用 ANIMA_DEFAULT_WIDTH/HEIGHT
        seed: 负数 → 随机
        task_id: 用于队列追踪的标识（空 → 自动生成）

    Raises:
        CNBComfyTimeoutError: 启动 / 出图阶段超时
        Exception: 其他失败（提交 / 下载等）
    """
    pool = _init_pool()
    defaults = _anima_defaults
    template = _anima_payload_template
    if template is None:
        raise RuntimeError("anima_provider: payload 模板未加载")

    positive_text = (positive or "").strip() or defaults["positive"]
    negative_text = (negative or "").strip() or defaults["negative"]
    width_px = int(width) if int(width) > 0 else defaults["width"]
    height_px = int(height) if int(height) > 0 else defaults["height"]
    seed_value = int(seed) if int(seed) >= 0 else random.randint(0, 2**31 - 1)

    if not task_id:
        task_id = "anima_" + "".join(
            random.choice(string.ascii_lowercase + string.digits) for _ in range(10)
        )

    account: Optional[dict] = None
    base_url = ""
    prompt_id: str | None = None
    needs_restart = False

    # 入队 + 动态扩容（让用户看到"已加入队列"提示用，调用层可忽略 position）
    try:
        await pool.enqueue_local_task(task_id)
    except Exception as e:
        logger.warning(f"anima enqueue 提示失败（不阻塞）: {e}")

    try:
        account, _initial_position = await pool.acquire_local_account(task_id)
        try:
            base_url = await pool.ensure_account_ready_url(account)
        except Exception as e:
            needs_restart = True
            raise Exception(f"anima workspace 不可用: {e}")

        # 队列守护：清理超时任务
        try:
            await pool.guard_queue(base_url)
        except Exception as e:
            logger.warning(f"anima guard_queue 异常（继续提交）: {e}")

        payload = _patch_anima_payload(
            template,
            positive=positive_text,
            negative=negative_text,
            width=width_px,
            height=height_px,
            seed=seed_value,
        )
        prompt_id = await _submit_prompt(base_url, payload)
        logger.info(
            f"anima 提交成功: task={task_id} prompt_id={prompt_id} "
            f"account={pool.get_account_key(account)} size={width_px}x{height_px} seed={seed_value}"
        )

        history = await _wait_history(
            pool,
            base_url,
            prompt_id,
            poll_interval=defaults["poll_interval"],
            running_timeout_seconds=defaults["running_timeout"],
        )
        result_meta = _pick_image_output(history)
        return await _download_image(base_url, result_meta)

    except CNBComfyTimeoutError:
        if base_url and prompt_id:
            try:
                await pool.cleanup_prompt(base_url, prompt_id, interrupt_running=True)
            except Exception as cleanup_err:
                logger.warning(f"anima 超时清理失败: {cleanup_err}")
        if isinstance(account, dict):
            needs_restart = True
        raise
    except Exception:
        if base_url and prompt_id:
            try:
                await pool.cleanup_prompt(base_url, prompt_id, interrupt_running=False)
            except Exception as cleanup_err:
                logger.warning(f"anima 异常清理失败: {cleanup_err}")
        if isinstance(account, dict):
            needs_restart = True
        raise
    finally:
        await pool.release_local_account(account, task_id)
        if isinstance(account, dict) and needs_restart:
            try:
                await pool.ensure_account_restarting(account)
            except Exception as e:
                logger.warning(f"anima 触发重启失败（继续）: {e}")


# ============================================================
# server lifecycle hooks
# ============================================================

def start_anima_patrol() -> None:
    """app.py @on_event('startup') 调用。"""
    pool = _init_pool()
    pool.start_patrol()


async def cancel_anima_background() -> None:
    """app.py @on_event('shutdown') 调用。"""
    global _anima_pool
    if _anima_pool is None:
        return
    await _anima_pool.cancel_background_tasks()
