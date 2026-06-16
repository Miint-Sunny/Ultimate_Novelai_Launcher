import { Tokenizer } from '@huggingface/tokenizers';
import t5TokenizerJson from '../assets/tokenizer/t5_tokenizer.json';

const tokenCache = new Map<string, number>();
const MAX_CACHE_SIZE = 1000;

const naiT5Tokenizer = new Tokenizer(t5TokenizerJson as object, {});

function normalizePromptForNaiT5(text: string): string {
  return text
    .replace(/[[\]{}]/g, '')
    .replace(/-?\d*\.?\d*::/g, '');
}

function rememberTokenCount(text: string, tokenCount: number): number {
  if (tokenCache.size >= MAX_CACHE_SIZE) {
    const keys = Array.from(tokenCache.keys());
    keys.slice(0, MAX_CACHE_SIZE / 2).forEach((key) => tokenCache.delete(key));
  }
  tokenCache.set(text, tokenCount);
  return tokenCount;
}

export function countTokens(text: string): number {
  if (!text || text.trim() === '') return 0;

  const cached = tokenCache.get(text);
  if (cached !== undefined) return cached;

  const normalized = normalizePromptForNaiT5(text);
  if (!normalized.trim()) return rememberTokenCount(text, 0);

  return rememberTokenCount(text, naiT5Tokenizer.encode(normalized).ids.length);
}

export function countTokensBatch(texts: string[]): number[] {
  return texts.map(countTokens);
}

export function countTotalTokens(
  mainPrompt: string,
  characterPrompts: Array<{ positive: string; negative: string; enabled: boolean }>,
  preset: { positive: string; negative: string } | undefined,
  mode: 'positive' | 'negative'
): number {
  let total = countTokens(mainPrompt);

  for (const char of characterPrompts) {
    if (char.enabled) {
      total += countTokens(mode === 'positive' ? char.positive : char.negative);
    }
  }

  if (preset) {
    total += countTokens(mode === 'positive' ? preset.positive : preset.negative);
  }

  return total;
}

export function clearTokenCache(): void {
  tokenCache.clear();
}
