/**
 * 角色槽位四件套。schema 逐字抄他的;坐标 V5 连续、V4.5 由工作台自己量化。
 * 增 / 改 / 删都支持批量(他 0.5.0 的 99e4a54):传数组就逐条处理,不传就把顶层参数当唯一一条。
 */

import { toolError, type AgentTool } from '../toolRegistry';
import type { WorkbenchCharacter } from '../workbench';
import type { ToolDeps } from './deps';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function describeCharacter(c: WorkbenchCharacter, index: number): string {
  const pos = c.center ? `(${c.center.x.toFixed(2)}, ${c.center.y.toFixed(2)})` : '自动';
  // 坐标原值单独一行:模型回填 update 时要的是没四舍五入的 position_x / position_y。
  const raw = c.center ? `position_x: ${c.center.x} | position_y: ${c.center.y}` : '(未手动定位)';
  return `${index + 1}. id=${c.id} 名称=${c.name || '(未命名)'} ${c.enabled ? '启用' : '停用'} 定位=${pos}\n   坐标原值: ${raw}\n   正向: ${c.prompt || '(空)'}\n   负向: ${c.negative_prompt || '(无)'}`;
}

/** 读坐标参数:契约是 position_x / position_y;模型照着 list 的回显传 center: {x, y} 也认。 */
function readPosition(args: Record<string, unknown>): { x: number | null; y: number | null } {
  const center = args.center && typeof args.center === 'object' ? (args.center as Record<string, unknown>) : null;
  const pick = (direct: unknown, nested: unknown) => (typeof direct === 'number' ? direct : typeof nested === 'number' ? nested : null);
  return { x: pick(args.position_x, center?.x), y: pick(args.position_y, center?.y) };
}

export function createCharacterTools(deps: ToolDeps): AgentTool[] {
  const list: AgentTool = {
    name: 'list_character_prompts',
    label: '角色列表',
    description: '查看工作台当前的全部多角色提示词 (id、名称、启停、定位与正负提示词) 与全局位置模式。',
    parameters: { type: 'object', properties: {} },
    permissionClass: 'R',
    execute: async (toolCallId) => {
      const chars = deps.adapter.listCharacters();
      const mode = deps.adapter.getParams().character_ai_position ? 'AI 自动排版' : '自定义坐标';
      if (chars.length === 0) return { toolCallId, toolName: list.name, content: `当前没有角色提示词。全局位置模式:${mode}。上限 ${deps.adapter.maxCharacters()} 个。` };
      return { toolCallId, toolName: list.name, content: `全局位置模式:${mode}(上限 ${deps.adapter.maxCharacters()} 个)\n${chars.map(describeCharacter).join('\n')}` };
    },
  };

  const CHARACTER_FIELDS = {
    name: { type: 'string', description: '角色名称 (仅本地标识,如 "左边的银发少女";留空自动命名)' },
    prompt: { type: 'string', description: '该角色的正向提示词 (以 girl/boy/other 等人数标签开头,不加数字;总人数标签如 2girls 写在主提示词)' },
    negative_prompt: { type: 'string', description: '该角色专属的负面提示词 (留空则不排除)' },
    position_x: { type: 'number', description: '定位坐标 X,0.0=画面最左,1.0=最右 (仅全局自定义定位模式下生效,V5 为连续小数,V4/V4.5 量化到 5x5 网格)' },
    position_y: { type: 'number', description: '定位坐标 Y,0.0=画面最上,1.0=最下' },
  } as const;

  const add: AgentTool = {
    name: 'add_character_prompt',
    label: '添加角色',
    description: '添加一个或多个角色提示词槽位并同步到工作台 UI。单个:直接传顶层字段;多个:传 characters 数组一次全部添加。传了 position_x/position_y 即视为手动定位,否则按启用顺序自动布局。',
    parameters: {
      type: 'object',
      properties: {
        ...CHARACTER_FIELDS,
        characters: {
          type: 'array',
          description: '批量添加多个角色:每项字段与顶层同名参数一致 (prompt 必填),本次调用内一次全部添加',
          items: { type: 'object', properties: { ...CHARACTER_FIELDS }, required: ['prompt'] },
        },
      },
    },
    permissionClass: 'W',
    writesFields: () => ['characters'],
    describeChange: async (args) => {
      const { specs } = resolveSpecs(args, 'characters');
      const prompts = specs.map((sp) => String(sp.prompt ?? '').slice(0, 60));
      return specs.length > 1 ? `新增 ${specs.length} 个角色:${prompts.join(' / ')}` : `新增角色:${prompts[0] ?? ''}`;
    },
    execute: async (toolCallId, args) => {
      const batch = args.characters !== undefined && args.characters !== null;
      const { specs, error } = resolveSpecs(args, 'characters');
      if (error) return toolError(toolCallId, add.name, `参数不合法:${error}`);
      const prompts = specs.map((sp) => (typeof sp.prompt === 'string' ? sp.prompt.trim() : ''));
      if (prompts.some((p) => !p)) return toolError(toolCallId, add.name, '参数不合法:prompt (角色正向提示词) 不能为空。');
      const existing = deps.adapter.listCharacters();
      const limit = deps.adapter.maxCharacters();
      const available = limit - existing.length;
      if (specs.length > available) {
        const detail = available <= 0 ? `角色数量已达上限 ${limit} 个` : `当前 ${limit} 个上限下仅剩 ${available} 个名额,本次要添加 ${specs.length} 个`;
        return toolError(toolCallId, add.name, `${detail},请先用 remove_character_prompt 删除后再添加。`);
      }
      const created: WorkbenchCharacter[] = [];
      specs.forEach((sp, i) => {
        const { x, y } = readPosition(sp);
        const center = x !== null && y !== null ? { x: clamp01(x), y: clamp01(y) } : null;
        created.push(deps.adapter.addCharacter({
          name: typeof sp.name === 'string' ? sp.name : undefined,
          prompt: prompts[i],
          negative_prompt: typeof sp.negative_prompt === 'string' ? sp.negative_prompt : undefined,
          center,
        }));
      });
      const total = existing.length + created.length;
      const lines = created.map((c) => `• id=${c.id} 名称=${c.name || '(未命名)'} 定位=${c.center ? `(${c.center.x}, ${c.center.y})` : '自动'} 正向=已设置 负向=${c.negative_prompt ? '已设置' : '(空)'}`);
      const head = batch ? `已添加 ${created.length} 个角色并同步到工作台:` : '已添加角色并同步到工作台:';
      const foot = batch ? `当前共 ${total} 个角色。后续修改或删除请引用上述 id。` : `当前共 ${total} 个角色。后续修改或删除该角色请引用 id=${created[0].id}。`;
      return { toolCallId, toolName: add.name, content: [head, ...lines, foot].join('\n') };
    },
  };

  const UPDATE_FIELDS = {
    id: { type: 'string', description: '目标角色的 ID (可先用 list_character_prompts 查询)' },
    name: { type: 'string', description: '新的角色名称' },
    prompt: { type: 'string', description: '新的正向提示词' },
    negative_prompt: { type: 'string', description: '新的负面提示词' },
    enabled: { type: 'boolean', description: '是否启用该角色 (false 则不参与生成)' },
    position_x: { type: 'number', description: '定位坐标 X (0.0~1.0,传入即视为手动定位)' },
    position_y: { type: 'number', description: '定位坐标 Y (0.0~1.0)' },
    use_auto_position: { type: 'boolean', description: 'true 时清除手动定位,恢复按启用顺序自动布局' },
  } as const;

  /** 一条修改规格 → patch;没有可改字段时返回 null。 */
  const buildPatch = (sp: Record<string, unknown>, existing: WorkbenchCharacter): Partial<Omit<WorkbenchCharacter, 'id'>> | null => {
    const patch: Partial<Omit<WorkbenchCharacter, 'id'>> = {};
    if (typeof sp.name === 'string') patch.name = sp.name;
    if (typeof sp.prompt === 'string') patch.prompt = sp.prompt;
    if (typeof sp.negative_prompt === 'string') patch.negative_prompt = sp.negative_prompt;
    if (typeof sp.enabled === 'boolean') patch.enabled = sp.enabled;
    const pos = readPosition(sp);
    if (sp.use_auto_position === true) patch.center = null;
    else if (pos.x !== null || pos.y !== null) {
      const base = existing.center ?? { x: 0.5, y: 0.5 };
      patch.center = { x: clamp01(pos.x ?? base.x), y: clamp01(pos.y ?? base.y) };
    }
    return Object.keys(patch).length === 0 ? null : patch;
  };

  const update: AgentTool = {
    name: 'update_character_prompt',
    label: '修改角色',
    description: '按 ID 修改已有的角色提示词,只需传入要修改的字段 (名称/正负提示词/启停/定位坐标),未传入的字段保持不变;多个角色一起改传 updates 数组。全局位置模式 (AI 自动 / 自定义) 请用 update_studio_parameters 的 character_ai_position 参数切换。',
    parameters: {
      type: 'object',
      properties: {
        ...UPDATE_FIELDS,
        updates: {
          type: 'array',
          description: '批量修改多个角色:每项含 id 与要修改的字段 (字段名与顶层同名参数一致),本次调用内一次全部应用',
          items: { type: 'object', properties: { ...UPDATE_FIELDS }, required: ['id'] },
        },
      },
    },
    permissionClass: 'W',
    writesFields: () => ['characters'],
    describeChange: async (args) => {
      const { specs } = resolveSpecs(args, 'updates');
      return specs.map((sp) => `修改角色 ${String(sp.id ?? '?')}:${Object.keys(sp).filter((k) => k !== 'id').join(', ')}`).join('\n');
    },
    execute: async (toolCallId, args) => {
      const { specs, error } = resolveSpecs(args, 'updates');
      if (error) return toolError(toolCallId, update.name, `参数不合法:${error}`);
      const applied: string[] = [];
      const failed: string[] = [];
      for (const sp of specs) {
        const id = typeof sp.id === 'string' ? sp.id : '';
        if (!id) { failed.push('缺少 id'); continue; }
        const existing = deps.adapter.listCharacters().find((c) => c.id === id);
        if (!existing) { failed.push(`找不到 id=${id} 的角色`); continue; }
        const patch = buildPatch(sp, existing);
        if (!patch) { failed.push(`id=${id} 没有传入任何要修改的字段`); continue; }
        const next = deps.adapter.updateCharacter(id, patch);
        if (!next) { failed.push(`修改 id=${id} 失败`); continue; }
        applied.push(`id=${id}:${Object.keys(patch).join(', ')}`);
      }
      if (applied.length === 0) return toolError(toolCallId, update.name, `没有任何角色被修改:${failed.join(';') || '没有传入任何要修改的字段。'} 请先用 list_character_prompts 查询。`);
      const lines = [`已更新 ${applied.length} 个角色:`, ...applied.map((a) => `• ${a}`)];
      if (failed.length) lines.push('以下未生效:', ...failed.map((f) => `• ${f}`));
      return { toolCallId, toolName: update.name, content: lines.join('\n') };
    },
  };

  const remove: AgentTool = {
    name: 'remove_character_prompt',
    label: '删除角色',
    description: '按 ID 删除一个或多个角色提示词并同步到工作台 UI(单个传 id,多个传 ids,可并用)。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要删除的角色 ID' },
        ids: { type: 'array', items: { type: 'string' }, description: '批量删除的角色 ID 列表 (与 id 可并用)' },
      },
    },
    permissionClass: 'W',
    writesFields: () => ['characters'],
    describeChange: async (args) => `删除角色 ${collectIds(args).join(', ') || '?'}`,
    execute: async (toolCallId, args) => {
      const ids = collectIds(args);
      if (ids.length === 0) return toolError(toolCallId, remove.name, '参数不合法:请传 id 或非空的 ids 数组。');
      const removed: string[] = [];
      const missing: string[] = [];
      for (const id of ids) (deps.adapter.removeCharacter(id) ? removed : missing).push(id);
      if (removed.length === 0) return toolError(toolCallId, remove.name, `找不到 id=${missing.join(', ')} 的角色。`);
      const lines = [`已删除 ${removed.length} 个角色:${removed.map((id) => `id=${id}`).join(', ')}`];
      if (missing.length) lines.push(`找不到:${missing.map((id) => `id=${id}`).join(', ')}`);
      return { toolCallId, toolName: remove.name, content: lines.join('\n') };
    },
  };

  return [list, add, update, remove];
}

type Spec = Record<string, unknown>;

/** 批量参数:传了数组就逐条处理,没传就把顶层参数当唯一一条(与他 0.5.0 的 _resolveSpecs 一致)。 */
export function resolveSpecs(args: Record<string, unknown>, key: string): { specs: Spec[]; error?: string } {
  const raw = args[key];
  if (raw === undefined || raw === null) return { specs: [args] };
  if (!Array.isArray(raw) || raw.length === 0 || raw.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
    return { specs: [], error: `${key} 必须是非空对象数组。` };
  }
  return { specs: raw as Spec[] };
}

function collectIds(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (typeof args.id === 'string' && args.id) out.push(args.id);
  if (Array.isArray(args.ids)) for (const v of args.ids) if (typeof v === 'string' && v && !out.includes(v)) out.push(v);
  return out;
}
