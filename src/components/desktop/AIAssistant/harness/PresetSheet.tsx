import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Copy, Download, Pencil, Plus, RotateCcw, SlidersHorizontal, Trash2, Upload } from 'lucide-react';
import { PARAM_KEYS } from '../../../../services/agentHarness/presets';
import {
  createPreset, duplicatePreset, inheritsFromParent, isBuiltinPreset, isSkillEnabled, normalizeSkillId, parseSkillMarkdown,
  removePreset, removeUserSkill, resetBuiltinPreset, setActivePreset, skillToMarkdown, toggleId, upsertPreset, upsertUserSkill,
  resolveActivePreset, type PresetLibrary,
} from '../../../../services/agentHarness/presetLibrary';
import type { Skill } from '../../../../services/agentHarness/skillCatalog';
import type { WorkbenchToolInfo } from '../../../../services/agentHarness/tools/index';
import { C } from '../tokens';
import { chipButton } from './HarnessThread';

/**
 * 预设与技能设置,照他的 presets_settings_tab:选预设 → 名称 / 系统提示词 / 技能 / 工具 / 可改参数,
 * 每一下都直接落盘。内置预设可改可 reset,不可删;用户技能是 SKILL.md 进出。
 */

interface Props {
  library: PresetLibrary;
  skills: readonly Skill[];
  tools: readonly WorkbenchToolInfo[];
  onChange: (next: PresetLibrary) => void;
  onBack: () => void;
}

const INK_MUTED = 'var(--nai-agent-ink-muted)';
const INK_FAINT = 'var(--nai-agent-ink-faint)';

const PARAM_LABEL: Record<(typeof PARAM_KEYS)[number], string> = {
  prompt: '提示词', negative_prompt: '负向', model: '模型', resolution: '分辨率预设', width: '宽', height: '高', steps: '步数',
  scale: 'CFG', cfg_rescale: 'Rescale', sampler: '采样器', noise_schedule: '噪声调度', quality_preset: '质量档', character_ai_position: '角色定位模式',
};
const CLASS_LABEL: Record<string, string> = { R: '读', W: '写', D: '删', P: '付费', A: '问' };

const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '6px 9px', fontSize: 12, lineHeight: 1.5, color: C.text,
  background: 'var(--nai-agent-chip-bg)', border: '1px solid var(--nai-agent-chip-border)', borderRadius: 'var(--nai-agent-radius-sm)', outline: 'none',
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
      <span style={{ width: 48, flexShrink: 0, fontSize: 11, color: INK_MUTED, lineHeight: '28px' }}>{label}</span>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', paddingTop: 2 }}>{children}</div>
    </div>
  );
}

export const PresetSheet: React.FC<Props> = ({ library, skills, tools, onChange, onBack }) => {
  const active = resolveActivePreset(library);
  const builtin = isBuiltinPreset(active.id);
  const [editingSkill, setEditingSkill] = useState<Skill | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); if (editingSkill) setEditingSkill(null); else onBack(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editingSkill, onBack]);

  const update = (patch: Partial<typeof active>) => onChange(upsertPreset(library, { ...active, ...patch }));

  const importSkill = async (file: File) => {
    const text = await file.text();
    const parsed = parseSkillMarkdown(text, file.name);
    onChange(upsertUserSkill(library, parsed));
  };

  const exportSkill = (skill: Skill) => {
    const blob = new Blob([skillToMarkdown(skill)], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${skill.id.replace(/\//g, '_')}.md`; a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const userSkillIds = new Set(library.userSkills.map((s) => s.id));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px 4px' }}>
        <button className="aa-btn" title="返回对话" onClick={onBack} style={iconBtn}><ArrowLeft size={13} /></button>
        <SlidersHorizontal size={13} color={C.accent} />
        <span style={{ fontSize: 12.5, fontWeight: 700, color: C.text }}>预设与技能</span>
        <span style={{ marginLeft: 'auto', fontSize: 10, color: INK_FAINT, padding: '2px 8px', borderRadius: 999, background: 'var(--nai-agent-chip-bg)', border: '1px solid var(--nai-agent-chip-border)' }}>改动即时保存</span>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '4px 12px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {editingSkill ? (
          <SkillEditor
            skill={editingSkill}
            existing={userSkillIds.has(editingSkill.id)}
            onCancel={() => setEditingSkill(null)}
            onSave={(skill) => { onChange(upsertUserSkill(library, skill)); setEditingSkill(null); }}
          />
        ) : (
          <>
            <Row label="预设">
              {library.presets.map((p) => (
                <button key={p.id} onClick={() => onChange(setActivePreset(library, p.id))} style={chipButton({ primary: p.id === active.id })} title={p.id}>{p.name}</button>
              ))}
              <button title="新建预设" onClick={() => onChange(createPreset(library))} style={miniBtn}><Plus size={12} /></button>
              <button title="复制当前预设" onClick={() => onChange(duplicatePreset(library, active.id))} style={miniBtn}><Copy size={12} /></button>
              {builtin
                ? <button title="恢复出厂内容" onClick={() => onChange(resetBuiltinPreset(library, active.id))} style={miniBtn}><RotateCcw size={12} /></button>
                : <button title="删除当前预设" onClick={() => onChange(removePreset(library, active.id))} style={miniBtn}><Trash2 size={12} /></button>}
            </Row>
            <Row label="名称">
              <input value={active.name} onChange={(e) => update({ name: e.target.value })} style={inputStyle} />
            </Row>
            <Row label="系统提示词">
              <textarea value={active.systemPrompt} onChange={(e) => update({ systemPrompt: e.target.value })} rows={8} spellCheck={false}
                style={{ ...inputStyle, resize: 'vertical', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11.5 }} />
              <div style={{ width: '100%', fontSize: 10.5, color: INK_FAINT }}>技能目录会自动附在后面;留空则只有技能目录与工具说明。</div>
            </Row>
            <Row label="技能">
              {skills.map((s) => {
                const on = isSkillEnabled(s.id, active.enabledSkillIds);
                const inherited = inheritsFromParent(s.id, active.enabledSkillIds);
                const mine = userSkillIds.has(s.id);
                return (
                  <span key={s.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                    <button title={inherited ? `${s.description}\n(随父技能启用)` : s.description} disabled={inherited}
                      onClick={() => update({ enabledSkillIds: toggleId(active.enabledSkillIds, s.id, !on) })}
                      style={{ ...chipButton({ primary: on }), opacity: inherited ? 0.6 : 1 }}>{s.name}</button>
                    {mine && <button title="编辑" onClick={() => setEditingSkill(s)} style={miniBtn}><Pencil size={11} /></button>}
                    {mine && <button title="导出 SKILL.md" onClick={() => exportSkill(s)} style={miniBtn}><Download size={11} /></button>}
                    {mine && <button title="删除技能" onClick={() => onChange(removeUserSkill(library, s.id))} style={miniBtn}><Trash2 size={11} /></button>}
                  </span>
                );
              })}
              <button title="新建技能" onClick={() => setEditingSkill({ id: '', name: '', description: '', systemPrompt: '' })} style={miniBtn}><Plus size={12} /></button>
              <button title="导入 SKILL.md" onClick={() => fileRef.current?.click()} style={miniBtn}><Upload size={12} /></button>
              <input ref={fileRef} type="file" accept=".md,text/markdown" style={{ display: 'none' }} onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void importSkill(file);
                if (fileRef.current) fileRef.current.value = '';
              }} />
            </Row>
            <Row label="工具">
              {tools.map((t) => {
                const on = active.enabledToolNames.includes(t.name);
                return (
                  <button key={t.name} title={`${t.name}(${CLASS_LABEL[t.permissionClass] ?? t.permissionClass})\n${t.description}`}
                    onClick={() => update({ enabledToolNames: toggleId(active.enabledToolNames, t.name, !on) })}
                    style={chipButton({ primary: on })}>{t.label}</button>
                );
              })}
            </Row>
            <Row label="可改参数">
              {PARAM_KEYS.map((k) => {
                const on = active.allowedModifiableParams.includes(k);
                return (
                  <button key={k} title={k} onClick={() => update({ allowedModifiableParams: toggleId(active.allowedModifiableParams, k, !on) })}
                    style={chipButton({ primary: on })}>{PARAM_LABEL[k]}</button>
                );
              })}
              <div style={{ width: '100%', fontSize: 10.5, color: INK_FAINT }}>没勾的字段,助手改了也不会生效;和「锁定字段」不同,这是按预设固定的。</div>
            </Row>
          </>
        )}
      </div>
    </div>
  );
};

function SkillEditor({ skill, existing, onCancel, onSave }: { skill: Skill; existing: boolean; onCancel: () => void; onSave: (skill: Skill) => void }) {
  const [draft, setDraft] = useState<Skill>(skill);
  const id = existing ? draft.id : normalizeSkillId(draft.id || draft.name);
  const valid = draft.name.trim().length > 0 && draft.systemPrompt.trim().length > 0;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: C.text }}>{existing ? '编辑技能' : '新建技能'}</div>
      <Row label="名称"><input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} style={inputStyle} placeholder="模型看到的技能名" /></Row>
      <Row label="标识"><input value={existing ? draft.id : draft.id} disabled={existing} onChange={(e) => setDraft({ ...draft, id: e.target.value })} style={{ ...inputStyle, opacity: existing ? 0.6 : 1 }} placeholder={id || '留空按名称生成'} /></Row>
      <Row label="描述"><input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} style={inputStyle} placeholder="一句话说明什么时候该加载它(进系统提示词目录)" /></Row>
      <Row label="正文">
        <textarea value={draft.systemPrompt} onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })} rows={12} spellCheck={false}
          style={{ ...inputStyle, resize: 'vertical', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11.5 }} placeholder="Markdown 正文;load_skill 时整段给模型" />
      </Row>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
        <button onClick={onCancel} style={chipButton({})}>取消</button>
        <button disabled={!valid} onClick={() => onSave({ ...draft, id, name: draft.name.trim(), description: draft.description.trim() })}
          style={{ ...chipButton({ primary: true }), opacity: valid ? 1 : 0.5 }}>保存</button>
      </div>
    </div>
  );
}

const iconBtn: React.CSSProperties = {
  width: 26, height: 26, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  borderRadius: 'var(--nai-agent-radius-xs)', border: '1px solid var(--nai-agent-chip-border)',
  background: 'var(--nai-agent-chip-bg)', color: C.text2, cursor: 'pointer',
};
const miniBtn: React.CSSProperties = { ...iconBtn, width: 22, height: 22 };
