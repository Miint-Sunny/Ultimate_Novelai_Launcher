import React from 'react';
import { AgentPanel } from '../AgentPanel';
import { setAssistantUi, useAssistantUi } from './assistantUi';
import { HarnessPanel } from './HarnessPanel';

/**
 * 助手面板的形态开关:默认是 harness(单循环、直接改工作台),旧的两阶段 planner
 * 留一个入口切回去——固定指令(kkt / 生成图片 / 生成视频)还在那边。
 * 形态存在 assistantUi 这个小 store 里,会话历史面板打开某条会话时也会切它。
 */
export const AssistantSwitch: React.FC = () => {
  const ui = useAssistantUi();
  if (ui === 'legacy') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        <button onClick={() => setAssistantUi('harness')} style={{ alignSelf: 'flex-end', margin: '6px 10px 0', fontSize: 11, padding: '3px 10px', borderRadius: 999, border: '1px solid var(--nai-agent-chip-border)', background: 'var(--nai-agent-chip-bg)', color: 'inherit', cursor: 'pointer' }}>
          切到新版助手
        </button>
        <AgentPanel />
      </div>
    );
  }
  return <HarnessPanel onSwitchToLegacy={() => setAssistantUi('legacy')} />;
};
