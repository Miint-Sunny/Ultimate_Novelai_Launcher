"""宿主 Opus「体力条」状态:判定、缓存与钱包保护策略。

V5 是唯一消耗 Opus 体力条的模型族,而条空之后 NovelAI **不报错、不返回 402**,
照常出图并改扣宿主账号的 Anlas。云端宿主拿宿主账号生成,所以这条闸门是账务层的
钱安全兜底(方案 P5-5),不是产品层配额。

设计约束(方案 P5-5 原话):
  - 策略显式可配,「要么拒绝并提示,要么按 Anlas 价入账」二选一,**默认拒绝**;
  - usage 必须缓存(约 60 秒),不能每张图打一次 /user/subscription;
  - 拿不到 usage 时**不得当作条是满的**:一律按耗尽处理(fail-closed),
    宁可错杀可见的免费,不可放过不可见的扣钱。
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from enum import Enum

logger = logging.getLogger(__name__)

DEFAULT_CACHE_TTL_SECONDS = 60.0

# 订阅响应里的 token -> usage 判定由宿主适配器提供;缓存层只认这份形状。
UsageFetcher = Callable[[], Awaitable[Mapping[str, bool]]]


def is_usage_exhausted(usage: object) -> bool:
    """从 /user/subscription 的 ``usage`` 对象判定体力条是否耗尽。

    percent 可以大于 100(官方上线时发过一次性加成,实测见过 170),只有 0 才是
    空;isNegative 是官方的「已透支」位。形状不对/缺字段按耗尽处理——这里
    判「满」的错误会直接变成宿主钱包漏钱。
    """
    if not isinstance(usage, Mapping):
        return True
    percent = usage.get("percent")
    if isinstance(percent, bool) or not isinstance(percent, (int, float)):
        return True
    return percent == 0 or bool(usage.get("isNegative"))


class OpusExhaustedPolicy(str, Enum):
    """条空(或未知)时的处置:拒绝生成并提示(默认),或按 Anlas 价入账。"""

    REJECT = "reject"
    CHARGE = "charge"


def parse_policy(
    value: object,
    *,
    default: OpusExhaustedPolicy = OpusExhaustedPolicy.REJECT,
) -> OpusExhaustedPolicy:
    """解析配置值;非法值回落到安全默认(reject)并留痕,绝不允许拼错单词放宽闸门。"""
    if isinstance(value, OpusExhaustedPolicy):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        for policy in OpusExhaustedPolicy:
            if normalized == policy.value:
                return policy
    if value not in (None, ""):
        logger.warning("未知 HOST_OPUS_EXHAUSTED_POLICY=%r,回落到默认 %s", value, default.value)
    return default


@dataclass(frozen=True)
class OpusUsageSnapshot:
    """一次缓存判定结果。``fetched_at`` 用单调钟,跨进程无意义,仅用于 TTL。"""

    exhausted: bool
    data_available: bool
    fetched_at: float


class OpusUsageCache:
    """进程内共享的体力条状态缓存。

    - TTL 内直接命中,不碰上游;
    - 并发未命中时单飞(asyncio.Lock),不会一群请求同时打订阅接口;
    - 拉取失败/空数据 **同样缓存一个 TTL**:既避免反复敲打挂掉的接口,又保证
      在整个窗口内都是保守值,窗口过后自动重试;
    - 多账号(token 池)语义:任一账号条空(含该账号查询失败)即按耗尽处理。
      混合池会错杀仍健康的账号,但钱包方向上宁可错杀——错杀可见可修,
      漏扣不可见不可修。单 token 部署(常态)无此歧义。
    """

    def __init__(
        self,
        fetcher: UsageFetcher,
        *,
        ttl_seconds: float = DEFAULT_CACHE_TTL_SECONDS,
        clock: Callable[[], float] | None = None,
    ) -> None:
        if ttl_seconds <= 0:
            raise ValueError("ttl_seconds must be positive")
        self._fetcher = fetcher
        self._ttl_seconds = ttl_seconds
        self._clock: Callable[[], float] = clock or time.monotonic
        self._lock = asyncio.Lock()
        self._snapshot: OpusUsageSnapshot | None = None

    def _fresh(self, snapshot: OpusUsageSnapshot) -> bool:
        return self._clock() - snapshot.fetched_at < self._ttl_seconds

    async def snapshot(self) -> OpusUsageSnapshot:
        cached = self._snapshot
        if cached is not None and self._fresh(cached):
            return cached
        async with self._lock:
            cached = self._snapshot
            if cached is not None and self._fresh(cached):
                return cached
            now = self._clock()
            try:
                per_token = dict(await self._fetcher())
            except Exception:
                logger.warning("宿主 Opus usage 拉取失败,按耗尽处理(fail-closed)", exc_info=True)
                per_token = {}
            if per_token:
                snapshot = OpusUsageSnapshot(
                    exhausted=any(per_token.values()),
                    data_available=True,
                    fetched_at=now,
                )
            else:
                # 空 token 池/全部失败/拿不到 usage:不能当满条。
                snapshot = OpusUsageSnapshot(
                    exhausted=True,
                    data_available=False,
                    fetched_at=now,
                )
            self._snapshot = snapshot
            if snapshot.exhausted:
                logger.warning(
                    "宿主 Opus 体力条按耗尽处理(exhausted=%s, data_available=%s)",
                    snapshot.exhausted,
                    snapshot.data_available,
                )
            return snapshot

    async def is_exhausted(self) -> bool:
        return (await self.snapshot()).exhausted


__all__ = [
    "DEFAULT_CACHE_TTL_SECONDS",
    "OpusExhaustedPolicy",
    "OpusUsageCache",
    "OpusUsageSnapshot",
    "is_usage_exhausted",
    "parse_policy",
]
