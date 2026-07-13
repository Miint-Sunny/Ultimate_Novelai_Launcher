import { appBackendApi } from '../../api/appBackendApi';

export interface PublicOCData {
  id: string;
  en_name: string;
  zh_name: string | null;
  zh_aliases: string[];
  tag_group: string;
  negative_prompt?: string;
  preview_url: string | null;
  created_by?: string;
  created_at?: number;
}

export interface PublicOCListResponse {
  ocs: PublicOCData[];
  total: number;
}

export interface CreateOCParams {
  en_name?: string;
  zh_name?: string;
  zh_aliases?: string[];
  tag_group: string;
  negative_prompt?: string;
  preview_base64?: string;
  created_by?: string;
}

export interface UpdateOCParams {
  zh_name?: string;
  zh_aliases?: string[];
  tag_group?: string;
  negative_prompt?: string;
  preview_base64?: string;
  created_by?: string;
  created_at?: number;
}

const PUBLIC_OC_CACHE_KEY = 'public_oc_cache';
const PUBLIC_OC_CACHE_TTL = 10 * 60 * 1000;
const ocPreviewUrls = new Map<string, string>();

interface PublicOCCache {
  data: PublicOCData[];
  timestamp: number;
}

function getPublicOCCache(): PublicOCCache | null {
  try {
    const cached = localStorage.getItem(PUBLIC_OC_CACHE_KEY);
    if (!cached) return null;
    const cache: PublicOCCache = JSON.parse(cached);
    if (Date.now() - cache.timestamp > PUBLIC_OC_CACHE_TTL) {
      localStorage.removeItem(PUBLIC_OC_CACHE_KEY);
      return null;
    }
    return cache;
  } catch {
    return null;
  }
}

function setPublicOCCache(data: PublicOCData[]): void {
  try {
    localStorage.setItem(PUBLIC_OC_CACHE_KEY, JSON.stringify({ data, timestamp: Date.now() }));
  } catch (error) {
    console.warn('保存公共OC缓存失败:', error);
  }
}

export async function getPublicOCs(forceRefresh = false): Promise<PublicOCData[]> {
  if (!forceRefresh) {
    const cache = getPublicOCCache();
    if (cache) {
      console.log('[公共OC] 使用缓存数据');
      return hydrateOCPreviews(cache.data);
    }
  }

  try {
    const data = await appBackendApi.getJson<PublicOCListResponse>(
      '/api/oc/list',
    );
    const ocs = data.ocs || [];
    setPublicOCCache(ocs);
    console.log(`[公共OC] 已从服务器获取 ${ocs.length} 个OC`);
    return hydrateOCPreviews(ocs);
  } catch (error) {
    console.error('获取公共OC列表失败:', error);
    try {
      const cached = localStorage.getItem(PUBLIC_OC_CACHE_KEY);
      if (cached) {
        const cache: PublicOCCache = JSON.parse(cached);
        console.log('[公共OC] 使用过期缓存作为fallback');
        return hydrateOCPreviews(cache.data);
      }
    } catch { }
    return [];
  }
}

export function clearPublicOCCache(): void {
  localStorage.removeItem(PUBLIC_OC_CACHE_KEY);
  ocPreviewUrls.clear();
  appBackendApi.revokeObjectUrls('/api/oc/preview/');
}

export function getOCPreviewUrl(ocName: string): string {
  return ocPreviewUrls.get(ocName) || '';
}

async function hydrateOCPreviews(ocs: PublicOCData[]): Promise<PublicOCData[]> {
  return Promise.all(ocs.map(async oc => {
    if (!oc.preview_url) return oc;
    const path = `/api/oc/preview/${encodeURIComponent(oc.en_name)}`;
    try {
      const preview = await appBackendApi.objectUrl(path);
      ocPreviewUrls.set(oc.en_name, preview);
      return { ...oc, preview_url: preview };
    } catch {
      return { ...oc, preview_url: null };
    }
  }));
}

export async function createPublicOC(
  params: CreateOCParams
): Promise<{ success: boolean; message: string; oc?: PublicOCData }> {
  try {
    const data = await appBackendApi.postJson<{ message?: string; oc?: PublicOCData }>(
      '/api/oc/create',
      params,
    );
    clearPublicOCCache();
    return {
      success: true,
      message: data.message || '创建成功',
      oc: data.oc ? normalizePublicOC(data.oc) : undefined,
    };
  } catch (error) {
    console.error('创建公共OC失败:', error);
    return { success: false, message: String(error) };
  }
}

export async function updatePublicOC(
  ocName: string,
  params: UpdateOCParams
): Promise<{ success: boolean; message: string; oc?: PublicOCData }> {
  try {
    const data = await appBackendApi.putJson<{ message?: string; oc?: PublicOCData }>(
      `/api/oc/${encodeURIComponent(ocName)}`,
      params,
    );
    clearPublicOCCache();
    return {
      success: true,
      message: data.message || '更新成功',
      oc: data.oc ? normalizePublicOC(data.oc) : undefined,
    };
  } catch (error) {
    console.error('更新公共OC失败:', error);
    return { success: false, message: String(error) };
  }
}

export async function deletePublicOC(ocName: string): Promise<{ success: boolean; message: string }> {
  try {
    const data = await appBackendApi.deleteJson<{ message?: string }>(`/api/oc/${encodeURIComponent(ocName)}`);
    clearPublicOCCache();
    return { success: true, message: data.message || '删除成功' };
  } catch (error) {
    console.error('删除公共OC失败:', error);
    return { success: false, message: String(error) };
  }
}

function normalizePublicOC(raw: PublicOCData): PublicOCData {
  return {
    id: raw.id,
    en_name: raw.en_name,
    zh_name: raw.zh_name,
    zh_aliases: raw.zh_aliases || [],
    tag_group: raw.tag_group,
    negative_prompt: raw.negative_prompt || '',
    preview_url: raw.preview_url,
  };
}
