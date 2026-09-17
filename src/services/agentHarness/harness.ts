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
import { ContextMemory, type ContextUsage } from './contextMemory';
import { ReplyMarkerStreamFilter, stripReplyMarkers } from './replyMarker';
import { toolError, toolToOpenAiFunction, type AgentTool, type ToolContext, type ToolRegistry } from './toolRegistry';
import {
  createMessage,
  hasVisionImages,
  usageTotal,
  usageTotalInput,
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
  /** 上下文过了硬阈值七成就在后台先压,主请求不等它(他 0.5.0 的 64b728e)。 */
  backgroundCompactionEnabled?: boolean;
  /** 压缩模型的窗口;摘要请求按它分批,小窗口模型也能压大上下文。 */
  compactionModelWindowTokens?: number;
  /** 单次摘要请求的总时限。 */
  compactionTimeoutMs?: number;
  /** 专门做摘要的 provider;缺省用主 provider。 */
  compactionProvider?: LlmProvider | null;
  /** 上下文用量 / 笔记 / 压缩状态变了(UI 刷新指示器、落盘上下文状态)。 */
  onContextChanged?: () => void;
  /** 摘要请求的用量单独回报(不混进对话账目)。 */
  onCompactionUsage?: (usage: TokenUsage, model: string) => void;
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

/**
 * 每次 send 独立的取消信号(照他 0.5.0 的 _HarnessRun):中断等待中的模型流、退避与工具结果;
 * 已发出的外部副作用(比如已经提交的生成)不能撤回。
 */
class HarnessRun {
  readonly controller = new AbortController();
  private resolveCancelled!: () => void;
  readonly cancelled = new Promise<void>((resolve) => { this.resolveCancelled = resolve; });
  private done = false;
  get isCancelled(): boolean { return this.done; }
  cancel(): void {
    if (this.done) return;
    this.done = true;
    this.resolveCancelled();
    this.controller.abort();
  }
  /** 等一个 Promise;取消时提前返回 undefined,不等上游。 */
  wait<T>(work: Promise<T>): Promise<T | undefined> {
    return Promise.race([work, this.cancelled.then(() => undefined)]);
  }
}

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
  backgroundCompactionEnabled: boolean;
  compactionModelWindowTokens: number;
  compactionTimeoutMs: number;
  compactionProvider: LlmProvider | null;
  onContextChanged: (() => void) | null;
  onCompactionUsage: ((usage: TokenUsage, model: string) => void) | null;
  /** 会话笔记与请求侧遗忘状态。 */
  readonly memory = new ContextMemory();

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
  private activeRun: HarnessRun | null = null;
  private compactionSummary: string | null = null;
  private contextStartIndex = 0;
  private compactionError: string | null = null;
  private pendingCompaction: Promise<CompactionEvent | null> | null = null;
  private compactionRun: HarnessRun | null = null;
  private contextRevision = 0;
  private lastBackgroundSize = -1;
  /** 回复编号序列;每条 assistant 消息领一个稳定编号。 */
  private replySequence = 0;
  /** 只有压缩 / 遗忘之后发出的请求用量,才可作为当前上下文估算的锚点。 */
  private usageFloor = 0;

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
    this.backgroundCompactionEnabled = options.backgroundCompactionEnabled ?? true;
    this.compactionModelWindowTokens = options.compactionModelWindowTokens ?? 128_000;
    this.compactionTimeoutMs = options.compactionTimeoutMs ?? 120_000;
    this.compactionProvider = options.compactionProvider ?? null;
    this.onContextChanged = options.onContextChanged ?? null;
    this.onCompactionUsage = options.onCompactionUsage ?? null;
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
  /** 中断当前这一轮:等待中的模型流、退避与工具结果立刻收口;没有在跑就什么都不做。 */
  abort(): void {
    this.activeRun?.cancel();
  }

  get isRunning(): boolean {
    return this.activeRun !== null;
  }

  async *send(userText: string, options: { temperature?: number; images?: AgentMessageImage[]; id?: string } = {}): AsyncGenerator<HarnessEvent> {
    if (this.activeRun) {
      yield { type: 'error', error: 'Agent 已在运行,等它结束或先中断。', transient: false };
      return;
    }
    const run = new HarnessRun();
    this.activeRun = run;
    try {
      yield* this.sendWithRun(userText, options, run);
    } finally {
      run.cancel();
      if (this.activeRun === run) this.activeRun = null;
    }
  }

  private async *sendWithRun(userText: string, options: { temperature?: number; images?: AgentMessageImage[]; id?: string }, run: HarnessRun): AsyncGenerator<HarnessEvent> {
    const images = options.images ?? [];
    if (!userText.trim() && images.length === 0) return;
    this.sendEpoch += 1;

    this._messages.push(createMessage({
      id: options.id ?? `user_${this.now()}`,
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
      // 提前后台压缩;临近硬阈值才等待,避免超窗盲发。
      if (this.compactionEnabled && this.contextWindowTokens > 0) {
        const used = this.estimateContextTokens(systemPrompt);
        if (used > this.hardContextLimit) {
          const evt = await run.wait(this.compactContext());
          if (run.isCancelled) { yield { type: 'aborted' }; return; }
          if (evt) yield evt;
          if (this.estimateContextTokens(systemPrompt) > this.hardContextLimit) {
            yield { type: 'error', error: '上下文超过安全窗口,压缩未能释放足够空间。请释放旧回复、手动压缩或切换更大窗口模型。', transient: false };
            return;
          }
        } else if (this.backgroundCompactionEnabled && used > this.hardContextLimit * 0.7 && this.lastBackgroundSize !== this._messages.length) {
          this.lastBackgroundSize = this._messages.length;
          void this.compactContext();
        }
      }
      this.onContextChanged?.();

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
        // 模型偶尔回显我们注入的 [回复 #N];流式期间就地剥掉,UI 与历史都不留残渣。
        const contentFilter = new ReplyMarkerStreamFilter();
        const thoughtFilter = new ReplyMarkerStreamFilter();

        const stream = this.provider.streamChat({
          messages: this.buildRequestMessages(systemPrompt),
          tools: toolsForTurn,
          temperature: options.temperature ?? 0.7,
          promptCacheKey: this.sessionId,
          signal: run.controller.signal,
        });
        for await (const event of stream) {
          if (event.type === 'thought_delta') { const d = thoughtFilter.add(event.delta); if (d) { thoughts += d; yield { type: 'thought_delta', delta: d }; } }
          else if (event.type === 'content_delta') { const d = contentFilter.add(event.delta); if (d) { content += d; yield { type: 'content_delta', delta: d }; } }
          else if (event.type === 'tool_call') { toolCalls.push(event.toolCall); yield event; }
          else if (event.type === 'usage') { usage = event.usage; yield event; }
          else if (event.type === 'degraded') { yield event; }
          else if (event.type === 'error') { errorMessage = event.error; errorTransient = event.transient; }
        }
        {
          const t = thoughtFilter.flush(); if (t) { thoughts += t; yield { type: 'thought_delta', delta: t }; }
          const c = contentFilter.flush(); if (c) { content += c; yield { type: 'content_delta', delta: c }; }
        }

        if (run.isCancelled) {
          // 已经流出来的内容留在历史里:模型下次看到的就是用户看到的;半截工具调用不留。
          if (content || thoughts) {
            this.replySequence += 1;
            this._messages.push(createMessage({
              id: assistantMsgId, role: 'assistant', replyNumber: this.replySequence, content: stripReplyMarkers(content), thoughts, usage,
              provider: this.providerLabel, model: this.provider.modelId || undefined, imageEpoch: this.sendEpoch, createdAt: this.now(),
            }));
          }
          this.onContextChanged?.();
          yield { type: 'aborted' };
          return;
        }

        if (errorMessage !== null) {
          if (errorTransient && attempt < this.maxRetryAttempts) {
            const delayMs = this.retryBaseDelayMs * (1 << (attempt - 1));
            yield { type: 'retry', attempt: attempt + 1, maxAttempts: this.maxRetryAttempts, reason: errorMessage, delayMs };
            await run.wait(this.sleep(delayMs));
            if (run.isCancelled) { yield { type: 'aborted' }; return; }
            continue;
          }
          giveUpReason = errorTransient ? `连续 ${this.maxRetryAttempts} 次请求失败: ${errorMessage}` : errorMessage;
          break;
        }

        if (!content && !thoughts && toolCalls.length === 0) {
          if (attempt < this.maxRetryAttempts) {
            const delayMs = this.retryBaseDelayMs * (1 << (attempt - 1));
            yield { type: 'retry', attempt: attempt + 1, maxAttempts: this.maxRetryAttempts, reason: '模型返回空响应', delayMs };
            await run.wait(this.sleep(delayMs));
            if (run.isCancelled) { yield { type: 'aborted' }; return; }
            continue;
          }
          giveUpReason = `模型连续 ${this.maxRetryAttempts} 次返回空响应,请检查模型配置或稍后重试。`;
          break;
        }

        this.replySequence += 1;
        assistantMsg = createMessage({
          id: assistantMsgId,
          role: 'assistant',
          replyNumber: this.replySequence,
          content: stripReplyMarkers(content),
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
        this.onContextChanged?.();
        yield { type: 'turn_end', finalMessage: assistantMsg };
        return;
      }

      for (const call of calls) {
        // 中断后剩下的调用不再执行,但要用占位结果收口:OpenAI 要求每个 tool_call 都有回应。
        const result = run.isCancelled
          ? toolError(call.id, call.name, '用户已中断,工具调用未完成。')
          : yield* this.runTool(call, toolContext, budget, run);
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

      if (run.isCancelled) { yield { type: 'aborted' }; return; }

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
  private async *runTool(call: ToolCall, ctx: ToolContext, budget: MessageBudget, run: HarnessRun): AsyncGenerator<HarnessEvent, ToolResult> {
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
      const decision = (await run.wait(Promise.race([decided, timeout]))) ?? { kind: 'deny', reason: '用户已中断' };
      settled = true;
      yield { type: 'permission_result', requestId, toolName: tool.name, decision };
      if (decision.kind === 'deny') return toolError(call.id, call.name, denialToolText(tool.name, decision.reason));
      if (decision.kind === 'allow-class') budget.allowClass(tool.permissionClass);
    }

    if (tool.countsAsGeneration) budget.generations += 1;
    try {
      const result = await run.wait(tool.execute(call.id, call.arguments, ctx));
      if (result === undefined) return toolError(call.id, call.name, '用户已中断;已启动的外部操作可能仍在执行。');
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
    const notes = this.memory.prompt;
    if (notes) result.push(createMessage({ id: 'context_notes', role: 'user', content: notes }));
    const forgottenToolIds = new Set<string>();
    for (let i = this.contextStartIndex; i < this._messages.length; i += 1) {
      let m = this._messages[i];
      if (m.role === 'tool' && m.toolCallId && forgottenToolIds.has(m.toolCallId)) continue;
      if (m.replyNumber !== undefined && this.memory.forgottenReplies.has(m.replyNumber)) {
        for (const c of m.toolCalls ?? []) forgottenToolIds.add(c.id);
        result.push(createMessage({ id: m.id, role: 'assistant', content: `[回复 #${m.replyNumber} 已释放;可用 context_memory read_reply 读取原文]`, createdAt: m.createdAt }));
        continue;
      }
      if (m.replyNumber !== undefined) {
        // 每次从原文现拼一层标记,避免历史正文里的回显叠成 [回复 #N] 链。
        m = { ...m, content: `[回复 #${m.replyNumber}]\n${stripReplyMarkers(m.content)}` };
      }
      result.push(m.imageEpoch === this.sendEpoch || !hasVisionImages(m) ? m : withVisionImagesCollapsed(m, COLLAPSED_IMAGE_PLACEHOLDER));
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // 上下文估算与记忆
  // ---------------------------------------------------------------------------

  private estimateMessageTokens(m: AgentMessage): number {
    let chars = m.content.length + m.thoughts.length;
    if (hasVisionImages(m)) {
      chars += ESTIMATED_IMAGE_TOKENS * 4 * m.images.length;
      if (m.role === 'tool') chars += ESTIMATED_IMAGE_TOKENS * 4;
    }
    for (const tc of m.toolCalls ?? []) chars += tc.name.length + JSON.stringify(tc.arguments).length;
    // 正文按非 ASCII 一字一 token 重估,中文不能按 chars/4 严重低估。
    return Math.ceil(chars / 4) + estimateTextTokens(m.content) - Math.ceil(m.content.length / 4);
  }

  /**
   * 估算当前请求上下文的 token 总量:优先用压缩 / 遗忘之后最后一条带用量的 assistant 消息的
   * total(含全部输入)加其后消息的估算;没有可用锚点时按整份请求(含工具 schema)估。
   */
  estimateContextTokens(systemPrompt?: string): number {
    for (let i = this._messages.length - 1; i >= this.usageFloor && i >= this.contextStartIndex; i -= 1) {
      const m = this._messages[i];
      if (m.usage && usageTotalInput(m.usage) > 0) {
        let sum = usageTotal(m.usage);
        for (let j = i + 1; j < this._messages.length; j += 1) sum += this.estimateMessageTokens(this._messages[j]);
        return sum;
      }
    }
    const prompt = systemPrompt ?? this.buildSystemPrompt();
    let total = 0;
    for (const t of this.activeTools()) total += estimateTextTokens(JSON.stringify(toolToOpenAiFunction(t)));
    for (const m of this.buildRequestMessages(prompt)) total += this.estimateMessageTokens(m) + 8;
    return total;
  }

  /** 硬阈值 = 窗口减去预留(预留至少 1、至多窗口的四分之一)。 */
  get hardContextLimit(): number {
    if (this.contextWindowTokens <= 0) return 1;
    const reserve = Math.min(Math.max(1, this.compactionReserveTokens), Math.max(1, Math.floor(this.contextWindowTokens / 4)));
    return this.contextWindowTokens - reserve;
  }

  /** 当前请求上下文快照(含估算成分),不是会话累计账单。 */
  get contextUsage(): ContextUsage {
    return {
      tokens: this.estimateContextTokens(),
      window: this.contextWindowTokens,
      compacting: this.pendingCompaction !== null,
      noteCount: this.memory.notes.size,
      error: this.compactionError,
    };
  }

  /** 释放不了的原因;能释放时返回 null。 */
  private releaseBlocker(number: number): string | null {
    const index = this._messages.findIndex((m) => m.replyNumber === number);
    if (index < 0 || index < this.contextStartIndex) return '不存在或已进入摘要,不能单独释放';
    let lastUser = -1;
    for (let i = this._messages.length - 1; i >= 0; i -= 1) if (this._messages[i].role === 'user') { lastUser = i; break; }
    if (index >= lastUser) return '属于当前用户轮次,不能释放';
    return null;
  }

  /** 批量释放旧回复的请求上下文(原始历史保留):逐项处理,单项失败不影响其余,只通知一次。 */
  forgetReplies(numbers: Iterable<number>): string {
    const ids = [...new Set(numbers)].sort((a, b) => a - b);
    if (ids.length === 0) throw new Error('需要至少一个回复编号');
    const released: number[] = [];
    const blocked: string[] = [];
    for (const number of ids) {
      const blocker = this.releaseBlocker(number);
      if (blocker !== null) { blocked.push(`#${number} (${blocker})`); continue; }
      this.memory.forgetReply(number);
      released.push(number);
    }
    if (released.length === 0) throw new Error(`没有可释放的回复:${blocked.join('、')}`);
    this.memoryChanged();
    let text = `已释放回复 ${released.map((n) => `#${n}`).join('、')} 及其工具结果;`;
    if (blocked.length > 0) text += `未释放 ${blocked.join('、')};`;
    return `${text}原始历史保留。`;
  }

  /** 笔记或遗忘状态变了:进行中的后台压缩作废,用量锚点后移。 */
  memoryChanged(): void {
    this.invalidateCompaction();
    this.usageFloor = this._messages.length + (this.activeRun ? 1 : 0);
    this.onContextChanged?.();
  }

  private invalidateCompaction(): void {
    this.contextRevision += 1;
    this.compactionRun?.cancel();
    this.compactionRun = null;
    this.pendingCompaction = null;
    this.lastBackgroundSize = -1;
  }

  /** 可落盘的上下文状态(摘要、切点、编号序列、笔记),与消息 id 序列绑定。 */
  exportContextState(): Record<string, unknown> {
    return {
      messageIds: this._messages.map((m) => m.id),
      summary: this.compactionSummary,
      start: this.contextStartIndex,
      replySequence: this.replySequence,
      memory: this.memory.toJson(),
    };
  }

  /** 消息 id 序列对得上才恢复(前缀匹配即可);对不上就当没有。 */
  restoreContextState(state: unknown): boolean {
    if (!state || typeof state !== 'object') return false;
    const j = state as Record<string, unknown>;
    const ids = j.messageIds;
    if (!Array.isArray(ids) || ids.length > this._messages.length) return false;
    for (let i = 0; i < ids.length; i += 1) if (ids[i] !== this._messages[i].id) return false;
    this.invalidateCompaction();
    if (j.memory && typeof j.memory === 'object') this.memory.restore(j.memory);
    if (typeof j.start === 'number' && Number.isInteger(j.start) && j.start >= 0 && j.start <= ids.length && typeof j.summary === 'string' && j.summary) {
      this.contextStartIndex = j.start;
      this.compactionSummary = j.summary;
    }
    if (typeof j.replySequence === 'number' && j.replySequence > this.replySequence) this.replySequence = j.replySequence;
    this.usageFloor = this._messages.length;
    this.onContextChanged?.();
    return true;
  }

  dispose(): void {
    this.abort();
    this.invalidateCompaction();
    this.onContextChanged = null;
    this.onCompactionUsage = null;
  }

  // ---------------------------------------------------------------------------
  // 上下文压缩(参考 pi compaction;单飞后台压缩:快照计算,版本校验后原子提交)
  // ---------------------------------------------------------------------------

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
          lines.push(`[助手 #${m.replyNumber ?? m.id}]: ${stripReplyMarkers(m.content)}`);
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

  /** 失败、超时、被取消或空摘要都返回 null,此时放弃压缩(绝不破坏现有上下文)。 */
  private async generateSummary(toSummarize: readonly AgentMessage[], previousSummary: string | null, run?: HarnessRun): Promise<string | null> {
    const p = this.compactionProvider ?? this.provider;
    if (!p) return null;
    let request = `<conversation>\n${this.serializeForSummary(toSummarize)}</conversation>\n\n`;
    if (previousSummary !== null) {
      request += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
      request += '请在保留既有摘要全部信息的基础上,把新对话内容合并进去并更新摘要,仍严格按上述格式输出。\n\n';
    }
    request += SUMMARIZATION_PROMPT;
    let summary = '';
    const consume = (async (): Promise<'done' | 'error' | 'cancelled'> => {
      for await (const event of p.streamChat({
        messages: [
          createMessage({ id: 'summarization_system', role: 'system', content: SUMMARIZATION_SYSTEM_PROMPT }),
          createMessage({ id: 'summarization_request', role: 'user', content: request }),
        ],
        tools: [],
        temperature: 0.3,
        signal: run?.controller.signal,
      })) {
        if (run?.isCancelled) return 'cancelled';
        if (event.type === 'content_delta') summary += event.delta;
        else if (event.type === 'usage') { if (!run?.isCancelled) this.onCompactionUsage?.(event.usage, p.modelId); }
        else if (event.type === 'error') return 'error';
      }
      return 'done';
    })();
    // 时限用真实计时器(不走可注入的 sleep,测试里的假 sleep 会让它立刻超时);unref 免得挂住进程。
    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.compactionTimeoutMs);
      (timer as unknown as { unref?: () => void }).unref?.();
    });
    const outcome = await Promise.race([consume, deadline]);
    if (timer !== null) clearTimeout(timer);
    if (outcome !== 'done') return null;
    const trimmed = summary.trim();
    return trimmed || null;
  }

  /** 单飞:进行中的压缩直接复用;版本变了(回溯 / 换会话 / 记忆变动)晚到的结果不提交。 */
  compactContext(force = false): Promise<CompactionEvent | null> {
    if (this.pendingCompaction) return this.pendingCompaction;
    const run = new HarnessRun();
    this.compactionRun = run;
    const revision = this.contextRevision;
    const pending = this.compactSnapshot(force, run).finally(() => {
      if (revision === this.contextRevision) {
        this.pendingCompaction = null;
        this.compactionRun = null;
        this.onContextChanged?.();
      }
    });
    this.pendingCompaction = pending;
    this.onContextChanged?.();
    return pending;
  }

  private async compactSnapshot(force: boolean, run: HarnessRun): Promise<CompactionEvent | null> {
    if ((!force && !this.compactionEnabled) || !this.provider) return null;
    const cut = this.findCutIndex(force);
    if (cut <= this.contextStartIndex) return null;
    const revision = this.contextRevision;
    const tokensBefore = this.estimateContextTokens();
    // 用请求替身做快照,已释放的回复不会在摘要里复活。
    const ids = new Set(this._messages.slice(this.contextStartIndex, cut).map((m) => m.id));
    const snapshot = this.buildRequestMessages('').filter((m) => ids.has(m.id));
    if (snapshot.length === 0) return null;
    this.compactionError = null;
    try {
      // 小窗口压缩模型分批迭代;保守字符预算确保中文也不会超窗。
      const budget = Math.floor(this.compactionModelWindowTokens * 0.45) - 2048;
      if (budget < 256) throw new Error('压缩模型上下文窗口过小');
      const chunkSize = Math.min(50_000, Math.max(256, budget));
      const batches: AgentMessage[][] = [];
      let batch: AgentMessage[] = [];
      let used = 0;
      for (const m of snapshot) {
        const text = this.serializeForSummary([m]);
        for (let start = 0; start < text.length; start += chunkSize) {
          const chunk = createMessage({ id: m.id, role: 'user', content: text.slice(start, start + chunkSize) });
          const cost = estimateTextTokens(chunk.content) + 16;
          if (used + cost > budget && batch.length > 0) { batches.push(batch); batch = []; used = 0; }
          batch.push(chunk);
          used += cost;
        }
      }
      if (batch.length > 0) batches.push(batch);
      let summary = this.compactionSummary;
      for (const part of batches) {
        summary = await this.generateSummary(part, summary, run);
        if (run.isCancelled || revision !== this.contextRevision) return null;
        if (summary === null) throw new Error('压缩模型未返回摘要');
        if (estimateTextTokens(summary) > Math.floor(this.compactionModelWindowTokens / 4)) throw new Error('压缩摘要过长,已保留原始上下文');
      }
      if (summary === null || run.isCancelled || revision !== this.contextRevision) return null;
      const originalTokens = snapshot.reduce((n, m) => n + this.estimateMessageTokens(m), 0) + estimateTextTokens(this.compactionSummary ?? '');
      if (estimateTextTokens(summary) >= originalTokens) throw new Error('摘要未缩短上下文');
      this.compactionSummary = summary;
      this.contextStartIndex = cut;
      // 当前主请求可能仍用着旧快照,连同它下一条响应的用量一起作废。
      this.usageFloor = this._messages.length + (this.activeRun ? 1 : 0);
      return { type: 'compaction', summary, tokensBefore, tokensAfter: this.estimateContextTokens() };
    } catch (error) {
      if (!run.isCancelled && revision === this.contextRevision) this.compactionError = `压缩失败:${error instanceof Error ? error.message : String(error)}`;
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // 消息管理
  // ---------------------------------------------------------------------------

  addInfoMessage(text: string): void {
    this.replySequence += 1;
    this._messages.push(createMessage({ id: `info_${this.now()}`, role: 'assistant', replyNumber: this.replySequence, content: text, imageEpoch: this.sendEpoch, createdAt: this.now() }));
  }

  /** 恢复的历史消息 imageEpoch 恒为 0,旧图不会再灌给模型。 */
  restoreMessages(messages: readonly AgentMessage[]): void {
    this._messages.push(...messages.map((m) => ({ ...m, imageEpoch: 0 })));
    this.resetCompaction();
    this.restoreReplyNumbers();
  }

  setMessages(messages: readonly AgentMessage[]): void {
    this._messages.splice(0, this._messages.length, ...messages);
    this.resetCompaction();
    this.restoreReplyNumbers();
  }

  rewindToMessage(messageId: string): boolean {
    const idx = this._messages.findIndex((m) => m.id === messageId);
    if (idx < 0) return false;
    this.truncate(idx + 1);
    return true;
  }

  /** 回到某条消息**之前**:该消息连同其后全部截掉(面板把它放回输入框让用户改)。 */
  rewindBeforeMessage(messageId: string): boolean {
    const idx = this._messages.findIndex((m) => m.id === messageId);
    if (idx < 0) return false;
    this.truncate(idx);
    return true;
  }

  /** 回溯:进行中的后台压缩作废;回溯点落在压缩窗口之外时压缩状态已无意义,重置为完整上下文;编号序列不回退。 */
  private truncate(keepCount: number): void {
    this.invalidateCompaction();
    const sequence = this.replySequence;
    this._messages.splice(keepCount);
    if (keepCount <= this.contextStartIndex) this.resetCompaction();
    this.replySequence = sequence;
    this.usageFloor = this._messages.length;
    this.onContextChanged?.();
  }

  clearMessages(): void {
    this._messages.splice(0);
    this.resetCompaction();
    this.onContextChanged?.();
  }

  /** 恢复 / 替换历史后给 assistant 消息补编号,并把正文里的回显标记洗掉。 */
  private restoreReplyNumbers(): void {
    this.replySequence = 0;
    for (let i = 0; i < this._messages.length; i += 1) {
      const m = this._messages[i];
      if (m.role !== 'assistant') continue;
      const n = m.replyNumber ?? this.replySequence + 1;
      if (n > this.replySequence) this.replySequence = n;
      this._messages[i] = { ...m, replyNumber: n, content: stripReplyMarkers(m.content) };
    }
  }

  private resetCompaction(): void {
    this.invalidateCompaction();
    this.memory.clear();
    this.replySequence = 0;
    this.usageFloor = this._messages.length;
    this.compactionError = null;
    this.compactionSummary = null;
    this.contextStartIndex = 0;
  }
}

type CompactionEvent = Extract<HarnessEvent, { type: 'compaction' }>;

/** 非 ASCII 保守按一字符一 token 估计,避免中文 chars/4 严重低估。 */
export function estimateTextTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 128) ascii += 1; else other += 1;
  }
  return Math.ceil(ascii / 4) + other;
}
