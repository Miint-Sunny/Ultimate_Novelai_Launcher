// 远端标签 API 客户端（remote tag API client）
// 通过 sidecar 调用 Danbooru 自动补全 / 语义搜索 / 验证三个端点。
// 每个函数保持 fetch + 解析 + 失败兜底，返回 Promise 供编排层并行。
import { appBackendApi } from '../../api/appBackendApi';

/** Danbooru 自动补全：成功返回原始 JSON 数组，失败/非 200 返回 [] */
export function fetchDanbooruAutocomplete(query: string, limit: number): Promise<any[]> {
  return appBackendApi.getJson<any[]>(
    `/api/tags/autocomplete?query=${encodeURIComponent(query)}&limit=${limit}`,
  )
    .catch(() => []);
}

/** DanbooruSearch HF Space 语义搜索：成功返回原始 JSON，失败返回 { results: [] } */
export function fetchDanbooruSemanticSearch(query: string, limit: number): Promise<{ results: any[] }> {
  return appBackendApi.postJson<{ results: any[] }>('/api/tags/search', {
    query,
    limit,
    show_nsfw: true,
  })
    .catch(() => ({ results: [] }));
}

/** 标签验证（postCount）：成功返回 tag→count 映射，失败返回 {} */
export function verifyTags(normalizedTags: string[]): Promise<Record<string, number>> {
  return appBackendApi.postJson<Record<string, number>>('/api/tags/verify', {
    tags: normalizedTags,
  })
    .catch(() => ({} as Record<string, number>));
}
