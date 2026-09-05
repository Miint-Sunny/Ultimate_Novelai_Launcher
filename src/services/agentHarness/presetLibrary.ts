/**
 * 预设库:内置预设 + 用户预设 + 用户自建技能,以及对它们的纯操作。
 * 形状照他的 PresetsSettingsDraft(新建 / 复制 / 删除 / 切换 / 技能与工具与参数的启停),
 * 落盘由面板层做,这里不碰存储。内置预设允许改,改坏了可以 reset 回出厂。
 */

import type { AgentPreset } from './harness';
import { BUILTIN_PRESETS, PARAM_KEYS, PHASE_ONE_TOOLS } from './presets';
import { stripFrontmatter, type Skill } from './skillCatalog';

export interface PresetLibrary {
  presets: AgentPreset[];
  activeId: string;
  userSkills: Skill[];
}

const BUILTIN_IDS = new Set(BUILTIN_PRESETS.map((p) => p.id));

export function isBuiltinPreset(id: string): boolean {
  return BUILTIN_IDS.has(id);
}

export function defaultPresetLibrary(): PresetLibrary {
  return { presets: BUILTIN_PRESETS.map(clonePreset), activeId: BUILTIN_PRESETS[0].id, userSkills: [] };
}

function clonePreset(p: AgentPreset): AgentPreset {
  return { ...p, enabledToolNames: [...p.enabledToolNames], allowedModifiableParams: [...p.allowedModifiableParams], enabledSkillIds: [...p.enabledSkillIds] };
}

/** 找不到 activeId 时退回第一个预设,永远有东西可用。 */
export function resolveActivePreset(lib: PresetLibrary): AgentPreset {
  return lib.presets.find((p) => p.id === lib.activeId) ?? lib.presets[0] ?? clonePreset(BUILTIN_PRESETS[0]);
}

export function setActivePreset(lib: PresetLibrary, id: string): PresetLibrary {
  return lib.presets.some((p) => p.id === id) ? { ...lib, activeId: id } : lib;
}

export function upsertPreset(lib: PresetLibrary, preset: AgentPreset): PresetLibrary {
  const exists = lib.presets.some((p) => p.id === preset.id);
  const presets = exists ? lib.presets.map((p) => (p.id === preset.id ? clonePreset(preset) : p)) : [...lib.presets, clonePreset(preset)];
  return { ...lib, presets };
}

let presetSeq = 0;
export function newPresetId(): string {
  presetSeq += 1;
  return `preset_${Date.now().toString(36)}_${presetSeq}`;
}

function uniqueName(lib: PresetLibrary, base: string): string {
  const names = new Set(lib.presets.map((p) => p.name));
  if (!names.has(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base} ${i}`;
    if (!names.has(candidate)) return candidate;
  }
  return `${base} ${Date.now()}`;
}

/** 新建:全工具、全参数、内置技能全开,系统提示词留空让用户写;并切为当前。 */
export function createPreset(lib: PresetLibrary, name = '新预设'): PresetLibrary {
  const preset: AgentPreset = {
    id: newPresetId(),
    name: uniqueName(lib, name),
    systemPrompt: '',
    enabledToolNames: [...PHASE_ONE_TOOLS],
    allowedModifiableParams: [...PARAM_KEYS],
    enabledSkillIds: [],
  };
  return { ...upsertPreset(lib, preset), activeId: preset.id };
}

export function duplicatePreset(lib: PresetLibrary, id: string): PresetLibrary {
  const source = lib.presets.find((p) => p.id === id);
  if (!source) return lib;
  const copy: AgentPreset = { ...clonePreset(source), id: newPresetId(), name: uniqueName(lib, `${source.name} 副本`) };
  return { ...upsertPreset(lib, copy), activeId: copy.id };
}

/** 内置的不能删(可以 reset);删掉当前预设就切到第一个。 */
export function removePreset(lib: PresetLibrary, id: string): PresetLibrary {
  if (isBuiltinPreset(id) || !lib.presets.some((p) => p.id === id)) return lib;
  const presets = lib.presets.filter((p) => p.id !== id);
  if (presets.length === 0) return lib;
  return { ...lib, presets, activeId: lib.activeId === id ? presets[0].id : lib.activeId };
}

export function resetBuiltinPreset(lib: PresetLibrary, id: string): PresetLibrary {
  const factory = BUILTIN_PRESETS.find((p) => p.id === id);
  return factory ? upsertPreset(lib, factory) : lib;
}

export function toggleId(list: readonly string[], id: string, on: boolean): string[] {
  const has = list.includes(id);
  if (on && !has) return [...list, id];
  if (!on && has) return list.filter((x) => x !== id);
  return [...list];
}

/** 父技能开了,子技能(`父/子`)跟着开;这是 harness 与 load_skill 的口径。 */
export function isSkillEnabled(skillId: string, enabledIds: readonly string[]): boolean {
  return enabledIds.some((id) => skillId === id || skillId.startsWith(`${id}/`));
}

export function inheritsFromParent(skillId: string, enabledIds: readonly string[]): boolean {
  return !enabledIds.includes(skillId) && enabledIds.some((id) => skillId.startsWith(`${id}/`));
}

// ---------------------------------------------------------------------------
// 用户技能:SKILL.md 进出
// ---------------------------------------------------------------------------

export function normalizeSkillId(raw: string): string {
  const cleaned = raw.trim().toLowerCase().replace(/\.md$/, '').replace(/[^a-z0-9\u4e00-\u9fa5/_-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || `skill-${Date.now().toString(36)}`;
}

/** 读 frontmatter 里的 name / description(只认这两个单行键),正文去掉 frontmatter。 */
export function parseSkillMarkdown(text: string, fallbackId: string): Skill {
  const normalized = text.replace(/\r\n/g, '\n');
  let name = '';
  let description = '';
  if (normalized.startsWith('---')) {
    const end = normalized.indexOf('\n---', 3);
    const head = end < 0 ? '' : normalized.slice(3, end);
    for (const line of head.split('\n')) {
      const m = /^\s*(name|description)\s*:\s*(.*)$/i.exec(line);
      if (!m) continue;
      const value = m[2].trim().replace(/^["']|["']$/g, '');
      if (m[1].toLowerCase() === 'name') name = value; else description = value;
    }
  }
  const body = stripFrontmatter(normalized);
  const id = normalizeSkillId(name || fallbackId);
  return { id, name: name || fallbackId.replace(/\.md$/, ''), description, systemPrompt: body };
}

export function skillToMarkdown(skill: Skill): string {
  const quote = (v: string) => JSON.stringify(v);
  return `---\nname: ${quote(skill.name)}\ndescription: ${quote(skill.description)}\n---\n\n${skill.systemPrompt.trim()}\n`;
}

export function upsertUserSkill(lib: PresetLibrary, skill: Skill): PresetLibrary {
  const exists = lib.userSkills.some((s) => s.id === skill.id);
  const userSkills = exists ? lib.userSkills.map((s) => (s.id === skill.id ? { ...skill } : s)) : [...lib.userSkills, { ...skill }];
  return { ...lib, userSkills };
}

/** 删技能时把它从所有预设的启用名单里摘掉,免得留下悬空 id。 */
export function removeUserSkill(lib: PresetLibrary, id: string): PresetLibrary {
  return {
    ...lib,
    userSkills: lib.userSkills.filter((s) => s.id !== id),
    presets: lib.presets.map((p) => ({ ...p, enabledSkillIds: p.enabledSkillIds.filter((x) => x !== id) })),
  };
}

export function allSkills(builtin: readonly Skill[], lib: PresetLibrary): Skill[] {
  const ids = new Set(builtin.map((s) => s.id));
  return [...builtin, ...lib.userSkills.filter((s) => !ids.has(s.id))];
}

// ---------------------------------------------------------------------------
// 落盘回来的东西不可信:逐字段收窄,内置预设永远在
// ---------------------------------------------------------------------------

const strArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function sanitizePreset(raw: unknown): AgentPreset | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id.trim()) return null;
  return {
    id: r.id,
    name: typeof r.name === 'string' && r.name.trim() ? r.name : '未命名预设',
    systemPrompt: typeof r.systemPrompt === 'string' ? r.systemPrompt : '',
    enabledToolNames: strArray(r.enabledToolNames),
    allowedModifiableParams: strArray(r.allowedModifiableParams).filter((k) => (PARAM_KEYS as readonly string[]).includes(k)),
    enabledSkillIds: strArray(r.enabledSkillIds),
  };
}

function sanitizeSkill(raw: unknown): Skill | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id.trim() || typeof r.systemPrompt !== 'string') return null;
  return { id: r.id, name: typeof r.name === 'string' && r.name.trim() ? r.name : r.id, description: typeof r.description === 'string' ? r.description : '', systemPrompt: r.systemPrompt };
}

export function sanitizePresetLibrary(raw: unknown): PresetLibrary {
  const base = defaultPresetLibrary();
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Record<string, unknown>;
  const seen = new Set<string>();
  const presets: AgentPreset[] = [];
  for (const item of Array.isArray(r.presets) ? r.presets : []) {
    const p = sanitizePreset(item);
    if (!p || seen.has(p.id)) continue;
    seen.add(p.id);
    presets.push(p);
  }
  for (const builtin of base.presets) if (!seen.has(builtin.id)) presets.unshift(builtin);
  const userSkills: Skill[] = [];
  const skillIds = new Set<string>();
  for (const item of Array.isArray(r.userSkills) ? r.userSkills : []) {
    const s = sanitizeSkill(item);
    if (!s || skillIds.has(s.id)) continue;
    skillIds.add(s.id);
    userSkills.push(s);
  }
  const activeId = typeof r.activeId === 'string' && presets.some((p) => p.id === r.activeId) ? r.activeId : presets[0].id;
  return { presets, activeId, userSkills };
}
