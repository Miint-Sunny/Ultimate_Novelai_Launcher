import type { components } from './generated/sidecar-v1';

type SidecarV1Schemas = components['schemas'];
export type ApiQueryValue = string | number | boolean | null | undefined;
export type ApiQuery = Record<string, ApiQueryValue | readonly ApiQueryValue[]>;
export type SidecarReady = SidecarV1Schemas['ReadyResponse'];
export type CanonicalGenerationJobCreate = SidecarV1Schemas['GenerationJobCreate'];
export type CanonicalGenerationJob = SidecarV1Schemas['GenerationJobResponse'];
export type CanonicalGenerationJobList = SidecarV1Schemas['GenerationJobListResponse'];
export type SidecarStorageStatus = SidecarV1Schemas['StorageStatusResponse'];
export type SidecarAssetList = SidecarV1Schemas['AssetListResponse'];
export type SidecarStoragePrune = SidecarV1Schemas['StoragePruneResponse'];
export type SidecarBackup = SidecarV1Schemas['BackupResponse'];
export type SidecarBackupList = SidecarV1Schemas['BackupListResponse'];
export type SidecarBackupRestore = SidecarV1Schemas['BackupRestoreResponse'];

export type GenerationMode = 'natural' | 'tags';

export interface PromptState {
  input: string;
  mode: GenerationMode;
  tags?: string | null;
  negative?: string | null;
}

export interface GenerationParams {
  /** 后端按 provider 分发:缺省 'nai';'comfy' 时 model 为工作流 id。 */
  provider?: 'nai' | 'comfy';
  model: string;
  width: number;
  height: number;
  steps: number;
  scale: number;
  cfg_rescale: number;
  sampler: string;
  noise_schedule: string;
  seed?: number | null;
}

export interface GenerationRequest extends PromptState {
  params: GenerationParams;
  legacy_payload?: Record<string, unknown> | null;
}

export interface GenerationResult {
  image_id: string;
  image_url: string;
  image_path: string;
  input: string;
  tags: string;
  negative: string;
  params: Record<string, unknown>;
  created_at: string;
}

export interface GenerationTask {
  id: string;
  status: string;
  progress?: number;
  error?: string | null;
}

export interface StoredAsset {
  id: string;
  url: string;
  path?: string;
  created_at?: string;
}

export interface HistoryItem {
  id: string;
  image_id: string;
  image_url: string | null;
  image_path: string | null;
  input: string;
  mode: GenerationMode;
  tags: string;
  negative: string;
  params: Record<string, unknown>;
  status: string;
  error: string | null;
  created_at: string;
}

export interface TokenStatus {
  configured: boolean;
  source: 'environment' | 'credential-store' | 'none';
  mock_generation: boolean;
}

export type LlmProvider = 'openai' | 'anthropic' | 'gemini';

export interface LlmKeyStatus {
  provider: string;
  key_configured: boolean;
  backup_provider: string;
  backup_key_configured: boolean;
  llm_configured: boolean;
}

export interface AppSettings {
  version: string;
  data_dir: string;
  nai_base_url: string;
  nai_configured: boolean;
  llm_provider: string;
  llm_base_url: string;
  llm_model: string;
  llm_key_configured: boolean;
  llm_backup_provider: string;
  llm_backup_base_url: string;
  llm_backup_model: string;
  llm_backup_key_configured: boolean;
  llm_configured: boolean;
  token: TokenStatus;
}

/**
 * Opus「体力条」。V5 起 Opus 的免费生成不再无限,改成一条持续恢复的额度。
 * 仅 Opus(tier 3)会返回此字段,低档位没有——所以是可选而不是默认零值:
 * 造一个 0 出来会被读成「额度已耗尽」。
 */
export interface OpusUsage {
  /** 剩余百分比。可以大于 100(官方发过一次性超额补偿,实测见过 170)。 */
  percent: number;
  /** true 表示额度不可用。 */
  isNegative: boolean;
  /** 距下 1% 恢复的秒数;条满暂停恢复时为 0。 */
  timeUntilNextPercent: number;
}

export interface AnlasInfo {
  fixedTrainingStepsLeft: number;
  purchasedTrainingSteps: number;
  isOpus: boolean;
  /** 仅 Opus 返回;见 OpusUsage。 */
  opusUsage?: OpusUsage;
}

export interface LegacyGenerateImageResult {
  imageData: Blob;
  seed?: number;
  sidecarResult: GenerationResult;
}

const DEFAULT_SIDECAR_URL = 'http://127.0.0.1:38176';
let resolvedSidecarUrl: string | null = null;
const BROWSER_SESSION_TOKEN_KEY = 'ultimate_novelai_launcher_sidecar_session';
const SIDECAR_PROTOCOL = 1;
export const SIDECAR_SESSION_CHANGED_EVENT = 'sidecar-session-changed';
export const SIDECAR_SETTINGS_CHANGED_EVENT = 'sidecar-settings-changed';

export class SidecarPairingRequiredError extends Error {
  constructor() {
    super('请输入 sidecar 终端显示的 6 位配对码');
    this.name = 'SidecarPairingRequiredError';
  }
}

export interface SidecarConnection {
  endpoint: string;
  token: string;
  instance_id: string;
  protocol: number;
  port: number;
}

export function getSidecarUrl(): string {
  return (
    resolvedSidecarUrl ||
    import.meta.env.VITE_SIDECAR_URL ||
    DEFAULT_SIDECAR_URL
  ).replace(/\/$/, '');
}

// The Tauri shell mints a per-session token and exposes it over the global bridge.
// Plain browser sessions must exchange the short-lived pairing code first. Cached
// after the first lookup (undefined = not looked up yet).
let sidecarAuthToken: string | null | undefined;
let sidecarConnectionPromise: Promise<SidecarConnection> | null = null;
let latestSidecarReady: SidecarReady | null = null;

type TauriBridge = {
  core?: { invoke?: (cmd: string) => Promise<unknown> };
  invoke?: (cmd: string) => Promise<unknown>;
};

function tauriInvoke(): ((cmd: string) => Promise<unknown>) | null {
  const tauri = (window as unknown as { __TAURI__?: TauriBridge }).__TAURI__;
  return tauri?.core?.invoke ?? tauri?.invoke ?? null;
}

function validateDesktopConnection(value: unknown): SidecarConnection {
  if (!value || typeof value !== 'object') throw new Error('桌面端未返回 sidecar 连接信息');
  const connection = value as Partial<SidecarConnection>;
  const endpoint = typeof connection.endpoint === 'string' ? connection.endpoint.replace(/\/$/, '') : '';
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') {
    throw new Error('桌面 sidecar 必须使用 127.0.0.1 HTTP 端点');
  }
  if (
    typeof connection.token !== 'string' || !connection.token
    || typeof connection.instance_id !== 'string' || !connection.instance_id
    || connection.protocol !== SIDECAR_PROTOCOL
    || typeof connection.port !== 'number' || connection.port <= 0
  ) {
    throw new Error('桌面 sidecar 握手不完整或协议不兼容');
  }
  return { ...connection, endpoint } as SidecarConnection;
}

async function getSidecarConnection(): Promise<SidecarConnection> {
  if (sidecarConnectionPromise) return sidecarConnectionPromise;
  sidecarConnectionPromise = (async () => {
    const invoke = tauriInvoke();
    if (invoke) {
      const connection = validateDesktopConnection(await invoke('sidecar_connection'));
      resolvedSidecarUrl = connection.endpoint;
      sidecarAuthToken = connection.token;
      return connection;
    }

    const endpoint = (import.meta.env.VITE_SIDECAR_URL || DEFAULT_SIDECAR_URL).replace(/\/$/, '');
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
      throw new Error('浏览器模式只允许连接 loopback sidecar');
    }
    const token = window.sessionStorage.getItem(BROWSER_SESSION_TOKEN_KEY) || '';
    resolvedSidecarUrl = endpoint;
    sidecarAuthToken = token || null;
    return {
      endpoint,
      token,
      instance_id: '',
      protocol: SIDECAR_PROTOCOL,
      port: Number(url.port || 80),
    };
  })();
  return sidecarConnectionPromise;
}

async function getSidecarAuthToken(): Promise<string | null> {
  if (sidecarAuthToken === undefined) await getSidecarConnection();
  return sidecarAuthToken ?? null;
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getSidecarAuthToken();
  return token
    ? { Authorization: `Bearer ${token}` }
    : {};
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

async function request(
  path: string,
  init?: RequestInit,
  query?: ApiQuery,
): Promise<Response> {
  const baseUrl = await resolveSidecarUrl();
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const headers = new Headers(init?.headers);
  const token = await getSidecarAuthToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(`${baseUrl}${withQuery(normalizedPath, query)}`, {
    ...init,
    headers,
  });
}

/** @deprecated Use localSidecarApi so authentication stays centralized. */
export async function sidecarAuthHeaders(): Promise<Record<string, string>> {
  return authHeaders();
}

async function requestJson<T>(path: string, init?: RequestInit, query?: ApiQuery): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await request(path, {
    ...init,
    headers,
  }, query);
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  return response.json() as Promise<T>;
}

async function requestBlob(path: string, init?: RequestInit, query?: ApiQuery): Promise<Blob> {
  const response = await request(path, init, query);
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  return response.blob();
}

const objectUrlCache = new Map<string, string>();
const objectUrlInflight = new Map<string, Promise<string>>();
const objectUrlControllers = new Map<string, AbortController>();
let objectUrlGeneration = 0;

export async function authenticatedObjectUrl(path: string): Promise<string> {
  const cached = objectUrlCache.get(path);
  if (cached) return cached;
  const pending = objectUrlInflight.get(path);
  if (pending) return pending;
  const generation = objectUrlGeneration;
  const controller = new AbortController();
  let promise: Promise<string>;
  promise = requestBlob(path, { signal: controller.signal })
    .then(blob => {
      if (generation !== objectUrlGeneration) {
        throw new Error('sidecar 会话已变化，请重新加载图片');
      }
      const url = URL.createObjectURL(blob);
      objectUrlCache.set(path, url);
      return url;
    })
    .finally(() => {
      if (objectUrlInflight.get(path) === promise) {
        objectUrlInflight.delete(path);
        objectUrlControllers.delete(path);
      }
    });
  objectUrlInflight.set(path, promise);
  objectUrlControllers.set(path, controller);
  return promise;
}

export function revokeAuthenticatedObjectUrls(prefix?: string): void {
  // Invalidate requests that started before this cleanup. Otherwise a slow
  // authenticated download could repopulate the cache after a session/mode
  // switch and expose a resource fetched with the previous credentials.
  objectUrlGeneration += 1;
  for (const controller of objectUrlControllers.values()) controller.abort();
  objectUrlInflight.clear();
  objectUrlControllers.clear();
  for (const [path, url] of objectUrlCache) {
    if (prefix && !path.startsWith(prefix)) continue;
    URL.revokeObjectURL(url);
    objectUrlCache.delete(path);
  }
}

async function resolveSidecarUrl(): Promise<string> {
  if (resolvedSidecarUrl) return resolvedSidecarUrl;
  return (await getSidecarConnection()).endpoint;
}

export async function initializeLocalSidecar(): Promise<void> {
  const connection = await getSidecarConnection();
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${connection.endpoint}/livez`, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (body?.service !== 'ultimate-novelai-launcher-sidecar') {
      throw new Error('服务身份不匹配');
    }
    if (connection.instance_id && body?.instance_id !== connection.instance_id) {
      throw new Error('sidecar 实例身份不匹配');
    }

    const ready = await fetch(`${connection.endpoint}/api/v1/system/ready`, {
      headers: await authHeaders(),
      signal: controller.signal,
    });
    if (ready.status === 401 && !connection.instance_id) {
      throw new SidecarPairingRequiredError();
    }
    if (!ready.ok) throw new Error(await readError(ready));
    latestSidecarReady = await ready.json() as SidecarReady;
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function pairLocalSidecar(code: string): Promise<void> {
  const connection = await getSidecarConnection();
  const response = await fetch(`${connection.endpoint}/api/v1/auth/pair/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: code.trim() }),
  });
  if (!response.ok) throw new Error(await readError(response));
  const body = await response.json() as { access_token?: string; token_type?: string };
  if (!body.access_token || body.token_type !== 'bearer') {
    throw new Error('sidecar 配对响应无效');
  }
  revokeAuthenticatedObjectUrls();
  window.sessionStorage.setItem(BROWSER_SESSION_TOKEN_KEY, body.access_token);
  sidecarAuthToken = body.access_token;
  window.dispatchEvent(new Event(SIDECAR_SESSION_CHANGED_EVENT));
}

export function getLocalSidecarReady(): SidecarReady | null {
  return latestSidecarReady;
}

export async function refreshLocalSidecarReady(): Promise<SidecarReady> {
  try {
    const ready = await requestJson<SidecarReady>('/api/v1/system/ready');
    latestSidecarReady = ready;
    return ready;
  } catch (error) {
    // Never keep advertising a paid capability from a stale startup snapshot
    // when the authoritative readiness probe can no longer be refreshed.
    latestSidecarReady = null;
    throw error;
  }
}

async function refreshReadyAfterSettingsMutation(): Promise<void> {
  try {
    await refreshLocalSidecarReady();
  } catch {
    // The settings mutation already succeeded. Keep its result, clear the stale
    // capability cache above, and let the next request surface connectivity.
  }
  window.dispatchEvent(new Event(SIDECAR_SETTINGS_CHANGED_EVENT));
}

async function readError(response: Response): Promise<string> {
  try {
    const body = await response.json();
    if (typeof body?.detail === 'string') return body.detail;
    if (typeof body?.detail?.message === 'string') return body.detail.message;
    if (typeof body?.message === 'string') return body.message;
    return JSON.stringify(body);
  } catch {
    return `HTTP ${response.status}`;
  }
}

export const localSidecarApi = {
  request: (path: string, init?: RequestInit, query?: ApiQuery) => request(path, init, query),
  getJson: <T>(path: string, query?: ApiQuery, signal?: AbortSignal) =>
    requestJson<T>(path, { signal }, query),
  postJson: <T>(path: string, body?: unknown) =>
    requestJson<T>(path, {
      method: 'POST',
      body: JSON.stringify(body ?? {}),
    }),
  putJson: <T>(path: string, body?: unknown) =>
    requestJson<T>(path, {
      method: 'PUT',
      body: JSON.stringify(body ?? {}),
    }),
  deleteJson: <T>(path: string) => requestJson<T>(path, { method: 'DELETE' }),
  blob: (path: string, init?: RequestInit, query?: ApiQuery) => requestBlob(path, init, query),
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
  health: () => requestJson<{ ok: boolean; version: string }>('/health'),
  settings: () => requestJson<AppSettings>('/settings'),
  primaryLlmModel: async () => {
    const settings = await requestJson<AppSettings>('/settings');
    return settings.llm_model.trim();
  },
  updateSettings: async (
    settings: Partial<Pick<AppSettings,
      'nai_base_url' | 'llm_provider' | 'llm_base_url' | 'llm_model'
      | 'llm_backup_provider' | 'llm_backup_base_url' | 'llm_backup_model'>>,
  ) => {
    const updated = await requestJson<AppSettings>('/settings', {
      method: 'POST',
      body: JSON.stringify(settings),
    });
    await refreshReadyAfterSettingsMutation();
    return updated;
  },
  tokenStatus: () => requestJson<TokenStatus>('/auth/token/status'),
  saveToken: (token: string) =>
    requestJson<TokenStatus>('/auth/token', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),
  clearToken: () => requestJson<TokenStatus>('/auth/token', { method: 'DELETE' }),
  llmKeyStatus: () => requestJson<LlmKeyStatus>('/auth/llm-key/status'),
  saveLlmKey: async (apiKey: string, slot: 'primary' | 'backup' = 'primary') => {
    const status = await requestJson<LlmKeyStatus>('/auth/llm-key', {
      method: 'POST',
      body: JSON.stringify({ api_key: apiKey, slot }),
    });
    await refreshReadyAfterSettingsMutation();
    return status;
  },
  clearLlmKey: async (slot: 'primary' | 'backup' = 'primary') => {
    const status = await requestJson<LlmKeyStatus>(
      `/auth/llm-key?slot=${slot}`,
      { method: 'DELETE' },
    );
    await refreshReadyAfterSettingsMutation();
    return status;
  },
  generate: (request: GenerationRequest) =>
    requestJson<GenerationResult>('/generate', {
      method: 'POST',
      body: JSON.stringify(request),
    }),
  generationTasks: () => requestJson<{ items: GenerationTask[] }>('/generation/tasks'),
  cancelGenerationTask: (id: string) =>
    requestJson<{ ok: boolean; task_id: string; message?: string }>(`/generation/tasks/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
    }),
  history: (limit = 100) => requestJson<{ items: HistoryItem[] }>(`/history?limit=${limit}`),
  image: (id: string) => requestBlob(`/images/${encodeURIComponent(id)}`),
  objectUrl: (path: string) => authenticatedObjectUrl(path),
  encodeVibe: (image: string, informationExtracted = 0.5, model = 'nai-diffusion-4-5-full') =>
    requestJson<{ encoding: string }>('/vibe/encode', {
      method: 'POST',
      body: JSON.stringify({ image, information_extracted: informationExtracted, model }),
    }),
  upscale: (request: { image: string; width: number; height: number; scale: number }) =>
    requestBlob('/upscale', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    }),
  generatePrompt: (input: string, params: GenerationParams, negative = '') =>
    requestJson<{ tags: string; negative: string; params: GenerationParams }>('/agent/generate-prompt', {
      method: 'POST',
      body: JSON.stringify({ input, params, negative }),
    }),
  getAnlas: async (): Promise<AnlasInfo | null> => {
    try {
      const data = await requestJson<AnlasInfo & { configured?: boolean }>('/api/anlas');
      if (data.configured === false) return null;
      return {
        fixedTrainingStepsLeft: Number(data.fixedTrainingStepsLeft || 0),
        purchasedTrainingSteps: Number(data.purchasedTrainingSteps || 0),
        isOpus: Boolean(data.isOpus),
      };
    } catch {
      return null;
    }
  },
};

export const sidecarV1Api = {
  ready: () => refreshLocalSidecarReady(),
  createGenerationJob: (
    body: CanonicalGenerationJobCreate,
    idempotencyKey?: string,
  ) => requestJson<CanonicalGenerationJob>('/api/v1/generation/jobs', {
    method: 'POST',
    headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
    body: JSON.stringify(body),
  }),
  generationJobs: (cursor?: string, limit = 100) => {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set('cursor', cursor);
    return requestJson<CanonicalGenerationJobList>(`/api/v1/generation/jobs?${query}`);
  },
  generationJob: (id: string) =>
    requestJson<CanonicalGenerationJob>(
      `/api/v1/generation/jobs/${encodeURIComponent(id)}`,
    ),
  cancelGenerationJob: (id: string, reason?: string) =>
    requestJson<CanonicalGenerationJob>(
      `/api/v1/generation/jobs/${encodeURIComponent(id)}/cancel`,
      { method: 'POST', body: JSON.stringify({ reason: reason ?? null }) },
    ),
  openGenerationEvents: async (id: string, lastEventId?: number) => {
    return localSidecarApi.openSse(
      `/api/v1/generation/jobs/${encodeURIComponent(id)}/events`,
      {
        headers: lastEventId === undefined
          ? undefined
          : { 'Last-Event-ID': String(lastEventId) },
      },
    );
  },
  storage: () => requestJson<SidecarStorageStatus>('/api/v1/storage'),
  assets: (offset = 0, limit = 100) =>
    requestJson<SidecarAssetList>(`/api/v1/assets?offset=${offset}&limit=${limit}`),
  asset: (id: string) => requestBlob(`/api/v1/assets/${encodeURIComponent(id)}/content`),
  pruneAssets: (assetIds: readonly string[]) =>
    requestJson<SidecarStoragePrune>('/api/v1/storage/prune', {
      method: 'POST',
      body: JSON.stringify({ asset_ids: assetIds }),
    }),
  backups: () => requestJson<SidecarBackupList>('/api/v1/backups'),
  createBackup: (includeAssets = true) =>
    requestJson<SidecarBackup>('/api/v1/backups', {
      method: 'POST',
      body: JSON.stringify({ include_assets: includeAssets }),
    }),
  validateBackup: (reference: string) =>
    requestJson<SidecarV1Schemas['BackupValidationResponse']>(
      `/api/v1/backups/${encodeURIComponent(reference)}/validate`,
      { method: 'POST', body: '{}' },
    ),
  restoreBackup: (reference: string) =>
    requestJson<SidecarBackupRestore>(
      `/api/v1/backups/${encodeURIComponent(reference)}/restore`,
      { method: 'POST', body: '{}' },
    ),
};

/** @deprecated Import and use `localSidecarApi` directly. */
export const sidecarApi = localSidecarApi;

export async function generateLegacyImage(
  request: GenerationRequest,
): Promise<LegacyGenerateImageResult> {
  const submitted = await sidecarV1Api.createGenerationJob(
    {
      payload: {
        ...request,
        params: { provider: 'nai' as const, ...request.params },
      },
    },
    `desktop-${crypto.randomUUID()}`,
  );
  let job = submitted;
  while (!['succeeded', 'failed', 'cancelled', 'interrupted'].includes(job.status)) {
    await new Promise(resolve => window.setTimeout(resolve, 250));
    job = await sidecarV1Api.generationJob(job.id);
  }
  if (job.status !== 'succeeded' || !job.result) {
    throw new Error(job.error_message || `生成任务已${job.status}`);
  }
  const result = job.result as unknown as GenerationResult;
  if (!result.image_url || !result.image_id || typeof result.params !== 'object') {
    throw new Error('本地后端返回了无效的生成结果');
  }
  const imageData = await requestBlob(result.image_url);
  const seed = typeof result.params.seed === 'number' ? result.params.seed : undefined;
  return { imageData, seed, sidecarResult: result };
}
