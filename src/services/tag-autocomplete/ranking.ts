// 合并/排序辅助（merge/ranking helpers）
// 纯函数：按建议来源分类、按设置里的 autocompleteSources 顺序重排。
// 保持补全排序行为不变。

import type { AutocompleteSourceId, AutocompleteSourceConfig } from '../localLibrary';
import type { TagSuggestion } from './types';

/**
 * 按建议类型归类到某个配置源 id。AI 加载占位归入 aiRecommend 槽。
 */
export function classifySuggSource(s: TagSuggestion): AutocompleteSourceId | null {
  if (s.isAiLoading) return 'aiRecommend';
  if (s.isNaturalLanguage) return 'nl';
  // AI 直译合并到 aiRecommend 桶里（置顶位置由插入顺序保证）
  if (s.isAiDirect || s.isAiRecommend) return 'aiRecommend';
  if (s.isArtist) return 'artists';
  if (s.isOC) return 'ocs';
  if (s.isOrigin) return 'origins';
  if (s.source === 'local') return 'characters';
  if (s.source === 'danbooru') return 'danbooru';
  return null;
}

/**
 * 按设置里的 autocompleteSources 顺序重排 items：禁用源剔除、按 maxCount 截断、按配置顺序拼接。
 */
export function reorderByConfig(items: TagSuggestion[], sources: AutocompleteSourceConfig[]): TagSuggestion[] {
  const grouped: Partial<Record<AutocompleteSourceId, TagSuggestion[]>> = {};
  for (const s of items) {
    const cat = classifySuggSource(s);
    if (cat == null) continue;
    (grouped[cat] ||= []).push(s);
  }
  const result: TagSuggestion[] = [];
  for (const cfg of sources) {
    if (!cfg.enabled) continue;
    const bucket = grouped[cfg.id] || [];
    const limited = cfg.maxCount != null ? bucket.slice(0, cfg.maxCount) : bucket;
    result.push(...limited);
  }
  return result;
}

export function getSrcCfg(sources: AutocompleteSourceConfig[], id: AutocompleteSourceId): AutocompleteSourceConfig {
  return sources.find(s => s.id === id) || { id, enabled: false };
}
