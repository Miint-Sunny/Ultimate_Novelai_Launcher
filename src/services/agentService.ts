/**
 * Agent 服务 —— AI 辅助生成提示词
 *
 * 重构后（单 PR：feat/pydantic-ai-agent）:
 * - 所有 LLM 调用、prompts 加载、prison_break 注入、工具调用循环、JSON 解析
 *   全部下沉到后端 /api/agent/web/generate-prompt（PydanticAI + CLI Proxy API）
 * - 本模块只做:
 *     1. UI 状态管理（日志、进度条、AgentResult 渲染）
 *     2. 单一 SSE 订阅 + 事件分发
 *     3. 生成快照 / 摘要 计算
 * - UI 组件（日志面板、AgentResult 卡片）数据契约保持不变（AgentResult / LogEntry / GenerationSnapshot 都是兼容的）
 */

import { appBackendApi } from '../api/appBackendApi';
import { getAppSettings } from './localLibrary/appSettings';
import { cleanPromptMarkers } from './novelai';

// ==================== 可选 model（与后端 MODEL_CHOICES 对齐）====================
// 与后端 MODEL_CHOICES（novelai_web_ui/server/config.py）保持同步。
// key 传给后端 model 字段；空字符串 = 后端用全局默认 ACTIVE_MODEL。
export interface AiModelChoice {
  key: string;
  label: string;
  shortLabel: string;   // 用于 segmented toggle 紧凑显示
}

export const AI_MODEL_CHOICES: AiModelChoice[] = [
  { key: 'deepseek', label: 'DeepSeek v4 Pro（官方）', shortLabel: 'DeepSeek' },
  { key: 'gemini', label: 'Gemini（3.5 Flash Vertex）', shortLabel: 'Gemini' },
  { key: 'chatgpt', label: 'ChatGPT（gpt-5.4-mini）', shortLabel: 'ChatGPT' },
  { key: 'claude', label: 'Claude Sonnet 4.6（原生协议）', shortLabel: 'Claude' },
  { key: 'glm46', label: 'GLM-4.6（NAI 文本 API）', shortLabel: 'GLM' },
];

// 前端默认选中的 model（与后端 ACTIVE_MODEL 对齐）
export const DEFAULT_AI_MODEL = 'deepseek';

// ==================== 类型定义 ====================

export interface CharacterPrompt {
  name: string;
  positive: string;
  negative?: string;
}

export interface AgentResult {
  thinking: string;
  positive: string;
  negative: string;
  characters: CharacterPrompt[];
  // vibes 字段已从后端 schema 移除，但保留为可选字段以兼容现有 UI 代码
  // 现有 UI 逻辑里访问 result.vibes 都有 `if (vibes && vibes.length > 0)` 守护，
  // 后端不返回 vibes 时这些代码自然跳过 vibe 处理，不会报错
  vibes?: string[];
}

// 日志条目
export interface LogEntry {
  type: 'user' | 'system' | 'success' | 'error';
  content: string;
  timestamp: number;
  collapsed?: boolean; // 是否折叠
  generationIndex?: number; // 生成编号（仅 success 类型）
  snapshot?: GenerationSnapshot; // 生成快照（仅 success 类型）
  thinking?: string; // AI 思考内容（仅 success 类型）
  expanded?: boolean; // 是否展开详情（仅 success 类型）
  imagePreview?: string; // 用户发送的图片预览（仅 user 类型）
  toolDisplayNames?: string[]; // 工具显示名称（仅工具系统日志）
}

// 生成快照（用于撤回和重试）
export interface GenerationSnapshot {
  // 生成后的结果（用于回退恢复）
  positive: string;
  negative: string;
  characters: CharacterPrompt[];
  vibes: string[];
  tokenCount: number;
  // 生成前的状态（用于重试时传给 AI）
  prePositive: string;
  preNegative: string;
  preCharacters: CharacterPrompt[];
}

// 生成摘要
export interface GenerationSummary {
  tokenCount: number;
  referencedVibes: string[];
  referencedArtists: string[];
  referencedOCs: string[];
  referencedRoleTags: string[];
  usedCodex: boolean;
}

export interface AgentState {
  status: 'idle' | 'thinking' | 'done' | 'error';
  result?: AgentResult;
  error?: string;
  progress?: string;
  logs: LogEntry[];
  summary?: GenerationSummary;
}

export interface AgentContext {
  vibes: Array<{ id: string; name: string; supportedModels: string[] }>;
  artists: Array<{ id: string; name: string; prompt: string }>;
  ocs: Array<{
    id: string;
    name: string;
    zhName?: string;
    positive: string;
    negative?: string;
  }>;
  roleTags: Record<
    string,
    {
      role_en: string;
      role_zh: string[];
      origin_en: string;
      origin_zh: string[];
    }
  >;
  currentPositive: string;
  currentNegative: string;
  currentCharacters: Array<{ name: string; positive: string; negative?: string }>;
  codex?: Array<{ id: string; category: string; title: string; content: string; isR18: boolean }>;
}

// 资料源类型（不包含 codex，codex 独立控制）
export type KnowledgeSource = 'roleTags' | 'artists' | 'vibes' | 'ocs';

// 资料源配置
export const KNOWLEDGE_SOURCES: Array<{
  id: KnowledgeSource;
  label: string;
  desc: string;
}> = [
  { id: 'roleTags', label: '中英文角色映射库', desc: '中英文tag映射数据' },
  { id: 'artists', label: '画师串库', desc: '公共+本地画师串数据' },
  { id: 'vibes', label: 'Vibe库', desc: '公共+本地Vibe风格数据' },
  { id: 'ocs', label: 'OC角色库', desc: '公共+本地OC角色tag数据' },
];

// 默认启用的资料源
const DEFAULT_KNOWLEDGE_SOURCES: KnowledgeSource[] = [
  'roleTags',
  'artists',
  'vibes',
  'ocs',
];

type AgentHistoryMessage = { role: 'user' | 'assistant'; content: string };

interface AgentWebRequest {
  user_request: string;
  model: string;
  image_b64?: string;
  image_mime_type: string;
  history: AgentHistoryMessage[];
  use_codex: boolean;
  knowledge_sources: KnowledgeSource[];
  web_artists: Array<{ id: string; name: string; prompt: string }>;
  web_ocs: Array<{
    id: string;
    name: string;
    zh_name: string;
    positive: string;
    negative: string;
  }>;
  web_codex: Array<{
    id: string;
    category: string;
    title: string;
    content: string;
    is_r18: boolean;
  }>;
  current_positive: string;
  current_negative: string;
  current_characters: CharacterPrompt[];
}

type SsePayload = Record<string, unknown> | string | null;

function payloadField(payload: SsePayload, key: string): unknown {
  return payload && typeof payload === 'object' ? payload[key] : undefined;
}

function payloadString(payload: SsePayload, key: string): string | undefined {
  const value = payloadField(payload, key);
  return typeof value === 'string' ? value : undefined;
}

function eventErrorMessage(payload: SsePayload): string {
  if (typeof payload === 'string' && payload.trim()) return payload;
  for (const key of ['message', 'detail', 'title', 'code']) {
    const value = payloadString(payload, key);
    if (value) return value;
  }
  return 'Agent 运行失败';
}

function parseImagePayload(image: string | undefined): {
  base64?: string;
  mimeType: string;
} {
  if (!image) return { mimeType: 'image/png' };

  const dataUrl = image.match(/^data:([^;,]+);base64,([\s\S]+)$/i);
  if (!dataUrl) return { base64: image, mimeType: 'image/png' };

  const mimeType = dataUrl[1].trim().toLowerCase().replace('image/jpg', 'image/jpeg');
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mimeType)) {
    throw new Error('Agent 图片只支持 PNG、JPEG、WebP 或 GIF');
  }
  return { base64: dataUrl[2], mimeType };
}

function parseSseBlock(block: string): { event: string; data: SsePayload } | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const rawLine of block.split(/\r?\n/)) {
    if (rawLine.startsWith('event:')) {
      event = rawLine.slice(6).trim();
    } else if (rawLine.startsWith('data:')) {
      dataLines.push(rawLine.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0) return null;
  const raw = dataLines.join('\n');
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed === 'string') return { event, data: parsed };
    if (typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { event, data: parsed as Record<string, unknown> };
    }
    return { event, data: raw };
  } catch {
    return { event, data: raw };
  }
}

// ==================== Agent 服务类 ====================

type AgentEventListener = (state: AgentState) => void;

class AgentService {
  private listeners: Set<AgentEventListener> = new Set();
  private state: AgentState = { status: 'idle', logs: [] };
  private context: AgentContext | null = null;
  private abortController: AbortController | null = null;
  private useCodex: boolean = false;            // 独立的法典开关
  private generationCounter: number = 0;        // 生成计数器

  // 日志延迟显示
  private lastLogTime = 0;
  private logDelay = 350;
  private logPromise: Promise<void> = Promise.resolve();

  getState(): AgentState {
    return { ...this.state, logs: [...this.state.logs] };
  }

  // 切换日志展开状态
  toggleLogExpanded(index: number) {
    if (this.state.logs[index]) {
      this.state.logs[index].expanded = !this.state.logs[index].expanded;
      this.emit();
    }
  }

  getLogs(): LogEntry[] {
    return [...this.state.logs];
  }

  addLog(type: LogEntry['type'], content: string, extra?: Partial<LogEntry>) {
    this.logPromise = this.logPromise.then(async () => {
      const now = Date.now();
      const timeSinceLastLog = now - this.lastLogTime;
      if (timeSinceLastLog < this.logDelay) {
        await new Promise(resolve => setTimeout(resolve, this.logDelay - timeSinceLastLog));
      }
      const logEntry: LogEntry = {
        type,
        content,
        timestamp: Date.now(),
        ...extra,
      };
      this.state.logs.push(logEntry);
      if (this.state.progress) {
        this.state.progress = undefined;
      }
      this.lastLogTime = Date.now();
      this.emit();
    });
  }

  clearLogs() {
    this.state.logs = [];
    this.state.summary = undefined;
    this.lastLogTime = 0;
    this.logPromise = Promise.resolve();
    this.emit();
  }

  truncateLogsTo(index: number) {
    this.state.logs = this.state.logs.slice(0, index + 1);
    const successLogs = this.state.logs.filter(l => l.type === 'success');
    this.generationCounter = successLogs.length;
    this.state.summary = undefined;
    this.lastLogTime = Date.now();
    this.logPromise = Promise.resolve();
    this.emit();
  }

  findUserRequestIndex(successLogIndex: number): number {
    for (let i = successLogIndex - 1; i >= 0; i--) {
      if (this.state.logs[i].type === 'user') {
        return i;
      }
    }
    return -1;
  }

  truncateToUserRequest(successLogIndex: number): { request: string; image?: string } | null {
    const userIndex = this.findUserRequestIndex(successLogIndex);
    if (userIndex === -1) return null;

    const userRequest = this.state.logs[userIndex].content;
    const userImage = this.state.logs[userIndex].imagePreview;

    this.state.logs = this.state.logs.slice(0, userIndex);

    const successLogs = this.state.logs.filter(l => l.type === 'success');
    this.generationCounter = successLogs.length;
    this.state.summary = undefined;
    this.lastLogTime = Date.now();
    this.logPromise = Promise.resolve();
    this.emit();

    return { request: userRequest, image: userImage };
  }

  getUseCodex(): boolean {
    return this.useCodex;
  }

  setUseCodex(value: boolean) {
    this.useCodex = value;
  }

  addEventListener(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    this.listeners.forEach((listener) => {
      try {
        listener(this.getState());
      } catch (e) {
        console.error('Agent event listener error:', e);
      }
    });
  }

  private updateState(partial: Partial<AgentState>) {
    this.state = { ...this.state, ...partial };
    this.emit();
  }

  private buildAssistantHistoryFromSuccess(log: LogEntry): string {
    return (log.content || '').trim();
  }

  setContext(context: AgentContext) {
    this.context = context;
  }

  cancel() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.updateState({ status: 'idle' });
  }

  reset() {
    this.cancel();
    this.state = { status: 'idle', logs: [] };
    this.generationCounter = 0;
    this.emit();
  }

  resetLogs() {
    this.state.logs = [];
    this.state.summary = undefined;
    this.generationCounter = 0;
    this.emit();
  }

  /**
   * 整体替换当前 logs（用于 AI 助手浮窗的"打开历史会话"功能）。
   * 不主动触发 SSE，只复原 UI 状态。
   */
  loadLogs(logs: LogEntry[]) {
    this.state.logs = [...logs];
    this.state.summary = undefined;
    const successLogs = logs.filter(l => l.type === 'success');
    this.generationCounter = successLogs.length;
    this.lastLogTime = Date.now();
    this.logPromise = Promise.resolve();
    this.emit();
  }

  // ==================== execute（重构后：单一 SSE 订阅）====================

  /**
   * 执行 AI Agent 生成提示词。
   *
   * 数据流（与旧实现的关键差异）:
   *   旧 - 前端构 Gemini contents → 调 /api/agent/proxy → 工具循环 × 3 → 抽 JSON
   *   新 - 前端发请求 → /api/agent/web/generate-prompt 走 SSE → 收 final 即拿到 AgentResult
   *
   * UI 行为完全保持：日志面板增量更新、折叠系统日志、success 卡片含 snapshot + summary。
   */
  async execute(
    userRequest: string,
    model: string = '',
    skipUserLog = false,
    imageBase64?: string,
  ): Promise<AgentResult | null> {
    const availability = appBackendApi.desktopAgentAvailability();
    if (!availability.available) {
      const message = availability.reason || '当前后端不支持完整桌面 Agent';
      this.addLog('error', message);
      this.updateState({ status: 'error', error: message });
      return null;
    }

    if (!this.context) {
      this.updateState({ status: 'error', error: '未设置上下文' });
      return null;
    }

    // 折叠之前的系统日志，但保留成功日志和用户日志
    this.state.logs = this.state.logs.map(log =>
      log.type === 'system' ? { ...log, collapsed: true } : log
    );
    this.state.summary = undefined;

    const controller = new AbortController();
    this.abortController = controller;
    this.updateState({ status: 'thinking', progress: undefined });

    // 添加用户日志（保留旧实现的延迟队列语义）
    if (!skipUserLog) {
      const userLogEntry: LogEntry = {
        type: 'user',
        content: userRequest,
        timestamp: Date.now(),
        imagePreview: imageBase64,
      };
      this.logPromise = this.logPromise.then(async () => {
        this.state.logs.push(userLogEntry);
        this.lastLogTime = Date.now();
        this.emit();
      });
    }

    // 从已完成的对话日志（user + success）重建 history
    const history: AgentHistoryMessage[] = [];
    let lastSuccessIdx = -1;
    for (let i = this.state.logs.length - 1; i >= 0; i--) {
      if (this.state.logs[i].type === 'success') {
        lastSuccessIdx = i;
        break;
      }
    }
    for (let i = 0; i <= lastSuccessIdx; i++) {
      const log = this.state.logs[i];
      if (log.type === 'user') {
        history.push({ role: 'user', content: log.content });
      } else if (log.type === 'success') {
        const assistantHistory = this.buildAssistantHistoryFromSuccess(log);
        if (assistantHistory) {
          history.push({ role: 'assistant', content: assistantHistory });
        }
      }
    }

    // 从工具调用事件累积的引用数据（生成摘要用）
    const referencedVibes: string[] = [];
    const referencedArtists: string[] = [];
    const referencedOCs: string[] = [];
    const referencedRoleTags: string[] = [];
    let responseReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

    try {
      const image = parseImagePayload(imageBase64);
      const isLocalSidecar = getAppSettings().serverMode !== 'custom';
      const body: AgentWebRequest = {
        user_request: userRequest,
        // Both Agent phases use the sidecar's configured primary model. The
        // private-cloud protocol keeps the existing per-request model keys.
        model: isLocalSidecar ? '' : model,
        image_b64: image.base64,
        image_mime_type: image.mimeType,
        history,
        use_codex: this.useCodex,
        knowledge_sources: [...DEFAULT_KNOWLEDGE_SOURCES],
        web_artists: this.context.artists.map(a => ({
          id: a.id,
          name: a.name,
          prompt: a.prompt,
        })),
        web_ocs: this.context.ocs.map(o => ({
          id: o.id,
          name: o.name,
          zh_name: o.zhName || o.name,
          positive: o.positive,
          negative: o.negative || '',
        })),
        web_codex: this.useCodex
          ? (this.context.codex ?? []).map(item => ({
              id: item.id,
              category: item.category,
              title: item.title,
              content: item.content,
              is_r18: item.isR18,
            }))
          : [],
        current_positive: cleanPromptMarkers(this.context.currentPositive || ''),
        current_negative: cleanPromptMarkers(this.context.currentNegative || ''),
        current_characters: this.context.currentCharacters.map(c => ({
          name: c.name,
          positive: cleanPromptMarkers(c.positive),
          negative: cleanPromptMarkers(c.negative ?? ''),
        })),
      };

      const resp = await appBackendApi.openSse('/api/agent/web/generate-prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!resp.body) {
        throw new Error('响应没有 body 流');
      }

      // ---- SSE 流式解析 ----
      let finalResult: AgentResult | null = null;
      const reader = resp.body.getReader();
      responseReader = reader;
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        if (controller.signal.aborted) throw new DOMException('aborted', 'AbortError');
        const { done, value } = await reader.read();
        if (done) {
          buf += decoder.decode();
        } else {
          buf += decoder.decode(value, { stream: true });
        }

        let boundary = buf.match(/\r?\n\r?\n/);
        while (boundary?.index !== undefined) {
          const block = buf.slice(0, boundary.index);
          buf = buf.slice(boundary.index + boundary[0].length);
          const parsed = parseSseBlock(block);
          if (!parsed) {
            boundary = buf.match(/\r?\n\r?\n/);
            continue;
          }
          const { event: evt, data } = parsed;

          if (evt === 'tool_call') {
            const name = payloadString(data, 'name') || 'unknown';
            const rawArgs = payloadField(data, 'arguments');
            const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
              ? rawArgs as Record<string, unknown>
              : {};
            // 累积引用统计（按 tool name 粗略归类）
            // 注：search_oc/search_vibe 已被后端合并/删除，分支保留作 dead code 兼容老 server
            // search_character 现在一次同时查通用角色库 + OC 库，referencedOCs 暂无法从 tool_call 层精确区分
            if (name === 'search_artist' && args.keyword) referencedArtists.push(String(args.keyword));
            else if (name === 'random_artist') { /* 等 tool_result 时统计 */ }
            else if (name === 'search_character' && args.query) {
              referencedRoleTags.push(String(args.query));
            }
            // 兼容旧 server（已废弃）
            else if (name === 'search_vibe' && args.query) referencedVibes.push(String(args.query));
            else if (name === 'search_oc' && args.query) referencedOCs.push(String(args.query));
            this.addLog('system', `🐾 调用工具 ${name}`, { toolDisplayNames: [name] });
          } else if (evt === 'tool_result') {
            const summary = payloadString(data, 'summary');
            if (summary) this.addLog('system', `↳ ${summary}`);
          } else if (evt === 'delegate_start') {
            const target = payloadString(data, 'target') || 'sub-agent';
            this.addLog('system', `🪄 委派子任务: ${target}`);
          } else if (evt === 'delegate_end') {
            // silent
          } else if (evt === 'agent_token') {
            // 暂不展示打字机；如需启用可在此追加 progress 文本
          } else if (evt === 'final') {
            if (!data || typeof data !== 'object') throw new Error('Agent final 事件格式无效');
            finalResult = data as unknown as AgentResult;
          } else if (evt === 'error') {
            throw new Error(eventErrorMessage(data));
          } else if (evt === 'degraded') {
            this.addLog(
              'system',
              payloadString(data, 'reason') === 'llm_backup'
                ? '⚠️ 主模型不可用，本轮已切换备用模型'
                : '⚠️ Agent 已进入降级模式',
            );
          }
          boundary = buf.match(/\r?\n\r?\n/);
        }
        if (done) break;
      }

      if (!finalResult) {
        throw new Error('未收到 final 事件');
      }

      // ---- 后处理：与旧实现保持一致 ----

      // 1) vibe 名称 → ID 映射（防止后端返回的是名称）
      if (finalResult.vibes && finalResult.vibes.length > 0 && this.context.vibes.length > 0) {
        const matchedVibeIds: string[] = [];
        for (const vibeKey of finalResult.vibes) {
          const v = this.context.vibes.find(
            x =>
              x.id === vibeKey ||
              x.name.toLowerCase() === vibeKey.toLowerCase() ||
              x.name.includes(vibeKey) ||
              vibeKey.includes(x.name),
          );
          if (v) {
            matchedVibeIds.push(v.id);
            if (!referencedVibes.includes(v.name)) referencedVibes.push(v.name);
          }
        }
        finalResult.vibes = matchedVibeIds;
      }

      // 2) token 估算（与旧实现相同：逗号分隔的 tag 数量）
      const estimateTokens = (text: string): number => {
        if (!text) return 0;
        return text.split(',').filter(t => t.trim()).length;
      };
      let totalTokens = estimateTokens(finalResult.positive) + estimateTokens(finalResult.negative);
      finalResult.characters.forEach(c => {
        totalTokens += estimateTokens(c.positive);
        if (c.negative) totalTokens += estimateTokens(c.negative);
      });

      // 3) 生成快照（撤回 / 重试用）
      const snapshot: GenerationSnapshot = {
        positive: finalResult.positive,
        negative: finalResult.negative,
        characters: finalResult.characters,
        vibes: finalResult.vibes ?? [],
        tokenCount: totalTokens,
        prePositive: this.context.currentPositive || '',
        preNegative: this.context.currentNegative || '',
        preCharacters: this.context.currentCharacters.map(c => ({
          name: c.name,
          positive: c.positive,
          negative: c.negative,
        })),
      };

      // 4) 生成摘要
      const summary: GenerationSummary = {
        tokenCount: totalTokens,
        referencedVibes,
        referencedArtists,
        referencedOCs,
        referencedRoleTags,
        usedCodex: this.useCodex,
      };

      // 5) 等之前的日志队列冲刷，再加 success 日志（保持原有 UI 节奏）
      await this.logPromise;
      await new Promise(r => setTimeout(r, this.logDelay));

      // 折叠之前的系统日志
      this.state.logs = this.state.logs.map(log =>
        log.type === 'system' ? { ...log, collapsed: true } : log,
      );

      this.generationCounter++;
      const msg = finalResult.thinking || '已根据您的要求生成提示词惹喵~';
      const meta = totalTokens > 0 ? `#${this.generationCounter} 生成完毕 · ${totalTokens} Tokens` : undefined;
      const successLog: LogEntry = {
        type: 'success',
        content: msg,
        timestamp: Date.now(),
        generationIndex: this.generationCounter,
        snapshot,
        thinking: meta,
        expanded: totalTokens > 0,
      };
      this.state.logs.push(successLog);
      this.lastLogTime = Date.now();
      this.emit();

      this.updateState({ status: 'done', result: finalResult, summary });
      return finalResult;
    } catch (error) {
      if (controller.signal.aborted) return null;
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.addLog('error', `生成失败: ${errorMsg}`);
      this.updateState({ status: 'error', error: errorMsg });
      return null;
    } finally {
      await responseReader?.cancel().catch(() => undefined);
      if (this.abortController === controller) this.abortController = null;
    }
  }
}

export const agentService = new AgentService();
export type { AgentService };
