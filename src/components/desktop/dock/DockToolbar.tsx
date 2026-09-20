import React, { useEffect, useState } from 'react';
import { Bot, History, MoreVertical, PanelRightClose } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAgentDock } from '../../../contexts/AgentDockContext';
import { C } from '../AIAssistant/tokens';
import { DOCK_PANEL_ORDER, type DockPanelId } from './dockLayout';

/** 面板的图标与名字。面板体本身在 RightDock 的登记表里。 */
export const PANEL_META: Record<DockPanelId, { title: string; Icon: LucideIcon }> = {
  assistant: { title: 'Plana 助手', Icon: Bot },
  sessions: { title: '会话历史', Icon: History },
};

const iconButton = (active: boolean): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 24,
  height: 24,
  borderRadius: 6,
  border: 'none',
  background: active ? 'rgb(var(--nai-accent) / 0.14)' : 'transparent',
  color: active ? C.accent : C.textDim,
  cursor: 'pointer',
});

/**
 * 面板开关:一排快捷图标 + 一个「⋮」勾选菜单。
 *
 * 它住在**窗口顶栏**而不是右缘 —— 右侧一块面板都不开时那里就该是空的,
 * 不该留一条竖着的窄条。开关始终在顶栏,所以关完了也找得回来。
 */
export const DockToolbar: React.FC = () => {
  const { dock } = useAgentDock();
  const { layout } = dock;
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [menuOpen]);

  return (
    <div className="flex items-center gap-1">
      {DOCK_PANEL_ORDER.map((id) => {
        const meta = PANEL_META[id];
        const open = layout.open.includes(id);
        return (
          <button
            key={id}
            style={iconButton(open)}
            onClick={() => dock.toggle(id)}
            title={open ? `关闭${meta.title}` : `打开${meta.title}`}
            aria-pressed={open}
          >
            <meta.Icon className="w-4 h-4" />
          </button>
        );
      })}
      <div className="relative">
        <button
          style={iconButton(menuOpen)}
          onClick={(e) => { e.stopPropagation(); setMenuOpen((prev) => !prev); }}
          title="面板"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          <MoreVertical className="w-4 h-4" />
        </button>
        {menuOpen && (
          <div
            className="absolute right-0 top-full mt-1 py-1 rounded-lg z-50"
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
              const meta = PANEL_META[id];
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
                  <meta.Icon className="w-3.5 h-3.5 shrink-0" style={{ color: C.textDim }} />
                  <span className="flex-1">{meta.title}</span>
                  <span style={{ color: C.accent, width: 12 }}>{open ? '✓' : ''}</span>
                </button>
              );
            })}
            <div style={{ height: 1, background: C.line, margin: '4px 0' }} />
            <button
              role="menuitem"
              disabled={layout.open.length === 0}
              className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[12px] hover:bg-white/5 disabled:opacity-40"
              style={{ background: 'transparent', border: 'none', color: C.text2, cursor: layout.open.length ? 'pointer' : 'default' }}
              onClick={() => dock.setLayout({ ...layout, open: [], collapsed: [] })}
            >
              <PanelRightClose className="w-3.5 h-3.5 shrink-0" style={{ color: C.textDim }} />
              <span className="flex-1">全部收起</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * 顶栏。**从左栏的右边缘起**,只跨画布与右栏(2026-09-21 外壳重排第 1 步):
 * 左栏是主工作区,必须直通到底,不能被一条横贯全宽的条切断。
 *
 * 它表达的是「对当前这张图动手」与「视图怎么摆」。现在靠右只有面板开关;
 * 第 2 步会在左段接上画布动作(重绘 / 放大 / 编辑,以后还有导演工具),
 * 那时画布上方那条浮动工具条退役,图不再被按钮压着。
 * 复制 / 保存**不进来**:它们是终结动作,留在图像右下角(方案 §3.6)。
 */
export const DockTopBar: React.FC = () => (
  <div
    className="shrink-0 flex items-center justify-end gap-2 px-2"
    style={{ height: 30, background: C.bgDeep, borderBottom: `1px solid ${C.line}` }}
  >
    <DockToolbar />
  </div>
);
