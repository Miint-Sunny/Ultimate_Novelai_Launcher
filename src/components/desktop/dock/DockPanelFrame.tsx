import React from 'react';
import { ChevronDown, ChevronRight, ChevronUp, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { C } from '../AIAssistant/tokens';
import { DOCK_HEADER_HEIGHT } from './dockLayout';

interface Props {
  title: string;
  Icon: LucideIcon;
  collapsed: boolean;
  /** 能不能再往上/往下挪一格(到头就禁掉,而不是藏起来——按钮位置跳动更难用)。 */
  canMoveUp: boolean;
  canMoveDown: boolean;
  onToggleCollapsed: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onClose: () => void;
  /** 标题栏右侧的面板自有控件(模型选择之类),排在通用控件左边。 */
  actions?: React.ReactNode;
  children: React.ReactNode;
}

const iconButton: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 22,
  height: 22,
  borderRadius: 6,
  border: 'none',
  background: 'transparent',
  color: C.textDim,
  cursor: 'pointer',
};

/**
 * 一块停靠面板的外框:标题栏 + 内容区。
 *
 * 标题栏统一提供折叠、上下换位、关闭;面板自己的控件走 actions 塞进来。
 * 折叠时**只留标题栏**(高度锁死 DOCK_HEADER_HEIGHT),内容整个不渲染 ——
 * 留着 display:none 的话,聊天区那种带滚动跟随的内容会在看不见的地方继续算布局。
 */
export const DockPanelFrame: React.FC<Props> = ({
  title,
  Icon,
  collapsed,
  canMoveUp,
  canMoveDown,
  onToggleCollapsed,
  onMoveUp,
  onMoveDown,
  onClose,
  actions,
  children,
}) => (
  <section
    className="flex flex-col min-h-0 overflow-hidden"
    // 展开态必须显式 flex:1 —— 外层那个 div 拿着高度权重,section 不填满它的话
    // 面板会按内容高度收着,栈底留一块空白(实测两块面板到 595px,而栏高 720)。
    style={collapsed ? { flex: '0 0 auto', height: DOCK_HEADER_HEIGHT } : { flex: '1 1 0', minHeight: 0 }}
  >
    <div
      className="shrink-0 flex items-center gap-1.5 px-2"
      style={{
        height: DOCK_HEADER_HEIGHT,
        background: C.panel2,
        borderBottom: `1px solid ${C.line}`,
        color: C.text2,
      }}
    >
      <button
        style={{ ...iconButton, width: 18 }}
        onClick={onToggleCollapsed}
        title={collapsed ? '展开' : '折叠'}
        aria-expanded={!collapsed}
      >
        {collapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
      </button>
      <Icon className="w-3.5 h-3.5 shrink-0" style={{ color: C.textDim }} />
      <span className="text-[12px] font-semibold truncate flex-1 min-w-0">{title}</span>
      {actions}
      <button
        style={{ ...iconButton, opacity: canMoveUp ? 1 : 0.3, cursor: canMoveUp ? 'pointer' : 'default' }}
        onClick={canMoveUp ? onMoveUp : undefined}
        disabled={!canMoveUp}
        title="上移"
      >
        <ChevronUp className="w-3.5 h-3.5" />
      </button>
      <button
        style={{ ...iconButton, opacity: canMoveDown ? 1 : 0.3, cursor: canMoveDown ? 'pointer' : 'default' }}
        onClick={canMoveDown ? onMoveDown : undefined}
        disabled={!canMoveDown}
        title="下移"
      >
        <ChevronDown className="w-3.5 h-3.5" />
      </button>
      <button style={iconButton} onClick={onClose} title="关闭此面板">
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
    {!collapsed && <div className="flex-1 min-h-0 relative flex flex-col overflow-hidden">{children}</div>}
  </section>
);
