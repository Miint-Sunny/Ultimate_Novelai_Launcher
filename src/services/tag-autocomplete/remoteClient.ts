// 远端标签 API 客户端（remote tag API client）
// 通过 sidecar 调用 Danbooru 自动补全 / 语义搜索 / 验证三个端点。
// 每个函数保持 fetch + 解析 + 失败兜底，返回 Promise 供编排层并行。
import { sidecarApi } from '../../api/sidecar';

/** Danbooru 自动补全：成功返回原始 JSON 数组，失败/非 200 返回 [] */
export function fetchDanbooruAutocomplete(query: string, limit: number): Promise<any[]> {
  return fetch(sidecarApi.url(`/api/tags/autocomplete?query=${encodeURIComponent(query)}&limit=${limit}`))
    .then(res => res.ok ? res.json() : [])
    .catch(() => []);
}

/** DanbooruSearch HF Space 语义搜索：成功返回原始 JSON，失败返回 { results: [] } */
export function fetchDanbooruSemanticSearch(query: string, limit: number): Promise<{ results: any[] }> {
  return fetch(sidecarApi.url('/api/tags/search'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, limit, show_nsfw: true }),
  }).then(res => res.ok ? res.json() : { results: [] })
    .catch(() => ({ results: [] }));
}

/** 标签验证（postCount）：成功返回 tag→count 映射，失败返回 {} */
export function verifyTags(normalizedTags: string[]): Promise<Record<string, number>> {
  return fetch(sidecarApi.url('/api/tags/verify'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tags: normalizedTags }),
  }).then(res => res.ok ? res.json() as Promise<Record<string, number>> : ({} as Record<string, number>))
    .catch(() => ({} as Record<string, number>));
}
