import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Copy, Download, FileDown, FileUp, FolderUp, Pencil, Plus, RotateCcw, SlidersHorizontal, Trash2, Upload } from 'lucide-react';
import { decodePresets, encodePreset, PresetImportError } from '../../../../services/agentHarness/presetTransfer';
import { PARAM_KEYS } from '../../../../services/agentHarness/presets';
import {
  createPreset, duplicatePreset, inheritsFromParent, isBuiltinPreset, isSkillEnabled, normalizeSkillId,
  removePreset, removeUserSkill, resetBuiltinPreset, setActivePreset, skillToMarkdown, toggleId, upsertPreset, upsertUserSkill,
  resolveActivePreset, type PresetLibrary,
} from '../../../../services/agentHarness/presetLibrary';
import type { Skill } from '../../../../services/agentHarness/skillCatalog';
import {
  decodeSkillDirectory, decodeSkillImport, encodeSkillPackage, prepareInstall, SKILL_ENTRY, SKILL_ID_PATTERN, SkillFormatError, type SkillPackage,
} from '../../../../services/agentHarness/skillPackage';
import type { WorkbenchToolInfo } from '../../../../services/agentHarness/tools/index';
import { C } from '../tokens';
import { chipButton } from './HarnessThread';
import { deleteSkillPackage, installSkillPackage, readSkillPackageFile } from './skillPackageStore';

/**
 * 预设与技能设置,照他的 presets_settings_tab:选预设 → 名称 / 系统提示词 / 技能 / 工具 / 可改参数,
 * 每一下都直接落盘。内置预设可改可 reset,不可删;用户技能是 SKILL.md 进出,
 * 标准技能包(文件夹 / .zip / .skill)导入后先预览编辑,确认才把资源写进托管存储。
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
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

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

type Note = { level: 'info' | 'error'; text: string } | null;

/** 编辑器的三种来路:新建 / 改已有 / 导入预览(确认才安装)。 */
interface EditorState {
  skill: Skill;
  mode: 'new' | 'edit' | 'install';
  pkg?: SkillPackage;
}

const describeError = (error: unknown): string => (error instanceof SkillFormatError || error instanceof PresetImportError ? error.message : `${error instanceof Error ? error.message : String(error)}`);

function download(bytes: BlobPart, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const PresetSheet: React.FC<Props> = ({ library, skills, tools, onChange, onBack }) => {
  const active = resolveActivePreset(library);
  const builtin = isBuiltinPreset(active.id);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const folderRef = useRef<HTMLInputElement | null>(null);
  const presetFileRef = useRef<HTMLInputElement | null>(null);
  const [transferNote, setTransferNote] = useState<Note>(null);
  const [skillNote, setSkillNote] = useState<Note>(null);

  // 预设 JSON 进出(他 fork 的 pr-preset-transfer):导入的是可编辑草稿,权限字段缺了就拒收,不退回全开。
  const importPresets = async (file: File) => {
    try {
      const imported = decodePresets(await file.text(), { existingIds: library.presets.map((p) => p.id), availableToolNames: tools.map((t) => t.name) });
      let next = library;
      for (const preset of imported) next = upsertPreset(next, preset);
      onChange(setActivePreset(next, imported[0].id));
      setTransferNote({ level: 'info', text: `已导入 ${imported.length} 个预设,当前切到「${imported[0].name}」;工具与参数权限按文件里写的来。` });
    } catch (error) {
      setTransferNote({ level: 'error', text: `导入失败:${describeError(error)}` });
    }
  };
  const exportPreset = () => download(encodePreset(active), `agent-preset-${active.id}.json`, 'application/json');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); if (editor) setEditor(null); else onBack(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editor, onBack]);

  const update = (patch: Partial<typeof active>) => onChange(upsertPreset(library, { ...active, ...patch }));

  // ---- 技能包:文件 / 文件夹 → 预览编辑 → 安装 ----
  const openPackage = (pkg: SkillPackage) => {
    setSkillNote(null);
    setEditor({ skill: pkg.skill, mode: 'install', pkg });
  };
  const importSkillFile = async (file: File) => {
    try {
      openPackage(await decodeSkillImport(new Uint8Array(await file.arrayBuffer()), file.name));
    } catch (error) {
      setSkillNote({ level: 'error', text: `导入失败:${describeError(error)}` });
    }
  };
  const importSkillFolder = async (list: FileList) => {
    try {
      const entries = Array.from(list).map((f) => ({
        path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name,
        size: f.size,
        read: async () => new Uint8Array(await f.arrayBuffer()),
      }));
      openPackage(await decodeSkillDirectory(entries));
    } catch (error) {
      setSkillNote({ level: 'error', text: `导入失败:${describeError(error)}` });
    }
  };

  /** 标识撞了(不分大小写,内置也算)就拒绝;改已有技能时自己不算。 */
  const conflict = (id: string, originalId: string | null): boolean =>
    skills.some((s) => s.id.toLowerCase() === id.toLowerCase() && s.id !== originalId);

  const saveSkill = async (draft: Skill) => {
    if (!editor) return;
    const originalId = editor.mode === 'edit' ? editor.skill.id : null;
    if (conflict(draft.id, originalId)) { setSkillNote({ level: 'error', text: `技能标识「${draft.id}」已存在,改个标识再保存。` }); return; }
    setBusy(true);
    try {
      const pkg = editor.pkg;
      // 只有 SKILL.md 的单文件导入走旧路(不要求标准 id,也不占托管存储);带资源的才安装成包。
      if (pkg && (pkg.files.size > 1 || (pkg.skill.resourcePaths?.length ?? 0) > 0)) {
        const prepared = prepareInstall(pkg, draft);
        const packageId = await installSkillPackage(prepared.files);
        onChange(upsertUserSkill(library, { ...prepared.skill, packageId }));
        setSkillNote({ level: 'info', text: `已安装技能包「${prepared.skill.name}」,${prepared.skill.resourcePaths?.length ?? 0} 个配套资源可用 load_skill 按需读取;在预设里勾上它才会进目录。` });
      } else {
        const skill: Skill = { ...draft, id: editor.mode === 'edit' ? draft.id : normalizeSkillId(draft.id || draft.name) };
        if (editor.mode !== 'edit' && conflict(skill.id, null)) { setSkillNote({ level: 'error', text: `技能标识「${skill.id}」已存在,改个标识再保存。` }); return; }
        onChange(upsertUserSkill(library, skill));
        if (editor.mode === 'install') setSkillNote({ level: 'info', text: `已导入技能「${skill.name}」;在预设里勾上它才会进目录。` });
      }
      setEditor(null);
    } catch (error) {
      setSkillNote({ level: 'error', text: `保存失败:${describeError(error)}` });
    } finally {
      setBusy(false);
    }
  };

  const exportSkill = async (skill: Skill) => {
    if (!skill.packageId) { download(skillToMarkdown(skill), `${skill.id.replace(/\//g, '_')}.md`, 'text/markdown'); return; }
    setBusy(true);
    try {
      const bytes = await encodeSkillPackage(skill, (path) => readSkillPackageFile(skill.packageId!, path));
      download(bytes as BlobPart, `${SKILL_ID_PATTERN.test(skill.id) ? skill.id : 'skill'}.skill`, 'application/zip');
    } catch (error) {
      setSkillNote({ level: 'error', text: `导出失败:${describeError(error)}` });
    } finally {
      setBusy(false);
    }
  };

  /** 先从库里摘掉(预设名单一起清),再删托管副本;别的技能还引用同一个包就留着。 */
  const deleteSkill = (skill: Skill) => {
    const next = removeUserSkill(library, skill.id);
    onChange(next);
    if (skill.packageId && !next.userSkills.some((s) => s.packageId === skill.packageId)) {
      void deleteSkillPackage(skill.packageId).catch(() => { /* 清不掉最多留一份没人引用的托管资源 */ });
    }
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
        {editor ? (
          <SkillEditor
            state={editor}
            busy={busy}
            note={skillNote}
            onCancel={() => { setEditor(null); setSkillNote(null); }}
            onSave={(skill) => { void saveSkill(skill); }}
          />
        ) : (
          <>
            <Row label="预设">
              {library.presets.map((p) => (
                <button key={p.id} onClick={() => onChange(setActivePreset(library, p.id))} style={chipButton({ primary: p.id === active.id })} title={p.id}>{p.name}</button>
              ))}
              <button title="新建预设" onClick={() => onChange(createPreset(library))} style={miniBtn}><Plus size={12} /></button>
              <button title="复制当前预设" onClick={() => onChange(duplicatePreset(library, active.id))} style={miniBtn}><Copy size={12} /></button>
              <button title="导出当前预设为 JSON(可导入他的 Novelai-harness)" onClick={exportPreset} style={miniBtn}><FileDown size={12} /></button>
              <button title="导入预设 JSON(单个或数组;权限字段必须写全)" onClick={() => presetFileRef.current?.click()} style={miniBtn}><FileUp size={12} /></button>
              <input ref={presetFileRef} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void importPresets(file);
                if (presetFileRef.current) presetFileRef.current.value = '';
              }} />
              {builtin
                ? <button title="恢复出厂内容" onClick={() => onChange(resetBuiltinPreset(library, active.id))} style={miniBtn}><RotateCcw size={12} /></button>
                : <button title="删除当前预设" onClick={() => onChange(removePreset(library, active.id))} style={miniBtn}><Trash2 size={12} /></button>}
            </Row>
            {transferNote && (
              <div style={{ fontSize: 11, lineHeight: 1.5, color: transferNote.level === 'error' ? C.err : INK_MUTED, padding: '4px 0 0 56px' }}>{transferNote.text}</div>
            )}
            <Row label="名称">
              <input value={active.name} onChange={(e) => update({ name: e.target.value })} style={inputStyle} />
            </Row>
            <Row label="系统提示词">
              <textarea value={active.systemPrompt} onChange={(e) => update({ systemPrompt: e.target.value })} rows={8} spellCheck={false}
                style={{ ...inputStyle, resize: 'vertical', fontFamily: MONO, fontSize: 11.5 }} />
              <div style={{ width: '100%', fontSize: 10.5, color: INK_FAINT }}>技能目录会自动附在后面;留空则只有技能目录与工具说明。</div>
            </Row>
            <Row label="技能">
              {skills.map((s) => {
                const on = isSkillEnabled(s.id, active.enabledSkillIds);
                const inherited = inheritsFromParent(s.id, active.enabledSkillIds);
                const mine = userSkillIds.has(s.id);
                const resources = s.resourcePaths?.length ?? 0;
                return (
                  <span key={s.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                    <button title={`${s.description}${resources ? `\n技能包:${resources} 个配套资源` : ''}${inherited ? '\n(随父技能启用)' : ''}`} disabled={inherited}
                      onClick={() => update({ enabledSkillIds: toggleId(active.enabledSkillIds, s.id, !on) })}
                      style={{ ...chipButton({ primary: on }), opacity: inherited ? 0.6 : 1 }}>{s.name}{resources ? <span style={{ marginLeft: 4, fontSize: 10, opacity: 0.7 }}>📦</span> : null}</button>
                    {mine && <button title="编辑" disabled={busy} onClick={() => { setSkillNote(null); setEditor({ skill: s, mode: 'edit' }); }} style={miniBtn}><Pencil size={11} /></button>}
                    {mine && <button title={s.packageId ? '导出技能包(.skill,含配套资源)' : '导出 SKILL.md'} disabled={busy} onClick={() => { void exportSkill(s); }} style={miniBtn}><Download size={11} /></button>}
                    {mine && <button title="删除技能(只清托管副本,不动你的源文件)" disabled={busy} onClick={() => deleteSkill(s)} style={miniBtn}><Trash2 size={11} /></button>}
                  </span>
                );
              })}
              <button title="新建技能" onClick={() => { setSkillNote(null); setEditor({ skill: { id: '', name: '', description: '', systemPrompt: '' }, mode: 'new' }); }} style={miniBtn}><Plus size={12} /></button>
              <button title="导入技能:SKILL.md,或 .zip / .skill 技能包" onClick={() => fileRef.current?.click()} style={miniBtn}><Upload size={12} /></button>
              <button title="导入技能文件夹(含 SKILL.md 与配套资源)" onClick={() => folderRef.current?.click()} style={miniBtn}><FolderUp size={12} /></button>
              <input ref={fileRef} type="file" accept=".md,.zip,.skill,text/markdown,application/zip" style={{ display: 'none' }} onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void importSkillFile(file);
                if (fileRef.current) fileRef.current.value = '';
              }} />
              <input ref={folderRef} type="file" {...{ webkitdirectory: '' }} multiple style={{ display: 'none' }} onChange={(e) => {
                if (e.target.files?.length) void importSkillFolder(e.target.files);
                if (folderRef.current) folderRef.current.value = '';
              }} />
              {skillNote && <div style={{ width: '100%', fontSize: 10.5, lineHeight: 1.5, color: skillNote.level === 'error' ? C.err : INK_MUTED }}>{skillNote.text}</div>}
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

const MAX_LISTED_RESOURCES = 24;

function SkillEditor({ state, busy, note, onCancel, onSave }: { state: EditorState; busy: boolean; note: Note; onCancel: () => void; onSave: (skill: Skill) => void }) {
  const [draft, setDraft] = useState<Skill>(state.skill);
  const existing = state.mode === 'edit';
  const resources = state.pkg ? [...state.pkg.files.keys()].filter((p) => p !== SKILL_ENTRY).sort() : (draft.resourcePaths ?? []);
  // 带资源的包必须是标准标识;单文件与手写技能沿用宽松规则(空格 → 连字符,允许中文)。
  const strict = state.mode === 'install' && resources.length > 0;
  const id = existing ? draft.id : strict ? draft.id.trim() : normalizeSkillId(draft.id || draft.name);
  const idOk = !strict || SKILL_ID_PATTERN.test(id);
  const valid = draft.name.trim().length > 0 && draft.systemPrompt.trim().length > 0 && idOk && (!strict || draft.description.trim().length > 0);
  const extra = draft.extraFrontmatter ? Object.keys(draft.extraFrontmatter) : [];
  const title = state.mode === 'edit' ? '编辑技能' : state.mode === 'install' ? (resources.length ? '安装技能包' : '导入技能') : '新建技能';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: C.text }}>{title}</div>
      <Row label="名称"><input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} style={inputStyle} placeholder="模型看到的技能名" /></Row>
      <Row label="标识">
        <input value={draft.id} disabled={existing} onChange={(e) => setDraft({ ...draft, id: e.target.value })} style={{ ...inputStyle, opacity: existing ? 0.6 : 1, borderColor: idOk ? undefined : C.err }} placeholder={strict ? '小写字母、数字与连字符' : (id || '留空按名称生成')} />
        {!idOk && <div style={{ width: '100%', fontSize: 10.5, color: C.err }}>标准技能包的标识只能是 1–64 位小写字母、数字与连字符,不能以连字符开头或结尾。</div>}
      </Row>
      <Row label="描述"><input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} style={inputStyle} placeholder="一句话说明什么时候该加载它(进系统提示词目录)" /></Row>
      <Row label="正文">
        <textarea value={draft.systemPrompt} onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })} rows={12} spellCheck={false}
          style={{ ...inputStyle, resize: 'vertical', fontFamily: MONO, fontSize: 11.5 }} placeholder="Markdown 正文;load_skill 时整段给模型" />
      </Row>
      {(resources.length > 0 || extra.length > 0) && (
        <Row label="资源">
          <div style={{ width: '100%', fontSize: 10.5, lineHeight: 1.6, color: INK_MUTED }}>
            {resources.length > 0 && (
              <>
                <div>{resources.length} 个配套资源,模型可用 load_skill 按需读取;脚本只读不执行。</div>
                <div style={{ fontFamily: MONO, fontSize: 10, color: INK_FAINT, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                  {resources.slice(0, MAX_LISTED_RESOURCES).join('\n')}{resources.length > MAX_LISTED_RESOURCES ? `\n…共 ${resources.length} 个` : ''}
                </div>
              </>
            )}
            {extra.length > 0 && <div>保留的扩展字段:{extra.join(', ')}(allowed-tools 只是元数据,不授予权限)</div>}
          </div>
        </Row>
      )}
      {note && <div style={{ fontSize: 10.5, lineHeight: 1.5, color: note.level === 'error' ? C.err : INK_MUTED, paddingLeft: 56 }}>{note.text}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
        <button disabled={busy} onClick={onCancel} style={chipButton({})}>取消</button>
        <button disabled={!valid || busy} onClick={() => onSave({ ...draft, id, name: draft.name.trim(), description: draft.description.trim() })}
          style={{ ...chipButton({ primary: true }), opacity: valid && !busy ? 1 : 0.5 }}>{state.mode === 'install' ? (resources.length ? '安装' : '导入') : '保存'}</button>
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
