import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Receipt } from 'lucide-react';
import { aggregateLedger, cacheHitRate, formatTokens, type BillPeriod } from '../../../../services/agentHarness/usageLedger';
import { usageTotal, type TokenUsage } from '../../../../services/agentHarness/types';
import { C, MONO } from '../tokens';
import { Segmented } from './Segmented';
import type { SessionModelUsage } from './sessionArchive';
import { useUsageLedger } from './usageLedgerStore';

/**
 * 用量账单,照他的 bill_settings_tab:周期胶囊(今天 / 近 7 天 / 近 30 天 / 全部)→ 各模型一行
 * (请求数、输入、输出、缓存读、命中率、合计)→ 合计行。多一栏「本会话」,是他挂在模型选择器
 * 悬停提示里的那份。账本只读,按响应记,回溯与清空对话都不会抹掉已经花掉的 token。
 */

interface Props {
  sessionUsage: SessionModelUsage[];
  onBack: () => void;
}

const INK_MUTED = 'var(--nai-agent-ink-muted)';
const INK_FAINT = 'var(--nai-agent-ink-faint)';

const PERIODS: readonly { id: BillPeriod; label: string }[] = [
  { id: 'today', label: '今天' }, { id: 'last7d', label: '近 7 天' }, { id: 'last30d', label: '近 30 天' }, { id: 'all', label: '全部' },
];

const COLUMNS = 'minmax(0, 2.4fr) repeat(6, minmax(0, 1fr))';
const HEAD = ['模型', '次', '输入', '输出', '缓存', '命中', '合计'];

const hitRate = (u: TokenUsage) => { const r = cacheHitRate(u); return r === null ? '-' : `${(r * 100).toFixed(1)}%`; };

export const BillSheet: React.FC<Props> = ({ sessionUsage, onBack }) => {
  const [period, setPeriod] = useState<BillPeriod>('today');
  const ledger = useUsageLedger();
  const summary = useMemo(() => aggregateLedger(ledger, period), [ledger, period]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onBack(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px 4px' }}>
        <button className="aa-btn" title="返回对话" onClick={onBack} style={iconBtn}><ArrowLeft size={13} /></button>
        <Receipt size={13} color={C.accent} />
        <span style={{ fontSize: 12.5, fontWeight: 700, color: C.text }}>用量账单</span>
        <span style={{ marginLeft: 'auto', fontSize: 10, color: INK_FAINT, padding: '2px 8px', borderRadius: 999, background: 'var(--nai-agent-chip-bg)', border: '1px solid var(--nai-agent-chip-border)' }}>ESC 退出</span>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 12px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', rowGap: 4 }}>
          <span style={{ width: 48, fontSize: 11, color: INK_MUTED, lineHeight: '28px', flexShrink: 0 }}>周期</span>
          <Segmented value={period} options={PERIODS} onChange={setPeriod} ariaLabel="账单周期" />
          <span style={{ marginLeft: 'auto', fontSize: 11, color: INK_MUTED, whiteSpace: 'nowrap' }}>
            {summary.requests} 次请求 · {formatTokens(usageTotal(summary.usage))} tokens
          </span>
        </div>

        {summary.models.length === 0 ? (
          <div style={{ padding: '28px 0', textAlign: 'center', fontSize: 12, color: INK_MUTED }}>这个周期还没有用量记录</div>
        ) : (
          <div style={{ borderRadius: 'var(--nai-agent-radius-md)', border: '1px solid var(--nai-agent-chip-border)', overflow: 'hidden' }}>
            <div style={{ ...row, background: 'var(--nai-agent-chip-bg)' }}>
              {HEAD.map((h, i) => <span key={h} style={{ ...cell, fontSize: 10.5, fontWeight: 700, color: INK_MUTED, textAlign: i === 0 ? 'left' : 'right' }}>{h}</span>)}
            </div>
            {summary.models.map((m) => {
              const slash = m.name.indexOf('/');
              const provider = slash > 0 ? m.name.slice(0, slash) : '';
              const model = slash > 0 ? m.name.slice(slash + 1) : m.name;
              return (
                <div key={m.name} style={row} title={m.name}>
                  <span style={{ ...cell, textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 1 }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: C.text, fontWeight: 600 }}>{model}</span>
                    {provider && <span style={{ fontSize: 10, color: INK_FAINT, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{provider}</span>}
                  </span>
                  <Num>{m.requests}</Num>
                  <Num>{formatTokens(m.usage.input)}</Num>
                  <Num>{formatTokens(m.usage.output)}</Num>
                  <Num>{formatTokens(m.usage.cacheRead)}</Num>
                  <Num>{hitRate(m.usage)}</Num>
                  <Num>{formatTokens(usageTotal(m.usage))}</Num>
                </div>
              );
            })}
            <div style={{ ...row, background: 'var(--nai-agent-chip-bg)', borderTop: '1px solid var(--nai-agent-chip-border)' }}>
              <span style={{ ...cell, textAlign: 'left', fontWeight: 700, color: C.text }}>合计</span>
              <Num bold>{summary.requests}</Num>
              <Num bold>{formatTokens(summary.usage.input)}</Num>
              <Num bold>{formatTokens(summary.usage.output)}</Num>
              <Num bold>{formatTokens(summary.usage.cacheRead)}</Num>
              <Num bold>{hitRate(summary.usage)}</Num>
              <Num bold>{formatTokens(usageTotal(summary.usage))}</Num>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: INK_MUTED }}>本会话</div>
          {sessionUsage.length === 0 ? (
            <div style={{ fontSize: 11.5, color: INK_FAINT }}>这个对话还没有用量</div>
          ) : sessionUsage.map((s) => (
            <div key={s.model} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 11.5, color: C.text, padding: '6px 10px', borderRadius: 'var(--nai-agent-radius-sm)', background: 'var(--nai-agent-card-bg)' }}>
              <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{s.model}</span>
              <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 11, color: INK_MUTED, whiteSpace: 'nowrap' }}>
                {s.requests} 次 · ↑{formatTokens(s.usage.input)} ↓{formatTokens(s.usage.output)}{s.usage.cacheRead > 0 ? ` · 缓存 ${formatTokens(s.usage.cacheRead)}(${hitRate(s.usage)})` : ''} · 合计 {formatTokens(usageTotal(s.usage))}
              </span>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 10.5, lineHeight: 1.5, color: INK_FAINT }}>
          按模型的每次响应记账,只存在这台机器上;回溯或清空对话不会抹掉已经花掉的 token。缓存列是命中提示缓存的输入,命中率 = 缓存 / 输入。
        </div>
      </div>
    </div>
  );
};

const row: React.CSSProperties = { display: 'grid', gridTemplateColumns: COLUMNS, alignItems: 'center', padding: '0 4px' };
const cell: React.CSSProperties = { padding: '6px 4px', fontSize: 11.5, minWidth: 0 };

function Num({ children, bold = false }: { children: React.ReactNode; bold?: boolean }) {
  return <span style={{ ...cell, fontFamily: MONO, fontSize: 11, textAlign: 'right', color: C.text, fontWeight: bold ? 700 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{children}</span>;
}

const iconBtn: React.CSSProperties = {
  width: 26, height: 26, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  borderRadius: 'var(--nai-agent-radius-xs)', border: '1px solid var(--nai-agent-chip-border)',
  background: 'var(--nai-agent-chip-bg)', color: C.text2, cursor: 'pointer',
};
