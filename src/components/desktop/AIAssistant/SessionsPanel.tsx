import React, { useCallback, useMemo } from 'react';
import { agentService } from '../../../services/agentService';
import { useAgentDock } from '../../../contexts/AgentDockContext';
import { formatTokens } from '../../../services/agentHarness/usageLedger';
import { usageTotal } from '../../../services/agentHarness/types';
import { setAssistantUi } from './harness/assistantUi';
import { discardCurrentTranscript, removeHarnessSession, restoreHarnessSession, useHarnessSessions } from './harness/harnessSessionStore';
import { HistoryView, type HistoryEntry } from './HistoryView';
import { buildSessionFromLogs } from './useSessions';
import { fmtDateShort } from './tokens';

/**
 * 会话历史面板。
 *
 * 以前它是助手面板里的一个视图,打开就把当前对话整个顶掉;现在是同级的一块面板,
 * 可以和对话并排开着 —— 挑一条历史的时候还看得见自己现在在聊什么。
 *
 * 两种会话混排在一起:harness(新版助手,存在 harnessSessionStore)与旧版规划式
 * (AgentDockContext 里的 sessions)。打开哪种,助手面板就切到哪种形态。
 */
export const SessionsPanel: React.FC = () => {
  const { agentState, sessions, archiveSession, removeSession, dock } = useAgentDock();
  const harness = useHarnessSessions();

  const entries = useMemo<HistoryEntry[]>(() => {
    const out: HistoryEntry[] = [];
    const busyReason = harness.busy ? '助手正在回复,等它说完再切换' : undefined;
    if (harness.current) {
      const c = harness.current;
      out.push({
        key: 'harness:current', kind: 'harness', id: 'current', current: true,
        title: c.title, preview: c.preview, date: fmtDateShort(c.startedAt), turns: c.turns, err: c.err,
        chips: harnessChips(c.toolCalls, usageTotal(c.usage)), disabledReason: busyReason,
      });
    }
    const legacyCurrent = buildSessionFromLogs(agentState.logs, 0);
    if (legacyCurrent) {
      out.push({
        key: 'legacy:current', kind: 'legacy', id: 0, current: true,
        title: legacyCurrent.title, preview: legacyCurrent.preview, date: legacyCurrent.date, turns: legacyCurrent.turns, err: legacyCurrent.err,
        chips: legacyCurrent.tagCount > 0 ? [`${legacyCurrent.tagCount} tags`] : [],
      });
    }
    const archived: { at: number; entry: HistoryEntry }[] = [
      ...harness.sessions.map((s) => ({ at: s.at, entry: {
        key: `harness:${s.id}`, kind: 'harness' as const, id: s.id,
        title: s.title, preview: s.preview, date: fmtDateShort(s.at), turns: s.turns, err: s.err,
        chips: harnessChips(s.toolCalls, usageTotal(s.usage)), disabledReason: busyReason,
      } })),
      // 旧版归档的 id 就是归档时的 Date.now(),拿它排序。
      ...sessions.map((s) => ({ at: s.id, entry: {
        key: `legacy:${s.id}`, kind: 'legacy' as const, id: s.id,
        title: s.title, preview: s.preview, date: s.date, turns: s.turns, err: s.err,
        chips: s.tagCount > 0 ? [`${s.tagCount} tags`] : [],
      } })),
    ];
    archived.sort((a, b) => b.at - a.at);
    return [...out, ...archived.map((a) => a.entry)];
  }, [agentState.logs, harness, sessions]);

  const showAssistant = useCallback(() => {
    // 对话面板可能没开着(或被折叠),打开它才看得到刚灌回去的内容
    if (!dock.layout.open.includes('assistant')) dock.toggle('assistant');
    else dock.setCollapsed('assistant', false);
  }, [dock]);

  /** 点"打开":当前会话 → 把对话面板亮出来;归档会话 → 先归档当前再灌回,面板切到对应形态 */
  const handleResume = useCallback(
    (e: HistoryEntry) => {
      if (e.kind === 'harness') {
        if (!e.current && !restoreHarnessSession(String(e.id))) return;
        setAssistantUi('harness');
      } else {
        if (!e.current) {
          if (agentState.logs.length > 0) archiveSession(agentState.logs);
          removeSession(Number(e.id));
          const target = sessions.find((s) => s.id === e.id);
          if (target) agentService.loadLogs(target.logs);
        }
        setAssistantUi('legacy');
      }
      showAssistant();
    },
    [agentState.logs, archiveSession, removeSession, sessions, showAssistant],
  );

  /** 点删除:当前会话 → 清空(不归档);归档会话 → 从列表移除 */
  const handleDelete = useCallback(
    (e: HistoryEntry) => {
      if (e.kind === 'harness') {
        if (e.current) discardCurrentTranscript();
        else removeHarnessSession(String(e.id));
        return;
      }
      if (e.current) { agentService.clearLogs(); return; }
      removeSession(Number(e.id));
    },
    [removeSession],
  );

  return <HistoryView entries={entries} onResume={handleResume} onDelete={handleDelete} />;
};

function harnessChips(toolCalls: number, tokens: number): string[] {
  const chips: string[] = [];
  if (toolCalls > 0) chips.push(`${toolCalls} 次工具`);
  if (tokens > 0) chips.push(`${formatTokens(tokens)} tokens`);
  return chips;
}
