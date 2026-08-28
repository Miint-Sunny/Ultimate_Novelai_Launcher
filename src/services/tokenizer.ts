import { Tokenizer } from '@huggingface/tokenizers';
import type { PromptTokenizerKind } from '../components/generation/modelResolutionOptions';
import t5TokenizerJson from '../assets/tokenizer/t5_tokenizer.json';
import { countQwenTokensIfReady, ensureQwenTokenizer } from './qwenTokenizer';

const tokenCache = new Map<string, number>();
const MAX_CACHE_SIZE = 1000;

const naiT5Tokenizer = new Tokenizer(t5TokenizerJson as object, {});

// T5 口径的权重记号剥离。只适用于 T5:它的词表把 {}、:: 之类字符当未知字符忽略,
// 剥掉只是避免它们干扰逗号分段。**Qwen 会把这些字符真实编码进 token**(官网
// "4::blending::" 计 5、"blending" 计 2,参考仓 Aaalice_NAI_Launcher 实测),
// 剥离会让 V5 读数偏小,所以 Qwen 分支原样计数、不做这一步。
function normalizePromptForNaiT5(text: string): string {
  return text
    .replace(/[[\]{}]/g, '')
    .replace(/-?\d*\.?\d*::/g, '');
}

// 缓存键必须带口径:同一段文本在 V4(T5)与 V5(Qwen)下读数不同。
const cacheKey = (tokenizer: PromptTokenizerKind, text: string): string =>
  `${tokenizer}\u0000${text}`;

function rememberTokenCount(tokenizer: PromptTokenizerKind, text: string, tokenCount: number): number {
  if (tokenCache.size >= MAX_CACHE_SIZE) {
    const keys = Array.from(tokenCache.keys());
    keys.slice(0, MAX_CACHE_SIZE / 2).forEach((key) => tokenCache.delete(key));
  }
  tokenCache.set(cacheKey(tokenizer, text), tokenCount);
  return tokenCount;
}

/**
 * 数一段提示词的 token。口径由调用方经 promptTokenizerForModel(model) 传入
 * (V5 → 'qwen35',V4 系 → 't5'),缺省 T5 保持历史行为。
 *
 * Qwen 词表(gzip 后约 1.3MB)懒加载:未就绪时先返回 T5 近似值顶住 UI 并触发
 * 后台加载,就绪后消费方经 useQwenTokenizerReady 重算;近似值不写缓存,不会
 * 被误当精确值钉住。计数只用于提示,不拦截生成。
 */
export function countTokens(text: string, tokenizer: PromptTokenizerKind = 't5'): number {
  if (!text || text.trim() === '') return 0;

  const cached = tokenCache.get(cacheKey(tokenizer, text));
  if (cached !== undefined) return cached;

  if (tokenizer === 'qwen35') {
    const exact = countQwenTokensIfReady(text);
    if (exact !== null) {
      return rememberTokenCount('qwen35', text, exact);
    }
    // 不缓存近似值;失败静默,下次计数自然重试。
    void ensureQwenTokenizer().catch(() => undefined);
  }

  // T5 精确路径,同时充当 Qwen 未就绪时的近似。
  const normalized = normalizePromptForNaiT5(text);
  if (!normalized.trim()) return rememberTokenCount(tokenizer, text, 0);

  return rememberTokenCount(tokenizer, text, naiT5Tokenizer.encode(normalized).ids.length);
}

export function countTokensBatch(texts: string[], tokenizer: PromptTokenizerKind = 't5'): number[] {
  return texts.map((text) => countTokens(text, tokenizer));
}

export function countTotalTokens(
  mainPrompt: string,
  characterPrompts: Array<{ positive: string; negative: string; enabled: boolean }>,
  preset: { positive: string; negative: string } | undefined,
  mode: 'positive' | 'negative',
  tokenizer: PromptTokenizerKind = 't5'
): number {
  let total = countTokens(mainPrompt, tokenizer);

  for (const char of characterPrompts) {
    if (char.enabled) {
      total += countTokens(mode === 'positive' ? char.positive : char.negative, tokenizer);
    }
  }

  if (preset) {
    total += countTokens(mode === 'positive' ? preset.positive : preset.negative, tokenizer);
  }

  return total;
}

export function clearTokenCache(): void {
  tokenCache.clear();
}
