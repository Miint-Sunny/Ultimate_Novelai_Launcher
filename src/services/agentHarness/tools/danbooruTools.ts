/** danbooru_search_tags / danbooru_related_tags → 我们自己的 /api/tags/search、/api/tags/related。 */

import { toolError, type AgentTool } from '../toolRegistry';
import type { ToolDeps } from './deps';

interface TagRow { name?: string; tag?: string; category?: string | number; count?: number; zh?: string; translation?: string; summary?: string }

function formatRows(rows: TagRow[]): string {
  return rows.map((r) => {
    const name = r.name ?? r.tag ?? '';
    const zh = r.zh ?? r.translation;
    const count = typeof r.count === 'number' ? ` ${r.count}` : '';
    return `- ${name}${count}${zh ? ` (${zh})` : ''}${r.summary ? `:${r.summary}` : ''}`;
  }).join('\n');
}

export function createDanbooruTools(deps: ToolDeps): AgentTool[] {
  const search: AgentTool = {
    name: 'danbooru_search_tags',
    label: 'Danbooru 语义搜词',
    description: '用中文或英文的自然语言描述查找对应的 Danbooru 标准标签。基于语义向量匹配,支持模糊概念、整段画面描述、拼写容错与中文查询(例如"白色水手服的少女"或"雨中奔跑的城市街道")。查询单一概念时结果更精准;返回标签附中文名、热度与一句话简介。注意:语义检索较慢(10~30 秒),不要在单轮对话里高频调用。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '自然语言描述或概念(中文或英文均可)' },
        limit: { type: 'integer', description: '返回条数上限(默认 20,最大 80)' },
        use_segmentation: { type: 'boolean', description: '是否开启智能分词:开启后自动拆分长句中的概念分别检索再合并(适合完整画面描述);查询单一概念时设为 false 更精准(默认 true)' },
      },
      required: ['query'],
    },
    permissionClass: 'R',
    execute: async (toolCallId, args) => {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) return toolError(toolCallId, search.name, '参数不合法:query 必填。');
      const limit = Math.min(80, Math.max(1, typeof args.limit === 'number' ? Math.round(args.limit) : 20));
      try {
        const data = await deps.postJson<{ results?: TagRow[] }>('/api/tags/search', { query, limit, show_nsfw: true });
        const rows = data.results ?? [];
        if (rows.length === 0) return { toolCallId, toolName: search.name, content: `没有找到与「${query}」匹配的标签。` };
        return { toolCallId, toolName: search.name, content: `「${query}」的匹配标签(${rows.length} 条):\n${formatRows(rows)}` };
      } catch (error) {
        return toolError(toolCallId, search.name, `语义搜词失败:${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };

  const related: AgentTool = {
    name: 'danbooru_related_tags',
    label: 'Danbooru 关联推荐',
    description: '给定一组 Danbooru 标签,推荐在图库中经常与它们共同出现的关联标签(基于共现统计,NPMI 评分)。适合补全画面细节、查角色典型特征(服装/配件/表情)、或探索某主题的标签体系。支持多个标签组合取交集推荐。输入拼写错误会自动纠错为标准标签。响应约需 10~30 秒。',
    parameters: {
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string' }, description: '种子标签列表(Danbooru 英文标签名,如 ["maid", "twintails"])' },
        limit: { type: 'integer', description: '返回条数上限(默认 20,最大 200)' },
        category: { type: 'string', enum: ['General', 'Character', 'Copyright', 'Artist', 'Meta'], description: '可选:仅返回指定类别的标签(默认不过滤)' },
      },
      required: ['tags'],
    },
    permissionClass: 'R',
    execute: async (toolCallId, args) => {
      const tags = Array.isArray(args.tags) ? args.tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map((t) => t.trim()) : [];
      if (tags.length === 0) return toolError(toolCallId, related.name, '参数不合法:tags 至少一个。');
      const limit = Math.min(100, Math.max(1, typeof args.limit === 'number' ? Math.round(args.limit) : 20));
      const category = typeof args.category === 'string' ? args.category : undefined;
      try {
        const data = await deps.postJson<{ results?: TagRow[] }>('/api/tags/related', { tags, limit, show_nsfw: true, ...(category ? { categories: [category] } : {}) });
        const rows = data.results ?? [];
        if (rows.length === 0) return { toolCallId, toolName: related.name, content: `没有找到与 ${tags.join(', ')} 相关的标签。` };
        return { toolCallId, toolName: related.name, content: `与 ${tags.join(', ')} 共现的标签(${rows.length} 条):\n${formatRows(rows)}` };
      } catch (error) {
        return toolError(toolCallId, related.name, `关联推荐失败:${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };

  return [search, related];
}
