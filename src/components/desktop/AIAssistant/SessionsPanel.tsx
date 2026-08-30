import React, { useCallback, useMemo } from 'react';
import { agentService } from '../../../services/agentService';
import { useAgentDock } from '../../../contexts/AgentDockContext';
import { HistoryView } from './HistoryView';
import { buildSessionFromLogs } from './useSessions';
import type { ArchivedSession } from './types';

/**
 * 会话历史面板。
 *
 * 以前它是助手面板里的一个视图,打开就把当前对话整个顶掉;现在是同级的一块面板,
 * 可以和对话并排开着 —— 挑一条历史的时候还看得见自己现在在聊什么。
 *
 * 会话列表本身在 AgentDockContext 里(两块面板共用同一份 state),
 * 这里只放「打开 / 删除」这两个动作。
 */
export const SessionsPanel: React.FC = () => {
  const { agentState, sessions, archiveSession, removeSession, dock } = useAgentDock();

  /** 列表 = 当前进行中的会话（如有）+ 已归档会话；当前固定在最前 */
  const displaySessions = useMemo(() => {
    const current = buildSessionFromLogs(agentState.logs, 0);
    if (!current) return sessions;
    return [{ ...current, current: true }, ...sessions];
  }, [agentState.logs, sessions]);

  /** 点"打开"：当前会话 → 把对话面板亮出来；归档会话 → 先归档当前再灌回 */
  const handleResume = useCallback(
    (s: ArchivedSession) => {
      if (!s.current) {
        if (agentState.logs.length > 0) archiveSession(agentState.logs);
        removeSession(s.id);
        agentService.loadLogs(s.logs);
      }
      // 对话面板可能没开着(或被折叠),打开它才看得到刚灌回去的内容
      if (!dock.layout.open.includes('assistant')) dock.toggle('assistant');
      else dock.setCollapsed('assistant', false);
    },
    [agentState.logs, archiveSession, removeSession, dock],
  );

  /** 点删除：当前会话 → 清空 logs；归档会话 → 走 remove */
  const handleDelete = useCallback(
    (id: number) => {
      if (id === 0) {
        agentService.clearLogs();
        return;
      }
      removeSession(id);
    },
    [removeSession],
  );

  return <HistoryView sessions={displaySessions} onResume={handleResume} onDelete={handleDelete} />;
};
