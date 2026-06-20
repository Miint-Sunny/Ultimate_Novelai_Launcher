// 远端标签 API 客户端（remote tag API client）
// 封装对后端 Danbooru 自动补全 / 语义搜索 / 验证三个端点的请求。
// 每个函数都保持与原内联实现一致的 fetch + 解析 + 失败兜底，返回 Promise 供编排层并行。
// 注意：结果的合并/映射逻辑仍由 getTagSuggestions 负责，这里只做请求。

import { getBackendUrl } from '../../utils/apiConfig';

/** Danbooru 自动补全：成功返回原始 JSON 数组，失败/非 200 返回 [] */
export function fetchDanbooruAutocomplete(query: string, limit: number): Promise<any[]> {
  const backendUrl = getBackendUrl();
  return fetch(`${backendUrl}/api/tags/autocomplete?query=${encodeURIComponent(query)}&limit=${limit}`)
    .then(res => res.ok ? res.json() : [])
    .catch(() => []);
}

/** DanbooruSearch HF Space 语义搜索：成功返回原始 JSON，失败返回 { results: [] } */
export function fetchDanbooruSemanticSearch(query: string, limit: number): Promise<{ results: any[] }> {
  const backendUrl = getBackendUrl();
  return fetch(`${backendUrl}/api/tags/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, limit, show_nsfw: true }),
  }).then(res => res.ok ? res.json() : { results: [] })
    .catch(() => ({ results: [] }));
}

/** 标签验证（postCount）：成功返回 tag→count 映射，失败返回 {} */
export function verifyTags(normalizedTags: string[]): Promise<Record<string, number>> {
  const backendUrl = getBackendUrl();
  return fetch(`${backendUrl}/api/tags/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tags: normalizedTags }),
  }).then(res => res.ok ? res.json() as Promise<Record<string, number>> : ({} as Record<string, number>))
    .catch(() => ({} as Record<string, number>));
}
