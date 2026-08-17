import { appBackendApi } from '../../api/appBackendApi';
import { getOptionalSessionId } from './session';

export interface PublicVibeData {
  id: string;
  name: string;
  filename: string;
  thumbnail: string;
  supportedModels: string[];
  defaultStrength?: number;
  defaultInfoExtracted?: number;
  createdAt: number;
  hasImage?: boolean;
  uploaderId?: string | null;
  uploadedAt?: number | null;
}

export interface PublicVibeListResponse {
  vibes: PublicVibeData[];
  total: number;
}

const PUBLIC_VIBE_CACHE_KEY = 'public_vibe_cache_v3';
const PUBLIC_VIBE_CACHE_TTL = 10 * 60 * 1000;

try {
  localStorage.removeItem('public_vibe_cache');
  localStorage.removeItem('public_vibe_cache_v2');
} catch { }

interface PublicVibeCacheItem {
  id: string;
  name: string;
  filename: string;
  supportedModels: string[];
  defaultStrength?: number;
  defaultInfoExtracted?: number;
  createdAt: number;
  uploaderId?: string | null;
  uploadedAt?: number | null;
}

interface PublicVibeCache {
  data: PublicVibeCacheItem[];
  timestamp: number;
}

function getPublicVibeCache(): PublicVibeCache | null {
  try {
    const cached = localStorage.getItem(PUBLIC_VIBE_CACHE_KEY);
    if (!cached) return null;
    const cache: PublicVibeCache = JSON.parse(cached);
    if (Date.now() - cache.timestamp > PUBLIC_VIBE_CACHE_TTL) {
      localStorage.removeItem(PUBLIC_VIBE_CACHE_KEY);
      return null;
    }
    return cache;
  } catch {
    return null;
  }
}

function setPublicVibeCache(data: PublicVibeData[]): void {
  try {
    const cacheData: PublicVibeCacheItem[] = data.map(v => ({
      id: v.id,
      name: v.name,
      filename: v.filename,
      supportedModels: v.supportedModels,
      defaultStrength: v.defaultStrength,
      defaultInfoExtracted: v.defaultInfoExtracted,
      createdAt: v.createdAt,
      uploaderId: v.uploaderId,
      uploadedAt: v.uploadedAt,
    }));
    localStorage.setItem(PUBLIC_VIBE_CACHE_KEY, JSON.stringify({ data: cacheData, timestamp: Date.now() }));
  } catch (error) {
    console.warn('保存公共Vibe缓存失败:', error);
  }
}

export async function getPublicVibes(forceRefresh = false): Promise<PublicVibeData[]> {
  if (!forceRefresh) {
    const cache = getPublicVibeCache();
    if (cache) {
      console.log('[公共Vibe] 使用缓存数据');
      return hydrateVibeThumbnails(cache.data);
    }
  }

  try {
    const data = await appBackendApi.getJson<PublicVibeListResponse>(
      '/api/vibes/list',
    );
    const vibes = data.vibes || [];
    setPublicVibeCache(vibes);
    console.log(`[公共Vibe] 已从服务器获取 ${vibes.length} 个Vibe`);
    return hydrateVibeThumbnails(vibes);
  } catch (error) {
    console.error('获取公共Vibe列表失败:', error);
    try {
      const cached = localStorage.getItem(PUBLIC_VIBE_CACHE_KEY);
      if (cached) {
        const cache: PublicVibeCache = JSON.parse(cached);
        console.log('[公共Vibe] 使用过期缓存作为fallback');
        return hydrateVibeThumbnails(cache.data);
      }
    } catch { }
    return [];
  }
}

export async function getPublicVibeFile(filename: string): Promise<Record<string, unknown> | null> {
  try {
    return await appBackendApi.getJson<Record<string, unknown>>(`/api/vibes/file/${encodeURIComponent(filename)}`);
  } catch (error) {
    console.error('获取Vibe文件失败:', error);
    return null;
  }
}

export async function fetchPublicVibeEncoding(
  filename: string,
  model: string,
  informationExtracted: number
): Promise<string | null> {
  try {
    const params = new URLSearchParams({ model, ie: String(informationExtracted) });
    const data = await appBackendApi.getJson<{ found?: boolean; encoding?: string }>(
      `/api/vibes/encoding/${encodeURIComponent(filename)}?${params}`,
    );
    return data.found && data.encoding ? data.encoding : null;
  } catch {
    return null;
  }
}

export function clearPublicVibeCache(): void {
  localStorage.removeItem(PUBLIC_VIBE_CACHE_KEY);
  appBackendApi.revokeObjectUrls('/api/vibes/');
}

export function resolvePublicVibeThumbnailUrl(thumbnail?: string): string {
  if (!thumbnail) return '';
  return thumbnail.startsWith('/') ? '' : thumbnail;
}

export function getPublicVibeDownloadUrl(filename: string): Promise<string> {
  return appBackendApi.objectUrl(`/api/vibes/download/${encodeURIComponent(filename)}`);
}

async function hydrateVibeThumbnails(
  vibes: Array<PublicVibeData | PublicVibeCacheItem>,
): Promise<PublicVibeData[]> {
  return Promise.all(vibes.map(async vibe => {
    const path = `/api/vibes/thumbnail/${encodeURIComponent(vibe.filename)}`;
    try {
      const thumbnail = await appBackendApi.objectUrl(path);
      return { ...vibe, thumbnail } as PublicVibeData;
    } catch {
      return { ...vibe, thumbnail: '' } as PublicVibeData;
    }
  }));
}

export async function deletePublicVibe(filename: string): Promise<{ success: boolean; message?: string }> {
  try {
    await appBackendApi.deleteJson<{ success?: boolean }>(
      `/api/vibes/file/${encodeURIComponent(filename)}`,
    );
    clearPublicVibeCache();
    return { success: true };
  } catch (error) {
    console.error('删除Vibe文件失败:', error);
    return { success: false, message: error instanceof Error ? error.message : '删除失败' };
  }
}

export async function updatePublicVibeMeta(
  filename: string,
  meta: { name?: string; defaultStrength?: number; defaultInfoExtracted?: number }
): Promise<{ success: boolean; message?: string }> {
  try {
    await appBackendApi.putJson<{ success?: boolean }>(
      `/api/vibes/file/${encodeURIComponent(filename)}`,
      {
        name: meta.name,
        default_strength: meta.defaultStrength,
        default_info_extracted: meta.defaultInfoExtracted,
      },
    );
    clearPublicVibeCache();
    return { success: true };
  } catch (error) {
    console.error('更新公共Vibe失败:', error);
    return { success: false, message: error instanceof Error ? error.message : '更新失败' };
  }
}

export async function uploadVibeToPublic(
  vibeData: Record<string, unknown>,
  name?: string
): Promise<{ success: boolean; message: string; filename?: string }> {
  try {
    // 该端点是 body-session 双通道之一：Plana 方言要求 body 里带 session_id，
    // 我们后端走请求头认证但也接受 body 里的 session_id，所以有会话时一并带上。
    const sessionId = getOptionalSessionId();
    const data = await appBackendApi.postJson<{ message?: string; filename?: string }>('/api/vibes/upload', {
      vibe_data: vibeData,
      name,
      ...(sessionId ? { session_id: sessionId } : {}),
    });
    clearPublicVibeCache();
    return { success: true, message: data.message || '上传成功', filename: data.filename };
  } catch (error) {
    console.error('上传Vibe失败:', error);
    return { success: false, message: error instanceof Error ? error.message : '上传失败' };
  }
}
