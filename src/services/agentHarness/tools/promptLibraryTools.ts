/**
 * 词库四件套 → 我们的 Prompt Chunks(提示词片段)。他的 title / prompt / category
 * 对应片段的 label / expansion / 文件夹;负面提示词、tags、favorite 我们没有,
 * 传了就在结果里说明未保存,不假装存了。
 *
 * 批量参数照他的 99e4a54:add 的 `entries[]`、update 的 `updates[]`、delete 的 `ids[]`;
 * 不传数组就是单条,老调用方式不变。新增先整体校验再落盘,免得批量到一半才发现重名。
 */

import { toolError, type AgentTool } from '../toolRegistry';
import type { PromptLibraryEntry, ToolDeps } from './deps';

const CATEGORIES = ['角色', '风格', '服装', '构图', '环境', '特效', '其他'] as const;
const DEFAULT_PAGE = 20;
const MAX_PAGE = 50;

function describeEntry(e: PromptLibraryEntry): string {
  return `- id=${e.id} 「${e.title}」[${e.category || '其他'}]:${e.prompt.length > 120 ? `${e.prompt.slice(0, 120)}…` : e.prompt}`;
}

function unsupported(specs: readonly Record<string, unknown>[]): string {
  const ignored = ['negative_prompt', 'tags', 'favorite'].filter((k) => specs.some((s) => k in s));
  return ignored.length ? `(本地词库不支持 ${ignored.join(' / ')},这些字段未保存)` : '';
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

const newId = () => `chunk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** `args[key]` 是非空对象数组就逐项返回,没传就把顶层参数当唯一一项;传了但不合法返回错误文案。 */
function resolveSpecs(args: Record<string, unknown>, key: string): { specs: Record<string, unknown>[]; batch: boolean } | { error: string } {
  const raw = args[key];
  if (raw === undefined) return { specs: [args], batch: false };
  if (!Array.isArray(raw) || raw.length === 0 || raw.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) return { error: `${key} 必须是非空对象数组。` };
  return { specs: raw as Record<string, unknown>[], batch: true };
}

export function createPromptLibraryTools(deps: ToolDeps): AgentTool[] {
  const search: AgentTool = {
    name: 'search_prompt_library',
    label: '搜索词库',
    description: '检索本地词组合预设库 (词库)。传入 query 可按标题、提示词内容或标签模糊搜索;传入 category 可按分类过滤 (角色/风格/服装/构图/环境/特效/其他);传入 id 可精确读取单条条目的完整内容。不传任何参数时分页列出全部条目(默认每页 20 条,用 offset 翻页)。返回的条目 id 可用于 add/update/delete 工具的精确引用。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词 (匹配标题、提示词与标签,不区分大小写)' },
        category: { type: 'string', enum: [...CATEGORIES], description: '按分类过滤' },
        id: { type: 'string', description: '精确条目 ID,传入时直接返回该条目的完整内容' },
        offset: { type: 'integer', minimum: 0, description: '分页偏移,默认 0' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_PAGE, description: `每页条数,默认 ${DEFAULT_PAGE}` },
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
      const q = str(args.query).toLowerCase();
      const category = typeof args.category === 'string' ? args.category : '';
      const rows = entries.filter((e) => (!category || e.category === category) && (!q || e.title.toLowerCase().includes(q) || e.prompt.toLowerCase().includes(q)));
      if (rows.length === 0) return { toolCallId, toolName: search.name, content: entries.length === 0 ? '词库当前为空。可调用 add_prompt_library_entry 新增条目。' : '词库里没有匹配的条目。' };
      const offset = Math.min(Math.max(typeof args.offset === 'number' && Number.isInteger(args.offset) ? args.offset : 0, 0), rows.length);
      const limit = Math.min(Math.max(typeof args.limit === 'number' && Number.isInteger(args.limit) ? args.limit : DEFAULT_PAGE, 1), MAX_PAGE);
      const page = rows.slice(offset, offset + limit);
      const next = offset + page.length;
      const lines = [`${rows.length} 条${page.length < rows.length ? `(本页第 ${offset + 1}–${next} 条)` : ''}:`, ...page.map(describeEntry)];
      if (next < rows.length) lines.push(`下一页 offset: ${next}`);
      return { toolCallId, toolName: search.name, content: lines.join('\n') };
    },
  };

  const add: AgentTool = {
    name: 'add_prompt_library_entry',
    label: '新增词库条目',
    description: '向本地词库新增词组合预设。title 与 prompt 必填;分类建议使用标准分类名 (角色/风格/服装/构图/环境/特效/其他)。新增成功后返回条目 ID。需要一次新增多条时用 entries 数组,不要逐条多次调用;有一条不合法(缺字段 / 重名)就整批不新增。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '条目标题 (如「初音未来」「赛博水彩风」)' },
        prompt: { type: 'string', description: '正向提示词组合 (Danbooru 标签或自然语言)' },
        category: { type: 'string', enum: [...CATEGORIES], description: '分类 (默认 其他)' },
        negative_prompt: { type: 'string', description: '负面提示词 (仅角色分类生效)' },
        tags: { type: 'array', items: { type: 'string' }, description: '检索用标签列表' },
        favorite: { type: 'boolean', description: '是否收藏' },
        entries: {
          type: 'array',
          description: '批量新增多个条目:每项字段与顶层同名参数一致 (title 与 prompt 必填),本次调用内一次全部新增',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' }, prompt: { type: 'string' }, category: { type: 'string', enum: [...CATEGORIES] },
              negative_prompt: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, favorite: { type: 'boolean' },
            },
            required: ['title', 'prompt'],
          },
        },
      },
    },
    permissionClass: 'W',
    writesFields: () => ['prompt_library'],
    describeChange: async (args) => {
      const resolved = resolveSpecs(args, 'entries');
      if ('error' in resolved) return '新增词库条目(参数不合法)';
      const titles = resolved.specs.map((s) => `「${str(s.title)}」`).join('');
      return resolved.batch ? `新增 ${resolved.specs.length} 条词库条目:${titles}` : `新增词库条目${titles}`;
    },
    execute: async (toolCallId, args) => {
      const resolved = resolveSpecs(args, 'entries');
      if ('error' in resolved) return toolError(toolCallId, add.name, resolved.error);
      const { specs, batch } = resolved;
      const entries = await deps.promptLibrary.list();
      const existing = new Set(entries.map((e) => e.title));
      const seen = new Set<string>();
      const drafts: PromptLibraryEntry[] = [];
      for (const spec of specs) {
        const title = str(spec.title);
        const prompt = str(spec.prompt);
        if (!title || !prompt) return toolError(toolCallId, add.name, '参数不合法:title 与 prompt 必填。');
        if (title.includes('!')) return toolError(toolCallId, add.name, `标题「${title}」里不能有 \`!\`(它是片段引用的定界符)。`);
        if (existing.has(title)) return toolError(toolCallId, add.name, `已经有一条叫「${title}」的条目,请换个标题或用 update_prompt_library_entry 修改。`);
        if (seen.has(title)) return toolError(toolCallId, add.name, `这批里「${title}」出现了两次。`);
        seen.add(title);
        drafts.push({ id: newId(), title, prompt, category: typeof spec.category === 'string' && spec.category ? spec.category : '其他' });
      }
      for (const entry of drafts) await deps.promptLibrary.save(entry);
      const note = unsupported(specs);
      if (!batch) {
        const entry = drafts[0];
        return { toolCallId, toolName: add.name, content: `已新增条目 id=${entry.id}(「${entry.title}」,可在提示词里用 @${entry.title} 插入)。${note}` };
      }
      return { toolCallId, toolName: add.name, content: `已新增 ${drafts.length} 个词库条目(可在提示词里用 @标题 插入):\n${drafts.map(describeEntry).join('\n')}${note ? `\n${note}` : ''}` };
    },
  };

  const update: AgentTool = {
    name: 'update_prompt_library_entry',
    label: '修改词库条目',
    description: '按 ID 修改本地词库中的词组合条目。只需传入要修改的字段,未传入的字段保持原值。ID 可先用 search_prompt_library 查询获取;一次修改复数条目时用 updates 数组,不要逐条多次调用(逐条应用,哪条没生效会在结果里说明)。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要修改的条目 ID' },
        title: { type: 'string', description: '新标题' },
        prompt: { type: 'string', description: '新正向提示词' },
        category: { type: 'string', enum: [...CATEGORIES], description: '新分类' },
        negative_prompt: { type: 'string', description: '新负面提示词' },
        tags: { type: 'array', items: { type: 'string' }, description: '新标签列表 (整体替换)' },
        favorite: { type: 'boolean', description: '是否收藏' },
        updates: {
          type: 'array',
          description: '批量修改多个条目:每项含 id 与要修改的字段 (字段名与顶层同名参数一致),本次调用内一次全部应用',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' }, title: { type: 'string' }, prompt: { type: 'string' }, category: { type: 'string', enum: [...CATEGORIES] },
              negative_prompt: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, favorite: { type: 'boolean' },
            },
            required: ['id'],
          },
        },
      },
    },
    permissionClass: 'W',
    writesFields: () => ['prompt_library'],
    describeChange: async (args) => {
      const resolved = resolveSpecs(args, 'updates');
      if ('error' in resolved) return '修改词库条目(参数不合法)';
      const one = (s: Record<string, unknown>) => `${str(s.id) || '?'}:${Object.keys(s).filter((k) => k !== 'id').join(', ')}`;
      return resolved.batch ? `修改 ${resolved.specs.length} 条词库条目:${resolved.specs.map(one).join(';')}` : `修改词库条目 ${one(args)}`;
    },
    execute: async (toolCallId, args) => {
      const resolved = resolveSpecs(args, 'updates');
      if ('error' in resolved) return toolError(toolCallId, update.name, resolved.error);
      const { specs, batch } = resolved;
      if (!batch) {
        const id = str(args.id);
        if (!id) return toolError(toolCallId, update.name, 'id 为必填项。');
        if (!(await deps.promptLibrary.list()).some((e) => e.id === id)) return toolError(toolCallId, update.name, `找不到 id=${id} 的条目。`);
      }
      const applied: PromptLibraryEntry[] = [];
      const failed: string[] = [];
      for (const spec of specs) {
        const id = str(spec.id);
        if (!id) { failed.push('缺少条目 id'); continue; }
        // 每次重新读,同一批里对同一条目的多次修改依次生效。
        const entries = await deps.promptLibrary.list();
        const current = entries.find((e) => e.id === id);
        if (!current) { failed.push(`找不到 id=${id} 的条目`); continue; }
        const next: PromptLibraryEntry = { ...current };
        if (str(spec.title)) next.title = str(spec.title);
        if (typeof spec.prompt === 'string') next.prompt = spec.prompt;
        if (typeof spec.category === 'string') next.category = spec.category;
        if (next.title.includes('!')) { failed.push(`id=${id} 的新标题里不能有 \`!\``); continue; }
        if (next.title !== current.title && entries.some((e) => e.id !== id && e.title === next.title)) { failed.push(`id=${id} 改名失败,已经有一条叫「${next.title}」的条目`); continue; }
        await deps.promptLibrary.save(next);
        applied.push(next);
      }
      const note = unsupported(specs);
      if (applied.length === 0) return toolError(toolCallId, update.name, `未修改任何条目:${failed.join(';')}。`);
      const lines = batch
        ? [`已修改 ${applied.length} 个词库条目:`, ...applied.map(describeEntry)]
        : [`已更新条目 id=${applied[0].id}。`];
      if (failed.length) lines.push(`未修改:${failed.join(';')}。`);
      if (note) lines.push(note);
      return { toolCallId, toolName: update.name, content: lines.join('\n') };
    },
  };

  const remove: AgentTool = {
    name: 'delete_prompt_library_entry',
    label: '删除词库条目',
    description: '按 ID 删除本地词库中的词组合条目 (不可恢复)。ID 可先用 search_prompt_library 查询获取;删除复数条目时用 ids 数组一次完成,不要逐条多次调用。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要删除的单个条目 ID' },
        ids: { type: 'array', items: { type: 'string' }, description: '批量删除的条目 ID 列表 (与 id 可并用)' },
      },
    },
    permissionClass: 'D',
    describeChange: async (args) => {
      const ids = collectIds(args);
      if ('error' in ids) return '删除词库条目(参数不合法)';
      const entries = await deps.promptLibrary.list();
      const names = ids.ids.map((id) => { const hit = entries.find((e) => e.id === id); return hit ? `「${hit.title}」` : id; });
      return ids.ids.length === 1 ? `删除词库条目${names[0]}(不可恢复)` : `删除 ${ids.ids.length} 条词库条目:${names.join('、')}(不可恢复)`;
    },
    execute: async (toolCallId, args) => {
      const collected = collectIds(args);
      if ('error' in collected) return toolError(toolCallId, remove.name, collected.error);
      const { ids } = collected;
      const entries = await deps.promptLibrary.list();
      const targets = entries.filter((e) => ids.includes(e.id));
      if (targets.length === 0) return toolError(toolCallId, remove.name, ids.length === 1 ? `找不到 id=${ids[0]} 的条目。` : `找不到 id 为 ${ids.join('、')} 的条目。`);
      for (const target of targets) await deps.promptLibrary.remove(target.id);
      const missing = ids.filter((id) => !targets.some((e) => e.id === id));
      const lines = [targets.length === 1 && ids.length === 1
        ? `已删除条目 id=${targets[0].id}(「${targets[0].title}」)。`
        : `已删除 ${targets.length} 个词库条目:${targets.map((e) => `「${e.title}」(${e.id})`).join('、')}。`];
      if (missing.length) lines.push(`未找到:${missing.join('、')}。`);
      return { toolCallId, toolName: remove.name, content: lines.join('\n') };
    },
  };

  return [search, add, update, remove];
}

/** `id` 与 `ids[]` 并集,去重保序;`ids` 传了就得是非空数组,一个都没有就是缺 id。 */
function collectIds(args: Record<string, unknown>): { ids: string[] } | { error: string } {
  const ids: string[] = [];
  const single = str(args.id);
  if (single) ids.push(single);
  if (args.ids !== undefined) {
    if (!Array.isArray(args.ids) || args.ids.length === 0) return { error: 'ids 必须是非空字符串数组。' };
    for (const item of args.ids) {
      const value = str(item);
      if (value && !ids.includes(value)) ids.push(value);
    }
  }
  if (ids.length === 0) return { error: 'id 为必填项。' };
  return { ids };
}
