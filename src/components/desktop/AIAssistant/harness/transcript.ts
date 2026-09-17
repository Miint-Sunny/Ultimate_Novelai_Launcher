import type { AgentQuestion, StudioParams, WorkbenchCharacter } from '../../../../services/agentHarness/workbench';
import { createMessage, usageFromLegacyAppJson, usageToJson, type AgentMessage, type PermissionRequest, type PermissionDecision, type ToolCall, type ToolResult, type TokenUsage } from '../../../../services/agentHarness/types';

/** 发这条用户消息之前工作台的样子;回溯时整套还原。 */
export interface WorkbenchCheckpoint {
  params: StudioParams;
  characters: WorkbenchCharacter[];
}

/** 面板里的一条。assistant 在流式期间就地更新;工具调用与结果平铺成独立条目。 */
export type TranscriptItem =
  | { kind: 'user'; id: string; text: string; imageDataUrl?: string; at: number; harnessId?: string; checkpoint?: WorkbenchCheckpoint }
  | { kind: 'assistant'; id: string; content: string; thoughts: string; streaming: boolean; usage?: TokenUsage; model?: string; at: number }
  | { kind: 'tool_call'; id: string; call: ToolCall; result?: ToolResult; at: number }
  | { kind: 'notice'; id: string; level: 'info' | 'warn' | 'error'; text: string; at: number }
  | { kind: 'permission'; id: string; request: PermissionRequest; decision?: PermissionDecision; at: number }
  | { kind: 'ask'; id: string; questions: AgentQuestion[]; answers?: string[] | null; at: number };

/** 落盘用:去掉 respond 之类的函数与图片字节。 */
export function serializeTranscript(items: readonly TranscriptItem[]): unknown[] {
  return items.map((item) => {
    if (item.kind === 'user') return { ...item, imageDataUrl: undefined };
    if (item.kind === 'permission') {
      const { request, ...rest } = item;
      return { ...rest, request: { id: request.id, toolCallId: request.toolCallId, toolName: request.toolName, toolLabel: request.toolLabel, permissionClass: request.permissionClass, args: request.args, summary: request.summary, cost: request.cost } };
    }
    if (item.kind === 'tool_call' && item.result?.imageBase64) return { ...item, result: { ...item.result, imageBase64: undefined } };
    // 用量带口径标记落盘(input 已排除缓存),读回来不会再减一次。
    if (item.kind === 'assistant' && item.usage) return { ...item, usage: usageToJson(item.usage) };
    return item;
  });
}

/**
 * 把面板条目重建成 harness 的消息历史,刷新页面后模型才记得前文。
 * assistant 条目带上紧随其后的工具调用,每个工具行变成一条 tool 消息(OpenAI 要求
 * tool 紧跟带 tool_calls 的 assistant)。图片与权限/提问卡片不回填;没内容也没调用的
 * assistant 空壳(被中断的轮次)丢掉,免得给模型一条空消息。
 */
export function transcriptToMessages(items: readonly TranscriptItem[]): AgentMessage[] {
  const out: AgentMessage[] = [];
  let assistant: AgentMessage | null = null;
  for (const item of items) {
    if (item.kind === 'user') {
      assistant = null;
      out.push(createMessage({ id: item.harnessId ?? item.id, role: 'user', content: item.text, createdAt: item.at }));
    } else if (item.kind === 'assistant') {
      assistant = createMessage({ id: item.id, role: 'assistant', content: item.content, thoughts: item.thoughts, model: item.model, createdAt: item.at });
      out.push(assistant);
    } else if (item.kind === 'tool_call') {
      if (!assistant) {
        assistant = createMessage({ id: `a_${item.id}`, role: 'assistant', content: '', createdAt: item.at });
        out.push(assistant);
      }
      assistant.toolCalls = [...(assistant.toolCalls ?? []), item.call];
      out.push(createMessage({
        id: `tool_${item.id}`, role: 'tool', toolCallId: item.call.id, toolName: item.call.name,
        content: item.result?.content ?? '(结果未保存)', isError: item.result?.isError, createdAt: item.at,
      }));
    }
  }
  return out.filter((m) => !(m.role === 'assistant' && !m.content && !(m.toolCalls?.length)));
}

/** 回溯视图里的一轮:一条用户消息加它后面的回复与工具调用。 */
export interface TranscriptCheckpoint {
  index: number;
  userItemId: string;
  text: string;
  at: number;
  assistantSummary: string;
  toolNames: string[];
  restoresWorkbench: boolean;
}

/** 按「用户消息 → 其后的回复」聚合成轮次;连续两条用户消息(被中止的轮)各自成轮。 */
export function extractCheckpoints(items: readonly TranscriptItem[]): TranscriptCheckpoint[] {
  const out: TranscriptCheckpoint[] = [];
  let current: TranscriptCheckpoint | null = null;
  for (const item of items) {
    if (item.kind === 'user') {
      current = { index: out.length + 1, userItemId: item.id, text: item.text, at: item.at, assistantSummary: '', toolNames: [], restoresWorkbench: !!item.checkpoint };
      out.push(current);
    } else if (!current) {
      continue;
    } else if (item.kind === 'assistant') {
      if (item.content.trim()) current.assistantSummary = item.content.trim();
    } else if (item.kind === 'tool_call') {
      current.toolNames.push(item.call.name);
    }
  }
  return out;
}

export function deserializeTranscript(raw: unknown): TranscriptItem[] {
  if (!Array.isArray(raw)) return [];
  const out: TranscriptItem[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object' || typeof (item as { kind?: unknown }).kind !== 'string') continue;
    let it = item as TranscriptItem;
    // 早期版本用模型给的 call id 当行 id,跨轮会重复;重复的行改个名,免得 React key 撞车。
    if (seen.has(it.id)) it = { ...it, id: `${it.id}_${out.length}` };
    seen.add(it.id);
    if (it.kind === 'permission') out.push({ ...it, request: { ...it.request, respond: () => {} } });
    else if (it.kind === 'assistant') out.push({ ...it, streaming: false, usage: it.usage ? usageFromLegacyAppJson(it.usage) : undefined });
    else out.push(it);
  }
  return out;
}
