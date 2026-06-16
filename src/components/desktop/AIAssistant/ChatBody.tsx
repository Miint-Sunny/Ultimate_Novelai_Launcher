import React, { forwardRef, useEffect, useMemo, useState } from 'react';
import { NekoAvatar } from './NekoAvatar';
import { TagChip, renderTagContent, extractTagMarkers } from './TagChip';
import { C, MONO, splitPromptToTags } from './tokens';
import type { VMsg } from './types';
import { lookupTagTranslations } from '../../../services/translate';

interface Props {
  msgs: VMsg[];
  sending: boolean;
  progressText?: string;
  /** VMsg 数组中最后一条 AI 回复的下标 */
  lastAiVIndex: number;
  /** 输入栏的实际高度（用于消息区底部留出避让，避免被悬浮输入栏盖住） */
  inputBarOffset: number;
  onSuggest: (text: string) => void;
  onCopyAll: (msg: VMsg) => void;
  /** 重试这条 AI 回复（或 error）= 截到对应 user request + 重发 */
  onRetry: (msg: VMsg) => void;
  /** 撤回最新一条 AI 回复 + 把 user 文本回填到输入框 */
  onUndoLast: () => void;
}

const SUGGESTIONS = [
  '帮我画一只白发红瞳的傲娇猫娘',
  '给我抽一个好看的画师串',
  '帮我查一下足交的Tag',
  '随机画一个蔚蓝档案的角色',
  '包含 Chen Bin 的画师串有哪些呢',
  '优化一下当前的 Tag',
];

// 空态主标题文案池：每次进入空态随机挑一句。
// 想加新文案：直接在数组里加一行 '你的文案'，逗号结尾。空数组会崩，至少留 1 条。
const GREETINGS = [
  '今天想画点什么喵？',
  '又要跑图了 ？！'
];

/** 消息列表 + 空态 */
export const ChatBody = forwardRef<HTMLDivElement, Props>(
  ({ msgs, sending, progressText, lastAiVIndex, inputBarOffset, onSuggest, onCopyAll, onRetry, onUndoLast }, ref) => {
    const shuffled = useMemo(
      () => [...SUGGESTIONS].sort(() => 0.5 - Math.random()).slice(0, 3),
      [],
    );

    // 为每条 AI 消息计算与「生成前 Web 端已有提示词」的 diff。
    // snapshot.prePositive 是发起该次 AI 请求时的真实画面提示词，比上一条 AI 回复更适合作为基准。
    const diffInfo = useMemo(() => {
      const map: Record<
        number,
        { added: string[]; removed: string[]; diffMap: Record<string, 'add' | 'rem'> }
      > = {};
      msgs.forEach((m, i) => {
        if (m.role !== 'ai') return;
        const tags = m.tags ?? [];
        const baselineTags = splitPromptToTags(m.snapshot?.prePositive);
        const prevSet = new Set(baselineTags);
        const curSet = new Set(tags);
        const added = tags.filter(t => !prevSet.has(t));
        const removed = baselineTags.filter(t => !curSet.has(t));
        // diffMap 用于 inline 文本里的 tag chip 染色（基于 TAG[[]] 标记里的 tag 名）
        const diffMap: Record<string, 'add' | 'rem'> = {};
        extractTagMarkers(m.content).forEach(t => {
          if (added.includes(t)) diffMap[t] = 'add';
        });
        map[i] = { added, removed, diffMap };
      });
      return map;
    }, [msgs]);

    return (
      <div
        ref={ref}
        className="aa-scroll"
        style={{
          position: 'relative',
          flex: 1,
          overflowY: 'auto',
          background: 'linear-gradient(180deg, rgba(0,0,0,0.1), rgba(0,0,0,0.3))',
        }}
      >
        <div style={{ position: 'relative', padding: `14px 14px ${inputBarOffset + 14}px 14px` }}>
          {msgs.length === 0 && !sending ? (
            <EmptyState onPick={onSuggest} suggestions={shuffled} />
          ) : (
            msgs.map((m, i) => {
              if (m.role === 'user') {
                return <UserMsg key={`u-${m.logIndex}`} m={m} />;
              }
              if (m.role === 'error') {
                return (
                  <AIMsg
                    key={`e-${m.logIndex}`}
                    m={m}
                    isError
                    isLast={i === msgs.length - 1}
                    onRetry={() => onRetry(m)}
                    onCopyAll={() => {}}
                    onUndoLast={null}
                  />
                );
              }
              const info = diffInfo[i] ?? { added: [], removed: [], diffMap: {} };
              const isLastAi = i === lastAiVIndex;
              const showDiff =
                info.removed.length > 0 ||
                info.added.length > 0;
              return (
                <AIMsg
                  key={`a-${m.logIndex}`}
                  m={m}
                  isLast={isLastAi}
                  diffMap={info.diffMap}
                  diffAdded={info.added}
                  diffRemoved={info.removed}
                  showDiffToggle={showDiff && isLastAi}
                  onCopyAll={() => onCopyAll(m)}
                  onRetry={() => onRetry(m)}
                  onUndoLast={isLastAi ? onUndoLast : null}
                />
              );
            })
          )}
          {sending && <ThinkingMsg text={progressText} />}
        </div>
      </div>
    );
  },
);
ChatBody.displayName = 'ChatBody';

// ───────────────────────────────────────────────────────
// 空态
// ───────────────────────────────────────────────────────
const EmptyState: React.FC<{ onPick: (s: string) => void; suggestions: string[] }> = ({
  onPick,
  suggestions,
}) => {
  const greeting = useMemo(
    () => GREETINGS[Math.floor(Math.random() * GREETINGS.length)],
    [],
  );
  return (
  <div style={{ paddingTop: 6 }}>
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
      <NekoAvatar size={48} status="online" />
      <div style={{ flex: 1, paddingTop: 4 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>
          {greeting}
        </div>
        <div
          style={{
            fontSize: 11.5,
            color: C.textDim,
            marginTop: 4,
            lineHeight: 1.55,
          }}
        >
          我能帮你优化 Tag、查找画师串、查找角色...
        </div>
      </div>
    </div>
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        margin: '20px 0 10px',
      }}
    >
      <span style={{ flex: 1, height: 1, background: C.line2 }} />
      <span
        style={{
          fontSize: 10,
          color: C.textDim,
          fontWeight: 700,
          letterSpacing: 1,
        }}
      >
        试试这样问我
      </span>
      <span style={{ flex: 1, height: 1, background: C.line2 }} />
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {suggestions.map((s, i) => (
        <button
          key={i}
          className="aa-btn"
          onClick={() => onPick(s)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 10px',
            background: C.surfaceHover,
            border: `1px solid ${C.borderStrong}`,
            borderRadius: 8,
            color: C.text,
            fontSize: 12.5,
            textAlign: 'left',
          }}
        >
          <span
            style={{
              width: 18,
              height: 18,
              display: 'grid',
              placeItems: 'center',
              fontFamily: MONO,
              fontSize: 10,
              color: C.accent,
              background: C.accentSoft,
              border: `1px solid ${C.accentLine}`,
              borderRadius: 4,
              flexShrink: 0,
            }}
          >
            {i + 1}
          </span>
          <span style={{ flex: 1 }}>{s}</span>
          <span style={{ color: C.textDim, fontFamily: MONO, fontSize: 10 }}>⏎</span>
        </button>
      ))}
    </div>
  </div>
  );
};

// ───────────────────────────────────────────────────────
// User 消息
// ───────────────────────────────────────────────────────
const UserMsg: React.FC<{ m: VMsg }> = ({ m }) => (
  <div
    className="aa-msg-in"
    style={{
      position: 'relative',
      marginBottom: 14,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-end',
    }}
  >
    <div style={{ display: 'flex', justifyContent: 'flex-end', width: '100%' }}>
      <div
        style={{
          position: 'relative',
          maxWidth: '85%',
          padding: '8px 12px',
          borderRadius: '12px 12px 4px 12px',
          background: C.accent,
          color: C.bgDeep,
          fontSize: 12.5,
          fontWeight: 500,
          lineHeight: 1.5,
          boxShadow: '0 4px 12px -4px rgba(252, 237, 164, 0.4)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {m.image && (
          <div style={{ marginBottom: 6 }}>
            <img
              src={m.image}
              alt=""
              style={{ maxWidth: '100%', maxHeight: 80, borderRadius: 4 }}
            />
          </div>
        )}
        <div>{m.content}</div>
        <div
          style={{
            position: 'absolute',
            right: -3,
            bottom: 0,
            width: 10,
            height: 10,
            background: C.accent,
            clipPath: 'polygon(0 0, 100% 100%, 0 100%)',
          }}
        />
      </div>
    </div>
  </div>
);

// ───────────────────────────────────────────────────────
// AI 消息（含 error 复用）
// ───────────────────────────────────────────────────────
interface AIMsgProps {
  m: VMsg;
  isLast: boolean;
  isError?: boolean;
  diffMap?: Record<string, 'add' | 'rem'>;
  diffAdded?: string[];
  diffRemoved?: string[];
  /** 是否显示「对比上次」按钮（外层根据 isLastAi + diff 是否非空决定） */
  showDiffToggle?: boolean;
  onCopyAll: () => void;
  /** 仅最新一条 AI 显示，点了会撤回 + 回填到输入框 */
  onUndoLast: (() => void) | null;
  onRetry: () => void;
}

const AIMsg: React.FC<AIMsgProps> = ({
  m,
  isLast: _isLast,
  isError,
  diffMap,
  diffAdded,
  diffRemoved,
  showDiffToggle,
  onCopyAll,
  onUndoLast,
  onRetry,
}) => {
  void _isLast;
  const tagCount = m.tags?.length ?? 0;
  const [diffOpen, setDiffOpen] = useState(false);
  const addedCount = diffAdded?.length ?? 0;
  const removedCount = diffRemoved?.length ?? 0;
  return (
    <div
      className="aa-msg-in"
      style={{ position: 'relative', marginBottom: 14 }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          marginBottom: 4,
        }}
      >
        <NekoAvatar size={18} status={isError ? 'err' : 'online'} />
        <span style={{ fontWeight: 700, fontSize: 11.5, color: C.text }}>Plana</span>
      </div>
      <div
        style={{
          position: 'relative',
          padding: '8px 12px',
          borderRadius: '4px 12px 12px 12px',
          background: isError ? 'rgba(240, 130, 130, 0.06)' : C.surface,
          color: C.text2,
          border: `1px solid ${isError ? 'rgba(240, 130, 130, 0.25)' : C.border}`,
          boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
        }}
      >
        {isError ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 13 }}>😿</span>
              <span style={{ fontWeight: 700, color: C.err, fontSize: 11.5 }}>
                呜...这次没成功
              </span>
            </div>
            <div
              style={{
                marginTop: 6,
                padding: '6px 8px',
                background: 'rgba(0,0,0,0.3)',
                border: '1px solid rgba(240, 130, 130, 0.15)',
                borderRadius: 4,
                fontFamily: MONO,
                fontSize: 10.5,
                color: C.err,
                lineHeight: 1.45,
                wordBreak: 'break-word',
              }}
            >
              <span style={{ opacity: 0.7 }}>[error]</span> {m.content}
            </div>
          </>
        ) : (
          <div
            style={{
              fontSize: 12.5,
              lineHeight: 1.55,
              wordBreak: 'break-word',
            }}
          >
            {renderTagContent(m.content, diffMap)}
          </div>
        )}
      </div>
      {/* 常驻操作栏 */}
      <div
        className="no-drag"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          marginTop: 6,
          paddingLeft: 2,
          flexWrap: 'wrap',
        }}
      >
        {isError ? (
          <button className="aa-btn" style={actBtnHot()} onClick={onRetry}>
            <RetryIcon />
            重试
          </button>
        ) : (
          <>
            {showDiffToggle && (
              <button
                className="aa-btn-cell"
                style={{
                  ...actBtn(),
                  ...(diffOpen ? { background: 'rgba(255,255,255,0.06)', color: C.text } : null),
                }}
                onClick={() => setDiffOpen(o => !o)}
                title="对比生成前已有提示词的 Tag 差异"
              >
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{
                    transform: diffOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                    transition: 'transform 0.2s ease',
                  }}
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
                对比
                <span style={{ fontFamily: MONO, marginLeft: 2, color: C.ok, fontWeight: 700 }}>
                  +{addedCount}
                </span>
                <span style={{ fontFamily: MONO, color: C.err, fontWeight: 700 }}>
                  −{removedCount}
                </span>
              </button>
            )}
            <button className="aa-btn-cell" style={actBtn()} onClick={onCopyAll} title="复制全部 Tag">
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
              复制{tagCount ? ` ${tagCount}` : ''}
            </button>
            <button
              className="aa-btn-cell"
              style={actBtn()}
              onClick={onRetry}
              title="用同一句请求重新生成一次"
            >
              <RetryIcon />
              重试
            </button>
            {onUndoLast && (
              <button
                className="aa-btn-cell"
                style={actBtn()}
                onClick={onUndoLast}
                title="撤回这条 AI 回复，并把请求回填到输入框"
              >
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M9 14l-4-4 4-4" />
                  <path d="M5 10h11a4 4 0 0 1 0 8h-1" />
                </svg>
                撤回
              </button>
            )}
          </>
        )}
      </div>
      {showDiffToggle && diffOpen && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 36,
            zIndex: 5,
            background: C.panel,
            border: `1px solid ${C.borderStrong}`,
            borderRadius: 8,
            boxShadow: '0 10px 28px rgba(0,0,0,0.55)',
            padding: 2,
          }}
        >
          <DiffCard added={diffAdded ?? []} removed={diffRemoved ?? []} />
        </div>
      )}
    </div>
  );
};

const RetryIcon: React.FC = () => (
  <svg
    width="11"
    height="11"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M21 12a9 9 0 1 1-3-6.7" />
    <path d="M21 4v5h-5" />
  </svg>
);


// ───────────────────────────────────────────────────────
// 思考态
// ───────────────────────────────────────────────────────
const THINKING_PHRASES = [
  '努力思考喵...',
  '脑电波链接中喵～',
  '整理魔法词汇喵～',
  '灵感加载中喵 ✨',
];

const ThinkingMsg: React.FC<{ text?: string }> = ({ text }) => {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    const t = window.setInterval(
      () => setIdx(i => (i + 1) % THINKING_PHRASES.length),
      2500,
    );
    return () => window.clearInterval(t);
  }, []);
  const display = text && text.trim() ? text : THINKING_PHRASES[idx];
  return (
    <div className="aa-msg-in" style={{ position: 'relative', marginBottom: 14 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          marginBottom: 4,
        }}
      >
        <NekoAvatar size={18} status="thinking" />
        <span style={{ fontWeight: 700, fontSize: 11.5, color: C.text }}>Plana</span>
        <span
          style={{
            fontSize: 10.5,
            color: C.textDim,
            marginLeft: 'auto',
          }}
        >
          正在
        </span>
      </div>
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          borderRadius: '4px 12px 12px 12px',
          background: C.surface,
          border: `1px solid ${C.accentLine}`,
          boxShadow: '0 0 0 4px rgba(252, 237, 164, 0.03)',
        }}
      >
        <span className="aa-pulse-dot" style={{ animationDelay: '0s' }} />
        <span className="aa-pulse-dot" style={{ animationDelay: '0.16s' }} />
        <span className="aa-pulse-dot" style={{ animationDelay: '0.32s' }} />
        <span style={{ fontSize: 12.5, color: C.text2 }}>{display}</span>
      </div>
    </div>
  );
};

// ───────────────────────────────────────────────────────
// Diff 卡片
// ───────────────────────────────────────────────────────
const DiffCard: React.FC<{ added: string[]; removed: string[] }> = ({
  added,
  removed,
}) => {
  const [zhMap, setZhMap] = useState<Record<string, string>>({});
  const allTagsKey = useMemo(() => [...added, ...removed].join('|'), [added, removed]);
  useEffect(() => {
    const tags = [...added, ...removed];
    if (tags.length === 0) return;
    let cancelled = false;
    lookupTagTranslations(tags).then(m => {
      if (!cancelled) setZhMap(m);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allTagsKey]);

  if (added.length === 0 && removed.length === 0) return null;
  return (
    <div
      style={{
        position: 'relative',
        padding: '8px 10px',
        background: 'transparent',
        borderRadius: 8,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span
            style={{
              width: 5,
              height: 5,
              borderRadius: 3,
              background: C.accent,
            }}
          />
          <span style={{ fontSize: 11, fontWeight: 700, color: C.text }}>
            这次跟原提示词比
          </span>
        </span>
        <span style={{ fontFamily: MONO, fontSize: 10, color: C.text2 }}>
          +{added.length} −{removed.length}
        </span>
      </div>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '6px 4px',
          marginTop: 6,
          alignItems: 'flex-start',
        }}
      >
        {added.map((t, i) => (
          <TagChip key={`a${i}`} diff="add" subText={zhMap[t]}>
            {t}
          </TagChip>
        ))}
        {removed.map((t, i) => (
          <TagChip key={`r${i}`} diff="rem" subText={zhMap[t]}>
            {t}
          </TagChip>
        ))}
      </div>
    </div>
  );
};

// ───────────────────────────────────────────────────────
// 公共按钮样式
// actBtn: 底部操作栏 ghost 风格，无 border、无底色，hover 才有反馈（aa-btn-cell 提供）
// ───────────────────────────────────────────────────────
function actBtn(): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '3px 7px',
    fontSize: 11,
    fontWeight: 500,
    color: C.textDim,
    background: 'transparent',
    border: 0,
    borderRadius: 6,
  };
}
function actBtnHot(): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '4px 10px',
    fontSize: 11,
    fontWeight: 700,
    color: C.accent,
    background: C.accentSoft,
    border: `1px solid ${C.accentLine}`,
    borderRadius: 6,
  };
}
