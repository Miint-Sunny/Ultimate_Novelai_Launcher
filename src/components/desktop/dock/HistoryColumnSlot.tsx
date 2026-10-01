import React, { useCallback, useSyncExternalStore } from 'react';

/**
 * 生成历史停到右栏时的插槽(外壳重排方案 §3.4:历史可停底、可停右)。
 *
 * 历史的全部状态 —— 多选、右键菜单、全览弹窗、生成中的那张 —— 都留在底部的 HistoryDock 里不动;
 * 这块面板只把自己的 DOM 节点登记出去,HistoryDock 看到插槽就把缩略图列 portal 进来,
 * 底部只剩一条标题栏当把手(方案:「历史停右时底栏留一条收起把手,避免画布高度忽有忽无」)。
 * 这样两处不会各有一份历史逻辑。
 */
let slot: HTMLElement | null = null;
const listeners = new Set<() => void>();

const setHistorySlot = (element: HTMLElement | null) => {
  if (slot === element) return;
  slot = element;
  listeners.forEach((listener) => listener());
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** 右栏里历史面板的节点;面板没开时为 null。 */
export function useHistorySlot(): HTMLElement | null {
  return useSyncExternalStore(subscribe, () => slot, () => null);
}

export const HistoryColumnSlot: React.FC = () => {
  const ref = useCallback((element: HTMLDivElement | null) => setHistorySlot(element), []);
  return <div ref={ref} className="h-full min-h-0 overflow-y-auto custom-scrollbar" />;
};
