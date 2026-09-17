/**
 * 预设导入导出,照他 fork 的 pr-preset-transfer(PresetTransferService):可移植的预设比本地存档更严——
 * 权限字段(工具白名单、可改参数、技能)缺一个都不算合法,绝不退回「全开」的旧默认;
 * 引用了当前不存在的工具或参数键也拒收。JSON 形状与他的 AgentPreset.toJson 一致,两边能互导。
 */

import type { AgentPreset } from './harness';
import { PARAM_KEYS } from './presets';

export type PresetImportErrorCode = 'invalid_json' | 'invalid_field' | 'unknown_tool' | 'unknown_parameter';

export class PresetImportError extends Error {
  readonly code: PresetImportErrorCode;
  readonly detail: string;
  constructor(code: PresetImportErrorCode, detail = '') {
    super(describeImportError(code, detail));
    this.name = 'PresetImportError';
    this.code = code;
    this.detail = detail;
  }
}

export function describeImportError(code: PresetImportErrorCode, detail: string): string {
  switch (code) {
    case 'invalid_json': return '不是合法的预设 JSON(应为一个预设对象或预设数组)。';
    case 'invalid_field': return `预设字段 ${detail} 缺失或类型不对;可移植预设必须显式写全权限字段。`;
    case 'unknown_tool': return `预设引用了当前不存在的工具 ${detail}。`;
    case 'unknown_parameter': return `预设引用了不认识的参数键 ${detail}。`;
  }
}

/** 单个预设 → 带缩进的 JSON;isBuiltin 一律 false,导出的永远是可编辑副本。 */
export function encodePreset(preset: AgentPreset): string {
  return JSON.stringify({
    id: preset.id,
    name: preset.name,
    description: '',
    systemPrompt: preset.systemPrompt,
    enabledSkillIds: [...preset.enabledSkillIds],
    enabledToolNames: [...preset.enabledToolNames],
    allowedModifiableParams: [...preset.allowedModifiableParams],
    isBuiltin: false,
  }, null, 2);
}

const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim().length > 0);

/**
 * JSON(单个对象或数组)→ 预设列表。id 与现有的撞了就加 -2 / -3 后缀;
 * 抛 PresetImportError,调用方按 code 提示。
 */
export function decodePresets(
  source: string,
  options: { existingIds: Iterable<string>; availableToolNames: Iterable<string>; paramKeys?: readonly string[] },
): AgentPreset[] {
  let decoded: unknown;
  try { decoded = JSON.parse(source); } catch { throw new PresetImportError('invalid_json'); }
  const entries = Array.isArray(decoded) ? decoded : [decoded];
  if (entries.length === 0) throw new PresetImportError('invalid_json');
  const ids = new Set(options.existingIds);
  const tools = new Set(options.availableToolNames);
  const params = new Set(options.paramKeys ?? PARAM_KEYS);
  const out: AgentPreset[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new PresetImportError('invalid_json');
    const e = entry as Record<string, unknown>;
    for (const key of ['id', 'name', 'systemPrompt'] as const) {
      const value = e[key];
      if (typeof value !== 'string' || (key !== 'systemPrompt' && !value.trim())) throw new PresetImportError('invalid_field', key);
    }
    if (e.description !== undefined && typeof e.description !== 'string') throw new PresetImportError('invalid_field', 'description');
    for (const key of ['enabledSkillIds', 'enabledToolNames', 'allowedModifiableParams'] as const) {
      if (!isStringList(e[key])) throw new PresetImportError('invalid_field', key);
    }
    const enabledToolNames = e.enabledToolNames as string[];
    const allowedModifiableParams = e.allowedModifiableParams as string[];
    for (const tool of enabledToolNames) if (!tools.has(tool)) throw new PresetImportError('unknown_tool', tool);
    for (const param of allowedModifiableParams) if (!params.has(param)) throw new PresetImportError('unknown_parameter', param);
    const baseId = (e.id as string).trim();
    let id = baseId;
    for (let suffix = 2; ids.has(id); suffix += 1) id = `${baseId}-${suffix}`;
    ids.add(id);
    out.push({
      id,
      name: (e.name as string).trim(),
      systemPrompt: e.systemPrompt as string,
      enabledSkillIds: [...(e.enabledSkillIds as string[])],
      enabledToolNames: [...enabledToolNames],
      allowedModifiableParams: [...allowedModifiableParams],
    });
  }
  return out;
}
