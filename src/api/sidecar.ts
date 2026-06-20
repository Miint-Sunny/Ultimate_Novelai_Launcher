export type GenerationMode = 'natural' | 'tags';

export interface PromptState {
  input: string;
  mode: GenerationMode;
  tags?: string | null;
  negative?: string | null;
}

export interface GenerationParams {
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

export interface AnlasInfo {
  fixedTrainingStepsLeft: number;
  purchasedTrainingSteps: number;
  isOpus: boolean;
}

export interface LegacyGenerateImageResult {
  imageData: Blob;
  seed?: number;
  sidecarResult: GenerationResult;
}

const DEFAULT_SIDECAR_URL = 'http://127.0.0.1:38176';
let resolvedSidecarUrl: string | null = null;

export function getSidecarUrl(): string {
  return (
    resolvedSidecarUrl ||
    cachedSidecarUrl() ||
    import.meta.env.VITE_SIDECAR_URL ||
    DEFAULT_SIDECAR_URL
  ).replace(/\/$/, '');
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const baseUrl = await resolveSidecarUrl();
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  return response.json() as Promise<T>;
}

async function requestBlob(path: string, init?: RequestInit): Promise<Blob> {
  const baseUrl = await resolveSidecarUrl();
  const response = await fetch(`${baseUrl}${path}`, init);
  if (!response.ok) {
    throw new Error(await readError(response));
  }
  return response.blob();
}

async function resolveSidecarUrl(): Promise<string> {
  if (resolvedSidecarUrl) return resolvedSidecarUrl;

  const errors: string[] = [];
  for (const url of sidecarCandidates()) {
    try {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 600);
      const response = await fetch(`${url}/health`, { signal: controller.signal });
      window.clearTimeout(timeout);
      if (!response.ok) {
        errors.push(`${url}: HTTP ${response.status}`);
        continue;
      }
      const body = await response.json();
      if (body?.ok === true) {
        resolvedSidecarUrl = url;
        window.localStorage.setItem('ultimate_novelai_launcher_sidecar_url', url);
        return url;
      }
      errors.push(`${url}: invalid health response`);
    } catch (error) {
      errors.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`无法连接 Ultimate Novelai launcher sidecar。已尝试：${errors.join('; ')}`);
}

function sidecarCandidates(): string[] {
  const candidates = new Set<string>();
  const envUrl = import.meta.env.VITE_SIDECAR_URL;
  if (envUrl) candidates.add(envUrl.replace(/\/$/, ''));
  for (let port = 38176; port <= 38210; port += 1) {
    candidates.add(`http://127.0.0.1:${port}`);
  }
  for (let port = 8766; port <= 8795; port += 1) {
    candidates.add(`http://127.0.0.1:${port}`);
  }
  candidates.add('http://127.0.0.1:8765');
  return [...candidates];
}

function cachedSidecarUrl(): string | null {
  const cached = window.localStorage.getItem('ultimate_novelai_launcher_sidecar_url')
    || window.localStorage.getItem('nai_studio_sidecar_url');
  if (!cached) return null;
  try {
    const url = new URL(cached);
    const port = Number(url.port);
    if (url.hostname === '127.0.0.1' && port >= 38176 && port <= 38210) {
      return cached;
    }
  } catch {
    return null;
  }
  return null;
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

export function imageUrl(path: string): string {
  return `${getSidecarUrl()}${path}`;
}

export const sidecarApi = {
  url: (path: string) => `${getSidecarUrl()}${path.startsWith('/') ? path : `/${path}`}`,
  getJson: <T>(path: string) => requestJson<T>(path),
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
  health: () => requestJson<{ ok: boolean; version: string }>('/health'),
  settings: () => requestJson<AppSettings>('/settings'),
  updateSettings: (
    settings: Partial<Pick<AppSettings,
      'nai_base_url' | 'llm_provider' | 'llm_base_url' | 'llm_model'
      | 'llm_backup_provider' | 'llm_backup_base_url' | 'llm_backup_model'>>,
  ) =>
    requestJson<AppSettings>('/settings', {
      method: 'POST',
      body: JSON.stringify(settings),
    }),
  tokenStatus: () => requestJson<TokenStatus>('/auth/token/status'),
  saveToken: (token: string) =>
    requestJson<TokenStatus>('/auth/token', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),
  clearToken: () => requestJson<TokenStatus>('/auth/token', { method: 'DELETE' }),
  llmKeyStatus: () => requestJson<LlmKeyStatus>('/auth/llm-key/status'),
  saveLlmKey: (apiKey: string, slot: 'primary' | 'backup' = 'primary') =>
    requestJson<LlmKeyStatus>('/auth/llm-key', {
      method: 'POST',
      body: JSON.stringify({ api_key: apiKey, slot }),
    }),
  clearLlmKey: (slot: 'primary' | 'backup' = 'primary') =>
    requestJson<LlmKeyStatus>(`/auth/llm-key?slot=${slot}`, { method: 'DELETE' }),
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

export async function generateLegacyImage(
  request: GenerationRequest,
): Promise<LegacyGenerateImageResult> {
  const result = await sidecarApi.generate(request);
  const imageData = await requestBlob(result.image_url);
  const seed = typeof result.params.seed === 'number' ? result.params.seed : undefined;
  return { imageData, seed, sidecarResult: result };
}
