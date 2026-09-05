/**
 * Agent harness 的数据类型。逐条移植自 Novelai-harness `lib/core/harness/types.dart`
 * (MIT,saltysalrua),字段名与语义不改,这样他的技能文本、会话格式和我们这边能对得上。
 *
 * 只有两处是新加的:`PermissionRequest` / `PermissionResult` 事件(契约 §5 的三档权限),
 * 以及 `DegradedEvent`(sidecar 切到备用槽位时的提示,契约 §2.2)。
 */

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const EMPTY_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function usageTotal(u: TokenUsage): number {
  return u.input + u.output + u.cacheRead + u.cacheWrite;
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

/** OpenAI usage 块 → TokenUsage。同时认 pi 的字段名和 OpenAI 的字段名,与他的 fromJson 一致。 */
export function usageFromJson(json: unknown): TokenUsage {
  if (!json || typeof json !== 'object') return { ...EMPTY_USAGE };
  const j = json as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0);
  const details = j.prompt_tokens_details;
  const cached = details && typeof details === 'object' ? (details as Record<string, unknown>).cached_tokens : undefined;
  return {
    input: n(j.input) + n(j.prompt_tokens),
    output: n(j.output) + n(j.completion_tokens),
    cacheRead: n(j.cacheRead) + n(j.prompt_cache_hit_tokens) + n(cached),
    cacheWrite: n(j.cacheWrite),
  };
}

export type AgentRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export function toolCallToOpenAi(call: ToolCall) {
  return {
    id: call.id,
    type: 'function' as const,
    function: { name: call.name, arguments: JSON.stringify(call.arguments) },
  };
}

/** 用户消息里的图片附件(base64 不含 data: 前缀)。 */
export interface AgentMessageImage {
  base64: string;
  mimeType: string;
}

export function imageDataUrl(image: AgentMessageImage): string {
  return `data:${image.mimeType};base64,${image.base64}`;
}

/** 工具执行结果。带图时会以多模态内容块回给模型(text + image_url)。 */
export interface ToolResult {
  toolCallId: string;
  toolName?: string;
  content: string;
  isError?: boolean;
  imageBase64?: string;
  imageMimeType?: string;
}

export interface AgentMessage {
  id: string;
  role: AgentRole;
  content: string;
  /** 思考过程(reasoning / thinking)。 */
  thoughts: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  /** 工具结果消息对应的工具名(仅 role === 'tool')。 */
  toolName?: string;
  isError?: boolean;
  usage?: TokenUsage;
  provider?: string;
  model?: string;
  /** 工具结果附带的图片(仅 role === 'tool',不落盘)。 */
  imageBase64?: string;
  imageMimeType?: string;
  /** 用户消息附带的图片(仅 role === 'user')。 */
  images: AgentMessageImage[];
  /**
   * 图片所属的发送轮次。只有与当前轮次相等时图片才真正发给模型(一次性展示),
   * 更早轮次的图片在构建请求时折叠为固定占位文本——控制视觉 token,也保持
   * 提示缓存前缀稳定。恢复的历史消息恒为 0。
   */
  imageEpoch: number;
  createdAt: number;
}

export function createMessage(partial: Partial<AgentMessage> & Pick<AgentMessage, 'id' | 'role'>): AgentMessage {
  return {
    content: '',
    thoughts: '',
    images: [],
    imageEpoch: 0,
    createdAt: Date.now(),
    ...partial,
  };
}

export function hasVisionImages(m: AgentMessage): boolean {
  return (m.role === 'user' && m.images.length > 0)
    || (m.role === 'tool' && !!m.imageBase64);
}

/**
 * 「图片已折叠」的请求替身:去掉全部图片数据,正文末尾附加固定占位符。
 * 只用于构建 LLM 请求;UI 与会话落盘仍保留原消息。占位文本必须恒定,否则击穿缓存前缀。
 */
export function withVisionImagesCollapsed(m: AgentMessage, placeholder: string): AgentMessage {
  return {
    ...m,
    content: m.content ? `${m.content}\n\n${placeholder}` : placeholder,
    images: [],
    imageBase64: undefined,
  };
}

/** 消息 → OpenAI chat 消息。与他的 toOpenAiJson 逐字段一致。 */
export function messageToOpenAi(m: AgentMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: m.role, content: m.content };
  if (m.toolCalls && m.toolCalls.length > 0) out.tool_calls = m.toolCalls.map(toolCallToOpenAi);
  if (m.toolCallId) out.tool_call_id = m.toolCallId;
  if (m.role === 'tool' && m.imageBase64) {
    out.content = [
      { type: 'text', text: m.content },
      { type: 'image_url', image_url: { url: `data:${m.imageMimeType ?? 'image/png'};base64,${m.imageBase64}` } },
    ];
  }
  if (m.role === 'user' && m.images.length > 0) {
    out.content = [
      ...(m.content ? [{ type: 'text', text: m.content }] : []),
      ...m.images.map((img) => ({ type: 'image_url', image_url: { url: imageDataUrl(img) } })),
    ];
  }
  return out;
}

// ---------------------------------------------------------------------------
// 工具与权限
// ---------------------------------------------------------------------------

/** 契约 §5.1:R 读 / W 写(可撤销)/ D 破坏 / P 付费 / A 交互。 */
export type PermissionClass = 'R' | 'W' | 'D' | 'P' | 'A';

export type PermissionMode = 'manual' | 'auto' | 'yolo';

export interface CostEstimate {
  anlas: number;
  free: boolean;
  note?: string;
}

// ---------------------------------------------------------------------------
// Harness 事件
// ---------------------------------------------------------------------------

export type PermissionDecision =
  | { kind: 'allow' }
  /** 本轮(当前用户消息)同类工具都放行。 */
  | { kind: 'allow-class' }
  | { kind: 'deny'; reason?: string };

export interface PermissionRequest {
  id: string;
  toolCallId: string;
  toolName: string;
  toolLabel: string;
  permissionClass: PermissionClass;
  args: Record<string, unknown>;
  /** 给卡片看的摘要:W 类是字段 diff,P 类是估价,D 类是将删除的对象。 */
  summary: string;
  cost?: CostEstimate;
  respond: (decision: PermissionDecision) => void;
}

export type HarnessEvent =
  | { type: 'turn_start'; messageId: string }
  | { type: 'thought_delta'; delta: string }
  | { type: 'content_delta'; delta: string }
  | { type: 'tool_call'; toolCall: ToolCall }
  | { type: 'tool_result'; result: ToolResult }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'turn_end'; finalMessage: AgentMessage }
  /** transient 为真时 harness 会退避重试,假则终止本轮。 */
  | { type: 'error'; error: string; transient: boolean }
  | { type: 'retry'; attempt: number; maxAttempts: number; reason: string; delayMs: number }
  | { type: 'compaction'; summary: string; tokensBefore: number; tokensAfter: number }
  | { type: 'degraded'; slot: string; reason: string }
  | { type: 'permission_request'; request: PermissionRequest }
  | { type: 'permission_result'; requestId: string; toolName: string; decision: PermissionDecision };
