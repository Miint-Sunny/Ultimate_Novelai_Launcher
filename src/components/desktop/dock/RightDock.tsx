import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, History, MoreVertical, PanelRightClose } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAgentDock } from '../../../contexts/AgentDockContext';
import { AgentPanel } from '../AIAssistant/AgentPanel';
import { SessionsPanel } from '../AIAssistant/SessionsPanel';
import { C } from '../AIAssistant/tokens';
import { DockPanelFrame } from './DockPanelFrame';
import {
  DOCK_MAX_WIDTH,
  DOCK_MIN_WIDTH,
  DOCK_PANEL_ORDER,
  isPanelCollapsed,
  panelWeight,
  type DockPanelId,
} from './dockLayout';

interface PanelSpec {
  title: string;
  Icon: LucideIcon;
  Body: React.FC;
}

/**
 * 面板登记表。加一块新面板只要往这里补一条 + 在 dockLayout 的 DockPanelId
 * 里加个 id —— 外壳、勾选菜单、排序、持久化都不用动。
 */
const PANELS: Record<DockPanelId, PanelSpec> = {
  assistant: { title: 'Plana 助手', Icon: Bot, Body: AgentPanel },
  sessions: { title: '会话历史', Icon: History, Body: SessionsPanel },
};

const railButton = (active: boolean): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 26,
  height: 26,
  borderRadius: 8,
  border: 'none',
  background: active ? 'rgb(var(--nai-accent) / 0.14)' : 'transparent',
  color: active ? C.accent : C.textDim,
  cursor: 'pointer',
});

/**
 * 右侧停靠区。
 *
 * 形态参考 Claude Desktop:右栏不是一块整板,而是若干可拼凑的面板 ——
 * 顶部一排图标(或「⋮」菜单)勾选要哪几块,它们竖着摞起来,面板之间拖着分高度,
 * 每块自己还能折叠、上下换位、单独关掉。整份布局持久化。
 *
 * 一块都没开时缩成右缘窄条,窄条上仍然是那排图标 —— 收起来之后还找得回来。
 */
export const RightDock: React.FC = () => {
  const { dock, isGeneratingPrompt } = useAgentDock();
  const { layout } = dock;
  const [menuOpen, setMenuOpen] = useState(false);
  const panelRefs = useRef(new Map<DockPanelId, HTMLDivElement>());

  // 点空白处收起「⋮」菜单
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [menuOpen]);

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

  const quickIcons = (
    <>
      {DOCK_PANEL_ORDER.map((id) => {
        const spec = PANELS[id];
        const open = layout.open.includes(id);
        return (
          <button
            key={id}
            style={railButton(open)}
            onClick={() => dock.toggle(id)}
            title={open ? `关闭${spec.title}` : `打开${spec.title}`}
            aria-pressed={open}
          >
            <spec.Icon className="w-4 h-4" />
          </button>
        );
      })}
    </>
  );

  // ── 一块都没开:右缘窄条 ──
  if (layout.open.length === 0) {
    return (
      <div
        className="shrink-0 flex flex-col items-center gap-1 pt-2.5 z-10"
        style={{ width: 34, background: C.panel, borderLeft: `1px solid ${C.border}` }}
      >
        {quickIcons}
        {isGeneratingPrompt && (
          <div className="mt-1 relative w-2 h-2" title="Plana 正在思考">
            <div className="absolute inset-0 bg-nai-accent/40 rounded-full animate-ping" />
            <div className="absolute inset-0.5 bg-nai-accent rounded-full" />
          </div>
        )}
      </div>
    );
  }

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

      {/* 顶部:快捷图标 + ⋮ 菜单 */}
      <div
        className="shrink-0 flex items-center justify-end gap-1 px-2"
        style={{ height: 34, background: C.bgDeep, borderBottom: `1px solid ${C.line}` }}
      >
        {quickIcons}
        <div className="relative">
          <button
            style={railButton(menuOpen)}
            onClick={(e) => { e.stopPropagation(); setMenuOpen((prev) => !prev); }}
            title="面板"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <MoreVertical className="w-4 h-4" />
          </button>
          {menuOpen && (
            <div
              className="absolute right-0 top-full mt-1 py-1 rounded-lg z-30"
              style={{
                minWidth: 168,
                background: C.panel2,
                border: `1px solid ${C.border}`,
                boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
              }}
              onPointerDown={(e) => e.stopPropagation()}
              role="menu"
            >
              {DOCK_PANEL_ORDER.map((id) => {
                const spec = PANELS[id];
                const open = layout.open.includes(id);
                return (
                  <button
                    key={id}
                    role="menuitemcheckbox"
                    aria-checked={open}
                    className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[12px] hover:bg-white/5"
                    style={{ background: 'transparent', border: 'none', color: C.text2, cursor: 'pointer' }}
                    onClick={() => dock.toggle(id)}
                  >
                    <spec.Icon className="w-3.5 h-3.5 shrink-0" style={{ color: C.textDim }} />
                    <span className="flex-1">{spec.title}</span>
                    <span style={{ color: C.accent, width: 12 }}>{open ? '✓' : ''}</span>
                  </button>
                );
              })}
              <div style={{ height: 1, background: C.line, margin: '4px 0' }} />
              <button
                role="menuitem"
                className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[12px] hover:bg-white/5"
                style={{ background: 'transparent', border: 'none', color: C.text2, cursor: 'pointer' }}
                onClick={() => dock.setLayout({ ...layout, open: [], collapsed: [] })}
              >
                <PanelRightClose className="w-3.5 h-3.5 shrink-0" style={{ color: C.textDim }} />
                <span className="flex-1">全部收起</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* 面板栈 */}
      <div className="flex-1 min-h-0 flex flex-col">
        {layout.open.map((id, index) => {
          const spec = PANELS[id];
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
                  title={spec.title}
                  Icon={spec.Icon}
                  collapsed={collapsed}
                  canMoveUp={index > 0}
                  canMoveDown={index < layout.open.length - 1}
                  onToggleCollapsed={() => dock.setCollapsed(id, !collapsed)}
                  onMoveUp={() => dock.move(id, -1)}
                  onMoveDown={() => dock.move(id, 1)}
                  onClose={() => dock.toggle(id)}
                >
                  <spec.Body />
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
