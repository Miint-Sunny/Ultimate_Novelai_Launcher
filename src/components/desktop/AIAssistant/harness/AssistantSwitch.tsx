import React, { useState } from 'react';
import { AgentPanel } from '../AgentPanel';
import { HarnessPanel } from './HarnessPanel';

const UI_KEY = 'desktop_agent_ui';

/**
 * 助手面板的形态开关:默认是 harness(单循环、直接改工作台),旧的两阶段 planner
 * 留一个入口切回去——固定指令(kkt / 生成图片 / 生成视频)还在那边。
 */
export const AssistantSwitch: React.FC = () => {
  const [ui, setUi] = useState<'harness' | 'legacy'>(() => {
    try { return localStorage.getItem(UI_KEY) === 'legacy' ? 'legacy' : 'harness'; } catch { return 'harness'; }
  });
  const switchTo = (next: 'harness' | 'legacy') => {
    setUi(next);
    try { localStorage.setItem(UI_KEY, next); } catch { /* ignore */ }
  };
  if (ui === 'legacy') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        <button onClick={() => switchTo('harness')} style={{ alignSelf: 'flex-end', margin: '6px 10px 0', fontSize: 11, padding: '3px 10px', borderRadius: 999, border: '1px solid var(--nai-agent-chip-border)', background: 'var(--nai-agent-chip-bg)', color: 'inherit', cursor: 'pointer' }}>
          切到新版助手
        </button>
        <AgentPanel />
      </div>
    );
  }
  return <HarnessPanel onSwitchToLegacy={() => switchTo('legacy')} />;
};
