/**
 * 词库四件套 → 我们的 Prompt Chunks(提示词片段)。他的 title / prompt / category
 * 对应片段的 label / expansion / 文件夹;负面提示词、tags、favorite 我们没有,
 * 传了就在结果里说明未保存,不假装存了。
 */

import { toolError, type AgentTool } from '../toolRegistry';
import type { PromptLibraryEntry, ToolDeps } from './deps';

const CATEGORIES = ['角色', '风格', '服装', '构图', '环境', '特效', '其他'] as const;

function describeEntry(e: PromptLibraryEntry): string {
  return `- id=${e.id} 「${e.title}」[${e.category || '其他'}]:${e.prompt.length > 120 ? `${e.prompt.slice(0, 120)}…` : e.prompt}`;
}

function unsupported(args: Record<string, unknown>): string {
  const ignored = ['negative_prompt', 'tags', 'favorite'].filter((k) => k in args);
  return ignored.length ? `(本地词库不支持 ${ignored.join(' / ')},这些字段未保存)` : '';
}

export function createPromptLibraryTools(deps: ToolDeps): AgentTool[] {
  const search: AgentTool = {
    name: 'search_prompt_library',
    label: '搜索词库',
    description: '检索本地词组合预设库 (词库)。传入 query 可按标题、提示词内容或标签模糊搜索;传入 category 可按分类过滤 (角色/风格/服装/构图/环境/特效/其他);传入 id 可精确读取单条条目的完整内容。不传任何参数时返回全部条目列表。返回的条目 id 可用于 add/update/delete 工具的精确引用。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词 (匹配标题、提示词与标签,不区分大小写)' },
        category: { type: 'string', enum: [...CATEGORIES], description: '按分类过滤' },
        id: { type: 'string', description: '精确条目 ID,传入时直接返回该条目的完整内容' },
      },
    },
    permissionClass: 'R',
    execute: async (toolCallId, args) => {
      const entries = await deps.promptLibrary.list();
      if (typeof args.id === 'string') {
        const hit = entries.find((e) => e.id === args.id);
        if (!hit) return toolError(toolCallId, search.name, `找不到 id=${args.id} 的条目。`);
        return { toolCallId, toolName: search.name, content: `id=${hit.id}\n标题:${hit.title}\n分类:${hit.category || '其他'}\n提示词:${hit.prompt}` };
      }
      const q = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
      const category = typeof args.category === 'string' ? args.category : '';
      const rows = entries.filter((e) => (!category || e.category === category) && (!q || e.title.toLowerCase().includes(q) || e.prompt.toLowerCase().includes(q)));
      if (rows.length === 0) return { toolCallId, toolName: search.name, content: '词库里没有匹配的条目。' };
      return { toolCallId, toolName: search.name, content: `${rows.length} 条:\n${rows.map(describeEntry).join('\n')}` };
    },
  };

  const add: AgentTool = {
    name: 'add_prompt_library_entry',
    label: '新增词库条目',
    description: '向本地词库新增一条词组合预设。title 与 prompt 必填;分类建议使用标准分类名 (角色/风格/服装/构图/环境/特效/其他)。新增成功后返回条目 ID。',
    parameters: {
      type: 'object',
      required: ['title', 'prompt'],
      properties: {
        title: { type: 'string', description: '条目标题 (如「初音未来」「赛博水彩风」)' },
        prompt: { type: 'string', description: '正向提示词组合 (Danbooru 标签或自然语言)' },
        category: { type: 'string', enum: [...CATEGORIES], description: '分类 (默认 其他)' },
        negative_prompt: { type: 'string', description: '负面提示词 (仅角色分类生效)' },
        tags: { type: 'array', items: { type: 'string' }, description: '检索用标签列表' },
        favorite: { type: 'boolean', description: '是否收藏' },
      },
    },
    permissionClass: 'W',
    writesFields: () => ['prompt_library'],
    describeChange: async (args) => `新增词库条目「${String(args.title ?? '')}」`,
    execute: async (toolCallId, args) => {
      const title = typeof args.title === 'string' ? args.title.trim() : '';
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
      if (!title || !prompt) return toolError(toolCallId, add.name, '参数不合法:title 与 prompt 必填。');
      if (title.includes('!')) return toolError(toolCallId, add.name, '标题里不能有 `!`(它是片段引用的定界符)。');
      const entries = await deps.promptLibrary.list();
      if (entries.some((e) => e.title === title)) return toolError(toolCallId, add.name, `已经有一条叫「${title}」的条目,请换个标题或用 update_prompt_library_entry 修改。`);
      const entry: PromptLibraryEntry = { id: `chunk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, title, prompt, category: typeof args.category === 'string' ? args.category : '其他' };
      await deps.promptLibrary.save(entry);
      return { toolCallId, toolName: add.name, content: `已新增条目 id=${entry.id}(「${title}」,可在提示词里用 @${title} 插入)。${unsupported(args)}` };
    },
  };

  const update: AgentTool = {
    name: 'update_prompt_library_entry',
    label: '修改词库条目',
    description: '按 ID 修改本地词库中的词组合条目。只需传入要修改的字段,未传入的字段保持原值。ID 可先用 search_prompt_library 查询获取。',
    parameters: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: '要修改的条目 ID' },
        title: { type: 'string', description: '新标题' },
        prompt: { type: 'string', description: '新正向提示词' },
        category: { type: 'string', enum: [...CATEGORIES], description: '新分类' },
        negative_prompt: { type: 'string', description: '新负面提示词' },
        tags: { type: 'array', items: { type: 'string' }, description: '新标签列表 (整体替换)' },
        favorite: { type: 'boolean', description: '是否收藏' },
      },
    },
    permissionClass: 'W',
    writesFields: () => ['prompt_library'],
    describeChange: async (args) => `修改词库条目 ${String(args.id)}:${Object.keys(args).filter((k) => k !== 'id').join(', ')}`,
    execute: async (toolCallId, args) => {
      const id = typeof args.id === 'string' ? args.id : '';
      const entries = await deps.promptLibrary.list();
      const existing = entries.find((e) => e.id === id);
      if (!existing) return toolError(toolCallId, update.name, `找不到 id=${id} 的条目。`);
      const next: PromptLibraryEntry = { ...existing };
      if (typeof args.title === 'string' && args.title.trim()) next.title = args.title.trim();
      if (typeof args.prompt === 'string') next.prompt = args.prompt;
      if (typeof args.category === 'string') next.category = args.category;
      if (next.title !== existing.title && entries.some((e) => e.id !== id && e.title === next.title)) return toolError(toolCallId, update.name, `已经有一条叫「${next.title}」的条目。`);
      await deps.promptLibrary.save(next);
      return { toolCallId, toolName: update.name, content: `已更新条目 id=${id}。${unsupported(args)}` };
    },
  };

  const remove: AgentTool = {
    name: 'delete_prompt_library_entry',
    label: '删除词库条目',
    description: '按 ID 删除本地词库中的词组合条目 (不可恢复)。ID 可先用 search_prompt_library 查询获取。',
    parameters: { type: 'object', required: ['id'], properties: { id: { type: 'string', description: '要删除的条目 ID' } } },
    permissionClass: 'D',
    describeChange: async (args) => {
      const entries = await deps.promptLibrary.list();
      const hit = entries.find((e) => e.id === args.id);
      return hit ? `删除词库条目「${hit.title}」(不可恢复)` : `删除词库条目 ${String(args.id)}`;
    },
    execute: async (toolCallId, args) => {
      const id = typeof args.id === 'string' ? args.id : '';
      const entries = await deps.promptLibrary.list();
      if (!entries.some((e) => e.id === id)) return toolError(toolCallId, remove.name, `找不到 id=${id} 的条目。`);
      await deps.promptLibrary.remove(id);
      return { toolCallId, toolName: remove.name, content: `已删除条目 id=${id}。` };
    },
  };

  return [search, add, update, remove];
}
