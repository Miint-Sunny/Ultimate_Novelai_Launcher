import { useMemo } from 'react';
import type { AgentState, LogEntry } from '../../../services/agentService';
import type { VMsg } from './types';
import { fmtTimeHM, splitPromptToTags } from './tokens';

/**
 * 把 agentState.logs 适配成 ChatBody 渲染用的 VMsg[]。
 *
 * 规则：
 * - user 日志 → role 'user'，imagePreview → image
 * - success 日志 → role 'ai'，content = thinking 文案（含 TAG[[]] 标记），
 *   tags 从 snapshot.positive 切（更准确，diff 计算也用这个）
 * - error 日志 → role 'error'
 * - system 日志 / collapsed 日志 → 跳过（新版砍掉了思考日志展示）
 */
export function useAdaptedMessages(agentState: AgentState): VMsg[] {
  return useMemo(() => {
    const out: VMsg[] = [];
    agentState.logs.forEach((log, idx) => {
      if (log.collapsed) return;
      if (log.type === 'system') return;
      if (log.type === 'user') {
        out.push({
          logIndex: idx,
          role: 'user',
          content: log.content,
          ts: fmtTimeHM(log.timestamp),
          image: log.imagePreview,
        });
      } else if (log.type === 'success') {
        out.push({
          logIndex: idx,
          role: 'ai',
          content: log.content,
          ts: fmtTimeHM(log.timestamp),
          snapshot: log.snapshot,
          tags: splitPromptToTags(log.snapshot?.positive),
        });
      } else if (log.type === 'error') {
        out.push({
          logIndex: idx,
          role: 'error',
          content: log.content,
          ts: fmtTimeHM(log.timestamp),
        });
      }
    });
    return out;
  }, [agentState.logs]);
}

/** 当前 logs 里最后一条 success 的下标（在原始 logs 里，不是 VMsg） */
export function findLastSuccessLogIndex(logs: LogEntry[]): number {
  for (let i = logs.length - 1; i >= 0; i--) {
    if (logs[i].type === 'success' && !logs[i].collapsed) return i;
  }
  return -1;
}

/** 当前 logs 里最后一条 error 的下标 */
export function findLastErrorLogIndex(logs: LogEntry[]): number {
  for (let i = logs.length - 1; i >= 0; i--) {
    if (logs[i].type === 'error' && !logs[i].collapsed) return i;
  }
  return -1;
}
