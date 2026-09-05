/**
 * LLM provider:走 sidecar 的 `POST /api/v1/agent/llm/chat`(契约 §2)。
 *
 * 密钥不出 sidecar,请求里没有 model 字段。这里只负责把消息与工具装成 OpenAI 形状、
 * 把流开始前的 Problem Details 与流中的 sidecar 事件映射成 harness 事件。
 * 传输层(fetch)注入,所以核心在 node 里也能跑校验脚本。
 */

import { parseOpenAiStream, sseLinesFromReader } from './openaiStream';
import { toolToOpenAiFunction, type AgentTool } from './tools';
import { messageToOpenAi, type AgentMessage, type HarnessEvent } from './types';
import { resolveThinkingFormat, thinkingParams } from './thinkingFormat';

export interface StreamChatOptions {
  messages: readonly AgentMessage[];
  tools: readonly AgentTool[];
  temperature?: number;
  promptCacheKey?: string | null;
  signal?: AbortSignal;
}

export interface LlmProvider {
  /** 当前模型 id(会话记录元数据用);sidecar 从响应头回报后更新。 */
  readonly modelId: string;
  streamChat(options: StreamChatOptions): AsyncGenerator<HarnessEvent>;
}

export interface SidecarLlmProviderOptions {
  /** 形如 `(path, init) => fetch(...)`,由调用方带上鉴权头。 */
  fetchImpl: (path: string, init: RequestInit) => Promise<Response>;
  /** 槽位的 base URL(GET /settings 的 llm_base_url),决定思考参数格式。 */
  llmBaseUrl: string;
  reasoning?: boolean;
  thinkingEffort?: string | null;
  thinkingFormat?: string | null;
  maxTokens?: number;
}

export const AGENT_LLM_CHAT_PATH = '/api/v1/agent/llm/chat';

const TRANSIENT_STATUSES = new Set([408, 425, 429]);

/** OpenAI 官方限制 prompt_cache_key 不超过 64 字符。 */
export function clampPromptCacheKey(key: string | null | undefined): string | undefined {
  if (!key) return undefined;
  const chars = [...key];
  return chars.length <= 64 ? key : chars.slice(0, 64).join('');
}

export function buildAgentChatBody(options: StreamChatOptions, provider: SidecarLlmProviderOptions): Record<string, unknown> {
  const format = resolveThinkingFormat(provider.llmBaseUrl, provider.thinkingFormat);
  const thinking = thinkingParams(format, provider.reasoning ?? false, provider.thinkingEffort);
  const body: Record<string, unknown> = {
    messages: options.messages.map(messageToOpenAi),
    temperature: options.temperature ?? 0.7,
    extra_body: thinking.extraBody,
  };
  if (options.tools.length > 0) {
    body.tools = options.tools.map(toolToOpenAiFunction);
    body.tool_choice = 'auto';
  }
  if (thinking.reasoningEffort) body.reasoning_effort = thinking.reasoningEffort;
  if (provider.maxTokens) body.max_tokens = provider.maxTokens;
  const cacheKey = clampPromptCacheKey(options.promptCacheKey);
  if (cacheKey) body.prompt_cache_key = cacheKey;
  return body;
}

export function createSidecarLlmProvider(options: SidecarLlmProviderOptions): LlmProvider {
  let modelId = '';
  return {
    get modelId() {
      return modelId;
    },
    async *streamChat(chat: StreamChatOptions): AsyncGenerator<HarnessEvent> {
      let response: Response;
      try {
        response = await options.fetchImpl(AGENT_LLM_CHAT_PATH, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify(buildAgentChatBody(chat, options)),
          signal: chat.signal,
        });
      } catch (error) {
        yield { type: 'error', error: `网络请求异常: ${error instanceof Error ? error.message : String(error)}`, transient: true };
        return;
      }

      if (response.status < 200 || response.status >= 300) {
        // 流开始前的失败是 Problem Details;retryable 由 sidecar 给,没给就按状态码。
        let detail: Record<string, unknown> = {};
        try { detail = await response.json(); } catch { /* 非 JSON 正文 */ }
        const code = typeof detail.code === 'string' ? detail.code : `http_${response.status}`;
        const message = typeof detail.message === 'string' ? detail.message : typeof detail.detail === 'string' ? detail.detail : response.statusText;
        const retryable = typeof detail.retryable === 'boolean'
          ? detail.retryable
          : TRANSIENT_STATUSES.has(response.status) || response.status >= 500;
        yield { type: 'error', error: `${code}: ${message}`, transient: retryable && response.status !== 401 && response.status !== 422 && response.status !== 400 };
        return;
      }

      const model = response.headers.get('X-Llm-Model');
      if (model) modelId = model;
      if (!response.body) {
        yield { type: 'error', error: 'LLM 响应没有正文', transient: true };
        return;
      }
      yield* parseOpenAiStream(sseLinesFromReader(response.body.getReader()));
    },
  };
}
