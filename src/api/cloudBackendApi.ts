import { getAppSettings } from '../utils/storage';
import { getOptionalSessionId } from '../services/publicLibrary/session';
import type { ApiQuery } from './localSidecarApi';

export class CloudBackendUnavailableError extends Error {
  readonly code = 'cloud_backend_unavailable';

  constructor() {
    super('当前没有配置私有云后端');
    this.name = 'CloudBackendUnavailableError';
  }
}

function configuredBaseUrl(): string {
  const settings = getAppSettings();
  if (settings.serverMode !== 'custom' || !settings.backendUrl?.trim()) {
    throw new CloudBackendUnavailableError();
  }
  return settings.backendUrl.trim().replace(/\/$/, '');
}

async function readError(response: Response): Promise<string> {
  try {
    const body = await response.json();
    return body?.detail || body?.title || body?.message || JSON.stringify(body);
  } catch {
    return `HTTP ${response.status}`;
  }
}

function withQuery(path: string, query?: ApiQuery): string {
  if (!query) return path;
  const separator = path.includes('?') ? '&' : '?';
  const params = new URLSearchParams();
  for (const [key, rawValue] of Object.entries(query)) {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      if (value !== null && value !== undefined) params.append(key, String(value));
    }
  }
  const encoded = params.toString();
  return encoded ? `${path}${separator}${encoded}` : path;
}

// 我们后端把「同一请求出现两个凭据载体」判为冲突的两处路径：
// GET/DELETE /api/task/{id} 在 ?session_id= 与 Authorization 同时出现时返回 400；
// /api/agent/** 在 X-Bot-Session / Authorization / ?session_id= 中出现两个时返回
// 404，即使两者的值完全相同也一样。这两处都只属于我们自己的方言（Plana 轮询走
// /api/bot/task/{id}，也没有 Agent 面），所以不在它们上自动补 Bearer 不损失兼容性。
function rejectsInferredBearer(path: string): boolean {
  const pathname = path.split('?')[0];
  return pathname === '/api/agent'
    || pathname.startsWith('/api/agent/')
    || pathname.startsWith('/api/task/');
}

async function request(path: string, init?: RequestInit, query?: ApiQuery): Promise<Response> {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const headers = new Headers(init?.headers);
  const sessionId = getOptionalSessionId();
  // Never replace an explicit caller credential. The backend rejects a
  // conflicting body/query compatibility session, so identity cannot depend on
  // adapter precedence.
  if (sessionId && !headers.has('X-Bot-Session')) {
    headers.set('X-Bot-Session', sessionId);
  }
  // 双方言认证：我们的后端读 X-Bot-Session，Plana 协议后端只认
  // Authorization: Bearer <sessionId>。两个头携带的是同一枚凭据、发往同一个用户
  // 配置的后端地址，且下面的 redirect: 'error' 杜绝了跨源重放，因此并发下发不会
  // 扩大凭据暴露面；我们后端的库/统计/计费等端点只读 X-Bot-Session 与 body/query
  // 里的 session_id，多出来的 Authorization 会被忽略（CORS 允许头里已含它）。
  // 同样不覆盖调用方显式设置的 Authorization（如 /api/task 的一次性任务能力令牌）。
  if (sessionId && !headers.has('Authorization') && !rejectsInferredBearer(normalizedPath)) {
    headers.set('Authorization', `Bearer ${sessionId}`);
  }
  // API redirects are not part of the custom backend protocol. Refusing them
  // guarantees that session headers cannot be replayed to another origin.
  return fetch(`${configuredBaseUrl()}${withQuery(normalizedPath, query)}`, {
    ...init,
    headers,
    redirect: 'error',
  });
}

async function requestJson<T>(path: string, init?: RequestInit, query?: ApiQuery): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await request(path, {
    ...init,
    headers,
  }, query);
  if (!response.ok) throw new Error(await readError(response));
  return response.json() as Promise<T>;
}

export const cloudBackendApi = {
  url(path: string): string {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${configuredBaseUrl()}${normalizedPath}`;
  },
  request: (path: string, init?: RequestInit, query?: ApiQuery) => request(path, init, query),
  getJson: <T>(path: string, query?: ApiQuery, signal?: AbortSignal) =>
    requestJson<T>(path, { signal }, query),
  postJson: <T>(path: string, body?: unknown) => requestJson<T>(path, {
    method: 'POST',
    body: JSON.stringify(body ?? {}),
  }),
  putJson: <T>(path: string, body?: unknown) => requestJson<T>(path, {
    method: 'PUT',
    body: JSON.stringify(body ?? {}),
  }),
  deleteJson: <T>(path: string) => requestJson<T>(path, { method: 'DELETE' }),
  blob: async (path: string, init?: RequestInit, query?: ApiQuery) => {
    const response = await request(path, init, query);
    if (!response.ok) throw new Error(await readError(response));
    return response.blob();
  },
  openSse: async (path: string, init?: RequestInit, query?: ApiQuery) => {
    const headers = new Headers(init?.headers);
    headers.set('Accept', 'text/event-stream');
    const response = await request(path, {
      ...init,
      headers,
    }, query);
    if (!response.ok) throw new Error(await readError(response));
    return response;
  },
};
