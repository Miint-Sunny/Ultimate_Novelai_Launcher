/**
 * API 配置管理
 * 统一管理所有后端 API 地址，方便本地测试和部署切换
 */

import { getAppSettings } from './storage';
import { getSidecarUrl } from '../api/sidecar';

/**
 * 获取后端服务地址（移除末尾斜杠）
 * - serverMode === 'public': 使用本地 sidecar
 * - serverMode === 'custom': 使用用户配置的 backendUrl
 */
export function getBackendUrl(): string {
  const settings = getAppSettings();
  if (settings.serverMode === 'custom' && settings.backendUrl) {
    return settings.backendUrl.replace(/\/$/, '');
  }
  return getSidecarUrl();
}

/**
 * 获取排队服务地址（已合并到后端地址）
 */
export function getQueueServerUrl(): string {
  return getBackendUrl();
}

/**
 * 构建 API 完整 URL
 * @param path API 路径，如 '/api/data/xxx.json'
 * @param useQueueServer 是否使用排队服务地址
 */
export function buildApiUrl(path: string, useQueueServer = false): string {
  const baseUrl = useQueueServer ? getQueueServerUrl() : getBackendUrl();
  // 确保 path 以 / 开头
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${baseUrl}${normalizedPath}`;
}

/**
 * API 路径常量
 */
export const API_PATHS = {
  // 数据文件
  DATA_ROLE_TAG_MAPPING: '/api/data/role_tag_mapping.json',
  DATA_NAI_NSFW: '/api/data/NAI_NSFW.json',
  DATA_NAI_COMMON: '/api/data/NAI_Common.json',
  DATA_OC_DATA: '/api/data/oc_data.json',
  
  // 标签服务
  TAGS_WIKI: '/api/tags/wiki',
  TAGS_AUTOCOMPLETE: '/api/tags/autocomplete',
  
  // 香蕉重绘
  BANANA_ESTIMATE: '/api/banana/estimate',
  BANANA_REPAINT: '/api/banana/repaint',
  BANANA_STATUS: '/api/banana/status',
  
  // Vibe 编码
  VIBE_ENCODE: '/api/vibe/encode',
  
  // 超分
  UPSCALE: '/upscale',
  
  // 翻译代理
  TRANSLATE_PROXY: '/api/translate/proxy',
  
  // OC 管理
  OC_LIST: '/api/oc/list',
  OC_CREATE: '/api/oc/create',
  
  // Vibes 管理
  VIBES_LIST: '/api/vibes/list',
  VIBES_UPLOAD: '/api/vibes/upload',
  
  // 画师管理
  ARTISTS_LIST: '/api/artists/list',
  ARTISTS_CREATE: '/api/artists/create',
  
  // Precise Reference 管理 (原 CR)
  CR_LIST: '/api/cr/list',
  CR_CREATE: '/api/cr/create',
  
  // Bot 相关
  BOT_AUTH_GENERATE: '/api/bot/auth/generate',
  BOT_AUTH_CHECK: '/api/bot/auth/check',
  BOT_GENERATE: '/api/bot/generate',
  BOT_IMAGE: '/api/bot/image',
  
  // 在线状态
  ONLINE_HEARTBEAT: '/api/online/heartbeat',
  ONLINE_COUNT: '/api/online/count',
  
  // Anlas
  ANLAS: '/api/anlas',
} as const;
