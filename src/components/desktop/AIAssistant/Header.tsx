import React from 'react';
import { NekoAvatar } from './NekoAvatar';
import { C } from './tokens';
import { AI_MODEL_CHOICES } from '../../../services/agentService';

interface Props {
  view: 'chat' | 'history';
  model: string;
  blink: boolean;
  sending: boolean;
  hasMessages: boolean;
  onModelChange: (m: string) => void;
  onGoHistory: () => void;
  onBack: () => void;
  onNewChat: () => void;
  onClose: () => void;
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
}

/**
 * 浮窗顶栏。
 * - 整条作为拖拽手柄（pointerdown/move/up），但内部按钮加 .no-drag 隔离
 * - chat 视图：头像 + 名称 + 模式 segmented（带滑块）+ 历史/新对话 group + 关闭
 * - history 视图：返回按钮 + "历史对话" 标题 + 关闭
 *
 * 整体 48px 高（padding 8 + 内容 32）。
 */
export const Header: React.FC<Props> = ({
  view,
  model,
  blink,
  sending,
  hasMessages,
  onModelChange,
  onGoHistory,
  onBack,
  onNewChat,
  onClose,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}) => {
  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={{
        position: 'relative',
        zIndex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 10px 10px 12px',
        background: C.bgDeep,
        borderBottom: `1px solid ${C.line}`,
        cursor: 'move',
        flexShrink: 0,
      }}
    >
      {/* 左：头像 / 返回 + 标题 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
        {view === 'history' ? (
          <button
            className="no-drag aa-btn"
            onClick={onBack}
            title="返回对话"
            style={iconBtnStyle()}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
        ) : (
          <NekoAvatar size={26} status={sending ? 'thinking' : 'online'} blink={blink} />
        )}
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              fontSize: 13,
              fontWeight: 800,
              color: C.text,
              lineHeight: 1.1,
            }}
          >
            {view === 'history' ? '历史对话' : 'Plana Art'}
          </div>
        </div>
      </div>

      {/* 右：模式 segmented + (历史/新对话 group) + 关闭 */}
      <div
        className="no-drag"
        style={{ display: 'flex', alignItems: 'center', gap: 6 }}
      >
        {view === 'chat' && <ModelSelect model={model} onChange={onModelChange} />}

        {view === 'chat' && (
          <>
            <button
              className="no-drag aa-btn"
              onClick={onGoHistory}
              title="历史对话"
              style={iconBtnStyle()}
            >
              <HistoryIcon />
            </button>
            <button
              className="no-drag aa-btn"
              onClick={onNewChat}
              title={hasMessages ? '存档并新建会话' : '新建会话'}
              style={iconBtnStyle()}
            >
              <NewSessionIcon />
            </button>
          </>
        )}

        <button
          className="aa-btn-cell"
          onClick={onClose}
          title="收起浮窗"
          style={closeBtnStyle()}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
          >
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
};

// ───────────────────────────────────────────────────────
// model 下拉选择 —— pill 形 select，紧凑、带自定义 caret 箭头
// 显示用 shortLabel（DeepSeek / Gemini），下拉选项里完整 label
// ───────────────────────────────────────────────────────
const ModelSelect: React.FC<{
  model: string;
  onChange: (m: string) => void;
}> = ({ model, onChange }) => {
  const [hover, setHover] = React.useState(false);
  const current = AI_MODEL_CHOICES.find((c) => c.key === model);
  return (
    <div
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={current ? current.label : '选择 model'}
    >
      <select
        value={model}
        onChange={(e) => onChange(e.target.value)}
        style={{
          height: 28,
          minWidth: 96,
          padding: '0 26px 0 12px',
          fontSize: 11.5,
          fontWeight: 800,
          letterSpacing: 0.3,
          color: C.text,
          background: hover ? C.surfaceHover : C.surface,
          border: `1px solid ${hover ? C.accentLine : C.borderStrong}`,
          borderRadius: 999,
          cursor: 'pointer',
          outline: 'none',
          appearance: 'none',
          WebkitAppearance: 'none',
          MozAppearance: 'none',
          boxShadow: hover
            ? `inset 0 1px 2px rgba(0,0,0,0.25), 0 0 0 3px ${C.accentSoft}`
            : 'inset 0 1px 2px rgba(0,0,0,0.25)',
          transition: 'background 160ms ease, border-color 160ms ease, box-shadow 160ms ease',
        }}
      >
        {AI_MODEL_CHOICES.map((c) => (
          <option
            key={c.key}
            value={c.key}
            title={c.label}
            style={{ background: C.panel, color: C.text }}
          >
            {c.shortLabel}
          </option>
        ))}
      </select>
      {/* 自定义 caret —— 暖黄 accent，hover 时上下抖动 */}
      <svg
        aria-hidden
        viewBox="0 0 12 12"
        width={10}
        height={10}
        style={{
          position: 'absolute',
          right: 10,
          top: '50%',
          transform: 'translateY(-50%)',
          color: hover ? C.accent : C.textDim,
          pointerEvents: 'none',
          transition: 'color 160ms ease',
        }}
      >
        <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
};

// ───────────────────────────────────────────────────────
// 图标
// ───────────────────────────────────────────────────────
const HistoryIcon: React.FC = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);

/** 「新建会话」图标 = 加号（lucide Plus） */
const NewSessionIcon: React.FC = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </svg>
);

// ───────────────────────────────────────────────────────
// 公共样式
// ───────────────────────────────────────────────────────
function iconBtnStyle(): React.CSSProperties {
  return {
    width: 28,
    height: 28,
    display: 'grid',
    placeItems: 'center',
    color: C.text,
    background: C.surface,
    border: `1px solid ${C.borderStrong}`,
    borderRadius: 999,
  };
}

/** 关闭按钮：ghost 风格，无 border、无底色，hover 才显形状（aa-btn-cell 提供反馈） */
function closeBtnStyle(): React.CSSProperties {
  return {
    width: 28,
    height: 28,
    display: 'grid',
    placeItems: 'center',
    color: C.text2,
    borderRadius: 999,
    marginLeft: 2,
  };
}
