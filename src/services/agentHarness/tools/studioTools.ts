/**
 * get_studio_parameters / update_studio_parameters。schema 逐字抄他的;
 * 校验规则也照抄:宽高 64 对齐并夹在 64..2048,步数 1..50,CFG 1..20,rescale 0..1。
 */

import { toolError, type AgentTool } from '../toolRegistry';
import type { StudioParams } from '../workbench';
import type { ToolDeps } from './deps';

export const RESOLUTION_PRESETS: Record<string, { width: number; height: number }> = {
  portrait: { width: 832, height: 1216 },
  landscape: { width: 1216, height: 832 },
  square: { width: 1024, height: 1024 },
  wallpaper: { width: 1920, height: 1088 },
  portrait_large: { width: 1024, height: 1536 },
  landscape_large: { width: 1536, height: 1024 },
};

export const STUDIO_MODEL_IDS = [
  'nai-diffusion-5-full', 'nai-diffusion-5-curated', 'nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated', 'nai-diffusion-4-full', 'nai-diffusion-3',
] as const;

export const QUALITY_PRESET_VALUES = ['Standard', 'Heavy', 'Light', 'Off'] as const;

const GET_KEYS = ['prompt', 'negative_prompt', 'model', 'resolution', 'width', 'height', 'steps', 'scale', 'cfg_rescale', 'sampler', 'noise_schedule', 'quality_preset', 'seed', 'opus_free_status', 'all'];

const align64 = (value: number) => Math.min(2048, Math.max(64, Math.floor(value / 64) * 64));
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function describeParams(p: StudioParams, keys: string[], opusFree: string): string {
  const all = keys.length === 0 || keys.includes('all');
  const want = (k: string) => all || keys.includes(k);
  const lines: string[] = [];
  if (want('prompt')) lines.push(`prompt: ${p.prompt || '(空)'}`);
  if (want('negative_prompt')) lines.push(`negative_prompt: ${p.negative_prompt || '(空)'}`);
  if (want('model')) lines.push(`model: ${p.model}`);
  if (want('resolution') || want('width') || want('height')) lines.push(`resolution: ${p.width}x${p.height}`);
  if (want('steps')) lines.push(`steps: ${p.steps}`);
  if (want('scale')) lines.push(`scale: ${p.scale}`);
  if (want('cfg_rescale')) lines.push(`cfg_rescale: ${p.cfg_rescale}`);
  if (want('sampler')) lines.push(`sampler: ${p.sampler}`);
  if (want('noise_schedule')) lines.push(`noise_schedule: ${p.noise_schedule}`);
  if (want('quality_preset')) lines.push(`quality_preset: ${p.quality_preset}`);
  if (want('seed')) lines.push(`seed: ${p.seed || '随机'}`);
  if (want('opus_free_status')) lines.push(`opus_free_status: ${opusFree}`);
  if (all) lines.push(`character_ai_position: ${p.character_ai_position ? 'AI 自动排版' : '自定义坐标'}`);
  return lines.join('\n');
}

/**
 * 校验并归一化一份 update 参数。返回要写的 patch、回显行和被拒的键——闸与卡片都靠它。
 * 纯函数,给校验脚本钉。
 */
export function normalizeStudioUpdate(
  args: Record<string, unknown>,
  current: StudioParams,
  allowed: ReadonlySet<string>,
): { patch: Partial<StudioParams>; applied: string[]; rejected: string[] } {
  const patch: Partial<StudioParams> = {};
  const applied: string[] = [];
  const rejected: string[] = [];
  const guard = (key: string): boolean => {
    if (!allowed.has(key)) { rejected.push(`${key}: 当前预设不允许修改`); return false; }
    return true;
  };
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  if ('prompt' in args && guard('prompt')) {
    const v = str(args.prompt); if (v === null) rejected.push('prompt: 需要字符串'); else { patch.prompt = v; applied.push('提示词已更新'); }
  }
  if ('negative_prompt' in args && guard('negative_prompt')) {
    const v = str(args.negative_prompt); if (v === null) rejected.push('negative_prompt: 需要字符串'); else { patch.negative_prompt = v; applied.push('负向提示词已更新'); }
  }
  if ('model' in args && guard('model')) {
    const v = str(args.model);
    if (v === null || !(STUDIO_MODEL_IDS as readonly string[]).includes(v)) rejected.push(`model: 不认识的模型 ${String(args.model)}`);
    else { patch.model = v; applied.push(`模型 → ${v}`); }
  }
  if ('resolution_preset' in args && guard('resolution')) {
    const v = str(args.resolution_preset);
    const preset = v ? RESOLUTION_PRESETS[v] : undefined;
    if (!preset) rejected.push(`resolution_preset: 不认识的预设 ${String(args.resolution_preset)}`);
    else { patch.width = preset.width; patch.height = preset.height; applied.push(`分辨率 → ${preset.width}x${preset.height} (${v})`); }
  }
  if ('width' in args && guard('width')) {
    const v = num(args.width); if (v === null) rejected.push('width: 需要数字'); else { patch.width = align64(v); applied.push(`宽度 → ${patch.width}`); }
  }
  if ('height' in args && guard('height')) {
    const v = num(args.height); if (v === null) rejected.push('height: 需要数字'); else { patch.height = align64(v); applied.push(`高度 → ${patch.height}`); }
  }
  if ('steps' in args && guard('steps')) {
    const v = num(args.steps); if (v === null) rejected.push('steps: 需要数字'); else { patch.steps = clamp(Math.round(v), 1, 50); applied.push(`步数 → ${patch.steps}`); }
  }
  if ('scale' in args && guard('scale')) {
    const v = num(args.scale); if (v === null) rejected.push('scale: 需要数字'); else { patch.scale = clamp(v, 1, 20); applied.push(`CFG → ${patch.scale}`); }
  }
  if ('cfg_rescale' in args && guard('cfg_rescale')) {
    const v = num(args.cfg_rescale); if (v === null) rejected.push('cfg_rescale: 需要数字'); else { patch.cfg_rescale = clamp(v, 0, 1); applied.push(`CFG Rescale → ${patch.cfg_rescale}`); }
  }
  if ('sampler' in args && guard('sampler')) {
    const v = str(args.sampler); if (v === null) rejected.push('sampler: 需要字符串'); else { patch.sampler = v; applied.push(`采样器 → ${v}`); }
  }
  if ('noise_schedule' in args && guard('noise_schedule')) {
    const v = str(args.noise_schedule); if (v === null) rejected.push('noise_schedule: 需要字符串'); else { patch.noise_schedule = v; applied.push(`噪声调度 → ${v}`); }
  }
  if ('quality_preset' in args && guard('quality_preset')) {
    const v = str(args.quality_preset);
    if (v === null || !(QUALITY_PRESET_VALUES as readonly string[]).includes(v)) rejected.push(`quality_preset: 只接受 ${QUALITY_PRESET_VALUES.join(' / ')}`);
    else { patch.quality_preset = v; applied.push(`质量档 → ${v}`); }
  }
  if ('seed' in args) {
    const v = args.seed;
    if (v === null || v === '' || v === 'random') { patch.seed = ''; applied.push('种子 → 随机'); }
    else if (typeof v === 'number' || typeof v === 'string') { patch.seed = String(v); applied.push(`种子 → ${patch.seed}`); }
    else rejected.push('seed: 需要数字或字符串');
  }
  if ('character_ai_position' in args && guard('character_ai_position')) {
    if (typeof args.character_ai_position !== 'boolean') rejected.push('character_ai_position: 需要布尔值');
    else { patch.character_ai_position = args.character_ai_position; applied.push(`角色定位 → ${args.character_ai_position ? 'AI 自动排版' : '自定义坐标'}`); }
  }
  void current;
  return { patch, applied, rejected };
}

/** 写类工具的字段 diff,给确认卡片看。 */
export function describeStudioDiff(patch: Partial<StudioParams>, current: StudioParams): string {
  const lines: string[] = [];
  for (const [key, next] of Object.entries(patch)) {
    const prev = (current as unknown as Record<string, unknown>)[key];
    const show = (v: unknown) => (typeof v === 'string' && v.length > 80 ? `${v.slice(0, 80)}…` : String(v));
    lines.push(`${key}: ${show(prev)} → ${show(next)}`);
  }
  return lines.join('\n') || '(没有实际改动)';
}

export function createStudioTools(deps: ToolDeps): AgentTool[] {
  const get: AgentTool = {
    name: 'get_studio_parameters',
    label: '读取参数',
    description: '按需读取工作台当前生效的生图参数。可传入 keys 参数指定要查看的一个或多个参数字段;未指定 keys 或包含 "all" 时返回全部参数。',
    parameters: {
      type: 'object',
      properties: {
        keys: {
          type: 'array',
          items: { type: 'string', enum: GET_KEYS },
          description: '要查询的参数键名列表(支持多选,如 ["prompt", "steps"];留空或包含 "all" 则返回全部)',
        },
      },
    },
    permissionClass: 'R',
    execute: async (toolCallId, args) => {
      const keys = Array.isArray(args.keys) ? args.keys.filter((k): k is string => typeof k === 'string') : [];
      const unknown = keys.filter((k) => !GET_KEYS.includes(k));
      if (unknown.length > 0) return toolError(toolCallId, get.name, `未匹配到指定的参数名称: ${unknown.join(', ')}。支持的键名: ${GET_KEYS.join(', ')}。`);
      const cost = deps.estimateGenerationCost();
      const opusFree = cost.free ? '当前参数在 Opus 免费区间内' : `当前参数不免费,预计 ${cost.anlas} Anlas${cost.note ? `(${cost.note})` : ''}`;
      return { toolCallId, toolName: get.name, content: describeParams(deps.adapter.getParams(), keys, opusFree) };
    },
  };

  const update: AgentTool = {
    name: 'update_studio_parameters',
    label: '修改参数',
    description: '按需修改工作台的生图参数。只需传入需要修改的一个或多个字段(如 prompt、steps、scale 等),未传入的字段将保持原设置不变。修改后会实时同步更新 UI 界面。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '正向提示词描述' },
        negative_prompt: { type: 'string', description: '负向提示词 (排除的内容)' },
        model: { type: 'string', enum: [...STUDIO_MODEL_IDS], description: '生图模型 ID' },
        resolution_preset: {
          type: 'string',
          enum: Object.keys(RESOLUTION_PRESETS),
          description: '分辨率预设:portrait(832x1216), landscape(1216x832), square(1024x1024), wallpaper(1920x1088)',
        },
        width: { type: 'integer', description: '自定义宽度 (自动64对齐,如 832, 1024, 1216)' },
        height: { type: 'integer', description: '自定义高度 (自动64对齐,如 1216, 832, 1024)' },
        steps: { type: 'integer', description: '采样步数 (1~50,Opus 免费生图上限为 28)' },
        scale: { type: 'number', description: 'CFG 提示词引导强度 (1.0~20.0,默认5.0)' },
        cfg_rescale: { type: 'number', description: 'CFG Rescale 抗过曝修正 (0.0~1.0)' },
        sampler: { type: 'string', enum: ['k_euler', 'k_euler_ancestral', 'k_dpmpp_2m', 'k_dpmpp_sde'], description: '采样算法' },
        noise_schedule: { type: 'string', enum: ['karras', 'exponential', 'polyexponential', 'native'], description: '噪声调度算法' },
        quality_preset: { type: 'string', enum: [...QUALITY_PRESET_VALUES], description: '质量标签档位' },
        character_ai_position: { type: 'boolean', description: '角色定位模式:true = AI 自动排版,false = 使用各角色的自定义坐标' },
        seed: { type: ['integer', 'string', 'null'], description: '种子;空 / null / "random" 表示随机' },
      },
    },
    permissionClass: 'W',
    writesFields: (args) => Object.keys(args).map((k) => (k === 'resolution_preset' ? 'resolution' : k)),
    describeChange: async (args) => {
      const current = deps.adapter.getParams();
      const { patch, rejected } = normalizeStudioUpdate(args, current, deps.allowedParams());
      return describeStudioDiff(patch, current) + (rejected.length ? `\n(将被拒绝:${rejected.join(';')})` : '');
    },
    execute: async (toolCallId, args) => {
      const current = deps.adapter.getParams();
      const { patch, applied, rejected } = normalizeStudioUpdate(args, current, deps.allowedParams());
      if (Object.keys(patch).length > 0) deps.adapter.applyParams(patch);
      const lines: string[] = [];
      if (applied.length) { lines.push('已成功同步修改工作台 UI 生图参数:'); for (const item of applied) lines.push(`• ${item}`); }
      if (rejected.length) { lines.push('以下字段未生效:'); for (const item of rejected) lines.push(`• ${item}`); }
      if (!applied.length && !rejected.length) return toolError(toolCallId, update.name, '没有传入任何可修改的字段。');
      return { toolCallId, toolName: update.name, content: lines.join('\n'), isError: applied.length === 0 };
    },
  };

  return [get, update];
}
