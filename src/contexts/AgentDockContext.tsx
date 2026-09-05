import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  agentService,
  DEFAULT_AI_MODEL,
  type AgentState,
  type GenerationSnapshot,
  type LogEntry,
} from '../services/agentService';
import { appBackendApi } from '../api/appBackendApi';
import { SIDECAR_SETTINGS_CHANGED_EVENT } from '../api/localSidecarApi';
import { APP_SETTINGS_CHANGED_EVENT } from '../services/localLibrary/appSettings';
import { loadCurrentLogs, saveCurrentLogs, useSessions } from '../components/desktop/AIAssistant/useSessions';
import type { ArchivedSession } from '../components/desktop/AIAssistant/types';
import { useDockLayout, type DockLayoutController } from '../components/desktop/dock/useDockLayout';
import type { WorkbenchAdapter } from '../services/agentHarness/workbench';

/**
 * 提示词落地回调由 LeftSidebar 注册：提示词状态的所有权仍在左栏，
 * 停靠面板只通过这三个入口写回（与旧悬浮窗的对外契约一致，
 * 但 restoreSnapshot 升级为整个 GenerationSnapshot——修复旧绑定丢弃 vibes 的问题）。
 */
export interface AgentDockHandlers {
  generate: (request: string, imageBase64?: string) => void;
  regenerate: (
    request: string,
    preState: {
      positive: string;
      negative: string;
      characters: { positive: string; negative?: string; name: string }[];
      vibes?: string[];
    },
    imageBase64?: string,
  ) => void;
  restoreSnapshot: (snapshot: GenerationSnapshot) => void;
  /** 固定指令「生成图片」：可选地先替换正向提示词，再按左栏当前参数提交生成 */
  triggerGenerate?: (positive?: string) => void;
  /**
   * Agent harness 的工作台桥:工具通过它读写左栏参数、角色槽位、触发生成、取历史图。
   * askUser 不在这里——那是停靠面板自己的 UI,由 hook 补上。
   */
  workbench?: Omit<WorkbenchAdapter, 'askUser'>;
}

interface AgentDockContextValue {
  aiModel: string;
  setAiModel: (model: string) => void;
  agentState: AgentState;
  isGeneratingPrompt: boolean;
  setIsGeneratingPrompt: React.Dispatch<React.SetStateAction<boolean>>;
  agentAvailable: boolean;
  agentUnavailableReason?: string;
  /** 右侧停靠区的布局(哪些面板开着、顺序、各自高度权重、整体宽度)。 */
  dock: DockLayoutController;
  /** 兼容口径:右栏是不是至少开着一块。左栏那个开关按钮只关心这个。 */
  isDockOpen: boolean;
  /** 兼容口径:开着就全收起,收着就把助手打开。 */
  toggleDock: () => void;
  /**
   * 会话历史提到这里,是因为「助手」和「会话历史」现在是两块可以同时打开的面板。
   * useSessions 各自持有 state 并整份写回同一个存储键,两处挂载会互相覆盖 ——
   * 归档完切到另一块就可能把刚归档的那条冲掉。
   */
  sessions: ArchivedSession[];
  archiveSession: (logs: LogEntry[]) => boolean;
  removeSession: (id: number) => void;
  /**
   * 写回入口存在 ref 里：LeftSidebar 每次渲染都会产生新的回调标识，
   * 走 state 会形成 注册→渲染→再注册 的死循环；ref + 幂等 ready 标志避免这一点。
   */
  handlersRef: React.MutableRefObject<AgentDockHandlers | null>;
  handlersReady: boolean;
  registerHandlers: (handlers: AgentDockHandlers) => void;
}

const AgentDockContext = createContext<AgentDockContextValue | null>(null);

export const AgentDockProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [aiModel, setAiModel] = useState<string>(DEFAULT_AI_MODEL);
  const [isGeneratingPrompt, setIsGeneratingPrompt] = useState(false);
  const dock = useDockLayout();
  const { sessions, archive: archiveSession, remove: removeSession } = useSessions();
  const [agentState, setAgentState] = useState<AgentState>(() => ({
    status: 'idle',
    logs: loadCurrentLogs(),
  }));
  // 可用性依赖 serverMode 与 sidecar 能力快照，两者都通过全局事件广播变更。
  const [availability, setAvailability] = useState(() => appBackendApi.desktopAgentAvailability());
  const handlersRef = useRef<AgentDockHandlers | null>(null);
  const [handlersReady, setHandlersReady] = useState(false);

  // 镜像 agentService 单例状态；恢复上次未归档的会话。
  useEffect(() => {
    const unsubscribe = agentService.addEventListener((state) => {
      setAgentState(state);
      setIsGeneratingPrompt(state.status === 'thinking');
    });
    const restoredLogs = loadCurrentLogs();
    const currentState = agentService.getState();
    if (currentState.logs.length === 0 && restoredLogs.length > 0) {
      agentService.loadLogs(restoredLogs);
    } else {
      setAgentState(currentState);
      setIsGeneratingPrompt(currentState.status === 'thinking');
    }
    return unsubscribe;
  }, []);

  // 当前会话实时持久化（刷新后可恢复）。
  useEffect(() => {
    saveCurrentLogs(agentState.logs);
  }, [agentState.logs]);

  // 可用性随设置/能力事件刷新；不可用时取消飞行中的请求。
  useEffect(() => {
    const refresh = () => setAvailability(appBackendApi.desktopAgentAvailability());
    window.addEventListener(APP_SETTINGS_CHANGED_EVENT, refresh);
    window.addEventListener(SIDECAR_SETTINGS_CHANGED_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(APP_SETTINGS_CHANGED_EVENT, refresh);
      window.removeEventListener(SIDECAR_SETTINGS_CHANGED_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  useEffect(() => {
    if (availability.available) return;
    agentService.cancel();
  }, [availability.available]);

  const isDockOpen = dock.layout.open.length > 0;
  const setLayout = dock.setLayout;
  const dockLayout = dock.layout;
  const toggleDock = useCallback(() => {
    setLayout(
      dockLayout.open.length > 0
        ? { ...dockLayout, open: [], collapsed: [] }
        : { ...dockLayout, open: ['assistant'] },
    );
  }, [dockLayout, setLayout]);

  const registerHandlers = useCallback((next: AgentDockHandlers) => {
    handlersRef.current = next;
    setHandlersReady(true); // 同值幂等，不会引发级联渲染
  }, []);

  return (
    <AgentDockContext.Provider
      value={{
        aiModel,
        setAiModel,
        agentState,
        isGeneratingPrompt,
        setIsGeneratingPrompt,
        agentAvailable: availability.available,
        agentUnavailableReason: availability.reason,
        dock,
        isDockOpen,
        toggleDock,
        sessions,
        archiveSession,
        removeSession,
        handlersRef,
        handlersReady,
        registerHandlers,
      }}
    >
      {children}
    </AgentDockContext.Provider>
  );
};

export function useAgentDock(): AgentDockContextValue {
  const value = useContext(AgentDockContext);
  if (!value) throw new Error('useAgentDock must be used within AgentDockProvider');
  return value;
}
