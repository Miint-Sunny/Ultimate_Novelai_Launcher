import type { AgentQuestion } from '../../../../services/agentHarness/workbench';
import type { PermissionRequest, PermissionDecision, ToolCall, ToolResult, TokenUsage } from '../../../../services/agentHarness/types';

/** 面板里的一条。assistant 在流式期间就地更新;工具调用与结果平铺成独立条目。 */
export type TranscriptItem =
  | { kind: 'user'; id: string; text: string; imageDataUrl?: string; at: number }
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
    return item;
  });
}

export function deserializeTranscript(raw: unknown): TranscriptItem[] {
  if (!Array.isArray(raw)) return [];
  const out: TranscriptItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || typeof (item as { kind?: unknown }).kind !== 'string') continue;
    const it = item as TranscriptItem;
    if (it.kind === 'permission') out.push({ ...it, request: { ...it.request, respond: () => {} } });
    else if (it.kind === 'assistant') out.push({ ...it, streaming: false });
    else out.push(it);
  }
  return out;
}
