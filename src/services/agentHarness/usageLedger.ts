/**
 * Token 用量账本,照他的 `usage_ledger_service.dart`(参考 pi-bill 的 usage-ledger.json):
 * 每次 assistant 响应完成记一条,按 key 去重;按「今天 / 近 7 天 / 近 30 天 / 全部」聚合成
 * 模型 × (请求数, 输入, 输出, 缓存读, 命中率, 合计)。这里只有纯函数,落盘在面板那层。
 *
 * 他按 天 → 供应商 → 模型 三层存一份聚合副本,我们只存条目(聚合是线性扫一遍的事);
 * 条目封顶 MAX_LEDGER_ENTRIES,超了丢最早的,localStorage 里不至于无限长。
 */

import { addUsage, EMPTY_USAGE, usageTotal, type TokenUsage } from './types';

export type BillPeriod = 'today' | 'last7d' | 'last30d' | 'all';

export const BILL_PERIODS: readonly BillPeriod[] = ['today', 'last7d', 'last30d', 'all'];

export interface UsageLedgerEntry {
  key: string;
  /** 本地日期 YYYY-MM-DD;周期过滤只看它,与他的 `_localDay` 一致。 */
  day: string;
  at: number;
  provider: string;
  model: string;
  usage: TokenUsage;
}

export interface UsageLedger {
  version: 1;
  entries: UsageLedgerEntry[];
}

export interface BillModelUsage {
  /** "provider/model" */
  name: string;
  requests: number;
  usage: TokenUsage;
}

export interface BillSummary {
  period: BillPeriod;
  requests: number;
  usage: TokenUsage;
  /** 按合计 token 降序。 */
  models: BillModelUsage[];
}

export const MAX_LEDGER_ENTRIES = 5000;

export const EMPTY_LEDGER: UsageLedger = { version: 1, entries: [] };

const two = (n: number) => String(n).padStart(2, '0');

export function localDay(at: number | Date): string {
  const d = at instanceof Date ? at : new Date(at);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/** 周期起始日(含);`all` 没有起点。近 7 天 = 今天往前 6 天,与他的算法一致。 */
export function periodStartDay(period: BillPeriod, now: number | Date): string | null {
  const d = now instanceof Date ? now : new Date(now);
  switch (period) {
    case 'all': return null;
    case 'today': return localDay(d);
    case 'last7d': return localDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 6));
    case 'last30d': return localDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 29));
  }
}

/** 记一条;用量为 0 或 key 重复时原样返回同一个对象(调用方据此判断要不要落盘)。 */
export function recordUsage(
  ledger: UsageLedger,
  entry: { key: string; provider: string; model: string; usage: TokenUsage; at?: number },
): UsageLedger {
  if (usageTotal(entry.usage) <= 0) return ledger;
  if (ledger.entries.some((e) => e.key === entry.key)) return ledger;
  const at = entry.at ?? Date.now();
  const next: UsageLedgerEntry = {
    key: entry.key,
    day: localDay(at),
    at,
    provider: entry.provider || 'unknown',
    model: entry.model || 'unknown',
    usage: { ...entry.usage },
  };
  const entries = [...ledger.entries, next];
  return { version: 1, entries: entries.length > MAX_LEDGER_ENTRIES ? entries.slice(entries.length - MAX_LEDGER_ENTRIES) : entries };
}

export function aggregateLedger(ledger: UsageLedger, period: BillPeriod, now: number | Date = Date.now()): BillSummary {
  const startDay = periodStartDay(period, now);
  let total = EMPTY_USAGE;
  let requests = 0;
  const byModel = new Map<string, BillModelUsage>();
  for (const entry of ledger.entries) {
    if (startDay !== null && entry.day < startDay) continue;
    requests += 1;
    total = addUsage(total, entry.usage);
    const name = `${entry.provider}/${entry.model}`;
    const existing = byModel.get(name);
    byModel.set(name, {
      name,
      requests: (existing?.requests ?? 0) + 1,
      usage: addUsage(existing?.usage ?? EMPTY_USAGE, entry.usage),
    });
  }
  const models = [...byModel.values()].sort((a, b) => usageTotal(b.usage) - usageTotal(a.usage));
  return { period, requests, usage: total, models };
}

/** 缓存命中率 = 缓存读 / 总输入;没有输入时为 null。口径与 pi 的 footer CH 标记一致。 */
export function cacheHitRate(u: TokenUsage): number | null {
  return u.input > 0 ? u.cacheRead / u.input : null;
}

/** 1.2K / 3.4M / 1.2B,与他的 formatTokens 一致(1000 显示 1.0K)。 */
export function formatTokens(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (absolute >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (absolute >= 1000) return `${(value / 1000).toFixed(1)}K`;
  return String(Math.trunc(value));
}

function isUsage(v: unknown): v is TokenUsage {
  if (!v || typeof v !== 'object') return false;
  const u = v as Record<string, unknown>;
  return ['input', 'output', 'cacheRead', 'cacheWrite'].every((k) => typeof u[k] === 'number' && Number.isFinite(u[k]));
}

/** 读回来的东西不可信:缺字段、类型错、重复 key 的条目一律丢掉。 */
export function sanitizeUsageLedger(raw: unknown): UsageLedger {
  if (!raw || typeof raw !== 'object') return EMPTY_LEDGER;
  const list = (raw as { entries?: unknown }).entries;
  if (!Array.isArray(list)) return EMPTY_LEDGER;
  const seen = new Set<string>();
  const entries: UsageLedgerEntry[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    if (typeof e.key !== 'string' || !e.key || seen.has(e.key)) continue;
    if (typeof e.at !== 'number' || !Number.isFinite(e.at) || !isUsage(e.usage)) continue;
    seen.add(e.key);
    entries.push({
      key: e.key,
      day: typeof e.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.day) ? e.day : localDay(e.at),
      at: e.at,
      provider: typeof e.provider === 'string' && e.provider ? e.provider : 'unknown',
      model: typeof e.model === 'string' && e.model ? e.model : 'unknown',
      usage: { input: e.usage.input, output: e.usage.output, cacheRead: e.usage.cacheRead, cacheWrite: e.usage.cacheWrite },
    });
  }
  return { version: 1, entries: entries.length > MAX_LEDGER_ENTRIES ? entries.slice(entries.length - MAX_LEDGER_ENTRIES) : entries };
}
