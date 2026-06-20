// 翻译辅助（translation helpers）
// Gemini 标签翻译（带 localStorage 持久化缓存 + 批量合并队列）、
// AI 中文→英文标签推荐、AI 中文→单英文标签直译。
// 翻译行为、缓存与节流策略保持不变。

import { requestSidecarChatCompletion, submitTagTranslations } from '../translate';

// Gemini 翻译缓存（启动时从 localStorage 恢复）
const TRANSLATE_CACHE_KEY = 'tag_translate_cache';
const TRANSLATE_CACHE_MAX = 2000;

const geminiTranslateCache = new Map<string, string>();

// 从 localStorage 恢复翻译缓存
try {
  const stored = localStorage.getItem(TRANSLATE_CACHE_KEY);
  if (stored) {
    const entries: [string, string][] = JSON.parse(stored);
    for (const [k, v] of entries) geminiTranslateCache.set(k, v);
  }
} catch { /* ignore */ }

// 持久化翻译缓存（节流，最多每 5 秒写一次）
let persistTimer: ReturnType<typeof setTimeout> | null = null;
function persistTranslateCache() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const entries = Array.from(geminiTranslateCache.entries()).slice(-TRANSLATE_CACHE_MAX);
      localStorage.setItem(TRANSLATE_CACHE_KEY, JSON.stringify(entries));
    } catch { /* ignore */ }
  }, 5000);
}

/**
 * 获取持久化翻译缓存的只读快照（供芯片编辑器初始化用）
 */
export function getTranslationCacheSnapshot(): Map<string, string> {
  return new Map(geminiTranslateCache);
}

/**
 * 将翻译结果写入持久化缓存（供芯片编辑器回写用）
 */
export function setTranslationCacheEntries(entries: Map<string, string>) {
  let changed = false;
  entries.forEach((v, k) => {
    if (v && !geminiTranslateCache.has(k)) {
      geminiTranslateCache.set(k, v);
      changed = true;
    }
  });
  if (changed) persistTranslateCache();
}

// AI 推荐标签缓存（中文 → 英文标签列表）
const aiRecommendCache = new Map<string, string[]>();

/**
 * 使用 AI 根据中文描述推荐 Danbooru 英文标签
 * 返回英文标签数组（下划线格式）
 */
export async function aiRecommendTags(chineseQuery: string): Promise<string[]> {
  if (!chineseQuery) return [];

  const cached = aiRecommendCache.get(chineseQuery);
  if (cached) return cached;

  try {
    const messages = [{
      role: 'user',
      content: `你是 Danbooru 标签专家。用户输入中文描述，你需要推荐最相关的 Danbooru 英文标签。
规则：
- 只输出标签，每行一个，用下划线连接单词
- 推荐 5-8 个最相关的标签，按相关度排序
- 只推荐 Danbooru 上真实存在的标签
- 不要输出任何解释

用户输入：${chineseQuery}`
    }];

    const data = await requestSidecarChatCompletion(messages, 0.1, 200);
    const content = data.choices?.[0]?.message?.content?.trim() || '';

    const tags = content
      .split('\n')
      .map((line: string) => line.trim().replace(/^[-*•\d.)\s]+/, '').trim())
      .filter((t: string) => t && /^[a-z0-9_()]+$/i.test(t))
      .map((t: string) => t.toLowerCase())
      .slice(0, 8);

    if (tags.length > 0) {
      aiRecommendCache.set(chineseQuery, tags);
      if (aiRecommendCache.size > 200) {
        const firstKey = aiRecommendCache.keys().next().value;
        if (firstKey) aiRecommendCache.delete(firstKey);
      }
    }

    return tags;
  } catch (e) {
    console.warn('AI recommend tags error:', e);
    return [];
  }
}

// AI 直接翻译缓存（中文 → 单个英文标签）
const aiDirectTranslateCache = new Map<string, string>();

/**
 * 使用 AI 将中文直接翻译为一个英文标签（不限制 D 站标签）
 * 例如 "短灰色头发" → "short_gray_hair"
 */
export async function aiDirectTranslate(chineseQuery: string): Promise<string> {
  if (!chineseQuery) return '';

  const cached = aiDirectTranslateCache.get(chineseQuery);
  if (cached) return cached;

  try {
    const messages = [{
      role: 'user',
      content: `将以下中文描述直接翻译为一个英文标签，用下划线连接单词。
规则：
- 只输出一个标签，不要多个
- 直接翻译，不要拆分成多个概念
- 用下划线连接单词，全小写
- 只输出标签本身，不要任何解释

中文：${chineseQuery}`
    }];

    const data = await requestSidecarChatCompletion(messages, 0.1, 50);
    const content = data.choices?.[0]?.message?.content?.trim() || '';

    // 取第一行，清理格式
    const tag = content.split('\n')[0].trim().replace(/^[-*•\s]+/, '').replace(/ /g, '_').toLowerCase();
    if (tag && /^[a-z0-9_()]+$/.test(tag)) {
      aiDirectTranslateCache.set(chineseQuery, tag);
      if (aiDirectTranslateCache.size > 200) {
        const firstKey = aiDirectTranslateCache.keys().next().value;
        if (firstKey) aiDirectTranslateCache.delete(firstKey);
      }
      return tag;
    }
    return '';
  } catch (e) {
    console.warn('AI direct translate error:', e);
    return '';
  }
}


// ========== 批量翻译队列 ==========
// 收集短时间内的翻译请求，合并为一次 API 调用
let batchQueue: { tag: string; resolve: (v: string) => void }[] = [];
let batchTimer: ReturnType<typeof setTimeout> | null = null;
const BATCH_DELAY = 150; // 收集窗口 150ms
const BATCH_MAX_SIZE = 30; // 单次最多翻译 30 个标签

function flushBatchQueue() {
  batchTimer = null;
  if (batchQueue.length === 0) return;

  const batch = batchQueue.splice(0, BATCH_MAX_SIZE);
  // 如果还有剩余，继续排队
  if (batchQueue.length > 0) {
    batchTimer = setTimeout(flushBatchQueue, BATCH_DELAY);
  }

  const tags = batch.map(b => b.tag);

  (async () => {
    try {
      const prompt = `将以下 Danbooru 图像标签翻译成简洁的中文。返回 JSON 数组，顺序与输入一致，每个元素是对应标签的中文翻译。
只输出 JSON 数组，不要其他内容。

${JSON.stringify(tags.map(t => t.replace(/_/g, ' ')))}`;

      const messages = [{ role: 'user', content: prompt }];
      const data = await requestSidecarChatCompletion(messages, 0.1, 2000);
      const content = data.choices?.[0]?.message?.content?.trim() || '';

      // 解析 JSON 数组
      let parsed: string[] | null = null;
      try {
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
      } catch { /* ignore */ }

      for (let i = 0; i < batch.length; i++) {
        const translation = (parsed && i < parsed.length && typeof parsed[i] === 'string') ? parsed[i].trim() : '';
        if (translation) {
          geminiTranslateCache.set(batch[i].tag, translation);
        }
        batch[i].resolve(translation);
      }
      persistTranslateCache();
      // AI 翻译结果回写映射库
      if (parsed) {
        const entries = batch
          .map((b, i) => ({ tag: b.tag, zh: (parsed![i] || '').trim(), source: 'ai' as const }))
          .filter(e => e.zh && e.zh !== e.tag);
        submitTagTranslations(entries);
      }
    } catch {
      for (const b of batch) b.resolve('');
    }
  })();
}

/**
 * 使用 AI 翻译英文标签为中文（自动合并为批量请求）
 * 短时间内的多次调用会被合并为一次 API 请求
 */
export function translateTagWithGemini(tag: string): Promise<string> {
  if (!tag) return Promise.resolve('');

  const cached = geminiTranslateCache.get(tag);
  if (cached !== undefined) return Promise.resolve(cached);

  return new Promise((resolve) => {
    batchQueue.push({ tag, resolve });
    if (!batchTimer) {
      batchTimer = setTimeout(flushBatchQueue, BATCH_DELAY);
    }
    // 队列满了立即发送
    if (batchQueue.length >= BATCH_MAX_SIZE) {
      if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
      flushBatchQueue();
    }
  });
}
