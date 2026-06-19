/**
 * 云端库适配器 - 对接 Bot/队列后端（getBackendUrl）的用户云数据：
 * Vibe 云同步、墓碑、标签池、备份记录、画师串与 tag-manager 四类备份。
 *
 * 所有请求都走传统云后端（不是本地 sidecar），由 botService.ts 门面统一导出。
 */

import { getBackendUrl } from '../../utils/apiConfig';
import { botService } from './botSession';

// ==================== 用户 Vibe 云同步 API ====================

export interface CloudVibeMeta {
  id: string;
  name: string;
  filename: string;
  thumbnail: string;
  supportedModels: string[];
  defaultStrength?: number;
  defaultInfoExtracted?: number;
  createdAt: number;
  updatedAt: number;
  tags: string[];
  hasImage?: boolean;
  // 云同步 v2：用于增量传输的 hash
  imageHash?: string;
  metaHash?: string;
}

export interface CloudTombstone {
  id: string;
  deletedAt: number;
}

const CLOUD_VIBE_CACHE_KEY = 'cloud_vibe_cache_v1';
const CLOUD_VIBE_CACHE_TTL = 5 * 60 * 1000; // 5 分钟

interface CloudVibeCache {
  data: CloudVibeMeta[];
  timestamp: number;
  userId: string; // 切换账号时缓存失效
}

function getCloudVibeCache(currentUserId: string): CloudVibeCache | null {
  try {
    const cached = localStorage.getItem(CLOUD_VIBE_CACHE_KEY);
    if (!cached) return null;
    const cache: CloudVibeCache = JSON.parse(cached);
    if (cache.userId !== currentUserId) {
      localStorage.removeItem(CLOUD_VIBE_CACHE_KEY);
      return null;
    }
    if (Date.now() - cache.timestamp > CLOUD_VIBE_CACHE_TTL) {
      return null;
    }
    return cache;
  } catch {
    return null;
  }
}

function setCloudVibeCache(data: CloudVibeMeta[], userId: string): void {
  try {
    const cache: CloudVibeCache = { data, timestamp: Date.now(), userId };
    localStorage.setItem(CLOUD_VIBE_CACHE_KEY, JSON.stringify(cache));
  } catch (e) {
    console.warn('保存云Vibe缓存失败:', e);
  }
}

export function clearCloudVibeCache(): void {
  try { localStorage.removeItem(CLOUD_VIBE_CACHE_KEY); } catch { }
}

/** 当前 bot_user_id（用于前端 UI 区分"我上传的"） */
export function getCurrentBotUserId(): string | null {
  return botService.getAuthState().botUserId || null;
}

/**
 * 获取当前用户云端 vibe 列表
 */
export async function getCloudVibes(forceRefresh = false): Promise<CloudVibeMeta[]> {
  const auth = botService.getAuthState();
  if (!auth.isAuthorized || !auth.sessionId || !auth.botUserId) {
    return [];
  }
  if (!forceRefresh) {
    const cached = getCloudVibeCache(auth.botUserId);
    if (cached) return cached.data;
  }

  const backendUrl = getBackendUrl();
  try {
    const resp = await fetch(`${backendUrl}/api/user-vibes/list?session_id=${encodeURIComponent(auth.sessionId)}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const vibes: CloudVibeMeta[] = (data.vibes || []).map((v: Record<string, unknown>) => ({
      id: String(v.id || ''),
      name: String(v.name || ''),
      filename: String(v.filename || ''),
      thumbnail: String(v.thumbnail || ''),
      supportedModels: (v.supportedModels as string[]) || [],
      defaultStrength: v.defaultStrength as number | undefined,
      defaultInfoExtracted: v.defaultInfoExtracted as number | undefined,
      createdAt: (v.createdAt as number) || 0,
      updatedAt: (v.updatedAt as number) || 0,
      tags: (v.tags as string[]) || [],
      hasImage: v.hasImage as boolean | undefined,
      imageHash: typeof v.image_hash === 'string' ? v.image_hash : undefined,
      metaHash: typeof v.meta_hash === 'string' ? v.meta_hash : undefined,
    }));
    setCloudVibeCache(vibes, auth.botUserId);
    return vibes;
  } catch (err) {
    console.error('获取云Vibe列表失败:', err);
    return [];
  }
}

/**
 * 获取完整的云端 vibe 文件
 */
export async function getCloudVibeFile(filename: string): Promise<Record<string, unknown> | null> {
  const auth = botService.getAuthState();
  if (!auth.sessionId) return null;
  const backendUrl = getBackendUrl();
  try {
    const resp = await fetch(
      `${backendUrl}/api/user-vibes/file/${encodeURIComponent(filename)}?session_id=${encodeURIComponent(auth.sessionId)}`
    );
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } catch (err) {
    console.error('获取云Vibe文件失败:', err);
    return null;
  }
}

/**
 * 推送 vibe 到云端（新建或覆盖更新）
 */
export async function uploadCloudVibe(
  vibeData: Record<string, unknown>,
  tags?: string[],
  filename?: string,
): Promise<{ success: boolean; filename?: string; message?: string; imageHash?: string; metaHash?: string }> {
  const auth = botService.getAuthState();
  if (!auth.sessionId) return { success: false, message: '未Bot授权' };
  const backendUrl = getBackendUrl();

  try {
    const resp = await fetch(`${backendUrl}/api/user-vibes/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: auth.sessionId,
        vibe_data: vibeData,
        tags,
        filename,
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.detail || `HTTP ${resp.status}`);
    clearCloudVibeCache();
    return {
      success: true,
      filename: data.filename,
      imageHash: typeof data.image_hash === 'string' ? data.image_hash : undefined,
      metaHash: typeof data.meta_hash === 'string' ? data.meta_hash : undefined,
    };
  } catch (err) {
    console.error('上传云Vibe失败:', err);
    return { success: false, message: err instanceof Error ? err.message : '上传失败' };
  }
}

/**
 * 更新云端 vibe 元数据（标签/名称/默认参数）
 */
export async function updateCloudVibeMeta(
  filename: string,
  meta: { name?: string; tags?: string[]; defaultStrength?: number; defaultInfoExtracted?: number }
): Promise<{ success: boolean; message?: string; imageHash?: string; metaHash?: string }> {
  const auth = botService.getAuthState();
  if (!auth.sessionId) return { success: false, message: '未Bot授权' };
  const backendUrl = getBackendUrl();

  try {
    const resp = await fetch(`${backendUrl}/api/user-vibes/file/${encodeURIComponent(filename)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: auth.sessionId,
        name: meta.name,
        tags: meta.tags,
        default_strength: meta.defaultStrength,
        default_info_extracted: meta.defaultInfoExtracted,
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.detail || `HTTP ${resp.status}`);
    clearCloudVibeCache();
    return {
      success: true,
      imageHash: typeof data.image_hash === 'string' ? data.image_hash : undefined,
      metaHash: typeof data.meta_hash === 'string' ? data.meta_hash : undefined,
    };
  } catch (err) {
    console.error('更新云Vibe失败:', err);
    return { success: false, message: err instanceof Error ? err.message : '更新失败' };
  }
}

/**
 * 删除云端 vibe
 */
export async function deleteCloudVibe(filename: string): Promise<{ success: boolean; message?: string }> {
  const auth = botService.getAuthState();
  if (!auth.sessionId) return { success: false, message: '未Bot授权' };
  const backendUrl = getBackendUrl();

  try {
    const resp = await fetch(
      `${backendUrl}/api/user-vibes/file/${encodeURIComponent(filename)}?session_id=${encodeURIComponent(auth.sessionId)}`,
      { method: 'DELETE' }
    );
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      throw new Error(data.detail || `HTTP ${resp.status}`);
    }
    clearCloudVibeCache();
    return { success: true };
  } catch (err) {
    console.error('删除云Vibe失败:', err);
    return { success: false, message: err instanceof Error ? err.message : '删除失败' };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 云同步 v2 — 严格版 wrapper：失败时 throw，绝不静默返回空，给 sync 流程用
// ════════════════════════════════════════════════════════════════════════════

/**
 * 严格版：拉取云端 vibe 列表。
 * - 成功 + 空列表 → 返回 []
 * - 失败 → throw，sync 流程 catch 后必须中止，不动本地数据
 */
export async function getCloudVibesStrict(): Promise<CloudVibeMeta[]> {
  const auth = botService.getAuthState();
  if (!auth.isAuthorized || !auth.sessionId || !auth.botUserId) {
    throw new Error('未Bot授权');
  }
  const backendUrl = getBackendUrl();
  const resp = await fetch(`${backendUrl}/api/user-vibes/list?session_id=${encodeURIComponent(auth.sessionId)}`);
  if (!resp.ok) throw new Error(`getCloudVibesStrict HTTP ${resp.status}`);
  const data = await resp.json();
  if (!data || !Array.isArray(data.vibes)) {
    throw new Error('getCloudVibesStrict 响应格式异常');
  }
  return (data.vibes as Array<Record<string, unknown>>).map(v => ({
    id: String(v.id || ''),
    name: String(v.name || ''),
    filename: String(v.filename || ''),
    thumbnail: String(v.thumbnail || ''),
    supportedModels: (v.supportedModels as string[]) || [],
    defaultStrength: v.defaultStrength as number | undefined,
    defaultInfoExtracted: v.defaultInfoExtracted as number | undefined,
    createdAt: (v.createdAt as number) || 0,
    updatedAt: (v.updatedAt as number) || 0,
    tags: (v.tags as string[]) || [],
    hasImage: v.hasImage as boolean | undefined,
    imageHash: typeof v.image_hash === 'string' ? v.image_hash : undefined,
    metaHash: typeof v.meta_hash === 'string' ? v.meta_hash : undefined,
  }));
}

/**
 * 严格版：拉取单个 vibe 完整文件。失败时 throw。
 */
export async function getCloudVibeFileStrict(filename: string): Promise<Record<string, unknown>> {
  const auth = botService.getAuthState();
  if (!auth.sessionId) throw new Error('未Bot授权');
  const backendUrl = getBackendUrl();
  const resp = await fetch(
    `${backendUrl}/api/user-vibes/file/${encodeURIComponent(filename)}?session_id=${encodeURIComponent(auth.sessionId)}`
  );
  if (!resp.ok) throw new Error(`getCloudVibeFileStrict HTTP ${resp.status}`);
  const data = await resp.json();
  if (!data || typeof data !== 'object') {
    throw new Error('getCloudVibeFileStrict 响应格式异常');
  }
  return data as Record<string, unknown>;
}

// ── 同步协议版本检查 ──────────────────────────────────────────────────────────

/** 客户端要求的最低后端协议版本（与后端 SYNC_PROTOCOL_VERSION 对齐） */
export const REQUIRED_SYNC_PROTOCOL_VERSION = 2;

export async function getServerSyncVersion(): Promise<number> {
  const backendUrl = getBackendUrl();
  const resp = await fetch(`${backendUrl}/api/sync/version`);
  if (!resp.ok) throw new Error(`getServerSyncVersion HTTP ${resp.status}`);
  const data = await resp.json();
  if (typeof data?.version !== 'number') {
    throw new Error('getServerSyncVersion 响应格式异常');
  }
  return data.version;
}

// ── 墓碑 ──────────────────────────────────────────────────────────────────────

export async function getCloudTombstones(): Promise<CloudTombstone[]> {
  const auth = botService.getAuthState();
  if (!auth.sessionId) throw new Error('未Bot授权');
  const backendUrl = getBackendUrl();
  const resp = await fetch(`${backendUrl}/api/user-vibes/tombstones?session_id=${encodeURIComponent(auth.sessionId)}`);
  if (!resp.ok) throw new Error(`getCloudTombstones HTTP ${resp.status}`);
  const data = await resp.json();
  if (!data || !Array.isArray(data.tombstones)) {
    throw new Error('getCloudTombstones 响应格式异常');
  }
  return (data.tombstones as Array<Record<string, unknown>>)
    .filter(t => typeof t.id === 'string' && typeof t.deleted_at === 'number')
    .map(t => ({ id: t.id as string, deletedAt: t.deleted_at as number }));
}

export async function addCloudTombstone(vibeId: string): Promise<void> {
  const auth = botService.getAuthState();
  if (!auth.sessionId) throw new Error('未Bot授权');
  const backendUrl = getBackendUrl();
  const resp = await fetch(`${backendUrl}/api/user-vibes/tombstones`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: auth.sessionId, vibe_id: vibeId }),
  });
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    throw new Error(data.detail || `addCloudTombstone HTTP ${resp.status}`);
  }
}

// ── 标签池 ────────────────────────────────────────────────────────────────────

export async function getCloudTagPool(): Promise<string[]> {
  const auth = botService.getAuthState();
  if (!auth.sessionId) throw new Error('未Bot授权');
  const backendUrl = getBackendUrl();
  const resp = await fetch(`${backendUrl}/api/user-vibes/tag-pool?session_id=${encodeURIComponent(auth.sessionId)}`);
  if (!resp.ok) throw new Error(`getCloudTagPool HTTP ${resp.status}`);
  const data = await resp.json();
  if (!data || !Array.isArray(data.tags)) {
    throw new Error('getCloudTagPool 响应格式异常');
  }
  return (data.tags as unknown[]).filter((t): t is string => typeof t === 'string' && t.length > 0);
}

export async function putCloudTagPool(tags: string[]): Promise<void> {
  const auth = botService.getAuthState();
  if (!auth.sessionId) throw new Error('未Bot授权');
  const backendUrl = getBackendUrl();
  const resp = await fetch(`${backendUrl}/api/user-vibes/tag-pool`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: auth.sessionId, tags }),
  });
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    throw new Error(data.detail || `putCloudTagPool HTTP ${resp.status}`);
  }
}

// ── 备份记录 ──────────────────────────────────────────────────────────────────

export interface BackupLogEntry {
  device: string;
  action: 'backup' | 'restore';
  time: number;       // unix seconds
  vibe_count: number;
  detail: string;
}

/** 获取设备名称（从 User-Agent 推断） */
export function getDeviceName(): string {
  const ua = navigator.userAgent;
  let os = '未知';
  if (/Windows/.test(ua)) os = 'Windows';
  else if (/iPhone|iPad/.test(ua)) os = 'iOS';
  else if (/Mac/.test(ua)) os = 'macOS';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/Linux/.test(ua)) os = 'Linux';

  let browser = '';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Safari\//.test(ua) && !/Chrome/.test(ua)) browser = 'Safari';

  return browser ? `${os} ${browser}` : os;
}

export async function getBackupLog(): Promise<BackupLogEntry[]> {
  const auth = botService.getAuthState();
  if (!auth.sessionId) return [];
  const backendUrl = getBackendUrl();
  try {
    const resp = await fetch(`${backendUrl}/api/user-vibes/backup-log?session_id=${encodeURIComponent(auth.sessionId)}`);
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.log || []) as BackupLogEntry[];
  } catch { return []; }
}

export async function recordBackup(action: 'backup' | 'restore', vibeCount: number, detail: string): Promise<void> {
  const auth = botService.getAuthState();
  if (!auth.sessionId) return;
  const backendUrl = getBackendUrl();
  try {
    await fetch(`${backendUrl}/api/user-vibes/backup-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: auth.sessionId,
        device: getDeviceName(),
        action,
        vibe_count: vibeCount,
        detail,
      }),
    });
  } catch { /* 记录失败不影响主流程 */ }
}

// ── 画师串个人备份 ────────────────────────────────────────────────────────────

export interface ArtistBackupData {
  artists: Array<Record<string, unknown>>;
  updated_at: number;
  count: number;
}

export async function getArtistsBackup(): Promise<ArtistBackupData> {
  const auth = botService.getAuthState();
  if (!auth.sessionId) throw new Error('未Bot授权');
  const backendUrl = getBackendUrl();
  const resp = await fetch(`${backendUrl}/api/user-artists/backup?session_id=${encodeURIComponent(auth.sessionId)}`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return await resp.json();
}

export async function uploadArtistsBackup(artists: Array<Record<string, unknown>>): Promise<{ count: number; updated_at: number }> {
  const auth = botService.getAuthState();
  if (!auth.sessionId) throw new Error('未Bot授权');
  const backendUrl = getBackendUrl();
  const resp = await fetch(`${backendUrl}/api/user-artists/backup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: auth.sessionId, artists }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  return { count: data.count, updated_at: data.updated_at };
}

// ── tag-manager 4 类统一云端备份 ─────────────────────────────────────────────
// 一次性备份/恢复 character / artist-style / scene / other 四类本地数据

export type TagBackupCategoryId = 'character' | 'artist-style' | 'scene' | 'other';

export interface TagBackupAllData {
  categories: Record<TagBackupCategoryId, Array<Record<string, unknown>>>;
  updated_at: number;
  counts: Record<TagBackupCategoryId, number>;
}

export async function getTagBackupAll(): Promise<TagBackupAllData> {
  const auth = botService.getAuthState();
  if (!auth.sessionId) throw new Error('未Bot授权');
  const backendUrl = getBackendUrl();
  const resp = await fetch(`${backendUrl}/api/user-tag-backup?session_id=${encodeURIComponent(auth.sessionId)}`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return await resp.json();
}

export async function uploadTagBackupAll(
  categories: Record<TagBackupCategoryId, Array<Record<string, unknown>>>,
): Promise<{ updated_at: number; counts: Record<TagBackupCategoryId, number> }> {
  const auth = botService.getAuthState();
  if (!auth.sessionId) throw new Error('未Bot授权');
  const backendUrl = getBackendUrl();
  const resp = await fetch(`${backendUrl}/api/user-tag-backup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: auth.sessionId, categories }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  return { updated_at: data.updated_at, counts: data.counts };
}

/**
 * 获取云端 vibe 状态（计数 + 最后更新时间），用于增量轮询
 */
export async function getCloudVibeState(): Promise<{ count: number; updated_at: number } | null> {
  const auth = botService.getAuthState();
  if (!auth.sessionId) return null;
  const backendUrl = getBackendUrl();

  try {
    const resp = await fetch(`${backendUrl}/api/user-vibes/state?session_id=${encodeURIComponent(auth.sessionId)}`);
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}
