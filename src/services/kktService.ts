/**
 * KKT 收集 API 服务
 * 对接独立部署的 kkt_server 后端
 */

import { getAppSettings } from './localLibrary';
import { botService } from './botService';

// KKT 公共服务端默认地址
const KKT_PUBLIC_URL = 'https://nai.sora214.top';

export function getKktServerUrl(): string {
  const settings = getAppSettings();
  if (settings.kktServerMode === 'custom' && settings.kktServerUrl) {
    return settings.kktServerUrl.replace(/\/$/, '');
  }
  return KKT_PUBLIC_URL;
}

// ==================== 类型定义 ====================

export interface KktRecord {
  name: string;
  content: string;
  created_time_str: string;
  user_id: string;
  user_name: string;
  has_custom_image: number; // 0 | 1
  image_url?: string | null; // 仅 get_record 返回
  width?: number;
  height?: number;
  model_name?: string | null;
  image_size?: string | null;
  seed?: number | null;
  prompt?: string | null;
  negative_prompt?: string | null;
  tags?: string | null;
  caption?: string | null;
}

export interface KktListResponse {
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
  items: KktRecord[];
}

export interface KktStats {
  total: number;
  with_image: number;
  without_image: number;
  users: number;
}

export interface KktUser {
  user_id: string;
  user_name: string;
  count: number;
}

export interface KktListParams {
  page?: number;
  page_size?: number;
  search?: string;
  tags?: string;  // 逗号分隔的标签筛选
  nsfw?: boolean; // 是否显示 NSFW 内容
  time_range?: string; // 时间范围: today / week / month
  oc_tags?: string; // OC的tag_group，逗号分隔
  date_start?: string; // 开始日期 YYYY-MM-DD
  date_end?: string; // 结束日期 YYYY-MM-DD
  has_image?: boolean;
  user_id?: string;
  sort?: 'newest' | 'oldest' | 'name';
}

// ==================== API 函数 ====================

async function kktFetch<T>(path: string, params?: Record<string, string | number | boolean>): Promise<T> {
  // 访问限制：必须 Bot 授权
  if (!botService.getAuthState().isAuthorized) {
    console.log('[KKT] 未Bot授权，拒绝访问');
    throw new Error('需要Bot授权才能访问KKT收集');
  }
  const base = getKktServerUrl();
  const url = new URL(`${base}${path}`);
  // 附带 Bot session_id 用于后端验证
  const sessionId = botService.getAuthState().sessionId;
  if (sessionId) {
    url.searchParams.set('session_id', sessionId);
  }
  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    });
  }
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`KKT API error: ${res.status}`);
  return res.json();
}

export async function getKktStats(): Promise<KktStats> {
  return kktFetch('/api/kkt/stats');
}

export async function getKktList(params: KktListParams = {}): Promise<KktListResponse> {
  const query: Record<string, string | number | boolean> = {};
  if (params.page !== undefined) query.page = params.page;
  if (params.page_size !== undefined) query.page_size = params.page_size;
  if (params.search) query.search = params.search;
  if (params.tags) query.tags = params.tags;
  if (params.nsfw !== undefined) query.nsfw = params.nsfw;
  if (params.time_range) query.time_range = params.time_range;
  if (params.oc_tags) query.oc_tags = params.oc_tags;
  if (params.date_start) query.date_start = params.date_start;
  if (params.date_end) query.date_end = params.date_end;
  if (params.has_image !== undefined) query.has_image = params.has_image;
  if (params.user_id) query.user_id = params.user_id;
  if (params.sort) query.sort = params.sort;
  return kktFetch('/api/kkt/list', query);
}

export async function getKktRecord(name: string): Promise<KktRecord> {
  return kktFetch(`/api/kkt/record/${encodeURIComponent(name)}`);
}

export async function getKktRandom(count = 1, hasImage?: boolean): Promise<{ items: KktRecord[] }> {
  const query: Record<string, string | number | boolean> = { count };
  if (hasImage !== undefined) query.has_image = hasImage;
  return kktFetch('/api/kkt/random', query);
}

export async function getKktUsers(): Promise<{ users: KktUser[] }> {
  return kktFetch('/api/kkt/users');
}

/**
 * 构建图片 URL（直接指向 kkt_server）
 */
export function getKktImageUrl(filename: string): string {
  return `${getKktServerUrl()}/api/kkt/image/${encodeURIComponent(filename)}`;
}

/**
 * 从 image_url 字段（如 /api/kkt/image/xxx.png）构建完整 URL
 */
export function resolveKktImageUrl(imageUrl: string | null | undefined, preview = false): string | null {
  if (!imageUrl) return null;
  let url = imageUrl.startsWith('http') ? imageUrl : `${getKktServerUrl()}${imageUrl}`;
  if (preview && url.includes('/api/kkt/image/')) {
    const separator = url.includes('?') ? '&' : '?';
    url += `${separator}preview=true`;
  }
  return url;
}
