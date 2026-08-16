import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  agentService,
  DEFAULT_AI_MODEL,
  type AgentState,
  type GenerationSnapshot,
} from '../services/agentService';
import { appBackendApi } from '../api/appBackendApi';
import { SIDECAR_SETTINGS_CHANGED_EVENT } from '../api/localSidecarApi';
import { APP_SETTINGS_CHANGED_EVENT } from '../services/localLibrary/appSettings';
import { loadCurrentLogs, saveCurrentLogs } from '../components/desktop/AIAssistant/useSessions';

const STORAGE_KEY_DOCK_OPEN = 'nai_agent_dock_open';
const STORAGE_KEY_DOCK_WIDTH = 'nai_agent_dock_width';

export const AGENT_DOCK_MIN_WIDTH = 320;
export const AGENT_DOCK_MAX_WIDTH = 640;
export const AGENT_DOCK_DEFAULT_WIDTH = 400;

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
}

interface AgentDockContextValue {
  aiModel: string;
  setAiModel: (model: string) => void;
  agentState: AgentState;
  isGeneratingPrompt: boolean;
  setIsGeneratingPrompt: React.Dispatch<React.SetStateAction<boolean>>;
  agentAvailable: boolean;
  agentUnavailableReason?: string;
  isDockOpen: boolean;
  setDockOpen: (open: boolean) => void;
  toggleDock: () => void;
  dockWidth: number;
  setDockWidth: (width: number) => void;
  /**
   * 写回入口存在 ref 里：LeftSidebar 每次渲染都会产生新的回调标识，
   * 走 state 会形成 注册→渲染→再注册 的死循环；ref + 幂等 ready 标志避免这一点。
   */
  handlersRef: React.MutableRefObject<AgentDockHandlers | null>;
  handlersReady: boolean;
  registerHandlers: (handlers: AgentDockHandlers) => void;
}

const AgentDockContext = createContext<AgentDockContextValue | null>(null);

const readInitialOpen = (): boolean => localStorage.getItem(STORAGE_KEY_DOCK_OPEN) !== '0';

const readInitialWidth = (): number => {
  const saved = Number(localStorage.getItem(STORAGE_KEY_DOCK_WIDTH));
  if (Number.isFinite(saved) && saved >= AGENT_DOCK_MIN_WIDTH && saved <= AGENT_DOCK_MAX_WIDTH) {
    return saved;
  }
  return AGENT_DOCK_DEFAULT_WIDTH;
};

export const AgentDockProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [aiModel, setAiModel] = useState<string>(DEFAULT_AI_MODEL);
  const [isGeneratingPrompt, setIsGeneratingPrompt] = useState(false);
  const [isDockOpen, setDockOpenState] = useState<boolean>(readInitialOpen);
  const [dockWidth, setDockWidthState] = useState<number>(readInitialWidth);
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

  const setDockOpen = useCallback((open: boolean) => {
    setDockOpenState(open);
    localStorage.setItem(STORAGE_KEY_DOCK_OPEN, open ? '1' : '0');
  }, []);

  const toggleDock = useCallback(() => {
    setDockOpenState((prev) => {
      localStorage.setItem(STORAGE_KEY_DOCK_OPEN, prev ? '0' : '1');
      return !prev;
    });
  }, []);

  const setDockWidth = useCallback((width: number) => {
    const clamped = Math.min(AGENT_DOCK_MAX_WIDTH, Math.max(AGENT_DOCK_MIN_WIDTH, Math.round(width)));
    setDockWidthState(clamped);
    localStorage.setItem(STORAGE_KEY_DOCK_WIDTH, String(clamped));
  }, []);

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
        isDockOpen,
        setDockOpen,
        toggleDock,
        dockWidth,
        setDockWidth,
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
