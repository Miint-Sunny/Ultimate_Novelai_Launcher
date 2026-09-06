/**
 * 助手面板形态(harness / 旧版规划式)的共享开关。以前只在 AssistantSwitch 里存一份 state,
 * 会话历史面板打开某条会话时得能把面板切到对应形态,所以抬成模块级的小 store。
 */

import { useSyncExternalStore } from 'react';

export type AssistantUi = 'harness' | 'legacy';

const UI_KEY = 'desktop_agent_ui';

function read(): AssistantUi {
  try { return localStorage.getItem(UI_KEY) === 'legacy' ? 'legacy' : 'harness'; } catch { return 'harness'; }
}

let current: AssistantUi | null = null;
const listeners = new Set<() => void>();

export function getAssistantUi(): AssistantUi {
  if (current === null) current = read();
  return current;
}

export function setAssistantUi(next: AssistantUi): void {
  if (getAssistantUi() === next) return;
  current = next;
  try { localStorage.setItem(UI_KEY, next); } catch { /* ignore */ }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAssistantUi(): AssistantUi {
  return useSyncExternalStore(subscribe, getAssistantUi, () => 'harness');
}
