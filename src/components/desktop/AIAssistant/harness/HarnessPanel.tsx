import React, { useMemo, useRef, useState } from 'react';
import { History, Lock, MessageSquarePlus, Receipt, RotateCcw, SlidersHorizontal } from 'lucide-react';
import type { PermissionMode } from '../../../../services/agentHarness/types';
import { InputBar } from '../InputBar';
import { C } from '../tokens';
import { BillSheet } from './BillSheet';
import { HarnessThread, chipButton, useStickToBottom } from './HarnessThread';
import { PresetSheet } from './PresetSheet';
import { RewindSheet } from './RewindSheet';
import { Segmented } from './Segmented';
import { extractCheckpoints } from './transcript';
import { useAgentHarness } from './useAgentHarness';

/**
 * Harness 形态的助手面板。外框(标题、折叠、换位)由 dock 负责,这里只有:
 * 一行参数(模式分段控件 + 锁 + 回溯 / 预设 / 账单 / 新对话 / 旧版),对话流,输入区。
 * 参数行照 STYLE.md:label 固定宽、单选是分段控件、没有横线;面板窄时图标组换行到右侧。
 */

const MODES: readonly { id: PermissionMode; label: string; hint: string }[] = [
  { id: 'manual', label: '逐项确认', hint: '每次修改都先问' },
  { id: 'auto', label: '自动', hint: '写类自动应用可撤销,花钱与删除会问' },
  { id: 'yolo', label: '放行', hint: '硬上限内全部自动;仍然拦体力条耗尽与锁定字段' },
];

const LOCKABLE_FIELDS: { id: string; label: string }[] = [
  { id: 'model', label: '模型' }, { id: 'resolution', label: '分辨率' }, { id: 'width', label: '宽' }, { id: 'height', label: '高' },
  { id: 'steps', label: '步数' }, { id: 'scale', label: 'CFG' }, { id: 'sampler', label: '采样器' }, { id: 'seed', label: '种子' },
  { id: 'prompt', label: '提示词' }, { id: 'negative_prompt', label: '负向' }, { id: 'characters', label: '角色槽位' },
];

type Sheet = 'none' | 'rewind' | 'presets' | 'bill';

interface Props {
  onSwitchToLegacy: () => void;
}

export const HarnessPanel: React.FC<Props> = ({ onSwitchToLegacy }) => {
  const h = useAgentHarness();
  const [input, setInput] = useState('');
  const [image, setImage] = useState<string | null>(null);
  const [locksOpen, setLocksOpen] = useState(false);
  const [sheet, setSheet] = useState<Sheet>('none');
  const [inputBarOffset, setInputBarOffset] = useState(64);
  const checkpoints = useMemo(() => extractCheckpoints(h.items), [h.items]);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useStickToBottom(bodyRef, [h.items, h.busy]);

  const toggleSheet = (next: Sheet) => setSheet((cur) => (cur === next ? 'none' : next));
  const closeSheet = () => setSheet('none');

  const send = (text?: string) => {
    const value = (text ?? input).trim();
    if (!value && !image) return;
    h.send(value, image);
    setInput('');
    setImage(null);
    if (inputRef.current) inputRef.current.style.height = 'auto';
  };

  const rewindDisabled = h.busy || checkpoints.length === 0;
  const hasConversation = h.items.some((i) => i.kind === 'user');

  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden', color: C.text }}>
      {/* 参数行:模式 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, rowGap: 4, flexWrap: 'wrap', padding: '8px 12px 4px' }}>
        <span style={{ width: 48, fontSize: 11, color: 'var(--nai-agent-ink-muted)', lineHeight: '28px', flexShrink: 0 }}>模式</span>
        <Segmented value={h.mode} options={MODES} onChange={h.setMode} ariaLabel="工作台权限模式" />
        {h.mode === 'yolo' && <span style={{ fontSize: 10, fontWeight: 700, color: '#f5c451' }}>YOLO</span>}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          <button className="aa-btn" title={h.lockedFields.size ? `已锁定 ${h.lockedFields.size} 项` : '锁定字段'} onClick={() => setLocksOpen((v) => !v)} style={iconBtn(h.lockedFields.size > 0)}><Lock size={13} /></button>
          <button className="aa-btn" title="回溯到某一轮" disabled={rewindDisabled} onClick={() => toggleSheet('rewind')} style={{ ...iconBtn(sheet === 'rewind'), opacity: rewindDisabled ? 0.45 : 1 }}><History size={13} /></button>
          <button className="aa-btn" title={`预设与技能(当前:${h.activePresetName})`} disabled={h.busy} onClick={() => toggleSheet('presets')} style={{ ...iconBtn(sheet === 'presets'), opacity: h.busy ? 0.45 : 1 }}><SlidersHorizontal size={13} /></button>
          <button className="aa-btn" title="用量账单" onClick={() => toggleSheet('bill')} style={iconBtn(sheet === 'bill')}><Receipt size={13} /></button>
          <button className="aa-btn" title="新对话(当前对话存进会话历史)" disabled={h.busy || !hasConversation} onClick={() => { if (h.newSession()) closeSheet(); }} style={{ ...iconBtn(false), opacity: h.busy || !hasConversation ? 0.45 : 1 }}><MessageSquarePlus size={13} /></button>
          <button className="aa-btn" title="切回旧版规划式助手" onClick={onSwitchToLegacy} style={iconBtn(false)}><RotateCcw size={13} /></button>
        </div>
      </div>
      {locksOpen && (
        <div style={{ margin: '4px 12px 6px', padding: '8px 10px', borderRadius: 'var(--nai-agent-radius-md)', background: 'var(--nai-agent-card-bg)', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <div style={{ width: '100%', fontSize: 11, color: 'var(--nai-agent-ink-muted)' }}>锁定的字段在任何模式下都拒绝 AI 修改</div>
          {LOCKABLE_FIELDS.map((f) => (
            <button key={f.id} onClick={() => h.toggleLockedField(f.id)} style={chipButton({ primary: h.lockedFields.has(f.id) })}>{f.label}</button>
          ))}
        </div>
      )}
      {!h.available && (
        <div style={{ margin: '4px 12px 0', padding: '6px 10px', borderRadius: 'var(--nai-agent-radius-sm)', background: 'rgba(252,237,164,0.06)', fontSize: 11, color: 'var(--nai-agent-ink-muted)' }}>
          {h.unavailableReason ?? '正在读取 sidecar 设置…'}
        </div>
      )}
      {sheet === 'presets' ? (
        <PresetSheet library={h.presetLibrary} skills={h.skills} tools={h.toolCatalog} onChange={h.updatePresetLibrary} onBack={closeSheet} />
      ) : sheet === 'rewind' ? (
        <RewindSheet checkpoints={checkpoints} busy={h.busy} onBack={closeSheet} onConfirm={(id) => {
          const text = h.rewindTo(id);
          if (text === null) return;
          setInput(text);
          closeSheet();
          window.setTimeout(() => inputRef.current?.focus(), 0);
        }} />
      ) : sheet === 'bill' ? (
        <BillSheet sessionUsage={h.sessionUsage} onBack={closeSheet} />
      ) : (
        <HarnessThread ref={bodyRef} items={h.items} busy={h.busy} bottomInset={inputBarOffset} onAnswer={h.answerQuestion} onDecide={h.decidePermission} onSuggest={(t) => send(t)} />
      )}
      <input type="file" accept="image/png,image/jpeg,image/webp" ref={fileRef} style={{ display: 'none' }} onChange={(e) => {
        const file = e.target.files?.[0];
        if (file) { const reader = new FileReader(); reader.onload = (ev) => setImage((ev.target?.result as string) ?? null); reader.readAsDataURL(file); }
        if (fileRef.current) fileRef.current.value = '';
      }} />
      {sheet === 'none' && <InputBar
        value={input}
        onChange={setInput}
        onSend={() => send()}
        sending={h.busy}
        inputRef={inputRef}
        selectedImage={image}
        onPickImage={() => fileRef.current?.click()}
        onClearImage={() => setImage(null)}
        hasMessages={h.items.length > 0}
        onClearChat={h.clear}
        onHeightChange={setInputBarOffset}
      />}
    </div>
  );
};

function iconBtn(active: boolean): React.CSSProperties {
  return {
    width: 26, height: 26, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    borderRadius: 'var(--nai-agent-radius-xs)', border: '1px solid var(--nai-agent-chip-border)',
    background: active ? 'rgba(252,237,164,0.16)' : 'var(--nai-agent-chip-bg)', color: active ? C.accent : C.text2, cursor: 'pointer',
  };
}
