/**
 * context_memory:笔记写入与请求侧释放统一经 harness 状态入口,原始历史只读。移植自他 0.5.0 的
 * context_memory_tool.dart。所有写操作都同时接受单数与复数参数(text/texts、id/ids),一次调用
 * 处理多条,避免逐条往返。它拿的是 harness 而不是工作台,所以由面板层在 harness 建好后注册。
 */

import type { AgentHarness } from '../harness';
import { toolError, type AgentTool } from '../toolRegistry';

export const CONTEXT_MEMORY_TOOL_NAME = 'context_memory';

const DESCRIPTION = '管理本会话记忆。list 列出笔记和回复编号;add_note 保存必要结论;delete_note 删除过期笔记;'
  + 'forget_reply 释放旧回复及工具结果的请求上下文(不删除历史,不允许释放当前轮或已进入摘要的回复);'
  + 'read_reply 按编号分页读取原文。批量操作请直接用 ids / texts 数组一次清理复数条目,不要逐条多次调用。'
  + '笔记最多 64 条,每条 2000 字符。';

/** 给预设页的工具目录看的静态描述(真正的工具要有 harness 才能造)。 */
export const CONTEXT_MEMORY_TOOL_INFO = { name: CONTEXT_MEMORY_TOOL_NAME, label: '上下文与笔记', permissionClass: 'R' as const, description: DESCRIPTION };

function positiveInt(raw: unknown, key: string): number {
  const value = typeof raw === 'number' ? Math.trunc(raw) : typeof raw === 'string' ? Number.parseInt(raw.trim(), 10) : Number.NaN;
  if (!Number.isInteger(value) || value < 1) throw new Error(`${key} 必须是正整数(或正整数数组)`);
  return value;
}

/** 汇总 id 与 ids 为去重升序的正整数列表。 */
function resolveIds(args: Record<string, unknown>): number[] {
  const out = new Set<number>();
  if (args.id !== undefined && args.id !== null) out.add(positiveInt(args.id, 'id'));
  if (args.ids !== undefined && args.ids !== null) {
    if (!Array.isArray(args.ids)) throw new Error('ids 必须是整数数组');
    for (const item of args.ids) out.add(positiveInt(item, 'ids'));
  }
  return [...out].sort((a, b) => a - b);
}

export function createContextMemoryTool(getHarness: () => AgentHarness | null): AgentTool {
  const tool: AgentTool = {
    name: CONTEXT_MEMORY_TOOL_NAME,
    label: CONTEXT_MEMORY_TOOL_INFO.label,
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add_note', 'delete_note', 'forget_reply', 'read_reply'] },
        text: { type: 'string', description: '单条笔记内容' },
        texts: { type: 'array', items: { type: 'string' }, description: '批量保存的多条笔记内容(与 text 可并用)' },
        id: { type: 'integer', minimum: 1, description: '单个笔记 ID 或回复编号' },
        ids: { type: 'array', items: { type: 'integer', minimum: 1 }, description: '批量条目列表:delete_note 为笔记 ID,forget_reply / read_reply 为回复编号(与 id 可并用,一次调用处理多条)' },
        offset: { type: 'integer', minimum: 0, description: '列表条目 / 原文字符起点' },
      },
      required: ['action'],
    },
    permissionClass: 'R',
    execute: async (toolCallId, args) => {
      const harness = getHarness();
      if (!harness) return toolError(toolCallId, tool.name, '会话还没有建立,无法操作记忆。');
      try {
        const offset = args.offset ?? 0;
        if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) throw new Error('offset 必须是非负整数');
        let content: string;
        switch (args.action) {
          case 'list': {
            const replies = harness.messages.filter((m) => m.replyNumber !== undefined);
            content = JSON.stringify({
              notes: Object.fromEntries([...harness.memory.notes.entries()].map(([id, text]) => [String(id), text])),
              contextTokensEstimated: harness.contextUsage.tokens,
              replies: replies.slice(offset, offset + 50).map((m) => ({
                number: m.replyNumber,
                forgotten: harness.memory.forgottenReplies.has(m.replyNumber!),
                preview: m.content.slice(0, 100),
              })),
              totalReplies: replies.length,
            });
            break;
          }
          case 'add_note': content = addNotes(harness, args); break;
          case 'delete_note': content = deleteNotes(harness, args); break;
          case 'forget_reply': {
            const ids = resolveIds(args);
            if (ids.length === 0) throw new Error('需要回复编号 id 或 ids');
            content = harness.forgetReplies(ids);
            break;
          }
          case 'read_reply': content = readReplies(harness, args, offset); break;
          default: throw new Error('未知 action');
        }
        return { toolCallId, toolName: tool.name, content };
      } catch (error) {
        return toolError(toolCallId, tool.name, error instanceof Error ? error.message : String(error));
      }
    },
  };
  return tool;
}

/** 汇总 text 与 texts 并逐条保存,单条失败不影响其余。 */
function addNotes(harness: AgentHarness, args: Record<string, unknown>): string {
  const texts: string[] = [];
  if (args.text !== undefined && args.text !== null) {
    if (typeof args.text !== 'string') throw new Error('text 必须是字符串');
    texts.push(args.text);
  }
  if (args.texts !== undefined && args.texts !== null) {
    if (!Array.isArray(args.texts) || args.texts.some((t) => typeof t !== 'string')) throw new Error('texts 必须是字符串数组');
    texts.push(...(args.texts as string[]));
  }
  if (texts.length === 0) throw new Error('需要 text 或 texts');
  const saved: number[] = [];
  const failed: string[] = [];
  for (const text of texts) {
    try { saved.push(harness.memory.addNote(text)); } catch (error) { failed.push(error instanceof Error ? error.message : String(error)); }
  }
  if (saved.length === 0) throw new Error(failed[0]);
  harness.memoryChanged();
  let out = `已保存笔记 ${saved.map((n) => `#${n}`).join('、')}`;
  if (failed.length > 0) out += `;${failed.length} 条失败:${failed[0]}`;
  return out;
}

/** 批量删除笔记,全部不存在时按错误返回。 */
function deleteNotes(harness: AgentHarness, args: Record<string, unknown>): string {
  const ids = resolveIds(args);
  if (ids.length === 0) throw new Error('需要笔记 id 或 ids');
  const removed = harness.memory.deleteNotes(ids);
  if (removed.length === 0) throw new Error(`笔记不存在:${ids.map((i) => `#${i}`).join('、')}`);
  harness.memoryChanged();
  const missing = ids.filter((i) => !removed.includes(i));
  let out = `已删除笔记 ${removed.map((i) => `#${i}`).join('、')}`;
  if (missing.length > 0) out += `;未找到 ${missing.map((i) => `#${i}`).join('、')}`;
  return out;
}

/** 单条回复的完整原文(正文 + 工具调用 + 工具结果);不存在返回 null。 */
function replyText(harness: AgentHarness, id: number): string | null {
  const message = harness.messages.find((m) => m.replyNumber === id);
  if (!message) return null;
  const calls = message.toolCalls ?? [];
  const callIds = new Set(calls.map((c) => c.id));
  const results = harness.messages.filter((m) => m.role === 'tool' && m.toolCallId && callIds.has(m.toolCallId)).map((m) => m.content).join('\n');
  return [message.content, ...calls.map((c) => JSON.stringify({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })), ...(results ? [results] : [])].join('\n');
}

function readReplies(harness: AgentHarness, args: Record<string, unknown>, offset: number): string {
  const ids = resolveIds(args);
  if (ids.length === 0) throw new Error('需要回复编号 id 或 ids');
  const missing: number[] = [];
  const blocks: string[] = [];
  for (const id of ids) {
    const text = replyText(harness, id);
    if (text === null) { missing.push(id); continue; }
    blocks.push(ids.length === 1 ? `回复 #${id} 原文:\n${text}` : `===== 回复 #${id} =====\n${text}`);
  }
  if (blocks.length === 0) throw new Error(`回复不存在:${missing.map((i) => `#${i}`).join('、')}`);
  const full = blocks.join('\n\n');
  if (offset > full.length) throw new Error(`offset 超出原文长度 ${full.length}`);
  const end = Math.min(full.length, offset + 8000);
  return `${full.slice(offset, end)}\n[字符 ${offset}～${end} / ${full.length}]${missing.length ? `\n未找到:${missing.map((i) => `#${i}`).join('、')}` : ''}`;
}
