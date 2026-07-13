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
