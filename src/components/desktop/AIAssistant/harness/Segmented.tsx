import React from 'react';
import { C } from '../tokens';

/** STYLE.md 的分段控件:胶囊底、选中项实心。面板的模式行与账单页的周期行共用。 */
export function Segmented<T extends string>({ value, options, onChange, ariaLabel }: {
  value: T;
  options: readonly { id: T; label: string; hint?: string }[];
  onChange: (next: T) => void;
  ariaLabel?: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} style={{ display: 'flex', padding: 3, borderRadius: 999, background: 'var(--nai-agent-chip-bg)', border: '1px solid var(--nai-agent-chip-border)', gap: 2 }}>
      {options.map((o) => {
        const on = value === o.id;
        return (
          <button key={o.id} role="radio" aria-checked={on} title={o.hint} onClick={() => onChange(o.id)}
            style={{ padding: '4px 10px', borderRadius: 999, fontSize: 11.5, fontWeight: 700, border: 'none', cursor: 'pointer', whiteSpace: 'nowrap',
              background: on ? 'var(--nai-agent-primary-fill)' : 'transparent', color: on ? 'var(--nai-agent-on-primary)' : C.text }}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
