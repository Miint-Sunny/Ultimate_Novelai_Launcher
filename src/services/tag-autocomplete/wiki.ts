// Wiki 预览辅助（wiki preview helpers）
// 包含 wiki 存在性 / 中文名 / 预览 / 中文摘要四类查询，
// 各自带 per-tag 缓存 + in-flight 去重注册表。行为与缓存 key 保持不变。

import { sidecarApi } from '../../api/sidecar';
import type { TagWikiPreview } from './types';

// 缓存
const wikiExistsCache = new Map<string, boolean>();
const wikiPreviewCache = new Map<string, TagWikiPreview>();
const wikiSummaryZhCache = new Map<string, string>();

// in-flight 去重：同一 tag 的请求未完成前，复用同一个 Promise，避免重复打到后端
const wikiExistsInflight = new Map<string, Promise<Record<string, boolean>>>();
const wikiPreviewInflight = new Map<string, Promise<TagWikiPreview | null>>();
const wikiSummaryZhInflight = new Map<string, Promise<string>>();

export function normalizeWikiTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/ /g, '_');
}

/**
 * 批量获取标签的中文别名（导出供外部使用）
 *
 * per-tag 缓存 + inflight 去重：
 * - 正缓存：查到的中文名
 * - 负缓存（null）：后端成功响应但确认无翻译的 tag，会话内不再重查——
 *   否则翻译不出来的 tag 会在每次编辑标签集合变化时反复发起相同请求
 * - 请求异常 / 非 200：不写缓存，允许下次重试（后端恢复后可继续工作）
 */
const wikiNamesCache = new Map<string, string[] | null>();
const wikiNamesInflight = new Map<string, Promise<Record<string, string[]>>>();

export async function fetchWikiChineseNames(tags: string[]): Promise<Record<string, string[]>> {
  if (!tags.length) return {};

  const result: Record<string, string[]> = {};
  const missing: string[] = [];
  const pending = new Set<Promise<Record<string, string[]>>>();
  const seen = new Set<string>();
  for (const tag of tags) {
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    if (wikiNamesCache.has(tag)) {
      const cached = wikiNamesCache.get(tag)!;
      if (cached) result[tag] = cached;
    } else {
      const flying = wikiNamesInflight.get(tag);
      if (flying) pending.add(flying);
      else missing.push(tag);
    }
  }

  if (missing.length > 0) {
    const promise = (async (): Promise<Record<string, string[]>> => {
      try {
        const res = await fetch(sidecarApi.url(`/api/tags/wiki?tags=${encodeURIComponent(missing.join(','))}`));
        if (res.ok) {
          const data = await res.json() as Record<string, string[]>;
          for (const tag of missing) {
            const names = data?.[tag];
            wikiNamesCache.set(tag, Array.isArray(names) && names.length > 0 ? names : null);
          }
          return data || {};
        }
      } catch (e) {
        console.warn('Failed to fetch wiki names:', e);
      }
      return {};
    })();
    promise.finally(() => {
      for (const tag of missing) {
        if (wikiNamesInflight.get(tag) === promise) wikiNamesInflight.delete(tag);
      }
    });
    for (const tag of missing) wikiNamesInflight.set(tag, promise);
    pending.add(promise);
  }

  if (pending.size > 0) {
    const settled = await Promise.all(pending);
    for (const data of settled) {
      for (const tag of seen) {
        if (result[tag]) continue;
        const names = data?.[tag];
        if (Array.isArray(names) && names.length > 0) result[tag] = names;
      }
    }
  }
  return result;
}

/**
 * 从 Danbooru 获取标签建议（通过后端代理）
 * onWikiLoaded: 可选回调，wiki中文名加载完成后调用
 */
export async function fetchWikiExistsBatch(tags: string[]): Promise<Record<string, boolean>> {
  const normalized = Array.from(new Set(tags.map(normalizeWikiTag).filter(Boolean)));
  if (normalized.length === 0) return {};

  const result: Record<string, boolean> = {};
  const missing: string[] = [];
  const pending = new Set<Promise<Record<string, boolean>>>();
  for (const tag of normalized) {
    if (wikiExistsCache.has(tag)) {
      result[tag] = wikiExistsCache.get(tag)!;
      continue;
    }
    const flying = wikiExistsInflight.get(tag);
    if (flying) pending.add(flying);
    else missing.push(tag);
  }

  if (missing.length > 0) {
    const promise = (async (): Promise<Record<string, boolean>> => {
      try {
        const res = await fetch(sidecarApi.url('/api/tags/wiki-exists-batch'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tags: missing }),
        });
        if (res.ok) {
          const data = await res.json() as Record<string, boolean>;
          const normalizedData: Record<string, boolean> = {};
          Object.entries(data || {}).forEach(([tag, hasWiki]) => {
            const normalizedTag = normalizeWikiTag(tag);
            wikiExistsCache.set(normalizedTag, !!hasWiki);
            normalizedData[normalizedTag] = !!hasWiki;
          });
          return normalizedData;
        }
      } catch (e) {
        console.warn('Failed to fetch wiki existence batch:', e);
      }
      return {};
    })();
    promise.finally(() => {
      for (const tag of missing) {
        if (wikiExistsInflight.get(tag) === promise) wikiExistsInflight.delete(tag);
      }
    });
    for (const tag of missing) wikiExistsInflight.set(tag, promise);
    pending.add(promise);
  }

  if (pending.size > 0) {
    const settled = await Promise.all(pending);
    for (const data of settled) {
      for (const [tag, hasWiki] of Object.entries(data)) {
        if (!(tag in result)) result[tag] = hasWiki;
      }
    }
  }

  return result;
}

export async function fetchTagWikiPreview(tag: string): Promise<TagWikiPreview | null> {
  const normalized = normalizeWikiTag(tag);
  if (!normalized) return null;
  if (wikiPreviewCache.has(normalized)) return wikiPreviewCache.get(normalized)!;

  const flying = wikiPreviewInflight.get(normalized);
  if (flying) return flying;

  const promise = (async (): Promise<TagWikiPreview | null> => {
    try {
      const res = await fetch(sidecarApi.url(`/api/tags/wiki-preview?tag=${encodeURIComponent(normalized)}`));
      if (!res.ok) return null;
      const data = await res.json() as TagWikiPreview;
      wikiExistsCache.set(normalized, !!data?.hasWiki);
      if (!data?.hasWiki) return null;
      wikiPreviewCache.set(normalized, data);
      return data;
    } catch (e) {
      console.warn('Failed to fetch wiki preview:', e);
      return null;
    }
  })();
  promise.finally(() => {
    if (wikiPreviewInflight.get(normalized) === promise) wikiPreviewInflight.delete(normalized);
  });
  wikiPreviewInflight.set(normalized, promise);
  return promise;
}

export async function fetchTagWikiSummaryZh(tag: string): Promise<string> {
  const normalized = normalizeWikiTag(tag);
  if (!normalized) return '';
  if (wikiSummaryZhCache.has(normalized)) return wikiSummaryZhCache.get(normalized)!;

  const flying = wikiSummaryZhInflight.get(normalized);
  if (flying) return flying;

  const promise = (async (): Promise<string> => {
    try {
      const res = await fetch(sidecarApi.url(`/api/tags/wiki-preview-summary-zh?tag=${encodeURIComponent(normalized)}`));
      if (!res.ok) return '';
      const data = await res.json() as { hasWiki?: boolean; summaryZh?: string };
      const summaryZh = data?.hasWiki && data.summaryZh ? data.summaryZh : '';
      if (summaryZh) {
        wikiSummaryZhCache.set(normalized, summaryZh);
        const cached = wikiPreviewCache.get(normalized);
        if (cached) wikiPreviewCache.set(normalized, { ...cached, summaryZh });
      }
      return summaryZh;
    } catch (e) {
      console.warn('Failed to fetch wiki Chinese summary:', e);
      return '';
    }
  })();
  promise.finally(() => {
    if (wikiSummaryZhInflight.get(normalized) === promise) wikiSummaryZhInflight.delete(normalized);
  });
  wikiSummaryZhInflight.set(normalized, promise);
  return promise;
}
