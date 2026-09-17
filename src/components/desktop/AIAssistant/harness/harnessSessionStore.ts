/**
 * Harness 对话的落盘中枢:当前对话(刷新后回填)与归档列表(会话历史面板)都在这里,
 * 面板 hook 与会话历史面板是它的两个订阅方。
 *
 * 为什么不放进 AgentDockContext:hook 只在助手面板挂着时才存在,会话历史面板却要在
 * 助手面板关着、或切在旧版形态时也能列出 / 打开 harness 会话。所以「替换当前对话」
 * 走的是存储层:先把新内容写进 localStorage,再通知挂着的 hook 重新读;没挂着的 hook
 * 下次挂载时自然从存储读到。
 */

import { useSyncExternalStore } from 'react';
import {
  buildHarnessSession, prependSession, sanitizeHarnessSessions, sessionItems, summarizeTranscript,
  type HarnessSession, type HarnessSessionSummary,
} from './sessionArchive';
import { deserializeTranscript, serializeTranscript, type TranscriptItem } from './transcript';

const TRANSCRIPT_KEY = 'desktop_agent_harness_transcript';
const CONTEXT_KEY = 'desktop_agent_harness_context';
const SESSIONS_KEY = 'desktop_agent_harness_sessions';

export interface HarnessSessionsSnapshot {
  sessions: HarnessSession[];
  /** 当前对话的摘要;还没有用户消息时为 null。 */
  current: HarnessSessionSummary | null;
  /** 助手正在回复:此时不能归档 / 打开 / 丢弃。 */
  busy: boolean;
}

let currentItems: TranscriptItem[] | null = null;
/** harness 的上下文状态(摘要、切点、编号、笔记),与当前对话一起换。 */
let currentContext: unknown = undefined;
let sessions: HarnessSession[] | null = null;
let busy = false;
let snapshot: HarnessSessionsSnapshot | null = null;

const snapshotListeners = new Set<() => void>();
const replacedListeners = new Set<() => void>();

function emit(replaced: boolean) {
  snapshot = null;
  for (const listener of snapshotListeners) listener();
  if (replaced) for (const listener of replacedListeners) listener();
}

function writeTranscript(items: TranscriptItem[]) {
  currentItems = items;
  try { localStorage.setItem(TRANSCRIPT_KEY, JSON.stringify(serializeTranscript(items))); } catch { /* 存不下就算了 */ }
}

function writeContext(state: unknown) {
  currentContext = state;
  try {
    if (state === undefined || state === null) localStorage.removeItem(CONTEXT_KEY);
    else localStorage.setItem(CONTEXT_KEY, JSON.stringify(state));
  } catch { /* 存不下就算了 */ }
}

export function loadCurrentContext(): unknown {
  if (currentContext === undefined) {
    try { currentContext = JSON.parse(localStorage.getItem(CONTEXT_KEY) || 'null'); } catch { currentContext = null; }
  }
  return currentContext;
}

/** harness 每次 onContextChanged 都调;不发通知,面板自己刷新指示器。 */
export function saveCurrentContext(state: unknown): void {
  writeContext(state);
}

/** 归档列表整份写回;超配额就从最旧的开始丢,直到写得下。 */
function writeSessions(list: HarnessSession[]) {
  let kept = list;
  for (;;) {
    try {
      localStorage.setItem(SESSIONS_KEY, JSON.stringify(kept));
      break;
    } catch {
      if (kept.length === 0) break;
      kept = kept.slice(0, kept.length - 1);
    }
  }
  sessions = kept;
}

export function loadCurrentTranscript(): TranscriptItem[] {
  if (currentItems === null) {
    try { currentItems = deserializeTranscript(JSON.parse(localStorage.getItem(TRANSCRIPT_KEY) || '[]')); } catch { currentItems = []; }
  }
  return currentItems;
}

/** 面板 hook 每次条目变化都调;同一个数组引用(刚从这里读出去的)不重复写。 */
export function saveCurrentTranscript(items: TranscriptItem[]): void {
  if (items === currentItems) return;
  writeTranscript(items);
  emit(false);
}

export function setHarnessBusy(next: boolean): void {
  if (busy === next) return;
  busy = next;
  emit(false);
}

export function listHarnessSessions(): HarnessSession[] {
  if (sessions === null) {
    try { sessions = sanitizeHarnessSessions(JSON.parse(localStorage.getItem(SESSIONS_KEY) || '[]')); } catch { sessions = []; }
  }
  return sessions;
}

/** 把当前对话存进历史并清空。没有用户消息(空对话)时什么都不做,返回 false。 */
export function archiveCurrentTranscript(): boolean {
  if (busy) return false;
  const session = buildHarnessSession(loadCurrentTranscript());
  if (!session) return false;
  writeSessions(prependSession(listHarnessSessions(), { ...session, context: loadCurrentContext() ?? undefined }));
  writeTranscript([]);
  writeContext(null);
  emit(true);
  return true;
}

/** 清空当前对话,不归档(输入栏的垃圾桶)。 */
export function discardCurrentTranscript(): boolean {
  if (busy) return false;
  writeTranscript([]);
  writeContext(null);
  emit(true);
  return true;
}

export function removeHarnessSession(id: string): void {
  removeHarnessSessions([id]);
}

/** 批量删除只写一次盘、只通知一次;不认识的 id 忽略,一个都没删到就不通知。 */
export function removeHarnessSessions(ids: Iterable<string>): number {
  const targets = new Set(ids);
  const list = listHarnessSessions();
  const kept = list.filter((s) => !targets.has(s.id));
  const removed = list.length - kept.length;
  if (removed === 0) return 0;
  writeSessions(kept);
  emit(false);
  return removed;
}

/** 打开一条归档:当前对话(如有内容)先归档,再把那条灌成当前对话。 */
export function restoreHarnessSession(id: string): boolean {
  if (busy) return false;
  const target = listHarnessSessions().find((s) => s.id === id);
  if (!target) return false;
  let list = listHarnessSessions().filter((s) => s.id !== id);
  const outgoing = buildHarnessSession(loadCurrentTranscript());
  if (outgoing) list = prependSession(list, { ...outgoing, context: loadCurrentContext() ?? undefined });
  writeSessions(list);
  writeTranscript(sessionItems(target));
  writeContext(target.context ?? null);
  emit(true);
  return true;
}

/** 当前对话被存储层整份换掉(归档 / 丢弃 / 打开归档)时通知挂着的 hook 重读。 */
export function subscribeTranscriptReplaced(listener: () => void): () => void {
  replacedListeners.add(listener);
  return () => replacedListeners.delete(listener);
}

function subscribe(listener: () => void): () => void {
  snapshotListeners.add(listener);
  return () => snapshotListeners.delete(listener);
}

function getSnapshot(): HarnessSessionsSnapshot {
  if (snapshot === null) snapshot = { sessions: listHarnessSessions(), current: summarizeTranscript(loadCurrentTranscript()), busy };
  return snapshot;
}

const SERVER_SNAPSHOT: HarnessSessionsSnapshot = { sessions: [], current: null, busy: false };

export function useHarnessSessions(): HarnessSessionsSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, () => SERVER_SNAPSHOT);
}
