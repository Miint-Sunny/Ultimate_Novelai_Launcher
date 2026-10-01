import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useAgentDock } from '../../contexts/AgentDockContext';
import {
  SIDEBAR_DEFAULT_WIDTH,
  clampSidebarWidth,
  resolveShellWidths,
  shellScale,
  type ShellWidths,
} from './shellLayout';

/** 左栏宽度(设计 px)。以前每次启动都回 430,拖过的宽度不记。 */
const SIDEBAR_WIDTH_KEY = 'nai_left_sidebar_width';

const readSidebarWidth = (): number => {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    return raw === null ? SIDEBAR_DEFAULT_WIDTH : clampSidebarWidth(Number(raw));
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
};

// 根字号由 index.css 的媒体查询按屏宽切换(16 / 17 / 19 / 22px),所以跟视口一起重读。
const readViewport = () => ({
  width: window.innerWidth,
  rootFontPx: parseFloat(getComputedStyle(document.documentElement).fontSize) || 16,
});

export interface ShellLayout extends ShellWidths {
  /** 根字号相对 16px 的倍数;拖动时把鼠标的 px 位移换回设计 px 要用它。 */
  scale: number;
  /** 拖动中实时改左栏宽(设计 px)。 */
  setSidebarWidth: (width: number) => void;
  /** 拖完落盘一次。 */
  commitSidebarWidth: (width: number) => void;
}

const ShellLayoutContext = createContext<ShellLayout | null>(null);

/**
 * 桌面外壳的宽度:左栏要多宽、右栏要多宽,在这里和视口一起交给 resolveShellWidths 统一分配,
 * 两栏各自只读结果。必须挂在 AgentDockProvider 里面(右栏的宽度与开合在那儿)。
 */
export const ShellLayoutProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { dock } = useAgentDock();
  const [sidebarWidth, setSidebarWidthState] = useState(readSidebarWidth);
  const [viewport, setViewport] = useState(readViewport);

  useEffect(() => {
    const onResize = () => setViewport(readViewport());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const setSidebarWidth = useCallback((width: number) => setSidebarWidthState(clampSidebarWidth(width)), []);
  const commitSidebarWidth = useCallback((width: number) => {
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(clampSidebarWidth(width)));
    } catch { /* 隐私模式等写不进就算了,下次回默认宽 */ }
  }, []);

  const dockWidth = dock.layout.width;
  const dockOpen = dock.layout.open.length > 0;
  const value = useMemo<ShellLayout>(() => ({
    ...resolveShellWidths({
      viewportPx: viewport.width,
      rootFontPx: viewport.rootFontPx,
      sidebar: sidebarWidth,
      dock: dockWidth,
      dockOpen,
    }),
    scale: shellScale(viewport.rootFontPx),
    setSidebarWidth,
    commitSidebarWidth,
  }), [viewport, sidebarWidth, dockWidth, dockOpen, setSidebarWidth, commitSidebarWidth]);

  return <ShellLayoutContext.Provider value={value}>{children}</ShellLayoutContext.Provider>;
};

export function useShellLayout(): ShellLayout {
  const context = useContext(ShellLayoutContext);
  if (!context) throw new Error('useShellLayout 必须在 ShellLayoutProvider 里用');
  return context;
}
