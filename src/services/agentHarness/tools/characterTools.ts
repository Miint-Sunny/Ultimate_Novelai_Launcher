/** 角色槽位四件套。schema 逐字抄他的;坐标 V5 连续、V4.5 由工作台自己量化。 */

import { toolError, type AgentTool } from '../toolRegistry';
import type { WorkbenchCharacter } from '../workbench';
import type { ToolDeps } from './deps';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function describeCharacter(c: WorkbenchCharacter, index: number): string {
  const pos = c.center ? `(${c.center.x.toFixed(2)}, ${c.center.y.toFixed(2)})` : '自动';
  return `${index + 1}. id=${c.id} 名称=${c.name || '(未命名)'} ${c.enabled ? '启用' : '停用'} 定位=${pos}\n   正向: ${c.prompt || '(空)'}\n   负向: ${c.negative_prompt || '(无)'}`;
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

  const add: AgentTool = {
    name: 'add_character_prompt',
    label: '添加角色',
    description: '为工作台添加一个多角色提示词 (V5 最多 22 个,V4/V4.5 最多 6 个)。添加后可配合 novelai_generate 进行多角色隔离生图;修改已有角色请用 update_character_prompt。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '角色名称 (仅本地标识,如 "左边的银发少女";留空自动命名)' },
        prompt: { type: 'string', description: '该角色的正向提示词 (以 girl/boy/other 等人数标签开头,不加数字;总人数标签如 2girls 写在主提示词)' },
        negative_prompt: { type: 'string', description: '该角色专属的负面提示词 (留空则不排除)' },
        position_x: { type: 'number', description: '定位坐标 X,0.0=画面最左,1.0=最右 (仅全局自定义定位模式下生效,V5 为连续小数,V4/V4.5 量化到 5x5 网格)' },
        position_y: { type: 'number', description: '定位坐标 Y,0.0=画面最上,1.0=最下' },
      },
      required: ['prompt'],
    },
    permissionClass: 'W',
    writesFields: () => ['characters'],
    describeChange: async (args) => `新增角色:${String(args.prompt ?? '').slice(0, 80)}`,
    execute: async (toolCallId, args) => {
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
      if (!prompt) return toolError(toolCallId, add.name, '参数不合法:prompt 必填。');
      const chars = deps.adapter.listCharacters();
      if (chars.length >= deps.adapter.maxCharacters()) return toolError(toolCallId, add.name, `角色数量已达上限 ${deps.adapter.maxCharacters()} 个。`);
      const x = typeof args.position_x === 'number' ? args.position_x : null;
      const y = typeof args.position_y === 'number' ? args.position_y : null;
      const center = x !== null && y !== null ? { x: clamp01(x), y: clamp01(y) } : null;
      const created = deps.adapter.addCharacter({
        name: typeof args.name === 'string' ? args.name : undefined,
        prompt,
        negative_prompt: typeof args.negative_prompt === 'string' ? args.negative_prompt : undefined,
        center,
      });
      return { toolCallId, toolName: add.name, content: `已添加角色 id=${created.id}(名称 ${created.name || '(未命名)'},定位 ${created.center ? `(${created.center.x}, ${created.center.y})` : '自动'})。当前共 ${chars.length + 1} 个角色。` };
    },
  };

  const update: AgentTool = {
    name: 'update_character_prompt',
    label: '修改角色',
    description: '按 ID 修改已有的角色提示词,只需传入要修改的字段 (名称/正负提示词/启停/定位坐标),未传入的字段保持不变。全局位置模式 (AI 自动 / 自定义) 请用 update_studio_parameters 的 character_ai_position 参数切换。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '目标角色的 ID (可先用 list_character_prompts 查询)' },
        name: { type: 'string', description: '新的角色名称' },
        prompt: { type: 'string', description: '新的正向提示词' },
        negative_prompt: { type: 'string', description: '新的负面提示词' },
        enabled: { type: 'boolean', description: '是否启用该角色 (false 则不参与生成)' },
        position_x: { type: 'number', description: '定位坐标 X (0.0~1.0,传入即视为手动定位)' },
        position_y: { type: 'number', description: '定位坐标 Y (0.0~1.0)' },
        use_auto_position: { type: 'boolean', description: 'true 时清除手动定位,恢复按启用顺序自动布局' },
      },
      required: ['id'],
    },
    permissionClass: 'W',
    writesFields: () => ['characters'],
    describeChange: async (args) => `修改角色 ${String(args.id)}:${Object.keys(args).filter((k) => k !== 'id').join(', ')}`,
    execute: async (toolCallId, args) => {
      const id = typeof args.id === 'string' ? args.id : '';
      const existing = deps.adapter.listCharacters().find((c) => c.id === id);
      if (!existing) return toolError(toolCallId, update.name, `找不到 id=${id} 的角色,请先用 list_character_prompts 查询。`);
      const patch: Partial<Omit<WorkbenchCharacter, 'id'>> = {};
      if (typeof args.name === 'string') patch.name = args.name;
      if (typeof args.prompt === 'string') patch.prompt = args.prompt;
      if (typeof args.negative_prompt === 'string') patch.negative_prompt = args.negative_prompt;
      if (typeof args.enabled === 'boolean') patch.enabled = args.enabled;
      if (args.use_auto_position === true) patch.center = null;
      else if (typeof args.position_x === 'number' || typeof args.position_y === 'number') {
        const base = existing.center ?? { x: 0.5, y: 0.5 };
        patch.center = {
          x: clamp01(typeof args.position_x === 'number' ? args.position_x : base.x),
          y: clamp01(typeof args.position_y === 'number' ? args.position_y : base.y),
        };
      }
      if (Object.keys(patch).length === 0) return toolError(toolCallId, update.name, '没有传入任何要修改的字段。');
      const next = deps.adapter.updateCharacter(id, patch);
      if (!next) return toolError(toolCallId, update.name, `修改 id=${id} 失败。`);
      return { toolCallId, toolName: update.name, content: `已更新角色 id=${id}:${Object.keys(patch).join(', ')}` };
    },
  };

  const remove: AgentTool = {
    name: 'remove_character_prompt',
    label: '删除角色',
    description: '按 ID 删除一个角色提示词并同步到工作台 UI。',
    parameters: { type: 'object', properties: { id: { type: 'string', description: '要删除的角色 ID' } }, required: ['id'] },
    permissionClass: 'W',
    writesFields: () => ['characters'],
    describeChange: async (args) => `删除角色 ${String(args.id)}`,
    execute: async (toolCallId, args) => {
      const id = typeof args.id === 'string' ? args.id : '';
      if (!deps.adapter.removeCharacter(id)) return toolError(toolCallId, remove.name, `找不到 id=${id} 的角色。`);
      return { toolCallId, toolName: remove.name, content: `已删除角色 id=${id}。` };
    },
  };

  return [list, add, update, remove];
}
