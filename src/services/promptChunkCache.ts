/**
 * 片段库的同步快照。
 *
 * 库本身在 IndexedDB 里,读是异步的;但有两处必须**同步**拿到片段:token 计数
 * (每次键入都算,不能等库)和导入时的反向折叠(`importedPositivePrompt` 是同步
 * 函数,移动端也在用)。所以这里维护一份内存快照:第一次被问到时空手而归并顺手
 * 去加载,之后由管理器的增删改主动刷新,订阅方(React 经 useSyncExternalStore)
 * 收到通知后重算。
 *
 * 库打不开(node 校验脚本、隐私模式)就永远是空数组——计数退回按字面算,导入不折叠,
 * 都不会抛错。
 */
import type { PromptChunkData } from './localLibrary/promptChunks';

type Listener = () => void;

const EMPTY: readonly PromptChunkData[] = Object.freeze([]);
let snapshot: readonly PromptChunkData[] = EMPTY;
let hydrated = false;
let inflight: Promise<readonly PromptChunkData[]> | null = null;
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** 重新从库里读一遍并广播。并发调用共享同一次读取。 */
export function refreshPromptChunkCache(): Promise<readonly PromptChunkData[]> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const store = await import('./localLibrary/promptChunks');
      snapshot = Object.freeze(await store.getPromptChunks());
    } catch {
      snapshot = EMPTY;
    } finally {
      hydrated = true;
      inflight = null;
    }
    notify();
    return snapshot;
  })();
  return inflight;
}

/** 同步取快照;还没加载过就先给空的,同时把加载踢出去。 */
export function getCachedPromptChunks(): readonly PromptChunkData[] {
  if (!hydrated && !inflight) void refreshPromptChunkCache();
  return snapshot;
}

export function subscribePromptChunkCache(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
