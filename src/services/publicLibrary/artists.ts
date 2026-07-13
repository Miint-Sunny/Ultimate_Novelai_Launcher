import { appBackendApi } from '../../api/appBackendApi';

export interface PublicArtistData {
  id: string;
  name: string;
  artist_string: string;
  negative?: string;
  preview_url: string | null;
  usage_count: number;
  created_time: number;
  created_time_str: string;
  added_by: string | null;
}

export interface PublicArtistListResponse {
  artists: PublicArtistData[];
  total: number;
}

export interface CreateArtistParams {
  name?: string;
  artist_string: string;
  negative?: string;
  preview_base64?: string;
  added_by?: string;
}

export interface UpdateArtistParams {
  artist_string?: string;
  negative?: string;
  preview_base64?: string;
  added_by?: string;
}

const PUBLIC_ARTIST_CACHE_KEY = 'public_artist_cache';
const PUBLIC_ARTIST_CACHE_TTL = 10 * 60 * 1000;
const artistPreviewUrls = new Map<string, string>();

interface PublicArtistCache {
  data: PublicArtistData[];
  timestamp: number;
}

function getPublicArtistCache(): PublicArtistCache | null {
  try {
    const cached = localStorage.getItem(PUBLIC_ARTIST_CACHE_KEY);
    if (!cached) return null;
    const cache: PublicArtistCache = JSON.parse(cached);
    if (Date.now() - cache.timestamp > PUBLIC_ARTIST_CACHE_TTL) {
      localStorage.removeItem(PUBLIC_ARTIST_CACHE_KEY);
      return null;
    }
    return cache;
  } catch {
    return null;
  }
}

function setPublicArtistCache(data: PublicArtistData[]): void {
  try {
    localStorage.setItem(PUBLIC_ARTIST_CACHE_KEY, JSON.stringify({ data, timestamp: Date.now() }));
  } catch (error) {
    console.warn('保存公共画师串缓存失败:', error);
  }
}

export async function getPublicArtists(forceRefresh = false): Promise<PublicArtistData[]> {
  if (!forceRefresh) {
    const cache = getPublicArtistCache();
    if (cache) {
      console.log('[公共画师串] 使用缓存数据');
      return hydrateArtistPreviews(cache.data);
    }
  }

  try {
    const data = await appBackendApi.getJson<PublicArtistListResponse>(
      '/api/artists/list',
    );
    const artists = data.artists || [];
    setPublicArtistCache(artists);
    console.log(`[公共画师串] 已从服务器获取 ${artists.length} 个画师串`);
    return hydrateArtistPreviews(artists);
  } catch (error) {
    console.error('获取公共画师串列表失败:', error);
    try {
      const cached = localStorage.getItem(PUBLIC_ARTIST_CACHE_KEY);
      if (cached) {
        const cache: PublicArtistCache = JSON.parse(cached);
        console.log('[公共画师串] 使用过期缓存作为fallback');
        return hydrateArtistPreviews(cache.data);
      }
    } catch { }
    return [];
  }
}

export function clearPublicArtistCache(): void {
  localStorage.removeItem(PUBLIC_ARTIST_CACHE_KEY);
  artistPreviewUrls.clear();
  appBackendApi.revokeObjectUrls('/api/artists/preview/');
}

export function getArtistPreviewUrl(filename: string): string {
  return artistPreviewUrls.get(filename) || '';
}

async function hydrateArtistPreviews(artists: PublicArtistData[]): Promise<PublicArtistData[]> {
  return Promise.all(artists.map(async artist => {
    if (!artist.preview_url) return artist;
    const path = `/api/artists/preview/${encodeURIComponent(artist.name)}`;
    try {
      const preview = await appBackendApi.objectUrl(path);
      artistPreviewUrls.set(artist.name, preview);
      return { ...artist, preview_url: preview };
    } catch {
      return { ...artist, preview_url: null };
    }
  }));
}

export async function createPublicArtist(
  params: CreateArtistParams
): Promise<{ success: boolean; message: string; artist?: PublicArtistData }> {
  try {
    const data = await appBackendApi.postJson<{ message?: string; artist?: PublicArtistData }>(
      '/api/artists/create',
      params,
    );
    clearPublicArtistCache();
    return { success: true, message: data.message || '创建成功', artist: data.artist };
  } catch (error) {
    console.error('创建公共画师串失败:', error);
    return { success: false, message: String(error) };
  }
}

export async function updatePublicArtist(
  artistName: string,
  params: UpdateArtistParams
): Promise<{ success: boolean; message: string; artist?: PublicArtistData }> {
  try {
    const data = await appBackendApi.putJson<{ message?: string; artist?: PublicArtistData }>(
      `/api/artists/${encodeURIComponent(artistName)}`,
      params,
    );
    clearPublicArtistCache();
    return { success: true, message: data.message || '更新成功', artist: data.artist };
  } catch (error) {
    console.error('更新公共画师串失败:', error);
    return { success: false, message: String(error) };
  }
}

export async function deletePublicArtist(artistName: string): Promise<{ success: boolean; message: string }> {
  try {
    const data = await appBackendApi.deleteJson<{ message?: string }>(`/api/artists/${encodeURIComponent(artistName)}`);
    clearPublicArtistCache();
    return { success: true, message: data.message || '删除成功' };
  } catch (error) {
    console.error('删除公共画师串失败:', error);
    return { success: false, message: String(error) };
  }
}

export async function usePublicArtist(artistName: string): Promise<boolean> {
  try {
    await appBackendApi.postJson<{ success?: boolean }>(`/api/artists/${encodeURIComponent(artistName)}/use`);
    return true;
  } catch (error) {
    console.error('记录画师串使用失败:', error);
    return false;
  }
}
