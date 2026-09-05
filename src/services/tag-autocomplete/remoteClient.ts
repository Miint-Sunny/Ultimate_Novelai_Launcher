// 远端标签 API 客户端（remote tag API client）
// 通过 sidecar 调用 Danbooru 自动补全 / 语义搜索 / 验证三个端点。
// 每个函数保持 fetch + 解析 + 失败兜底，返回 Promise 供编排层并行。
import { appBackendApi } from '../../api/appBackendApi';
import { localSidecarApi } from '../../api/localSidecarApi';
import type { TagSuggestSource } from '../localLibrary';

/** 「标签」来源返回的一条,三种来源都归到这个形状再进合并流程。 */
export interface RemoteTagItem {
  value: string;
  label?: string;
  name?: string;
  post_count?: number;
  /** 词典来源自带的中文释义。 */
  chinese?: string;
}

interface SidecarTagSuggestResponse {
  items?: Array<{ tag: string; count?: number | null; translation?: string | null }>;
}

/** sidecar 三来源联想(official / dictionary):失败返回 []。 */
export async function fetchSidecarTagSuggest(source: Exclude<TagSuggestSource, 'danbooru'>, query: string, limit: number): Promise<RemoteTagItem[]> {
  try {
    const data = await localSidecarApi.getJson<SidecarTagSuggestResponse>('/api/v1/tags/suggest', { source, q: query, limit });
    return (data.items ?? []).map((item) => ({
      value: item.tag,
      label: item.tag.replace(/_/g, ' '),
      post_count: typeof item.count === 'number' ? item.count : undefined,
      chinese: item.translation?.trim() || undefined,
    }));
  } catch {
    return [];
  }
}

/** 按设置里的来源取「标签」候选。 */
export function fetchTagSuggestions(source: TagSuggestSource, query: string, limit: number): Promise<RemoteTagItem[]> {
  return source === 'danbooru' ? fetchDanbooruAutocomplete(query, limit) : fetchSidecarTagSuggest(source, query, limit);
}

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
