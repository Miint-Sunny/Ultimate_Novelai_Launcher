/**
 * 用量账本的落盘与订阅。账本是纯数据(services/agentHarness/usageLedger),这里只管
 * localStorage 与 React 订阅;写入去重与封顶在纯函数里。
 */

import { useSyncExternalStore } from 'react';
import { EMPTY_LEDGER, recordUsage, sanitizeUsageLedger, type UsageLedger } from '../../../../services/agentHarness/usageLedger';
import type { TokenUsage } from '../../../../services/agentHarness/types';

const KEY = 'desktop_agent_usage_ledger';

let ledger: UsageLedger | null = null;
const listeners = new Set<() => void>();

export function getUsageLedger(): UsageLedger {
  if (ledger === null) {
    try { ledger = sanitizeUsageLedger(JSON.parse(localStorage.getItem(KEY) || 'null')); } catch { ledger = EMPTY_LEDGER; }
  }
  return ledger;
}

export function appendUsage(entry: { key: string; provider: string; model: string; usage: TokenUsage; at?: number }): void {
  const before = getUsageLedger();
  const after = recordUsage(before, entry);
  if (after === before) return;
  ledger = after;
  try { localStorage.setItem(KEY, JSON.stringify(after)); } catch { /* 存不下就只留在内存里 */ }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useUsageLedger(): UsageLedger {
  return useSyncExternalStore(subscribe, getUsageLedger, () => EMPTY_LEDGER);
}
