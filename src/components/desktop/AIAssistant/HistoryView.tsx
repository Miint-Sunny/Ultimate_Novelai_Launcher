import React from 'react';
import type { ArchivedSession } from './types';
import { C, MONO } from './tokens';

interface Props {
  sessions: ArchivedSession[];
  onResume: (s: ArchivedSession) => void;
  onDelete: (id: number) => void;
}

/**
 * 历史会话列表视图（Header 切到 history 时展示）。
 * - 卡片：状态点 / 标题 / 时间 / 预览 / 轮次 + tags + 删除 + 打开
 * - 空态：📭
 */
export const HistoryView: React.FC<Props> = ({ sessions, onResume, onDelete }) => {
  return (
    <div
      className="aa-scroll no-drag"
      style={{
        flex: 1,
        overflowY: 'auto',
        padding: '8px 10px 12px',
      }}
    >
      {sessions.length === 0 ? (
        <div
          style={{
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
          }}
        >
          <div style={{ fontSize: 32, opacity: 0.4 }}>📭</div>
          <div style={{ fontSize: 13, fontWeight: 700, marginTop: 8, color: C.text }}>
            还没有历史会话
          </div>
          <div
            style={{
              fontSize: 11,
              color: C.textDim,
              marginTop: 4,
              textAlign: 'center',
              maxWidth: 240,
              lineHeight: 1.55,
            }}
          >
            点顶部 + 新对话 或者清空当前对话，会把这次会话存档到这里
          </div>
        </div>
      ) : (
        sessions.map(s => (
          <div
            key={s.id}
            className="aa-msg-in"
            style={{
              padding: '10px 12px',
              marginBottom: 8,
              background: C.surface,
              border: `1px solid ${s.current ? C.accentLine : C.border}`,
              borderRadius: 10,
            }}
          >
            {/* 第一行：状态点 + 标题 + 当前徽章 / 时间 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  background: s.current ? C.accent : s.err ? C.err : C.textMute,
                  flexShrink: 0,
                }}
              />
              <span
                style={{
                  fontWeight: 700,
                  fontSize: 12.5,
                  flex: 1,
                  color: s.err ? C.textDim : C.text,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {s.title}
              </span>
              {s.current ? (
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    padding: '1px 6px',
                    color: C.accent,
                    background: C.accentSoft,
                    border: `1px solid ${C.accentLine}`,
                    borderRadius: 999,
                  }}
                >
                  当前
                </span>
              ) : (
                <span style={{ fontFamily: MONO, fontSize: 10, color: C.textDim }}>
                  {s.date}
                </span>
              )}
            </div>
            {/* 第二行：预览 */}
            <div
              style={{
                fontSize: 11.5,
                color: C.textDim,
                marginTop: 6,
                lineHeight: 1.5,
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}
            >
              {s.preview || <span style={{ opacity: 0.5 }}>（无回复内容）</span>}
            </div>
            {/* 第三行：chips + 操作 */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                marginTop: 8,
              }}
            >
              <MetaChip>{s.turns} 轮</MetaChip>
              {s.tagCount > 0 && <MetaChip>{s.tagCount} tags</MetaChip>}
              {s.err && <MetaChip danger>失败</MetaChip>}
              <span style={{ flex: 1 }} />
              <button
                className="aa-btn"
                onClick={() => onDelete(s.id)}
                title={s.current ? '清空当前对话' : '删除这条会话'}
                style={{
                  width: 24,
                  height: 22,
                  display: 'grid',
                  placeItems: 'center',
                  color: C.text2,
                  background: C.surfaceHover,
                  border: `1px solid ${C.borderStrong}`,
                  borderRadius: 5,
                }}
              >
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                </svg>
              </button>
              <button
                className="aa-btn"
                onClick={() => onResume(s)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 3,
                  padding: '3px 8px',
                  fontSize: 11,
                  fontWeight: 700,
                  color: C.accent,
                  background: C.accentSoft,
                  border: `1px solid ${C.accentLine}`,
                  borderRadius: 5,
                }}
              >
                {s.current ? '返回' : '打开'}
                <svg
                  width="9"
                  height="9"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                >
                  <path d="M9 18l6-6-6-6" />
                </svg>
              </button>
            </div>
          </div>
        ))
      )}
    </div>
  );
};

const MetaChip: React.FC<{ children: React.ReactNode; danger?: boolean }> = ({
  children,
  danger,
}) => (
  <span
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      padding: '2px 6px',
      fontSize: 10.5,
      fontWeight: 600,
      color: danger ? C.err : C.textDim,
      background: 'rgba(0,0,0,0.3)',
      border: `1px solid ${danger ? 'rgba(240,130,130,0.3)' : C.border}`,
      borderRadius: 4,
    }}
  >
    {children}
  </span>
);
