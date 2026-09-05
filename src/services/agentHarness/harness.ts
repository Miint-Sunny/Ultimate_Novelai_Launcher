/**
 * AgentHarness:单循环 + 工具直接改工作台。逐段移植他的 `agent_harness.dart`:
 *
 * - 每轮流式请求对瞬态错误(网络抖动 / 429 / 5xx / 流中断 / 空响应)指数退避重试
 *   (1s / 2s / 4s,含首次共 3 次),预算耗尽才报错终止;
 * - 工具轮数到 maxTurns 后注入收尾提示,追加一轮无工具的强制总结;
 * - 图片一次性展示:只有本轮新产生的图片发给模型,更早的折叠成固定占位符;
 * - 每轮请求前按估算 token 自适应压缩上下文,原始消息仍留在 UI 与落盘里。
 *
 * 我们加的只有一层:工具执行前过权限闸(契约 §5),要问就发 permission_request
 * 事件等 UI 回答,拒绝与超时都以工具结果回给模型。
 */

import { checkPermission, DEFAULT_PERMISSION_LIMITS, denialToolText, MessageBudget, type PermissionLimits } from './permissionGate';
import type { LlmProvider } from './provider';
import { toolError, type AgentTool, type ToolContext, type ToolRegistry } from './toolRegistry';
import {
  createMessage,
  hasVisionImages,
  usageTotal,
  withVisionImagesCollapsed,
  type AgentMessage,
  type AgentMessageImage,
  type HarnessEvent,
  type PermissionDecision,
  type PermissionMode,
  type ToolCall,
  type ToolResult,
  type TokenUsage,
} from './types';

export interface AgentPreset {
  id: string;
  name: string;
  systemPrompt: string;
  /** 白名单:不在名单里的工具根本不出现在 tools 里(契约 §5.3)。 */
  enabledToolNames: readonly string[];
  /** update_studio_parameters 允许改的参数键。 */
  allowedModifiableParams: readonly string[];
  enabledSkillIds: readonly string[];
}

export interface HarnessOptions {
  tools: ToolRegistry;
  provider: LlmProvider | null;
  preset: AgentPreset;
  /** 会话 id(prompt_cache_key)。 */
  sessionId?: string;
  providerLabel?: string;
  maxTurns?: number;
  maxRetryAttempts?: number;
  retryBaseDelayMs?: number;
  /** 测试注入:等待实现。 */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  compactionEnabled?: boolean;
  contextWindowTokens?: number;
  compactionReserveTokens?: number;
  compactionKeepRecentTokens?: number;
  /** 权限模式与硬上限,由 UI 层按设置传入;可在两次 send 之间改。 */
  permissionMode?: () => PermissionMode;
  permissionLimits?: () => PermissionLimits;
  opusExhausted?: () => boolean;
  lockedFields?: () => ReadonlySet<string>;
  /** 确认卡片的超时(默认 5 分钟),超时按拒绝。 */
  permissionTimeoutMs?: number;
  /** 追加系统提示词(可用技能声明等),每轮重算。 */
  systemPromptSuffix?: () => string;
}

const COLLAPSED_IMAGE_PLACEHOLDER =
  '[图片附件已折叠: 图片数据已在当时的轮次展示过,此处不再重复发送。如需再次查看画板图片,请调用 view_canvas_image 工具]';

const ESTIMATED_IMAGE_TOKENS = 1200;
const MAX_SERIALIZED_CHARS = 300_000;

const SUMMARIZATION_SYSTEM_PROMPT =
  '你是对话压缩助手。请把用户提供的对话历史压缩为结构化摘要,供另一个 AI 助手在不丢失关键信息的前提下无缝接续工作。只输出摘要本身。';

const SUMMARIZATION_PROMPT =
  '请把 <conversation> 中的对话历史压缩为一份上下文检查点摘要,另一个 AI 助手将只依据它继续工作。严格按以下格式输出:\n'
  + '## 目标\n[用户想完成什么]\n'
  + '## 约束与偏好\n[用户提过的要求与偏好,无则写 (无)]\n'
  + '## 进展\n### 已完成\n- ...\n### 进行中\n- ...\n### 受阻\n- ...\n'
  + '## 关键决定\n- **[决定]**: [原因]\n'
  + '## 下一步\n1. ...\n'
  + '## 关键上下文\n[接续工作必需的具体信息]\n\n'
  + '要求:每节保持精炼;完整保留提示词文本、生图参数、图片索引、批注坐标、报错原文等关键细节;不要遗漏未完成的请求。';

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let requestSeq = 0;

export class AgentHarness {
  readonly tools: ToolRegistry;
  provider: LlmProvider | null;
  preset: AgentPreset;
  sessionId?: string;
  providerLabel?: string;
  maxTurns: number;
  maxRetryAttempts: number;
  retryBaseDelayMs: number;
  compactionEnabled: boolean;
  contextWindowTokens: number;
  compactionReserveTokens: number;
  compactionKeepRecentTokens: number;

  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly permissionMode: () => PermissionMode;
  private readonly permissionLimits: () => PermissionLimits;
  private readonly opusExhausted: () => boolean;
  private readonly lockedFields: () => ReadonlySet<string>;
  private readonly permissionTimeoutMs: number;
  private readonly systemPromptSuffix: () => string;

  private readonly _messages: AgentMessage[] = [];
  private sendEpoch = 0;
  private compactionSummary: string | null = null;
  private contextStartIndex = 0;

  constructor(options: HarnessOptions) {
    this.tools = options.tools;
    this.provider = options.provider;
    this.preset = options.preset;
    this.sessionId = options.sessionId;
    this.providerLabel = options.providerLabel;
    this.maxTurns = options.maxTurns ?? 30;
    this.maxRetryAttempts = options.maxRetryAttempts ?? 3;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 1000;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
    this.compactionEnabled = options.compactionEnabled ?? true;
    this.contextWindowTokens = options.contextWindowTokens ?? 128_000;
    this.compactionReserveTokens = options.compactionReserveTokens ?? 16_384;
    this.compactionKeepRecentTokens = options.compactionKeepRecentTokens ?? 20_000;
    this.permissionMode = options.permissionMode ?? (() => 'auto');
    this.permissionLimits = options.permissionLimits ?? (() => DEFAULT_PERMISSION_LIMITS);
    this.opusExhausted = options.opusExhausted ?? (() => false);
    this.lockedFields = options.lockedFields ?? (() => new Set());
    this.permissionTimeoutMs = options.permissionTimeoutMs ?? 5 * 60_000;
    this.systemPromptSuffix = options.systemPromptSuffix ?? (() => '');
  }

  get messages(): readonly AgentMessage[] {
    return this._messages;
  }

  get isCompacted(): boolean {
    return this.compactionSummary !== null;
  }

  get currentSendEpoch(): number {
    return this.sendEpoch;
  }

  buildSystemPrompt(): string {
    const suffix = this.systemPromptSuffix();
    const base = this.preset.systemPrompt.trim();
    return suffix ? `${base}\n\n${suffix}` : base;
  }

  /** 预设白名单过滤后的工具:不在名单里的根本不给模型看。 */
  activeTools(): AgentTool[] {
    const allowed = new Set(this.preset.enabledToolNames);
    return this.tools.getAll().filter((tool) => allowed.has(tool.name));
  }

  /** 发送用户消息并驱动整个循环;事件流给 UI。 */
  async *send(userText: string, options: { temperature?: number; images?: AgentMessageImage[] } = {}): AsyncGenerator<HarnessEvent> {
    const images = options.images ?? [];
    if (!userText.trim() && images.length === 0) return;
    this.sendEpoch += 1;

    this._messages.push(createMessage({
      id: `user_${this.now()}`,
      role: 'user',
      content: userText.trim(),
      images,
      imageEpoch: this.sendEpoch,
      createdAt: this.now(),
    }));

    if (!this.provider) {
      yield { type: 'error', error: '未配置 LLM:请先在设置里配置 sidecar 的模型槽位。', transient: false };
      return;
    }

    const systemPrompt = this.buildSystemPrompt();
    const activeTools = this.activeTools();
    const budget = new MessageBudget();
    const toolContext: ToolContext = { sendEpoch: this.sendEpoch, lockedFields: this.lockedFields() };
    let completedToolTurns = 0;
    let wrapUpMode = false;

    for (;;) {
      if (this.compactionEnabled && this.contextWindowTokens > 0) {
        const window = this.contextWindowTokens - this.compactionReserveTokens;
        if (this.estimateContextTokens(systemPrompt) > window) {
          const evt = await this.compactContext();
          if (evt) yield evt;
        }
      }

      const toolsForTurn = wrapUpMode ? [] : activeTools;
      let assistantMsg: AgentMessage | null = null;
      let giveUpReason: string | null = null;
      let attempt = 0;

      while (!assistantMsg && !giveUpReason) {
        attempt += 1;
        const assistantMsgId = `asst_${this.now()}_${attempt}`;
        yield { type: 'turn_start', messageId: assistantMsgId };

        let content = '';
        let thoughts = '';
        let usage: TokenUsage | undefined;
        let errorMessage: string | null = null;
        let errorTransient = false;
        const toolCalls: ToolCall[] = [];

        const stream = this.provider.streamChat({
          messages: this.buildRequestMessages(systemPrompt),
          tools: toolsForTurn,
          temperature: options.temperature ?? 0.7,
          promptCacheKey: this.sessionId,
        });
        for await (const event of stream) {
          if (event.type === 'thought_delta') { thoughts += event.delta; yield event; }
          else if (event.type === 'content_delta') { content += event.delta; yield event; }
          else if (event.type === 'tool_call') { toolCalls.push(event.toolCall); yield event; }
          else if (event.type === 'usage') { usage = event.usage; yield event; }
          else if (event.type === 'degraded') { yield event; }
          else if (event.type === 'error') { errorMessage = event.error; errorTransient = event.transient; }
        }

        if (errorMessage !== null) {
          if (errorTransient && attempt < this.maxRetryAttempts) {
            const delayMs = this.retryBaseDelayMs * (1 << (attempt - 1));
            yield { type: 'retry', attempt: attempt + 1, maxAttempts: this.maxRetryAttempts, reason: errorMessage, delayMs };
            await this.sleep(delayMs);
            continue;
          }
          giveUpReason = errorTransient ? `连续 ${this.maxRetryAttempts} 次请求失败: ${errorMessage}` : errorMessage;
          break;
        }

        if (!content && !thoughts && toolCalls.length === 0) {
          if (attempt < this.maxRetryAttempts) {
            const delayMs = this.retryBaseDelayMs * (1 << (attempt - 1));
            yield { type: 'retry', attempt: attempt + 1, maxAttempts: this.maxRetryAttempts, reason: '模型返回空响应', delayMs };
            await this.sleep(delayMs);
            continue;
          }
          giveUpReason = `模型连续 ${this.maxRetryAttempts} 次返回空响应,请检查模型配置或稍后重试。`;
          break;
        }

        assistantMsg = createMessage({
          id: assistantMsgId,
          role: 'assistant',
          content,
          thoughts,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          usage,
          provider: this.providerLabel,
          model: this.provider.modelId || undefined,
          imageEpoch: this.sendEpoch,
          createdAt: this.now(),
        });
      }

      if (!assistantMsg) {
        yield { type: 'error', error: giveUpReason ?? '模型请求失败', transient: false };
        return;
      }
      this._messages.push(assistantMsg);

      const calls = assistantMsg.toolCalls ?? [];
      if (calls.length === 0 || wrapUpMode) {
        yield { type: 'turn_end', finalMessage: assistantMsg };
        return;
      }

      for (const call of calls) {
        const result = yield* this.runTool(call, toolContext, budget);
        yield { type: 'tool_result', result };
        this._messages.push(createMessage({
          id: `tool_${this.now()}_${call.id}`,
          role: 'tool',
          content: result.content,
          toolCallId: call.id,
          toolName: call.name,
          isError: result.isError,
          imageBase64: result.imageBase64,
          imageMimeType: result.imageMimeType,
          imageEpoch: this.sendEpoch,
          createdAt: this.now(),
        }));
      }

      completedToolTurns += 1;
      if (completedToolTurns >= this.maxTurns) {
        this._messages.push(createMessage({
          id: `limit_${this.now()}`,
          role: 'user',
          content: `已达到本轮对话的最大工具调用轮数上限 (${this.maxTurns} 轮)。请立即基于已获得的信息给出最终回答,不要再调用任何工具。`,
          imageEpoch: this.sendEpoch,
          createdAt: this.now(),
        }));
        wrapUpMode = true;
      }
    }
  }

  /** 过闸 → 执行。要问就发事件等 UI;拒绝/超时以工具结果回给模型。 */
  private async *runTool(call: ToolCall, ctx: ToolContext, budget: MessageBudget): AsyncGenerator<HarnessEvent, ToolResult> {
    const tool = this.tools.get(call.name);
    if (!tool) return toolError(call.id, call.name, `错误:未知工具 "${call.name}"`);
    if (!this.preset.enabledToolNames.includes(tool.name)) {
      return toolError(call.id, call.name, `错误:当前预设未开放工具 "${call.name}"`);
    }

    const verdict = await checkPermission(tool, call.arguments, {
      ...ctx,
      mode: this.permissionMode(),
      limits: this.permissionLimits(),
      opusExhausted: this.opusExhausted(),
    }, budget);

    if (verdict.kind === 'deny') return toolError(call.id, call.name, verdict.reason);

    if (verdict.kind === 'ask') {
      requestSeq += 1;
      const requestId = `perm_${this.now()}_${requestSeq}`;
      let resolveDecision!: (decision: PermissionDecision) => void;
      const decided = new Promise<PermissionDecision>((resolve) => { resolveDecision = resolve; });
      let settled = false;
      const respond = (decision: PermissionDecision) => { if (!settled) { settled = true; resolveDecision(decision); } };
      yield {
        type: 'permission_request',
        request: {
          id: requestId,
          toolCallId: call.id,
          toolName: tool.name,
          toolLabel: tool.label,
          permissionClass: tool.permissionClass,
          args: call.arguments,
          summary: verdict.summary,
          cost: verdict.cost,
          respond,
        },
      };
      const timeout = this.sleep(this.permissionTimeoutMs).then((): PermissionDecision => ({ kind: 'deny', reason: '确认超时' }));
      const decision = await Promise.race([decided, timeout]);
      settled = true;
      yield { type: 'permission_result', requestId, toolName: tool.name, decision };
      if (decision.kind === 'deny') return toolError(call.id, call.name, denialToolText(tool.name, decision.reason));
      if (decision.kind === 'allow-class') budget.allowClass(tool.permissionClass);
    }

    if (tool.countsAsGeneration) budget.generations += 1;
    try {
      const result = await tool.execute(call.id, call.arguments, ctx);
      return { ...result, toolName: result.toolName ?? tool.name };
    } catch (error) {
      return toolError(call.id, call.name, `工具执行异常: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // 请求上下文构建
  // ---------------------------------------------------------------------------

  buildRequestMessages(systemPrompt: string): AgentMessage[] {
    const result: AgentMessage[] = [createMessage({ id: 'system_prompt', role: 'system', content: systemPrompt })];
    if (this.compactionSummary !== null) {
      result.push(createMessage({
        id: 'compaction_summary',
        role: 'user',
        content: `以下是本次对话更早内容的压缩摘要 (原始消息已从上下文省略,用户界面仍保留完整历史)。请基于摘要继续当前任务:\n\n${this.compactionSummary}`,
      }));
    }
    for (let i = this.contextStartIndex; i < this._messages.length; i += 1) {
      const m = this._messages[i];
      result.push(m.imageEpoch === this.sendEpoch || !hasVisionImages(m) ? m : withVisionImagesCollapsed(m, COLLAPSED_IMAGE_PLACEHOLDER));
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // 上下文压缩
  // ---------------------------------------------------------------------------

  private estimateMessageTokens(m: AgentMessage): number {
    let chars = m.content.length + m.thoughts.length;
    if (hasVisionImages(m)) {
      chars += ESTIMATED_IMAGE_TOKENS * 4 * m.images.length;
      if (m.role === 'tool') chars += ESTIMATED_IMAGE_TOKENS * 4;
    }
    for (const tc of m.toolCalls ?? []) chars += tc.name.length + JSON.stringify(tc.arguments).length;
    return Math.ceil(chars / 4);
  }

  estimateContextTokens(systemPrompt?: string): number {
    let total = systemPrompt ? Math.floor(systemPrompt.length / 4) + 2048 : 0;
    if (this.compactionSummary !== null) total += Math.floor(this.compactionSummary.length / 4) + 64;
    let usageTokens = 0;
    let trailing = 0;
    for (let i = this._messages.length - 1; i >= this.contextStartIndex; i -= 1) {
      const m = this._messages[i];
      if (m.role === 'assistant' && m.usage && usageTotal(m.usage) > 0) {
        usageTokens = usageTotal(m.usage);
        break;
      }
      trailing += this.estimateMessageTokens(m);
    }
    return total + trailing + usageTokens;
  }

  /** 有效切点只能是 user / assistant,绝不在 tool 结果上切。 */
  private findCutIndex(force: boolean): number {
    const start = this.contextStartIndex;
    const end = this._messages.length;
    if (end <= start) return -1;
    if (force) {
      for (let i = end - 1; i >= start; i -= 1) {
        if (this._messages[i].role === 'user' && i > start) return i;
      }
      return -1;
    }
    const cutPoints: number[] = [];
    for (let i = start; i < end; i += 1) {
      const role = this._messages[i].role;
      if (role === 'user' || role === 'assistant') cutPoints.push(i);
    }
    if (cutPoints.length === 0) return -1;
    let acc = 0;
    for (let i = end - 1; i >= start; i -= 1) {
      acc += this.estimateMessageTokens(this._messages[i]);
      if (acc >= this.compactionKeepRecentTokens) {
        for (const c of cutPoints) if (c >= i) return c;
        return -1;
      }
    }
    return -1;
  }

  private serializeForSummary(msgs: readonly AgentMessage[]): string {
    const lines: string[] = [];
    for (const m of msgs) {
      if (m.role === 'user') {
        lines.push(`[用户]: ${m.content}`);
        if (hasVisionImages(m)) lines.push(`  (本条消息带有 ${m.images.length} 张图片附件,图片内容略)`);
      } else if (m.role === 'assistant') {
        if (m.content || m.toolCalls) {
          lines.push(`[助手]: ${m.content}`);
          for (const tc of m.toolCalls ?? []) lines.push(`  [助手调用了工具 ${tc.name}: ${JSON.stringify(tc.arguments)}]`);
        }
      } else if (m.role === 'tool') {
        lines.push(`[工具结果 ${m.toolName ?? ''}]: ${m.content}`);
      }
    }
    let text = lines.join('\n') + '\n';
    if (text.length > MAX_SERIALIZED_CHARS) text = `…… (更早内容已截断)\n${text.slice(text.length - MAX_SERIALIZED_CHARS)}`;
    return text;
  }

  private async generateSummary(toSummarize: readonly AgentMessage[], previousSummary: string | null): Promise<string | null> {
    if (!this.provider) return null;
    let request = `<conversation>\n${this.serializeForSummary(toSummarize)}</conversation>\n\n`;
    if (previousSummary !== null) {
      request += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
      request += '请在保留既有摘要全部信息的基础上,把新对话内容合并进去并更新摘要,仍严格按上述格式输出。\n\n';
    }
    request += SUMMARIZATION_PROMPT;
    let summary = '';
    for await (const event of this.provider.streamChat({
      messages: [
        createMessage({ id: 'summarization_system', role: 'system', content: SUMMARIZATION_SYSTEM_PROMPT }),
        createMessage({ id: 'summarization_request', role: 'user', content: request }),
      ],
      tools: [],
      temperature: 0.3,
    })) {
      if (event.type === 'content_delta') summary += event.delta;
      else if (event.type === 'error') return null;
    }
    const trimmed = summary.trim();
    return trimmed || null;
  }

  /** 压缩失败或没东西可压时返回 null,绝不破坏现有上下文。 */
  async compactContext(force = false): Promise<Extract<HarnessEvent, { type: 'compaction' }> | null> {
    if (!force && !this.compactionEnabled) return null;
    if (!this.provider) return null;
    const cut = this.findCutIndex(force);
    if (cut <= this.contextStartIndex) return null;
    const toSummarize = this._messages.slice(this.contextStartIndex, cut);
    if (toSummarize.length === 0) return null;
    const tokensBefore = this.estimateContextTokens();
    const summary = await this.generateSummary(toSummarize, this.compactionSummary);
    if (summary === null) return null;
    this.compactionSummary = summary;
    this.contextStartIndex = cut;
    return { type: 'compaction', summary, tokensBefore, tokensAfter: this.estimateContextTokens() };
  }

  // ---------------------------------------------------------------------------
  // 消息管理
  // ---------------------------------------------------------------------------

  addInfoMessage(text: string): void {
    this._messages.push(createMessage({ id: `info_${this.now()}`, role: 'assistant', content: text, imageEpoch: this.sendEpoch, createdAt: this.now() }));
  }

  /** 恢复的历史消息 imageEpoch 恒为 0,旧图不会再灌给模型。 */
  restoreMessages(messages: readonly AgentMessage[]): void {
    this._messages.push(...messages.map((m) => ({ ...m, imageEpoch: 0 })));
    this.resetCompaction();
  }

  setMessages(messages: readonly AgentMessage[]): void {
    this._messages.splice(0, this._messages.length, ...messages);
    this.resetCompaction();
  }

  rewindToMessage(messageId: string): boolean {
    const idx = this._messages.findIndex((m) => m.id === messageId);
    if (idx < 0) return false;
    const keepCount = idx + 1;
    this._messages.splice(keepCount);
    if (keepCount <= this.contextStartIndex) this.resetCompaction();
    return true;
  }

  clearMessages(): void {
    this._messages.splice(0);
    this.resetCompaction();
  }

  private resetCompaction(): void {
    this.compactionSummary = null;
    this.contextStartIndex = 0;
  }
}
