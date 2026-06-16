import React, { useEffect, useRef, useState } from 'react';
import { C } from './tokens';

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  sending: boolean;
  inputRef?: React.MutableRefObject<HTMLTextAreaElement | null>;
  /** 已选图片预览（base64） */
  selectedImage: string | null;
  onPickImage: () => void;
  onClearImage: () => void;
  /** 当前对话是否有内容（决定是否显示垃圾桶按钮） */
  hasMessages: boolean;
  /** 清空当前对话（不归档，直接 reset） */
  onClearChat: () => void;
  /** 把整个 InputBar 高度上报给父组件，用于 ChatBody 留出底部避让 */
  onHeightChange?: (h: number) => void;
}

/**
 * 输入区。
 * - textarea 自动增高（1 行 → 100px）
 * - Enter 发送，Shift+Enter 换行
 * - 左侧图标按钮：附图
 * - 右侧：发送按钮（有内容才高亮）
 * - 选了图后顶部显示缩略图
 */
export const InputBar: React.FC<Props> = ({
  value,
  onChange,
  onSend,
  sending,
  inputRef,
  selectedImage,
  onPickImage,
  onClearImage,
  hasMessages,
  onClearChat,
  onHeightChange,
}) => {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  // 是否多行：单行时居中对齐按钮与文字；多行时按钮贴底，避免随文字漂到中央
  const [multiLine, setMultiLine] = useState(false);

  useEffect(() => {
    if (inputRef) inputRef.current = taRef.current;
  });

  // 监测自身高度上报给父组件（图片预览展开 / 多行输入时高度会变）
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || !onHeightChange) return;
    const ro = new ResizeObserver(entries => {
      const h = entries[0]?.contentRect.height ?? el.offsetHeight;
      onHeightChange(h);
    });
    ro.observe(el);
    onHeightChange(el.offsetHeight);
    return () => ro.disconnect();
  }, [onHeightChange]);

  const canSend = (value.trim().length > 0 || !!selectedImage) && !sending;

  return (
    <div
      ref={wrapRef}
      className="no-drag"
      style={{
        position: 'absolute',
        left: 0,
        bottom: 0,
        width: '100%',
        boxSizing: 'border-box',
        padding: '10px 12px 12px',
        // 顶部用一段渐变把消息区底部柔和地"溶"进来，避免被悬浮输入框硬切
        background:
          'linear-gradient(180deg, rgba(19, 23, 36, 0) 0%, rgba(19, 23, 36, 0.55) 40%, rgba(19, 23, 36, 0.85) 100%)',
      }}
    >
      {selectedImage && (
        <div
          className="aa-msg-in"
          style={{
            display: 'inline-flex',
            position: 'relative',
            marginBottom: 6,
          }}
        >
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 6,
              overflow: 'hidden',
              border: `1px solid ${C.accentLine}`,
            }}
          >
            <img
              src={selectedImage}
              alt=""
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          </div>
          <button
            className="aa-btn"
            onClick={onClearImage}
            title="移除图片"
            style={{
              position: 'absolute',
              top: -6,
              right: -6,
              width: 18,
              height: 18,
              display: 'grid',
              placeItems: 'center',
              background: C.surfaceHover,
              border: `1px solid ${C.borderStrong}`,
              borderRadius: 9,
              color: C.text,
            }}
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
      <div
        className="aa-input-box"
        style={{
          display: 'flex',
          alignItems: multiLine ? 'flex-end' : 'center',
          gap: 2,
          width: '100%',
          boxSizing: 'border-box',
          padding: '4px 4px 4px 4px',
          background: C.panel2,
          border: `1px solid ${C.borderStrong}`,
          borderRadius: 12,
          // box-shadow 由 .aa-input-box CSS 控制（默认态 + focus-within 态都在那里）
        }}
      >
        <button
          className="aa-btn-cell"
          onClick={onPickImage}
          title="附图"
          disabled={sending}
          style={iconGhostStyle()}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <rect x="3" y="3" width="18" height="18" rx="3" />
            <circle cx="9" cy="9" r="2" />
            <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
          </svg>
        </button>
        <textarea
          ref={taRef}
          className="aa-input-field"
          value={value}
          onChange={e => {
            onChange(e.target.value);
            e.target.style.height = 'auto';
            const sh = e.target.scrollHeight;
            e.target.style.height = Math.min(sh, 100) + 'px';
            // 单行内容（含 padding）约 32-36px；超过 40 视为多行，按钮贴底
            setMultiLine(sh > 40);
          }}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (canSend) onSend();
            }
          }}
          placeholder="想画什么样的画呢～"
          disabled={sending}
          rows={1}
          style={{
            flex: 1,
            minWidth: 0,
            width: '100%',
            fontSize: 13,
            color: C.text,
            background: 'transparent',
            border: 0,
            padding: '8px 6px',
            resize: 'none',
            fontFamily: 'inherit',
            lineHeight: 1.45,
            minHeight: 18,
            maxHeight: 100,
            outline: 'none',
          }}
        />
        {hasMessages && (
          <button
            className="aa-btn-cell"
            onClick={onClearChat}
            disabled={sending}
            title="清空当前对话"
            style={iconGhostStyle()}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 6h18" />
              <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
            </svg>
          </button>
        )}
        <button
          className="aa-btn"
          onClick={onSend}
          disabled={!canSend}
          title="发送 (Enter)"
          style={{
            width: 30,
            height: 30,
            display: 'grid',
            placeItems: 'center',
            color: canSend ? C.bgDeep : C.textDim,
            background: canSend ? C.accent : 'transparent',
            border: 0,
            borderRadius: 8,
            transition: 'background 0.15s ease, color 0.15s ease',
          }}
        >
          {sending ? (
            <svg
              className="aa-spin"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
            >
              <path d="M12 2v4M4.93 4.93l2.83 2.83M2 12h4M4.93 19.07l2.83-2.83M12 18v4" />
            </svg>
          ) : (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
            >
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
};

function iconGhostStyle(): React.CSSProperties {
  return {
    width: 30,
    height: 30,
    display: 'grid',
    placeItems: 'center',
    color: C.textDim,
    background: 'transparent',
    border: 0,
    borderRadius: 8,
  };
}
