/**
 * Agent harness 的数据类型。逐条移植自 Novelai-harness `lib/core/harness/types.dart`
 * (MIT,saltysalrua),字段名与语义不改,这样他的技能文本、会话格式和我们这边能对得上。
 *
 * 只有两处是新加的:`PermissionRequest` / `PermissionResult` 事件(契约 §5 的三档权限),
 * 以及 `DegradedEvent`(sidecar 切到备用槽位时的提示,契约 §2.2)。
 */

/**
 * Token 用量,Pi 口径(与他 0.5.0 的 types.dart 一致):`input` 只算未命中缓存的输入,
 * 缓存读写单独计数;`cacheReadReported` 记这条统计有没有报告过缓存读数,缺失时命中率不冒充 0%。
 * 旧落盘数据的 input 含缓存,读回来走 usageFromLegacyAppJson 惰性迁移。
 */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheReadReported?: boolean;
}

export const EMPTY_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheReadReported: false };

export function usageTotalInput(u: TokenUsage): number {
  return u.input + u.cacheRead + u.cacheWrite;
}

export function usageTotal(u: TokenUsage): number {
  return usageTotalInput(u) + u.output;
}

export function usageCacheReported(u: TokenUsage): boolean {
  return u.cacheReadReported ?? u.cacheRead > 0;
}

/** 缓存命中率 = 缓存读 / 总输入;没报告缓存或没有输入时为 null(pi footer 的 CH 口径)。 */
export function cacheHitRate(u: TokenUsage): number | null {
  const total = usageTotalInput(u);
  return usageCacheReported(u) && total > 0 ? u.cacheRead / total : null;
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheReadReported: (usageTotalInput(a) === 0 || usageCacheReported(a)) && (usageTotalInput(b) === 0 || usageCacheReported(b)),
  };
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0);

/**
 * OpenAI usage 块 → TokenUsage。prompt_tokens 含缓存,减掉缓存读写才是 Pi 的 input;
 * 缓存读别名按 pi 的优先级短路(prompt_tokens_details.cached_tokens → prompt_cache_hit_tokens → cached_tokens),
 * 报告了 0 也算报告了。
 */
export function usageFromOpenAiJson(json: unknown): TokenUsage {
  if (!json || typeof json !== 'object') return { ...EMPTY_USAGE };
  const j = json as Record<string, unknown>;
  const details = j.prompt_tokens_details && typeof j.prompt_tokens_details === 'object' ? (j.prompt_tokens_details as Record<string, unknown>) : null;
  const rawRead = [details?.cached_tokens, j.prompt_cache_hit_tokens, j.cached_tokens].find((v) => typeof v === 'number' && Number.isFinite(v));
  const read = count(rawRead);
  const write = count(details?.cache_write_tokens);
  const prompt = count(j.prompt_tokens);
  return {
    input: Math.max(0, Math.min(prompt, prompt - read - write)),
    output: count(j.completion_tokens),
    cacheRead: read,
    cacheWrite: write,
    cacheReadReported: typeof rawRead === 'number' && rawRead >= 0,
  };
}

/** 已归一化的 Pi 形状(input 已排除缓存);带 prompt_tokens 的按 OpenAI 块解析。 */
export function usageFromJson(json: unknown): TokenUsage {
  if (!json || typeof json !== 'object') return { ...EMPTY_USAGE };
  const j = json as Record<string, unknown>;
  if ('prompt_tokens' in j) return usageFromOpenAiJson(j);
  const read = count(j.cacheRead);
  return {
    input: count(j.input),
    output: count(j.output),
    cacheRead: read,
    cacheWrite: count(j.cacheWrite),
    cacheReadReported: typeof j.cacheReadReported === 'boolean' ? j.cacheReadReported : read > 0,
  };
}

/** 本应用的旧落盘数据(条目 / 账本):旧 input 含缓存;带 inputAccounting: 'exclusive' 的已是新口径,不再减。 */
export function usageFromLegacyAppJson(json: unknown): TokenUsage {
  const usage = usageFromJson(json);
  if (!json || typeof json !== 'object' || (json as Record<string, unknown>).inputAccounting === 'exclusive') return usage;
  return { ...usage, input: Math.max(0, Math.min(usage.input, usage.input - usage.cacheRead - usage.cacheWrite)) };
}

/** 落盘形状:带口径标记,读回来不会再减一次缓存。 */
export function usageToJson(u: TokenUsage): Record<string, unknown> {
  return { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, cacheReadReported: usageCacheReported(u), inputAccounting: 'exclusive' };
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
  /** 助手回复的稳定编号(仅 role === 'assistant'):请求侧前缀 `[回复 #N]`,context_memory 按它读取 / 释放。 */
  replyNumber?: number;
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
  | { type: 'permission_result'; requestId: string; toolName: string; decision: PermissionDecision }
  /** 用户中断(Esc / 停止按钮):本轮到此为止,已流出的内容保留,未完成的工具调用以占位结果收口。 */
  | { type: 'aborted' };
