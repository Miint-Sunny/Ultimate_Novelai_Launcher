import { getBackendUrl } from '../../utils/apiConfig';
import { getOptionalSessionId, getPublicLibraryOwnerId } from './session';

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
      return cache.data;
    }
  }

  const backendUrl = getBackendUrl();
  try {
    const sessionId = getOptionalSessionId();
    const response = await fetch(`${backendUrl}/api/oc/list?session_id=${encodeURIComponent(sessionId)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data: PublicOCListResponse = await response.json();
    const ocs = data.ocs || [];
    setPublicOCCache(ocs);
    console.log(`[公共OC] 已从服务器获取 ${ocs.length} 个OC`);
    return ocs;
  } catch (error) {
    console.error('获取公共OC列表失败:', error);
    try {
      const cached = localStorage.getItem(PUBLIC_OC_CACHE_KEY);
      if (cached) {
        const cache: PublicOCCache = JSON.parse(cached);
        console.log('[公共OC] 使用过期缓存作为fallback');
        return cache.data;
      }
    } catch { }
    return [];
  }
}

export function clearPublicOCCache(): void {
  localStorage.removeItem(PUBLIC_OC_CACHE_KEY);
}

export function getOCPreviewUrl(ocName: string): string {
  return `${getBackendUrl()}/api/oc/preview/${encodeURIComponent(ocName)}`;
}

export async function createPublicOC(
  params: CreateOCParams
): Promise<{ success: boolean; message: string; oc?: PublicOCData }> {
  const backendUrl = getBackendUrl();
  try {
    const response = await fetch(`${backendUrl}/api/oc/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...params, created_by: params.created_by || getPublicLibraryOwnerId() }),
    });
    const data = await response.json();
    if (!response.ok) {
      return { success: false, message: data.detail || `HTTP ${response.status}` };
    }
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
  const backendUrl = getBackendUrl();
  try {
    const response = await fetch(`${backendUrl}/api/oc/${encodeURIComponent(ocName)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const data = await response.json();
    if (!response.ok) {
      return { success: false, message: data.detail || `HTTP ${response.status}` };
    }
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
  const backendUrl = getBackendUrl();
  try {
    const response = await fetch(`${backendUrl}/api/oc/${encodeURIComponent(ocName)}`, {
      method: 'DELETE',
    });
    const data = await response.json();
    if (!response.ok) {
      return { success: false, message: data.detail || `HTTP ${response.status}` };
    }
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
