import { useCallback, useEffect, useState } from 'react';
import type { LogEntry } from '../../../services/agentService';
import type { ArchivedSession } from './types';
import { fmtDateShort, splitPromptToTags } from './tokens';

const STORAGE_KEY = 'plana_aa_v1';

interface Persisted {
  sessions?: ArchivedSession[];
  currentLogs?: LogEntry[];
}

function loadPersisted(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Persisted;
  } catch {
    return {};
  }
}

function savePersisted(s: Persisted) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* quota / private mode — silently drop */
  }
}

/**
 * 把一组 logs 构建成 ArchivedSession 形状。
 * 返回 null 表示空对话（无用户消息），不应该入库 / 不应该显示。
 */
export function buildSessionFromLogs(
  logs: LogEntry[],
  id: number = Date.now(),
): ArchivedSession | null {
  const userLogs = logs.filter(l => !l.collapsed && l.type === 'user');
  if (userLogs.length === 0) return null;

  const lastAi = [...logs].reverse().find(l => !l.collapsed && l.type === 'success');
  const firstUser = userLogs[0];

  const tagCount = logs
    .filter(l => l.type === 'success')
    .reduce((sum, l) => sum + splitPromptToTags(l.snapshot?.positive).length, 0);

  const preview =
    lastAi?.content?.replace(/TAG\[\[(.*?)\]\]/g, '$1').slice(0, 80) ?? '';

  return {
    id,
    title: firstUser.content.slice(0, 30) || '未命名对话',
    preview,
    date: fmtDateShort(Date.now()),
    turns: userLogs.length,
    tagCount,
    err: logs.some(l => l.type === 'error' && !l.collapsed),
    logs: logs.filter(l => !l.collapsed),
  };
}

/**
 * 历史会话本地持久化。
 *
 * 不动 agentService 内部状态，调用方拿 logs 进来归档。
 */
export function useSessions() {
  const [sessions, setSessions] = useState<ArchivedSession[]>(() => {
    return loadPersisted().sessions ?? [];
  });

  useEffect(() => {
    const prev = loadPersisted();
    savePersisted({ ...prev, sessions });
  }, [sessions]);

  /** 把当前 logs 归档成一个 session（用于"新对话"按钮）。返回是否归档成功。 */
  const archive = useCallback((logs: LogEntry[]): boolean => {
    const session = buildSessionFromLogs(logs);
    if (!session) return false;
    setSessions(prev => [session, ...prev].slice(0, 30));
    return true;
  }, []);

  const remove = useCallback((id: number) => {
    setSessions(prev => prev.filter(s => s.id !== id));
  }, []);

  return { sessions, archive, remove };
}

export function loadCurrentLogs(): LogEntry[] {
  return loadPersisted().currentLogs ?? [];
}

export function saveCurrentLogs(logs: LogEntry[]) {
  const visibleLogs = logs.filter(l => !l.collapsed);
  const current = buildSessionFromLogs(visibleLogs, 0);
  const prev = loadPersisted();
  savePersisted({
    ...prev,
    currentLogs: current ? current.logs : [],
  });
}
