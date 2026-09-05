/**
 * 思考参数兼容矩阵。照抄他的 `resolvedThinkingFormat` / `_applyThinkingParams`
 * (它又是对齐 pi openai-completions 的 thinkingFormat 分支):不同供应商用不同字段
 * 开关思维链,格式不匹配时思考会被上游静默丢弃;Qwen / DeepSeek / Z.ai 关闭思考
 * 也要显式发 disabled。
 *
 * 我们这边模型在 sidecar 的槽位里,客户端只按 `GET /settings` 的 `llm_base_url`
 * 域名判定格式,把结果写进请求的 `extra_body` / `reasoning_effort`(契约 §2.1)。
 */

export type ThinkingFormat = 'openai' | 'deepseek' | 'qwen' | 'qwen_chat_template' | 'zai' | 'openrouter' | 'together';

export function resolveThinkingFormat(baseUrl: string, configured?: string | null): ThinkingFormat {
  const explicit = configured?.trim();
  if (explicit && explicit !== 'auto') return explicit as ThinkingFormat;
  const url = baseUrl.toLowerCase();
  if (url.includes('openrouter.ai')) return 'openrouter';
  if (url.includes('deepseek.com')) return 'deepseek';
  if (url.includes('dashscope') || url.includes('aliyuncs')) return 'qwen';
  if (url.includes('z.ai') || url.includes('zhipu') || url.includes('bigmodel')) return 'zai';
  if (url.includes('together.ai')) return 'together';
  return 'openai';
}

export interface ThinkingParams {
  extraBody: Record<string, unknown>;
  reasoningEffort?: string;
}

/**
 * effort 为空 = 模型不具备思考能力,什么都不发。
 * `reasoning` 是开关;`effort` 是档位(none/minimal/low/medium/high/xhigh)。
 */
export function thinkingParams(format: ThinkingFormat, reasoning: boolean, effort?: string | null): ThinkingParams {
  const level = effort?.trim();
  if (!level) return { extraBody: {} };
  const out: ThinkingParams = { extraBody: {} };
  switch (format) {
    case 'deepseek':
      out.extraBody.thinking = { type: reasoning ? 'enabled' : 'disabled' };
      if (reasoning) out.reasoningEffort = level;
      break;
    case 'qwen':
      out.extraBody.enable_thinking = reasoning;
      if (reasoning) out.reasoningEffort = level;
      break;
    case 'qwen_chat_template':
      out.extraBody.chat_template_kwargs = { enable_thinking: reasoning, preserve_thinking: true };
      break;
    case 'zai':
      out.extraBody.thinking = reasoning ? { type: 'enabled', clear_thinking: false } : { type: 'disabled' };
      if (reasoning) out.reasoningEffort = level;
      break;
    case 'openrouter':
      out.extraBody.reasoning = { effort: reasoning ? level : 'none' };
      break;
    case 'together':
      out.extraBody.reasoning = { enabled: reasoning };
      if (reasoning) out.reasoningEffort = level;
      break;
    default:
      if (reasoning) out.reasoningEffort = level;
  }
  return out;
}
