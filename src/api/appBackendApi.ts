import { APP_SETTINGS_CHANGED_EVENT } from '../services/localLibrary/appSettings';
import { getAppSettings } from '../utils/storage';
import { cloudBackendApi } from './cloudBackendApi';
import {
  getSidecarUrl,
  getLocalSidecarReady,
  localSidecarApi,
  revokeAuthenticatedObjectUrls,
  SIDECAR_SESSION_CHANGED_EVENT,
  type ApiQuery,
} from './localSidecarApi';

export interface BackendFeatureAvailability {
  available: boolean;
  reason?: string;
}

/**
 * Mode-aware facade for endpoints that exist on both the bundled sidecar and
 * the configured private backend. It preserves the endpoint protocol while
 * ensuring local requests always receive the process Bearer token.
 */
function client() {
  return getAppSettings().serverMode === 'custom'
    ? cloudBackendApi
    : localSidecarApi;
}

function backendEndpointUrl(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return getAppSettings().serverMode === 'custom'
    ? cloudBackendApi.url(normalizedPath)
    : `${getSidecarUrl()}${normalizedPath}`;
}

function webSocketUrl(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  if (!normalizedPath.startsWith('/ws/')) {
    throw new Error('webSocketUrl 仅允许 WebSocket 端点');
  }
  return backendEndpointUrl(normalizedPath).replace(/^http/, 'ws');
}

const cloudObjectUrls = new Map<string, { path: string; url: string }>();
const cloudObjectUrlInflight = new Map<string, Promise<string>>();
const cloudObjectUrlControllers = new Map<string, AbortController>();
let cloudObjectUrlGeneration = 0;

async function objectUrl(path: string): Promise<string> {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  if (getAppSettings().serverMode !== 'custom') return localSidecarApi.objectUrl(normalizedPath);
  const cacheKey = cloudBackendApi.url(normalizedPath);
  const cached = cloudObjectUrls.get(cacheKey);
  if (cached) return cached.url;
  const pending = cloudObjectUrlInflight.get(cacheKey);
  if (pending) return pending;
  const generation = cloudObjectUrlGeneration;
  const controller = new AbortController();
  let load: Promise<string>;
  load = cloudBackendApi.blob(normalizedPath, { signal: controller.signal })
    .then(blob => {
      if (generation !== cloudObjectUrlGeneration) {
        throw new Error('后端连接已变化，请重新加载图片');
      }
      const url = URL.createObjectURL(blob);
      cloudObjectUrls.set(cacheKey, { path: normalizedPath, url });
      return url;
    })
    .finally(() => {
      if (cloudObjectUrlInflight.get(cacheKey) === load) {
        cloudObjectUrlInflight.delete(cacheKey);
        cloudObjectUrlControllers.delete(cacheKey);
      }
    });
  cloudObjectUrlInflight.set(cacheKey, load);
  cloudObjectUrlControllers.set(cacheKey, controller);
  return load;
}

function revokeObjectUrls(prefix?: string): void {
  cloudObjectUrlGeneration += 1;
  for (const controller of cloudObjectUrlControllers.values()) controller.abort();
  cloudObjectUrlInflight.clear();
  cloudObjectUrlControllers.clear();
  revokeAuthenticatedObjectUrls(prefix);
  for (const [key, entry] of cloudObjectUrls) {
    if (prefix && !entry.path.startsWith(prefix)) continue;
    URL.revokeObjectURL(entry.url);
    cloudObjectUrls.delete(key);
  }
}

function backendIdentity(): string {
  const settings = getAppSettings();
  return settings.serverMode === 'custom'
    ? `custom:${settings.backendUrl.trim().replace(/\/$/, '')}`
    : 'local-sidecar';
}

let activeBackendIdentity = backendIdentity();

function synchronizeBackendIdentity(): void {
  const nextIdentity = backendIdentity();
  if (nextIdentity === activeBackendIdentity) return;
  revokeObjectUrls();
  activeBackendIdentity = nextIdentity;
}

function desktopAgentAvailability(): BackendFeatureAvailability {
  if (getAppSettings().serverMode === 'custom') return { available: true };

  const capabilities = getLocalSidecarReady()?.capabilities ?? {};
  const explicitAvailability = capabilities.desktop_agent_available;
  const promptResources = capabilities.agent_prompt_resources;
  if (explicitAvailability === true) return { available: true };

  if (promptResources === 'unavailable') {
    return {
      available: false,
      reason: '本地 Agent 正式提示词资源不可用，请检查 dev sidecar 打包资源',
    };
  }
  // The current dev sidecar always publishes this authoritative boolean. It
  // must take precedence over prompt-only compatibility states: prompts can be
  // present while the primary provider/model/key tuple is still incomplete.
  if (explicitAvailability === false) {
    return {
      available: false,
      reason: promptResources === 'available'
        ? '本地 Agent 主模型尚未完整配置，请先设置提供商、地址、模型和密钥'
        : '完整桌面 Agent 仅在 dev 版本或已配置的私有云后端中提供',
    };
  }

  // One-release compatibility for older dev sidecars that exposed only a
  // prompt-resource state and did not yet publish desktop_agent_available.
  if (
    promptResources === 'ready'
    || promptResources === 'bundled'
    || promptResources === 'available'
  ) {
    return { available: true };
  }

  return {
    available: false,
    reason: promptResources === 'not_required_on_main'
      ? '完整桌面 Agent 仅在 dev 版本或已配置的私有云后端中提供'
      : '本地后端未声明桌面 Agent 能力，请检查 sidecar 版本与就绪状态',
  };
}

window.addEventListener(APP_SETTINGS_CHANGED_EVENT, synchronizeBackendIdentity);
window.addEventListener('storage', synchronizeBackendIdentity);
window.addEventListener(SIDECAR_SESSION_CHANGED_EVENT, () => revokeObjectUrls());
window.addEventListener('pagehide', () => revokeObjectUrls());
window.addEventListener('beforeunload', () => revokeObjectUrls());

export const appBackendApi = {
  webSocketUrl,
  request: (path: string, init?: RequestInit, query?: ApiQuery) =>
    client().request(path, init, query),
  getJson: <T>(path: string, query?: ApiQuery, signal?: AbortSignal) =>
    client().getJson<T>(path, query, signal),
  postJson: <T>(path: string, body?: unknown) => client().postJson<T>(path, body),
  putJson: <T>(path: string, body?: unknown) => client().putJson<T>(path, body),
  deleteJson: <T>(path: string) => client().deleteJson<T>(path),
  blob: (path: string, init?: RequestInit, query?: ApiQuery) =>
    client().blob(path, init, query),
  objectUrl,
  revokeObjectUrls,
  desktopAgentAvailability,
  openSse: (path: string, init?: RequestInit, query?: ApiQuery) =>
    client().openSse(path, init, query),
};
