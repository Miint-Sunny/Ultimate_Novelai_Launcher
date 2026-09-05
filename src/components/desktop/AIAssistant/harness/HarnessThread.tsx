import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Info, Wrench } from 'lucide-react';
import type { PermissionDecision } from '../../../../services/agentHarness/types';
import type { AgentQuestion } from '../../../../services/agentHarness/workbench';
import { C } from '../tokens';
import type { TranscriptItem } from './transcript';

/**
 * 对话流。照 STYLE.md 的「对话流」一节:用户消息有壳(右对齐小卡),回复不包壳直接排在
 * 面板表面;没有全幅分隔线,分组靠留白与圆角岛;次要文字走 ink-muted。
 */

const R = {
  lg: 'var(--nai-agent-radius-lg)',
  md: 'var(--nai-agent-radius-md)',
  sm: 'var(--nai-agent-radius-sm)',
};
const INK_MUTED = 'var(--nai-agent-ink-muted)';
const INK_FAINT = 'var(--nai-agent-ink-faint)';
const CHIP_BG = 'var(--nai-agent-chip-bg)';
const CHIP_BORDER = 'var(--nai-agent-chip-border)';
const CHIP_SHADOW = 'var(--nai-agent-chip-shadow)';
const CARD_BG = 'var(--nai-agent-card-bg)';

const PERMISSION_CLASS_LABEL: Record<string, string> = { R: '读取', W: '修改', D: '删除', P: '付费', A: '提问' };

interface Props {
  items: TranscriptItem[];
  busy: boolean;
  bottomInset: number;
  onAnswer: (itemId: string, answers: string[] | null) => void;
  onDecide: (itemId: string, decision: PermissionDecision) => void;
  onSuggest: (text: string) => void;
}

export const HarnessThread = React.forwardRef<HTMLDivElement, Props>(({ items, busy, bottomInset, onAnswer, onDecide, onSuggest }, ref) => {
  return (
    <div ref={ref} style={{ position: 'relative', flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: `14px 12px ${bottomInset + 14}px 12px` }}>
        {items.length === 0 && !busy && <EmptyState onPick={onSuggest} />}
        {items.map((item) => {
          switch (item.kind) {
            case 'user': return <UserMsg key={item.id} text={item.text} image={item.imageDataUrl} />;
            case 'assistant': return <AssistantMsg key={item.id} content={item.content} thoughts={item.thoughts} streaming={item.streaming} model={item.model} />;
            case 'tool_call': return <ToolRow key={item.id} item={item} />;
            case 'notice': return <Notice key={item.id} level={item.level} text={item.text} />;
            case 'permission': return <PermissionCard key={item.id} item={item} onDecide={(d) => onDecide(item.id, d)} />;
            case 'ask': return <AskCard key={item.id} questions={item.questions} answers={item.answers} onAnswer={(a) => onAnswer(item.id, a)} />;
            default: return null;
          }
        })}
        {busy && items.at(-1)?.kind !== 'assistant' && (
          <div style={{ fontSize: 11, color: INK_FAINT, paddingLeft: 2 }}>思考中…</div>
        )}
      </div>
    </div>
  );
});
HarnessThread.displayName = 'HarnessThread';

const SUGGESTIONS = ['帮我把当前提示词改成一张雨夜街头的双人构图', '按方法层重写一遍提示词再出一张', '看看最新那张图哪里不对,改完再来一张'];

function EmptyState({ onPick }: { onPick: (t: string) => void }) {
  return (
    <div style={{ padding: '28px 6px 8px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>直接说要画什么</div>
      <div style={{ fontSize: 12, color: INK_MUTED, lineHeight: 1.6 }}>
        助手会自己改左栏参数、摆角色、出图、看图再改。写类改动默认自动应用并可撤销,花钱和删除会先问你。
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
        {SUGGESTIONS.map((s) => (
          <button key={s} onClick={() => onPick(s)} style={chipButton({ align: 'left' })}>{s}</button>
        ))}
      </div>
    </div>
  );
}

function UserMsg({ text, image }: { text: string; image?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
      <div style={{ maxWidth: '86%', padding: '8px 12px', borderRadius: R.lg, background: CHIP_BG, border: `1px solid ${CHIP_BORDER}`, boxShadow: CHIP_SHADOW, fontSize: 13, lineHeight: 1.55, color: C.text, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {image && <img src={image} alt="" style={{ display: 'block', maxWidth: '100%', maxHeight: 160, borderRadius: R.sm, marginBottom: text ? 8 : 0 }} />}
        {text}
      </div>
    </div>
  );
}

function AssistantMsg({ content, thoughts, streaming, model }: { content: string; thoughts: string; streaming: boolean; model?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 2 }}>
      {thoughts && (
        <button onClick={() => setOpen((v) => !v)} style={{ ...bareButton, display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: INK_FAINT }}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          思考过程{streaming && !content ? '…' : ''}
        </button>
      )}
      {thoughts && open && (
        <div style={{ fontSize: 11.5, lineHeight: 1.55, color: INK_MUTED, whiteSpace: 'pre-wrap', wordBreak: 'break-word', padding: '6px 10px', borderRadius: R.sm, background: CARD_BG }}>{thoughts}</div>
      )}
      {(content || streaming) && (
        <div style={{ fontSize: 13, lineHeight: 1.6, color: C.text, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {content}{streaming && <span style={{ display: 'inline-block', width: 6, height: 13, marginLeft: 2, verticalAlign: '-2px', background: C.accent, opacity: 0.7, borderRadius: 1 }} />}
        </div>
      )}
      {model && !streaming && <div style={{ fontSize: 10, color: INK_FAINT }}>{model}</div>}
    </div>
  );
}

function ToolRow({ item }: { item: Extract<TranscriptItem, { kind: 'tool_call' }> }) {
  const [open, setOpen] = useState(false);
  const argsText = useMemo(() => {
    const entries = Object.entries(item.call.arguments);
    if (entries.length === 0) return '';
    return entries.map(([k, v]) => `${k}=${typeof v === 'string' ? (v.length > 40 ? `${v.slice(0, 40)}…` : v) : JSON.stringify(v)}`).join(' ');
  }, [item.call.arguments]);
  const pending = !item.result;
  const failed = item.result?.isError;
  return (
    <div style={{ borderRadius: R.md, background: CARD_BG, padding: '6px 10px', display: 'flex', flexDirection: 'column', gap: 4 }}>
      <button onClick={() => setOpen((v) => !v)} style={{ ...bareButton, display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, textAlign: 'left' }}>
        <Wrench size={12} style={{ color: failed ? C.err : pending ? INK_FAINT : C.accent, flexShrink: 0 }} />
        <span style={{ fontSize: 12, fontWeight: 600, color: C.text, flexShrink: 0 }}>{item.call.name}</span>
        <span style={{ fontSize: 11, color: INK_FAINT, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{argsText}</span>
        <span style={{ fontSize: 10, color: failed ? C.err : INK_FAINT, flexShrink: 0 }}>{pending ? '执行中' : failed ? '失败' : '完成'}</span>
      </button>
      {open && item.result && (
        <div style={{ fontSize: 11.5, lineHeight: 1.5, color: INK_MUTED, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 220, overflowY: 'auto' }}>
          {item.result.imageBase64 && <img src={`data:${item.result.imageMimeType ?? 'image/png'};base64,${item.result.imageBase64}`} alt="" style={{ display: 'block', maxWidth: '100%', maxHeight: 200, borderRadius: R.sm, marginBottom: 6 }} />}
          {item.result.content}
        </div>
      )}
    </div>
  );
}

function Notice({ level, text }: { level: 'info' | 'warn' | 'error'; text: string }) {
  const color = level === 'error' ? C.err : level === 'warn' ? '#f5c451' : INK_MUTED;
  const Icon = level === 'info' ? Info : AlertTriangle;
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 11.5, lineHeight: 1.5, color, padding: '2px 2px' }}>
      <Icon size={13} style={{ flexShrink: 0, marginTop: 2 }} />
      <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{text}</span>
    </div>
  );
}

function PermissionCard({ item, onDecide }: { item: Extract<TranscriptItem, { kind: 'permission' }>; onDecide: (d: PermissionDecision) => void }) {
  const [reason, setReason] = useState('');
  const { request, decision } = item;
  const cls = PERMISSION_CLASS_LABEL[request.permissionClass] ?? request.permissionClass;
  return (
    <div style={{ borderRadius: R.lg, background: CARD_BG, border: `1px solid ${CHIP_BORDER}`, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 8px', borderRadius: 999, background: request.permissionClass === 'P' ? 'rgba(252,237,164,0.18)' : CHIP_BG, color: request.permissionClass === 'P' ? C.accent : INK_MUTED }}>{cls}</span>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: C.text }}>{request.toolLabel}</span>
        <span style={{ fontSize: 10.5, color: INK_FAINT, marginLeft: 'auto' }}>{request.toolName}</span>
      </div>
      <div style={{ fontSize: 12, lineHeight: 1.55, color: INK_MUTED, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{request.summary}</div>
      {request.cost && (
        <div style={{ fontSize: 11.5, color: request.cost.free ? INK_MUTED : C.accent }}>
          {request.cost.free ? '预计免费' : `预计消耗 ${request.cost.anlas} Anlas`}{request.cost.note ? ` · ${request.cost.note}` : ''}
        </div>
      )}
      {decision ? (
        <div style={{ fontSize: 11, color: INK_FAINT }}>
          {decision.kind === 'deny' ? `已拒绝${decision.reason ? `:${decision.reason}` : ''}` : decision.kind === 'allow-class' ? '已允许(本轮同类都放行)' : '已允许一次'}
        </div>
      ) : (
        <>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="拒绝理由(可空)"
            style={{ fontSize: 12, padding: '7px 10px', borderRadius: R.sm, border: `1px solid ${CHIP_BORDER}`, background: 'rgba(0,0,0,0.18)', color: C.text, outline: 'none' }}
          />
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button onClick={() => onDecide({ kind: 'allow' })} style={chipButton({ primary: true })}>允许一次</button>
            <button onClick={() => onDecide({ kind: 'allow-class' })} style={chipButton({})}>本轮同类都允许</button>
            <button onClick={() => onDecide({ kind: 'deny', reason })} style={chipButton({})}>拒绝</button>
          </div>
        </>
      )}
    </div>
  );
}

function AskCard({ questions, answers, onAnswer }: { questions: AgentQuestion[]; answers?: string[] | null; onAnswer: (a: string[] | null) => void }) {
  const [picked, setPicked] = useState<Record<number, Set<string>>>({});
  const [custom, setCustom] = useState<Record<number, string>>({});
  const done = answers !== undefined;
  const toggle = (qi: number, label: string, multi: boolean) => {
    setPicked((prev) => {
      const next = new Set(multi ? prev[qi] ?? [] : []);
      if (next.has(label)) next.delete(label); else next.add(label);
      return { ...prev, [qi]: next };
    });
  };
  const compose = () => questions.map((q, i) => {
    const chosen = [...(picked[i] ?? [])];
    const extra = (custom[i] ?? '').trim();
    return [...chosen, ...(extra ? [extra] : [])].join(q.multiSelect ? '、' : '') || '(未回答)';
  });
  return (
    <div style={{ borderRadius: R.lg, background: CARD_BG, border: `1px solid ${CHIP_BORDER}`, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      {questions.map((q, qi) => (
        <div key={qi} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {q.header && <div style={{ fontSize: 10.5, fontWeight: 700, color: INK_FAINT, letterSpacing: 0.4 }}>{q.header}</div>}
          <div style={{ fontSize: 12.5, color: C.text, lineHeight: 1.5 }}>{q.question}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {q.options.map((o) => {
              const on = done ? (answers?.[qi] ?? '').includes(o.label) : picked[qi]?.has(o.label);
              return (
                <button key={o.label} disabled={done} title={o.description} onClick={() => toggle(qi, o.label, q.multiSelect)} style={chipButton({ primary: !!on })}>{o.label}</button>
              );
            })}
          </div>
          {!done && q.allowCustomInput && (
            <input value={custom[qi] ?? ''} onChange={(e) => setCustom((p) => ({ ...p, [qi]: e.target.value }))} placeholder="或者自己写"
              style={{ fontSize: 12, padding: '6px 10px', borderRadius: R.sm, border: `1px solid ${CHIP_BORDER}`, background: 'rgba(0,0,0,0.18)', color: C.text, outline: 'none' }} />
          )}
        </div>
      ))}
      {done ? (
        <div style={{ fontSize: 11, color: INK_FAINT }}>{answers === null ? '已取消' : '已回答'}</div>
      ) : (
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={() => onAnswer(compose())} style={chipButton({ primary: true })}>提交</button>
          <button onClick={() => onAnswer(null)} style={chipButton({})}>取消</button>
        </div>
      )}
    </div>
  );
}

const bareButton: React.CSSProperties = { background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', color: 'inherit', font: 'inherit' };

export function chipButton({ primary = false, align = 'center' }: { primary?: boolean; align?: 'left' | 'center' }): React.CSSProperties {
  return {
    padding: '7px 12px',
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 700,
    lineHeight: 1.2,
    textAlign: align,
    cursor: 'pointer',
    border: `1px solid ${primary ? 'transparent' : CHIP_BORDER}`,
    background: primary ? 'var(--nai-agent-primary-fill)' : CHIP_BG,
    color: primary ? 'var(--nai-agent-on-primary)' : C.text,
    boxShadow: CHIP_SHADOW,
  };
}

/** 滚到底(新内容进来时)。 */
export function useStickToBottom(ref: React.RefObject<HTMLDivElement | null>, deps: unknown[]) {
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => { stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, [ref]);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
