import { useCallback, useMemo, useState } from 'react';
import {
  DEFAULT_DOCK_LAYOUT,
  DOCK_LAYOUT_KEY,
  LEGACY_DOCK_OPEN_KEY,
  LEGACY_DOCK_WIDTH_KEY,
  migrateLegacyDockLayout,
  movePanel,
  normalizeDockLayout,
  resizeAdjacent,
  setDockWidth,
  setPanelCollapsed,
  togglePanel,
  type DockLayout,
  type DockPanelId,
} from './dockLayout';

function readLayout(): DockLayout {
  try {
    const raw = localStorage.getItem(DOCK_LAYOUT_KEY);
    if (raw) return normalizeDockLayout(JSON.parse(raw));
    // 没有新键才看旧键:迁移只发生一次,之后新键就是唯一事实来源
    const migrated = migrateLegacyDockLayout(
      localStorage.getItem(LEGACY_DOCK_OPEN_KEY),
      localStorage.getItem(LEGACY_DOCK_WIDTH_KEY),
    );
    if (migrated) return migrated;
  } catch {
    /* 坏 JSON / 隐私模式:退默认,不让右栏白屏 */
  }
  return { ...DEFAULT_DOCK_LAYOUT };
}

/**
 * 右侧停靠区的布局状态。模型层在 dockLayout.ts(纯函数),这里只负责
 * 持有 state、写回 localStorage,以及把动作包成回调。
 */
export function useDockLayout() {
  const [layout, setLayoutState] = useState<DockLayout>(readLayout);

  const apply = useCallback((next: DockLayout) => {
    setLayoutState(next);
    try {
      localStorage.setItem(DOCK_LAYOUT_KEY, JSON.stringify(next));
    } catch {
      /* 配额/隐私模式:布局丢了下次回默认,不该因此报错 */
    }
  }, []);

  const actions = useMemo(
    () => ({
      toggle: (id: DockPanelId) => setLayoutState((prev) => {
        const next = togglePanel(prev, id);
        try { localStorage.setItem(DOCK_LAYOUT_KEY, JSON.stringify(next)); } catch { /* 同上 */ }
        return next;
      }),
      setCollapsed: (id: DockPanelId, collapsed: boolean) => setLayoutState((prev) => {
        const next = setPanelCollapsed(prev, id, collapsed);
        try { localStorage.setItem(DOCK_LAYOUT_KEY, JSON.stringify(next)); } catch { /* 同上 */ }
        return next;
      }),
      move: (id: DockPanelId, delta: number) => setLayoutState((prev) => {
        const next = movePanel(prev, id, delta);
        try { localStorage.setItem(DOCK_LAYOUT_KEY, JSON.stringify(next)); } catch { /* 同上 */ }
        return next;
      }),
      resizePair: (above: DockPanelId, below: DockPanelId, ratio: number) =>
        setLayoutState((prev) => resizeAdjacent(prev, above, below, ratio)),
      setWidth: (width: number) => setLayoutState((prev) => setDockWidth(prev, width)),
      /** 拖动结束时落盘一次:拖动过程中每帧都写 localStorage 是没必要的开销。 */
      commit: () => setLayoutState((prev) => {
        try { localStorage.setItem(DOCK_LAYOUT_KEY, JSON.stringify(prev)); } catch { /* 同上 */ }
        return prev;
      }),
    }),
    [],
  );

  return { layout, setLayout: apply, ...actions };
}

export type DockLayoutController = ReturnType<typeof useDockLayout>;
