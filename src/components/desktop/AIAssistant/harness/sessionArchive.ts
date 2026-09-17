/**
 * Harness 对话的归档形状与摘要,纯函数。会话历史面板要的是「标题 / 预览 / 轮数 / 工具数 /
 * token / 有没有出错」,打开时再把条目整份灌回面板;图片字节与 respond 函数在
 * serializeTranscript 里已经剥掉,所以一条归档就是 localStorage 里的一段 JSON。
 */

import { addUsage, EMPTY_USAGE, usageTotal, type TokenUsage } from '../../../../services/agentHarness/types';
import { deserializeTranscript, serializeTranscript, type TranscriptItem } from './transcript';

export interface HarnessSessionSummary {
  /** 第一条用户消息的前 30 字;只有图片时是「(图片)」。 */
  title: string;
  /** 最后一条有文字的回复的前 80 字。 */
  preview: string;
  /** 第一条用户消息的时间。 */
  startedAt: number;
  /** 用户消息条数。 */
  turns: number;
  toolCalls: number;
  usage: TokenUsage;
  /** 最后一条回复用的模型。 */
  model?: string;
  /** 有没有错误通知。 */
  err: boolean;
}

export interface HarnessSession extends HarnessSessionSummary {
  id: string;
  /** 归档时间。 */
  at: number;
  /** serializeTranscript 的产物。 */
  items: unknown[];
  /** harness.exportContextState() 的产物(摘要、切点、笔记);旧存档没有。 */
  context?: unknown;
}

/** 本会话按模型聚合的用量(账单页「本会话」一栏)。 */
export interface SessionModelUsage {
  model: string;
  requests: number;
  usage: TokenUsage;
}

export const MAX_HARNESS_SESSIONS = 30;

const TITLE_LEN = 30;
const PREVIEW_LEN = 80;

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

export function summarizeTranscript(items: readonly TranscriptItem[]): HarnessSessionSummary | null {
  let title: string | null = null;
  let startedAt = 0;
  let preview = '';
  let turns = 0;
  let toolCalls = 0;
  let usage = EMPTY_USAGE;
  let model: string | undefined;
  let err = false;
  for (const item of items) {
    switch (item.kind) {
      case 'user': {
        turns += 1;
        if (title === null) {
          const text = oneLine(item.text);
          title = text ? (text.length > TITLE_LEN ? `${text.slice(0, TITLE_LEN)}…` : text) : '(图片)';
          startedAt = item.at;
        }
        break;
      }
      case 'assistant': {
        const text = oneLine(item.content);
        if (text) preview = text.length > PREVIEW_LEN ? `${text.slice(0, PREVIEW_LEN)}…` : text;
        if (item.usage) usage = addUsage(usage, item.usage);
        if (item.model) model = item.model;
        break;
      }
      case 'tool_call': toolCalls += 1; break;
      case 'notice': if (item.level === 'error') err = true; break;
      default: break;
    }
  }
  if (title === null) return null;
  return { title, preview, startedAt, turns, toolCalls, usage, model, err };
}

export function buildHarnessSession(items: readonly TranscriptItem[], now: number = Date.now(), id: string = `hs_${now.toString(36)}`): HarnessSession | null {
  const summary = summarizeTranscript(items);
  if (!summary) return null;
  return { ...summary, id, at: now, items: serializeTranscript(items) };
}

export function sessionItems(session: HarnessSession): TranscriptItem[] {
  return deserializeTranscript(session.items);
}

/** 新的在前,封顶 MAX_HARNESS_SESSIONS;同 id 的旧条目先去掉。 */
export function prependSession(list: readonly HarnessSession[], session: HarnessSession): HarnessSession[] {
  return [session, ...list.filter((s) => s.id !== session.id)].slice(0, MAX_HARNESS_SESSIONS);
}

export function sessionUsageByModel(items: readonly TranscriptItem[]): SessionModelUsage[] {
  const byModel = new Map<string, SessionModelUsage>();
  for (const item of items) {
    if (item.kind !== 'assistant' || !item.usage || usageTotal(item.usage) <= 0) continue;
    const model = item.model || 'unknown';
    const existing = byModel.get(model);
    byModel.set(model, { model, requests: (existing?.requests ?? 0) + 1, usage: addUsage(existing?.usage ?? EMPTY_USAGE, item.usage) });
  }
  return [...byModel.values()].sort((a, b) => usageTotal(b.usage) - usageTotal(a.usage));
}

function isUsage(v: unknown): v is TokenUsage {
  if (!v || typeof v !== 'object') return false;
  const u = v as Record<string, unknown>;
  return ['input', 'output', 'cacheRead', 'cacheWrite'].every((k) => typeof u[k] === 'number' && Number.isFinite(u[k]));
}

/** 读回来的列表逐条校验:缺 id / 条目不是数组 / 摘要字段类型错的丢掉,重复 id 只留前一个。 */
export function sanitizeHarnessSessions(raw: unknown): HarnessSession[] {
  if (!Array.isArray(raw)) return [];
  const out: HarnessSession[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const s = item as Record<string, unknown>;
    if (typeof s.id !== 'string' || !s.id || seen.has(s.id) || !Array.isArray(s.items)) continue;
    if (typeof s.at !== 'number' || !Number.isFinite(s.at)) continue;
    // 摘要字段坏了就从条目重算,别因为一个字段丢整条会话。
    const rebuilt = summarizeTranscript(deserializeTranscript(s.items));
    if (!rebuilt) continue;
    seen.add(s.id);
    out.push({
      ...rebuilt,
      title: typeof s.title === 'string' && s.title ? s.title : rebuilt.title,
      preview: typeof s.preview === 'string' ? s.preview : rebuilt.preview,
      usage: isUsage(s.usage) ? s.usage : rebuilt.usage,
      id: s.id,
      at: s.at,
      items: s.items,
      context: s.context && typeof s.context === 'object' ? s.context : undefined,
    });
    if (out.length >= MAX_HARNESS_SESSIONS) break;
  }
  return out;
}
