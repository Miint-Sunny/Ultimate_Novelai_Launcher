import React, { useCallback, useRef } from 'react';
import { useAgentDock } from '../../../contexts/AgentDockContext';
import { AssistantSwitch } from '../AIAssistant/harness/AssistantSwitch';
import { SessionsPanel } from '../AIAssistant/SessionsPanel';
import { C } from '../AIAssistant/tokens';
import { DockPanelFrame } from './DockPanelFrame';
import { PANEL_META } from './DockToolbar';
import {
  DOCK_MAX_WIDTH,
  DOCK_MIN_WIDTH,
  isPanelCollapsed,
  panelWeight,
  type DockPanelId,
} from './dockLayout';

/**
 * 面板登记表:面板体。图标与名字在 DockToolbar 的 PANEL_META(顶栏也要用)。
 * 加一块新面板 = 这里补一条 + PANEL_META 补一条 + dockLayout 的 DockPanelId 加个 id;
 * 外壳、勾选菜单、排序、持久化都不用动。
 */
const PANEL_BODIES: Record<DockPanelId, React.FC> = {
  assistant: AssistantSwitch,
  sessions: SessionsPanel,
};

/**
 * 右侧停靠区。
 *
 * 形态参考 Claude Desktop:右栏不是一块整板,而是若干可拼凑的面板 ——
 * 竖着摞起来,面板之间拖着分高度,每块自己还能折叠、上下换位、单独关掉。
 * 整份布局持久化。
 *
 * **一块都没开时这里什么都不渲染**,不留竖窄条 —— 开关在窗口顶栏(DockToolbar),
 * 所以关完了也找得回来。
 */
export const RightDock: React.FC = () => {
  const { dock } = useAgentDock();
  const { layout } = dock;
  const panelRefs = useRef(new Map<DockPanelId, HTMLDivElement>());

  // ── 左缘拖宽 ──
  const widthDrag = useRef({ active: false, startX: 0, startWidth: 0 });
  const onWidthDown = (e: React.PointerEvent) => {
    widthDrag.current = { active: true, startX: e.clientX, startWidth: layout.width };
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* noop */ }
  };
  const onWidthMove = (e: React.PointerEvent) => {
    if (!widthDrag.current.active) return;
    dock.setWidth(widthDrag.current.startWidth + (widthDrag.current.startX - e.clientX));
  };
  const onWidthUp = (e: React.PointerEvent) => {
    if (!widthDrag.current.active) return;
    widthDrag.current.active = false;
    dock.commit();
    try { (e.currentTarget as Element).releasePointerCapture(e.pointerId); } catch { /* noop */ }
  };

  // ── 面板之间拖高度 ──
  const splitDrag = useRef<{ active: boolean; above: DockPanelId; below: DockPanelId; top: number; span: number }>({
    active: false, above: 'assistant', below: 'sessions', top: 0, span: 1,
  });
  const onSplitDown = useCallback((above: DockPanelId, below: DockPanelId) => (e: React.PointerEvent) => {
    const aboveEl = panelRefs.current.get(above);
    const belowEl = panelRefs.current.get(below);
    if (!aboveEl || !belowEl) return;
    const top = aboveEl.getBoundingClientRect().top;
    const span = belowEl.getBoundingClientRect().bottom - top;
    if (span <= 0) return;
    splitDrag.current = { active: true, above, below, top, span };
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* noop */ }
  }, []);
  const onSplitMove = (e: React.PointerEvent) => {
    const drag = splitDrag.current;
    if (!drag.active) return;
    dock.resizePair(drag.above, drag.below, (e.clientY - drag.top) / drag.span);
  };
  const onSplitUp = (e: React.PointerEvent) => {
    if (!splitDrag.current.active) return;
    splitDrag.current.active = false;
    dock.commit();
    try { (e.currentTarget as Element).releasePointerCapture(e.pointerId); } catch { /* noop */ }
  };

  // 展开着的面板的权重之和,用来把 flex-grow 归一化(见下方面板栈)
  const expandedTotal = layout.open
    .filter((id) => !isPanelCollapsed(layout, id))
    .reduce((sum, id) => sum + panelWeight(layout, id), 0);

  // 一块都没开:右侧整个不占位(开关在窗口顶栏)
  if (layout.open.length === 0) return null;

  return (
    <div
      className="relative shrink-0 flex flex-col z-10 overflow-hidden"
      style={{
        width: layout.width,
        minWidth: DOCK_MIN_WIDTH,
        maxWidth: DOCK_MAX_WIDTH,
        background: C.panel,
        borderLeft: `1px solid ${C.border}`,
        color: C.text,
      }}
    >
      {/* 左缘拖宽把手 */}
      <div
        className="absolute top-0 left-0 bottom-0 w-1.5 cursor-ew-resize z-20 hover:bg-white/10 transition-colors"
        onPointerDown={onWidthDown}
        onPointerMove={onWidthMove}
        onPointerUp={onWidthUp}
        onPointerCancel={onWidthUp}
        title="拖动调整整栏宽度"
      />

      {/* 面板栈 */}
      <div className="flex-1 min-h-0 flex flex-col">
        {layout.open.map((id, index) => {
          const meta = PANEL_META[id];
          const Body = PANEL_BODIES[id];
          const collapsed = isPanelCollapsed(layout, id);
          // flex-grow 要按**当前展开着的那几块**归一化,让它们的总和恰好是 1。
          // 直接把权重当 grow 用会漏:权重被拖成 0.2/1.8 之后再折叠掉一块,
          // 剩下那块的 grow 只有 0.2 —— grow 总和小于 1 时不会填满,
          // 栈底会空出一大片(实测折叠后空了约 520px)。
          const growShare = expandedTotal > 0 ? panelWeight(layout, id) / expandedTotal : 1;
          const below = layout.open[index + 1];
          return (
            <React.Fragment key={id}>
              <div
                ref={(el) => { if (el) panelRefs.current.set(id, el); else panelRefs.current.delete(id); }}
                className="flex flex-col min-h-0 overflow-hidden"
                style={collapsed ? { flex: '0 0 auto' } : { flexGrow: growShare, flexBasis: 0, minHeight: 0 }}
              >
                <DockPanelFrame
                  title={meta.title}
                  Icon={meta.Icon}
                  collapsed={collapsed}
                  canMoveUp={index > 0}
                  canMoveDown={index < layout.open.length - 1}
                  onToggleCollapsed={() => dock.setCollapsed(id, !collapsed)}
                  onMoveUp={() => dock.move(id, -1)}
                  onMoveDown={() => dock.move(id, 1)}
                  onClose={() => dock.toggle(id)}
                >
                  <Body />
                </DockPanelFrame>
              </div>
              {below && (
                <div
                  className="shrink-0 cursor-ns-resize hover:bg-white/10 transition-colors"
                  style={{ height: 4, background: C.line }}
                  onPointerDown={onSplitDown(id, below)}
                  onPointerMove={onSplitMove}
                  onPointerUp={onSplitUp}
                  onPointerCancel={onSplitUp}
                  title="拖动分配上下高度"
                />
              )}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
};
