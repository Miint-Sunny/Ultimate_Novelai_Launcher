import React, { useEffect, useState } from 'react';
import { ArrowLeft, History } from 'lucide-react';
import { C } from '../tokens';
import { chipButton } from './HarnessThread';
import type { TranscriptCheckpoint } from './transcript';

/**
 * 回溯视图,照他的 AgentRewindView:轮次列表(编号、时间、用户消息、回复摘要、工具胶囊),
 * 单击选中、双击确认、ESC 退出。选中一轮后对话回到这条消息发出之前,工作台参数与角色槽位
 * 一并还原,这条消息放回输入框让用户改了再发。
 */

interface Props {
  checkpoints: TranscriptCheckpoint[];
  busy: boolean;
  onBack: () => void;
  onConfirm: (userItemId: string) => void;
}

const INK_MUTED = 'var(--nai-agent-ink-muted)';
const INK_FAINT = 'var(--nai-agent-ink-faint)';

export const RewindSheet: React.FC<Props> = ({ checkpoints, busy, onBack, onConfirm }) => {
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onBack(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack]);

  const confirm = (id: string | null) => { if (id && !busy) onConfirm(id); };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px 4px' }}>
        <button className="aa-btn" title="返回对话" onClick={onBack} style={{ ...iconBtn, }}><ArrowLeft size={13} /></button>
        <History size={13} color={C.accent} />
        <span style={{ fontSize: 12.5, fontWeight: 700, color: C.text }}>回溯到某一轮</span>
        <span style={{ marginLeft: 'auto', fontSize: 10, color: INK_FAINT, padding: '2px 8px', borderRadius: 999, background: 'var(--nai-agent-chip-bg)', border: '1px solid var(--nai-agent-chip-border)' }}>ESC 退出</span>
      </div>
      <div style={{ margin: '4px 12px 6px', padding: '7px 10px', borderRadius: 'var(--nai-agent-radius-md)', background: 'var(--nai-agent-card-bg)', fontSize: 11, lineHeight: 1.4, color: INK_MUTED }}>
        选中一轮后,对话回到这条消息发出之前;工作台参数与角色槽位一并还原,这条消息会放回输入框。
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '2px 12px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {checkpoints.length === 0 && (
          <div style={{ padding: '28px 0', textAlign: 'center', fontSize: 12, color: INK_MUTED }}>还没有可回溯的轮次</div>
        )}
        {checkpoints.map((cp) => {
          const on = selected === cp.userItemId;
          const last = cp.index === checkpoints.length;
          return (
            <div key={cp.userItemId} role="option" aria-selected={on}
              onClick={() => setSelected(cp.userItemId)} onDoubleClick={() => { setSelected(cp.userItemId); confirm(cp.userItemId); }}
              style={{ padding: 10, borderRadius: 'var(--nai-agent-radius-lg)', cursor: 'pointer',
                background: on ? 'rgba(252,237,164,0.10)' : 'var(--nai-agent-card-bg)',
                border: `1px solid ${on ? C.accent : 'var(--nai-agent-chip-border)'}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 10.5, fontWeight: 700, padding: '1px 7px', borderRadius: 999, background: on ? 'var(--nai-agent-primary-fill)' : 'var(--nai-agent-chip-bg)', color: on ? 'var(--nai-agent-on-primary)' : C.text }}>#{cp.index}</span>
                {last && <span style={{ fontSize: 10.5, fontWeight: 600, color: '#8fd19e' }}>最新</span>}
                {!cp.restoresWorkbench && <span style={{ fontSize: 10.5, color: INK_FAINT }}>只回对话,不还原参数</span>}
                <span style={{ marginLeft: 'auto', fontSize: 10.5, color: INK_FAINT }}>{formatTime(cp.at)}</span>
              </div>
              <div style={{ marginTop: 6, fontSize: 12, fontWeight: 600, color: C.text, lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                {cp.text || '(仅图片)'}
              </div>
              {cp.assistantSummary && (
                <div style={{ marginTop: 3, fontSize: 11, color: INK_MUTED, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{cp.assistantSummary}</div>
              )}
              {cp.toolNames.length > 0 && (
                <div style={{ marginTop: 5, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {cp.toolNames.map((name, i) => (
                    <span key={`${name}_${i}`} style={{ fontSize: 10, padding: '1px 6px', borderRadius: 999, background: 'var(--nai-agent-chip-bg)', border: '1px solid var(--nai-agent-chip-border)', color: INK_MUTED }}>{name}</span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, padding: '6px 12px 10px' }}>
        <button onClick={onBack} style={chipButton({})}>取消</button>
        <button disabled={!selected || busy} onClick={() => confirm(selected)} style={{ ...chipButton({ primary: true }), opacity: !selected || busy ? 0.5 : 1, cursor: !selected || busy ? 'default' : 'pointer' }}>回到这里</button>
      </div>
    </div>
  );
};

const iconBtn: React.CSSProperties = {
  width: 26, height: 26, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  borderRadius: 'var(--nai-agent-radius-xs)', border: '1px solid var(--nai-agent-chip-border)',
  background: 'var(--nai-agent-chip-bg)', color: C.text2, cursor: 'pointer',
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}
