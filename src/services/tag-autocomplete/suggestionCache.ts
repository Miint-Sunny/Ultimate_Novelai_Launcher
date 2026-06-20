// 补全结果缓存注册表（cache registry）
// 由 getTagSuggestions 读写；clearTagCache 同时供外部与 clearArtistOCCache 调用。
// 缓存 key 始终是 query.toLowerCase()，行为保持不变。

import type { TagSuggestion } from './types';

export const cache = new Map<string, TagSuggestion[]>();

/**
 * 清除缓存
 */
export function clearTagCache(): void {
  cache.clear();
}
