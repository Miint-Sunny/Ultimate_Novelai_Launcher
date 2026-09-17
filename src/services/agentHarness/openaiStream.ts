/**
 * OpenAI 流式 chat.completion.chunk → HarnessEvent。
 *
 * 逐条移植他的 `openai_provider.dart` 解析段:
 * - 原生思考字段按 reasoning_content → reasoning → reasoning_text 短路取第一个非空;
 * - `<think>` 内嵌标签容错:标签可能被拆到多个 chunk,尾部前缀先缓冲再判定;
 * - tool_calls 按 `index` 累积拼装,流结束后统一发 tool_call 事件;
 * - usage 块(include_usage 时末 chunk 的 choices 为空)。
 *
 * 加上 sidecar 自己的两种事件(契约 §2.2):`event: degraded`、`event: error`。
 */

import { usageFromOpenAiJson, usageTotal, type HarnessEvent, type TokenUsage, type ToolCall } from './types';

const OPEN_THINK = '<think>';
const CLOSE_THINK = '</think>';

/** s 尾部与 tag 前缀重叠的最长长度(0 .. tag.length-1)。 */
export function tailTagOverlap(s: string, tag: string): number {
  const maxLen = Math.min(s.length, tag.length - 1);
  for (let len = maxLen; len > 0; len -= 1) {
    if (s.endsWith(tag.slice(0, len))) return len;
  }
  return 0;
}

/** 把字节流切成行(统一 \n),给浏览器端用;测试直接喂字符串数组。 */
export async function* sseLinesFromReader(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    let nl = buffer.indexOf('\n');
    while (nl >= 0) {
      yield buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf('\n');
    }
  }
  buffer += decoder.decode();
  if (buffer) yield buffer;
}

export async function* linesFromText(text: string): AsyncGenerator<string> {
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) yield line;
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
}

/**
 * 解析一条 SSE 行流。遇到 sidecar 的 `event: error` 直接以 transient 错误收尾;
 * 传输层异常(reader 抛错)同样按瞬态处理——多半是服务端提前断连,交给上层退避。
 */
export async function* parseOpenAiStream(lines: AsyncIterable<string>): AsyncGenerator<HarnessEvent> {
  const accumulator = new Map<number, ToolCallAccumulator>();
  let inThink = false;
  let pendingTag = '';
  let pendingEvent: string | null = null;
  let sawAnything = false;
  // 流式 usage 快照:newapi 系网关会在每个 chunk 回传全量累计 usage,逐 chunk 上报会按 chunk 数重复记账;
  // 对齐 pi 的 parseChunkUsage:逐 chunk 覆盖(last-wins),整条流(含中断)只发一次 usage。
  let latestUsage: TokenUsage | null = null;
  const flushUsage = function* (): Generator<HarnessEvent> {
    if (latestUsage) { yield { type: 'usage', usage: latestUsage }; latestUsage = null; }
  };

  const flushPending = function* (): Generator<HarnessEvent> {
    if (pendingTag) {
      yield inThink ? { type: 'thought_delta', delta: pendingTag } : { type: 'content_delta', delta: pendingTag };
      pendingTag = '';
    }
  };

  try {
    for await (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) { pendingEvent = null; continue; }
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) { pendingEvent = line.slice(6).trim(); continue; }
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();

      if (pendingEvent === 'error') {
        let payload: Record<string, unknown> = {};
        try { payload = JSON.parse(data); } catch { /* 按瞬态处理 */ }
        yield* flushPending();
        yield* flushUsage();
        yield {
          type: 'error',
          error: typeof payload.message === 'string' ? payload.message : 'LLM 流中断',
          transient: payload.retryable !== false,
        };
        return;
      }
      if (pendingEvent === 'degraded') {
        let payload: Record<string, unknown> = {};
        try { payload = JSON.parse(data); } catch { /* 忽略 */ }
        yield {
          type: 'degraded',
          slot: typeof payload.slot === 'string' ? payload.slot : 'backup',
          reason: typeof payload.reason === 'string' ? payload.reason : 'llm_backup',
        };
        pendingEvent = null;
        continue;
      }
      pendingEvent = null;

      if (data === '[DONE]') break;
      let json: Record<string, unknown>;
      try { json = JSON.parse(data); } catch { continue; }
      sawAnything = true;

      const usage = json.usage;
      if (usage && typeof usage === 'object') {
        const parsed = usageFromOpenAiJson(usage);
        if (usageTotal(parsed) > 0) latestUsage = parsed;
      }

      const choices = json.choices;
      if (!Array.isArray(choices) || choices.length === 0) continue;
      const first = choices[0] as Record<string, unknown>;
      // Moonshot 风格把 usage 挂在 choice 上;顶层优先,只在顶层没给时看它。
      if (!(usage && typeof usage === 'object') && first.usage && typeof first.usage === 'object') {
        const parsed = usageFromOpenAiJson(first.usage);
        if (usageTotal(parsed) > 0) latestUsage = parsed;
      }
      const delta = first.delta;
      if (!delta || typeof delta !== 'object') continue;
      const d = delta as Record<string, unknown>;

      // 1. 原生思考字段
      for (const key of ['reasoning_content', 'reasoning', 'reasoning_text']) {
        const raw = d[key];
        if (typeof raw === 'string' && raw.length > 0) {
          yield { type: 'thought_delta', delta: raw };
          break;
        }
      }

      // 2. content(内嵌 <think> 容错)
      const content = d.content;
      if (typeof content === 'string' && content.length > 0) {
        let rest = pendingTag + content;
        pendingTag = '';
        while (rest.length > 0) {
          const tag = inThink ? CLOSE_THINK : OPEN_THINK;
          const idx = rest.indexOf(tag);
          if (idx < 0) {
            const overlap = tailTagOverlap(rest, tag);
            const emitLen = rest.length - overlap;
            if (emitLen > 0) {
              const emit = rest.slice(0, emitLen);
              yield inThink ? { type: 'thought_delta', delta: emit } : { type: 'content_delta', delta: emit };
            }
            if (overlap > 0) pendingTag = rest.slice(emitLen);
            break;
          }
          if (idx > 0) {
            const emit = rest.slice(0, idx);
            yield inThink ? { type: 'thought_delta', delta: emit } : { type: 'content_delta', delta: emit };
          }
          rest = rest.slice(idx + tag.length);
          inThink = !inThink;
        }
      }

      // 3. tool_calls 流式组装
      const toolCalls = d.tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls as Array<Record<string, unknown>>) {
          const index = typeof tc.index === 'number' ? tc.index : 0;
          let current = accumulator.get(index);
          if (!current) {
            current = { id: typeof tc.id === 'string' ? tc.id : `call_${Date.now()}_${index}`, name: '', arguments: '' };
            accumulator.set(index, current);
          }
          if (typeof tc.id === 'string') current.id = tc.id;
          const fn = tc.function;
          if (fn && typeof fn === 'object') {
            const f = fn as Record<string, unknown>;
            if (typeof f.name === 'string') current.name += f.name;
            if (typeof f.arguments === 'string') current.arguments += f.arguments;
          }
        }
      }
    }
  } catch (error) {
    yield* flushPending();
    // 中断也要把已经花掉的 token 记上。
    yield* flushUsage();
    yield { type: 'error', error: `解析流式数据异常: ${error instanceof Error ? error.message : String(error)}`, transient: true };
    return;
  }

  yield* flushPending();
  yield* flushUsage();
  void sawAnything;

  for (const [, raw] of [...accumulator.entries()].sort((a, b) => a[0] - b[0])) {
    if (!raw.name) continue;
    let args: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(raw.arguments || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed;
    } catch { /* 参数不是合法 JSON 时给空对象,让工具自己报参数错 */ }
    const toolCall: ToolCall = { id: raw.id, name: raw.name, arguments: args };
    yield { type: 'tool_call', toolCall };
  }
}
