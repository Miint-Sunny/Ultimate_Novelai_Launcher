// Danbooru 标签自动补全服务（门面 + 编排）
// 具体实现按职责拆分到 ./tag-autocomplete/ 下：
//   types           共享类型
//   suggestionCache 补全结果缓存注册表（缓存 key = query.toLowerCase()）
//   ranking         合并/排序（reorderByConfig 等）
//   remoteClient    远端 Danbooru 自动补全 / 语义搜索 / 验证客户端
//   wiki            wiki 预览 / 中文名 / 存在性（含缓存与 inflight 去重）
//   localSearch     本地角色 / 画师串 / OC 搜索与缓存
//   translation     Gemini/AI 翻译与批量队列
// 本文件保留补全编排 getTagSuggestions / 防抖封装，并保持对外 export 形状不变。

import { getAppSettings } from './localLibrary';
import { submitTagTranslations } from './translate';
import { botService } from './botService';

import type { TagSuggestion } from './tag-autocomplete/types';
import { cache } from './tag-autocomplete/suggestionCache';
import { getSrcCfg, reorderByConfig } from './tag-autocomplete/ranking';
import { fetchDanbooruSemanticSearch, fetchTagSuggestions, verifyTags } from './tag-autocomplete/remoteClient';
import { fetchWikiChineseNames } from './tag-autocomplete/wiki';
import { searchLocalTags } from './tag-autocomplete/localSearch';
import { aiDirectTranslate, aiRecommendTags, translateTagWithGemini } from './tag-autocomplete/translation';

// 重新导出，保持对外 API 形状不变
export type { TagWikiPreviewExample, TagWikiPreview, TagSuggestion } from './tag-autocomplete/types';
export { clearTagCache } from './tag-autocomplete/suggestionCache';
export { fetchWikiChineseNames, fetchWikiExistsBatch, fetchTagWikiPreview, fetchTagWikiSummaryZh } from './tag-autocomplete/wiki';
export { verifyTags } from './tag-autocomplete/remoteClient';
export { clearArtistOCCache, preloadAutocompleteData, lookupCharacterChineseName } from './tag-autocomplete/localSearch';
export { getTranslationCacheSnapshot, setTranslationCacheEntries, translateTagWithGemini } from './tag-autocomplete/translation';

// 防抖函数
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

// 当前正在查询的关键词（用于防止旧查询的异步回调覆盖新结果）
let currentQuery: string = '';

export async function getTagSuggestions(
  query: string,
  onWikiLoaded?: (suggestions: TagSuggestion[]) => void
): Promise<TagSuggestion[]> {
  if (!query) return [];

  // 获取设置 + 当前 bot 用户 id（用于 artists/ocs 的 "仅我" 过滤）
  const settings = getAppSettings();
  const currentUserId = botService.getAuthState().botUserId || null;

  // 如果补全被禁用，直接返回空
  if (!settings.autocompleteEnabled) return [];

  // 检测是否包含中文
  const hasChinese = /[\u4e00-\u9fa5]/.test(query);

  // 如果包含中文但中文补全被禁用，返回空
  if (hasChinese && !settings.autocompleteChineseEnabled) return [];

  // 中文1个字符就触发，英文需要2个
  if (!hasChinese && query.length < 2) return [];

  // 换了「标签」来源就是另一份结果,不能共用缓存。
  const cacheKey = `${settings.tagSuggestSource}:${query.toLowerCase()}`;
  if (cache.has(cacheKey)) {
    const raw = cache.get(cacheKey)!;
    // 用户可能在上次缓存后调整过数据源配置，这里按最新配置再过滤/重排
    const cached = reorderByConfig(raw, settings.autocompleteSources);
    // 缓存命中但有未翻译的标签，异步补翻译
    if (onWikiLoaded && settings.autocompleteShowWiki) {
      const needTranslate = cached.filter(s => !s.chineseName && s.source === 'danbooru');
      if (needTranslate.length > 0) {
        (async () => {
          try {
            const wikiNames = await fetchWikiChineseNames(needTranslate.map(s => s.value));
            const stillMissing: TagSuggestion[] = [];
            let updated = false;
            for (const s of needTranslate) {
              const names = wikiNames[s.value];
              if (names && names.length > 0) {
                s.chineseName = names.join(' / ');
                updated = true;
              } else {
                stillMissing.push(s);
              }
            }
            if (stillMissing.length > 0) {
              const aiResults = await Promise.allSettled(
                stillMissing.map(s => translateTagWithGemini(s.value))
              );
              for (let i = 0; i < stillMissing.length; i++) {
                const r = aiResults[i];
                if (r.status === 'fulfilled' && r.value) {
                  stillMissing[i].chineseName = r.value;
                  updated = true;
                }
              }
            }
            if (updated) {
              cache.set(cacheKey, cached);
              onWikiLoaded(cached);
            }
          } catch { /* ignore */ }
        })();
      }
    }
    return cached;
  }

  try {
    let suggestions: TagSuggestion[] = [];
    const queryLower = query.toLowerCase();

    if (hasChinese) {
      // 中文搜索：本地 + Danbooru + AI 推荐并行，统一合并
      const sortByMatch = (arr: TagSuggestion[]) => {
        arr.sort((a, b) => {
          const getMatchScore = (s: TagSuggestion) => {
            const val = s.value.toLowerCase();
            const label = s.label.toLowerCase();
            const chinese = s.chineseName?.toLowerCase() || '';
            if (val === queryLower || label === queryLower || chinese === query) return 100;
            if (val.startsWith(queryLower) || label.startsWith(queryLower) || chinese.startsWith(query)) return 80;
            if (val.includes(queryLower) || label.includes(queryLower) || chinese.includes(query)) return 60;
            return 0;
          };
          return getMatchScore(b) - getMatchScore(a);
        });
      };

      // AI 推荐和直译不依赖 autocomplete 结果，提前并行启动
      // aiDirect 已合并到 aiRecommend，共享同一开关
      const aiRecommendCfg = getSrcCfg(settings.autocompleteSources, 'aiRecommend');
      const nlCfg = getSrcCfg(settings.autocompleteSources, 'nl');
      const danbooruCfg = getSrcCfg(settings.autocompleteSources, 'danbooru');
      const aiPromise = onWikiLoaded && aiRecommendCfg.enabled
        ? Promise.all([aiRecommendTags(query), aiDirectTranslate(query)])
        : null;

      // 先只等本地结果（瞬时），Danbooru 异步补充
      const localResults = await searchLocalTags(query, settings.autocompleteSources, currentUserId);

      // 用本地结果构建初始 suggestions
      const normalizeKey = (s: string) => s.toLowerCase().replace(/ /g, '_');
      const localValues = new Set<string>();
      const initialMerged: TagSuggestion[] = [];

      for (const s of localResults.high) {
        localValues.add(normalizeKey(s.value));
        initialMerged.push(s);
      }
      for (const s of localResults.low) {
        localValues.add(normalizeKey(s.value));
      }
      // 低优先本地结果追加
      for (const s of localResults.low) initialMerged.push(s);

      suggestions = initialMerged.slice(0, 10);

      // 中文输入时，含中文逗号或超过3个中文字符才显示"转换自然语言"选项
      const chineseCharCount = (query.match(/[\u4e00-\u9fa5]/g) || []).length;
      if (nlCfg.enabled && (query.includes('，') || chineseCharCount > 3)) {
        suggestions.unshift({
          value: query,
          label: '翻译为英文',
          chineseName: '直接翻译为英文',
          source: 'danbooru' as const,
          isNaturalLanguage: true,
        });
      }

      // 合并模式：先弹出一个加载占位，待所有数据源返回后统一显示，
      // 不再分阶段刷新，避免推荐列表多次跳变
      if (onWikiLoaded) {
        onWikiLoaded([{
          value: '__ai_loading__',
          label: '加载推荐中…',
          source: 'danbooru' as const,
          isAiLoading: true,
        }]);
      }

      // Danbooru 异步补充（中文命中率低，但仍尝试）
      const danbooruLimit = danbooruCfg.enabled ? Math.min(Math.max(danbooruCfg.maxCount ?? 7, 1), 20) : 0;
      const danbooruPromise = danbooruLimit > 0
        ? fetchTagSuggestions(settings.tagSuggestSource, query, danbooruLimit)
        : Promise.resolve([]);

      // DanbooruSearch HF Space 语义搜索（中文场景命中率高，与 /autocomplete 互补）
      // 与 danbooru 共用 enabled 开关：用户禁用 Danbooru 源时一并跳过
      const dsSearchLimit = danbooruCfg.enabled
        ? Math.min(Math.max(danbooruCfg.maxCount ?? 10, 10), 30)
        : 0;
      const dsSearchPromise = dsSearchLimit > 0
        ? fetchDanbooruSemanticSearch(query, dsSearchLimit)
        : Promise.resolve({ results: [] });

      // 等待所有数据源（Danbooru 自动补全 / 语义搜索 / AI 推荐）全部返回后统一合并
      const [danbooruData, dsData, aiResolved] = await Promise.all([
        danbooruPromise,
        dsSearchPromise,
        (aiPromise ?? Promise.resolve(null)).catch(() => null),
      ]);

      // Danbooru 自动补全结果
      if (Array.isArray(danbooruData) && danbooruData.length > 0) {
        const existingKeys = new Set(suggestions.map(s => normalizeKey(s.value)));
        for (const item of danbooruData) {
          const val = item.value?.replace(/ /g, '_') || item.name?.replace(/ /g, '_') || '';
          const postCount = item.post_count || 0;
          const key = normalizeKey(val);
          if (val && !existingKeys.has(key) && !localValues.has(key) && (!postCount || postCount >= 50)) {
            existingKeys.add(key);
            suggestions.push({
              value: val,
              label: item.label || item.value || item.name || '',
              chineseName: item.chinese,
              postCount: item.post_count,
              source: 'danbooru' as const,
            });
          }
        }
      }

      // DanbooruSearch HF Space 语义搜索结果
      const dsResults: any[] = (dsData && Array.isArray((dsData as any).results)) ? (dsData as any).results : [];
      if (dsResults.length > 0) {
        const existingKeys = new Set(suggestions.map(s => normalizeKey(s.value)));
        for (const item of dsResults) {
          const rawTag = String(item?.tag || '').trim();
          if (!rawTag) continue;
          const tag = rawTag.replace(/ /g, '_').toLowerCase();
          const key = normalizeKey(tag);
          if (existingKeys.has(key) || localValues.has(key)) continue;
          existingKeys.add(key);
          const cn = typeof item.cn_name === 'string' ? item.cn_name.trim() : '';
          const cnt = typeof item.count === 'number' ? item.count : undefined;
          suggestions.push({
            value: tag,
            label: tag.replace(/_/g, ' '),
            chineseName: cn || undefined,
            postCount: cnt,
            category: typeof item.category === 'string' ? item.category : undefined,
            source: 'danbooru' as const,
            verified: true, // 上游来自 Danbooru, 视为已验证, 无需再走 /verify
          });
        }
      }

      // AI 推荐 / AI 直译结果
      if (aiResolved) {
        const [aiTags, directTag] = aiResolved;
        const existingKeys = new Set(suggestions.map(s => normalizeKey(s.value)));
        // AI 直译结果 → 插到"翻译为英文"选项之后
        if (directTag) {
          const key = normalizeKey(directTag);
          if (!existingKeys.has(key)) {
            existingKeys.add(key);
            const nlCount = suggestions.filter(s => s.isNaturalLanguage).length;
            suggestions.splice(nlCount, 0, { value: directTag, label: directTag, source: 'danbooru' as const, verified: true, isAiDirect: true });
          }
        }
        // AI 推荐结果
        for (const t of aiTags) {
          const key = normalizeKey(t);
          if (!existingKeys.has(key)) {
            existingKeys.add(key);
            suggestions.push({ value: t, label: t, source: 'danbooru' as const, isAiRecommend: true });
          }
        }
      }

      // 标签验证（postCount）+ Wiki 中文名 并行获取
      const tagsNeedVerify = suggestions.filter(s => !s.isNaturalLanguage && s.source === 'danbooru' && !s.postCount).map(s => s.value);
      const allNeedWiki = suggestions.filter(s => !s.chineseName && !s.isNaturalLanguage && s.source === 'danbooru').map(s => s.value);
      const [verifyResult, wikiNames] = await Promise.all([
        tagsNeedVerify.length > 0
          ? verifyTags(tagsNeedVerify.map(t => t.replace(/ /g, '_')))
          : Promise.resolve({} as Record<string, number>),
        allNeedWiki.length > 0
          ? fetchWikiChineseNames(allNeedWiki).catch(() => ({} as Record<string, string[]>))
          : Promise.resolve({} as Record<string, string[]>),
      ]);

      // 应用验证结果
      if (tagsNeedVerify.length > 0) {
        const needVerifySet = new Set(tagsNeedVerify.map(t => t.replace(/ /g, '_').toLowerCase()));
        for (const s of suggestions) {
          const normalizedValue = s.value.replace(/ /g, '_').toLowerCase();
          if (needVerifySet.has(normalizedValue)) {
            s.verified = true;
            if (verifyResult[normalizedValue]) s.postCount = verifyResult[normalizedValue];
          }
        }
      }

      // 应用 Wiki 中文名，缺失的用 AI 翻译兜底
      if (allNeedWiki.length > 0) {
        const stillMissing: TagSuggestion[] = [];
        for (const s of suggestions) {
          if (!s.chineseName && !s.isNaturalLanguage && s.source === 'danbooru') {
            const names = wikiNames[s.value];
            if (names && names.length > 0) {
              s.chineseName = names.join(' / ');
            } else {
              stillMissing.push(s);
            }
          }
        }
        if (stillMissing.length > 0) {
          const aiTranslations = await Promise.allSettled(
            stillMissing.map(s => translateTagWithGemini(s.value))
          );
          for (let i = 0; i < stillMissing.length; i++) {
            const result = aiTranslations[i];
            if (result.status === 'fulfilled' && result.value) {
              stillMissing[i].chineseName = result.value;
            }
          }
        }
      }
    } else {
      // 英文搜索：先用本地结果立即弹面板，Danbooru 异步补充
      const danbooruCfg = getSrcCfg(settings.autocompleteSources, 'danbooru');
      const localResults = await searchLocalTags(query, settings.autocompleteSources, currentUserId);

      // 先用本地结果构建初始 suggestions
      const localSuggestions: TagSuggestion[] = [...localResults.high, ...localResults.low];
      suggestions = localSuggestions;

      // 立即将本地结果通过回调显示面板（不等 Danbooru）
      if (localSuggestions.length > 0 && onWikiLoaded) {
        const reordered = reorderByConfig(suggestions, settings.autocompleteSources);
        cache.set(cacheKey, reordered);
        onWikiLoaded(reordered);
      }

      // Danbooru 异步获取并合并
      const danbooruLimit = danbooruCfg.enabled ? Math.min(Math.max(danbooruCfg.maxCount ?? 7, 1), 20) : 0;
      const danbooruPromise = danbooruLimit > 0
        ? fetchTagSuggestions(settings.tagSuggestSource, query, danbooruLimit)
        : Promise.resolve([]);

      (async () => {
        try {
          const data = await danbooruPromise;

          const danbooruSuggestions: TagSuggestion[] = data.map((item: any) => ({
            value: item.value?.replace(/ /g, '_') || item.name?.replace(/ /g, '_') || '',
            label: item.label || item.value || item.name || '',
            chineseName: item.chinese,
            postCount: item.post_count,
            source: 'danbooru' as const,
          })).filter((s: TagSuggestion) => s.value && s.value.length > 1 && (!s.postCount || s.postCount >= 50));

          if (danbooruSuggestions.length === 0) return;

          // 合并：去除与本地重复的 Danbooru 结果
          const localValues = new Set(
            localSuggestions.map(s => s.value.toLowerCase())
          );
          const filteredDanbooru = danbooruSuggestions.filter(s => !localValues.has(s.value.toLowerCase())).slice(0, 10);

          // 构建合并结果：Danbooru 在前，local 在后
          const merged = [...filteredDanbooru, ...localSuggestions];

          // 排序
          if (settings.autocompleteSortOrder === 'prefix-first') {
            merged.sort((a, b) => {
              // local 始终排在自己的区域
              if (a.source === 'local' && b.source !== 'local') return 1;
              if (a.source !== 'local' && b.source === 'local') return -1;
              if (a.source === 'local' && b.source === 'local') return 0;
              const aStartsWith = a.value.toLowerCase().startsWith(queryLower);
              const bStartsWith = b.value.toLowerCase().startsWith(queryLower);
              if (aStartsWith && !bStartsWith) return -1;
              if (!aStartsWith && bStartsWith) return 1;
              return (b.postCount || 0) - (a.postCount || 0);
            });
          } else {
            merged.sort((a, b) => {
              if (a.source === 'local' && b.source !== 'local') return 1;
              if (a.source !== 'local' && b.source === 'local') return -1;
              return (b.postCount || 0) - (a.postCount || 0);
            });
          }

          // 按配置顺序/限额重排（取代旧的硬截断 10/5）
          const limitedMerged = reorderByConfig(merged, settings.autocompleteSources);

          // 更新 suggestions 引用
          suggestions.length = 0;
          suggestions.push(...limitedMerged);
          cache.set(cacheKey, suggestions);
          if (onWikiLoaded) onWikiLoaded(suggestions);

          // 异步获取中文别名
          if (settings.autocompleteShowWiki && onWikiLoaded) {
            const tagValues = suggestions.filter(s => s.source === 'danbooru').map(s => s.value);
            if (tagValues.length > 0) {
              const wikiNames = await fetchWikiChineseNames(tagValues);
              let hasUpdate = false;
              const missingTags: TagSuggestion[] = [];
              for (const s of suggestions) {
                if (s.source === 'danbooru') {
                  const chineseNames = wikiNames[s.value];
                  if (chineseNames && chineseNames.length > 0) {
                    s.chineseName = chineseNames.join(' / ');
                    hasUpdate = true;
                  } else {
                    missingTags.push(s);
                  }
                }
              }
              if (hasUpdate) {
                cache.set(cacheKey, suggestions);
                onWikiLoaded(suggestions);
                const wikiEntries = suggestions
                  .filter(s => s.source === 'danbooru' && s.chineseName && wikiNames[s.value])
                  .map(s => ({ tag: s.value, zh: s.chineseName!, source: 'wiki' as const }));
                submitTagTranslations(wikiEntries);
              }
              if (missingTags.length > 0) {
                const aiResults = await Promise.allSettled(
                  missingTags.map(s => translateTagWithGemini(s.value))
                );
                let aiUpdate = false;
                for (let i = 0; i < missingTags.length; i++) {
                  const result = aiResults[i];
                  if (result.status === 'fulfilled' && result.value) {
                    missingTags[i].chineseName = result.value;
                    aiUpdate = true;
                  }
                }
                if (aiUpdate) {
                  cache.set(cacheKey, suggestions);
                  onWikiLoaded(suggestions);
                  const aiEntries = missingTags
                    .filter(s => s.chineseName)
                    .map(s => ({ tag: s.value, zh: s.chineseName!, source: 'ai' as const }));
                  submitTagTranslations(aiEntries);
                }
              }
            }
          }
        } catch { /* ignore */ }
      })();
    }

    // 按配置顺序/限额重排（取代旧的硬截断 10/10）
    suggestions = reorderByConfig(suggestions, settings.autocompleteSources);

    // 缓存结果（先缓存无中文名的版本）
    cache.set(cacheKey, suggestions);

    // 限制缓存大小
    if (cache.size > 500) {
      const firstKey = cache.keys().next().value;
      if (firstKey) cache.delete(firstKey);
    }

    return suggestions;
  } catch (error) {
    console.warn('Failed to fetch tag suggestions:', error);
    return [];
  }
}

/**
 * 带防抖的标签建议获取
 */
export function getTagSuggestionsDebounced(
  query: string,
  callback: (suggestions: TagSuggestion[]) => void,
  delay = 200
): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }

  if (!query || query.length < 2) {
    currentQuery = '';
    callback([]);
    return;
  }

  // 记录当前查询
  currentQuery = query;

  debounceTimer = setTimeout(async () => {
    // 检查查询是否仍然是当前查询
    if (query !== currentQuery) return;

    // 传入包装后的回调，确保只有当前查询的结果才会被应用
    const wrappedCallback = (suggestions: TagSuggestion[]) => {
      // 再次检查，防止异步回调返回时查询已变化
      if (query === currentQuery) {
        callback(suggestions);
      }
    };

    const suggestions = await getTagSuggestions(query, wrappedCallback);
    // 最终结果也要检查
    if (query === currentQuery) {
      callback(suggestions);
    }
  }, delay);
}

/**
 * 取消当前的防抖请求（选择补全后调用，防止旧回调触发）
 */
export function cancelPendingAutocomplete(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  currentQuery = '';
}
