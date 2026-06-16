/**
 * Bot服务 - 管理Bot授权和生成
 */

import { getBackendUrl, getQueueServerUrl } from '../utils/apiConfig';
import { sidecarApi } from '../api/sidecar';

export interface BotAuthState {
  isAuthorized: boolean;
  sessionId: string | null;
  botUserId: string | null;
  authCode: string | null;
  authCodeExpires: number | null;
}

export interface BotTaskState {
  taskId: string | null;
  status: 'idle' | 'pending' | 'queued' | 'generating' | 'completed' | 'failed';
  queuePosition: number;
  result: BotTaskResult | null;
  error: string | null;
  // 流式进度
  step: number;
  totalSteps: number;
  previewImage: string | null;  // base64预览图
}

export interface BotTaskResult {
  type: 'file' | 'data' | 'base64';
  path?: string;
  data?: string;
  imageBase64?: string;
}

type BotEventListener = (authState: BotAuthState, taskState: BotTaskState) => void;

class BotService {
  private ws: WebSocket | null = null;
  private listeners: Set<BotEventListener> = new Set();
  private authCheckInterval: number | null = null;

  private authState: BotAuthState = {
    isAuthorized: false,
    sessionId: null,
    botUserId: null,
    authCode: null,
    authCodeExpires: null,
  };

  private taskState: BotTaskState = {
    taskId: null,
    status: 'idle',
    queuePosition: 0,
    result: null,
    error: null,
    step: 0,
    totalSteps: 0,
    previewImage: null,
  };

  getAuthState(): BotAuthState {
    return { ...this.authState };
  }

  getTaskState(): BotTaskState {
    return { ...this.taskState };
  }

  addEventListener(listener: BotEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    this.listeners.forEach((listener) => {
      try {
        listener(this.getAuthState(), this.getTaskState());
      } catch (e) {
        console.error('Bot event listener error:', e);
      }
    });
  }

  private getServerUrl(): string {
    return getQueueServerUrl();
  }

  /**
   * 生成授权码
   */
  async generateAuthCode(): Promise<string | null> {
    try {
      const response = await fetch(`${this.getServerUrl()}/api/bot/auth/generate`, {
        method: 'POST',
      });

      if (response.ok) {
        const data = await response.json();
        this.authState.authCode = data.code;
        this.authState.authCodeExpires = Date.now() + data.expires_in * 1000;
        this.emit();

        // 开始轮询检查授权状态
        this.startAuthCheck();

        return data.code;
      }
    } catch (e) {
      console.error('Failed to generate auth code:', e);
    }
    return null;
  }

  /**
   * 开始检查授权码状态
   */
  private startAuthCheck() {
    this.stopAuthCheck();

    this.authCheckInterval = window.setInterval(async () => {
      if (!this.authState.authCode) {
        this.stopAuthCheck();
        return;
      }

      // 检查是否过期
      if (this.authState.authCodeExpires && Date.now() > this.authState.authCodeExpires) {
        this.authState.authCode = null;
        this.authState.authCodeExpires = null;
        this.stopAuthCheck();
        this.emit();
        return;
      }

      try {
        const response = await fetch(`${this.getServerUrl()}/api/bot/auth/check`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: this.authState.authCode }),
        });

        if (response.ok) {
          const data = await response.json();
          if (data.verified && data.session_id) {
            this.authState.isAuthorized = true;
            this.authState.sessionId = data.session_id;
            this.stopAuthCheck();

            // 连接WebSocket
            this.connectWebSocket();

            this.emit();
          }
        }
      } catch (e) {
        console.error('Auth check failed:', e);
      }
    }, 2000);
  }

  private stopAuthCheck() {
    if (this.authCheckInterval) {
      clearInterval(this.authCheckInterval);
      this.authCheckInterval = null;
    }
  }

  /**
   * 连接Bot WebSocket
   */
  private connectWebSocket() {
    if (!this.authState.sessionId) return;

    // 如果已有连接且状态正常，不重复连接
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const wsUrl = this.getServerUrl().replace(/^http/, 'ws') + '/ws/bot';
    console.log('[BotService] 正在连接 WebSocket:', wsUrl);
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log('[BotService] WebSocket 已连接');
      // 绑定会话
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({
            action: 'bind_session',
            session_id: this.authState.sessionId,
          })
        );
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.action === 'session_bound') {
          if (data.success) {
            this.authState.botUserId = data.bot_user_id;
            this.emit();
          }
        } else if (data.action === 'task_update') {
          this.taskState.taskId = data.task_id;
          this.taskState.status = data.status;
          this.taskState.queuePosition = data.queue_position || 0;
          if (data.result) {
            this.taskState.result = data.result;
          }
          if (data.error) {
            this.taskState.error = data.error;
          }
          this.emit();
        } else if (data.action === 'task_progress') {
          // 流式进度更新（单调递增检查，防止进度回退）
          if (data.step >= this.taskState.step) {
            this.taskState.taskId = data.task_id;
            this.taskState.step = data.step;
            this.taskState.totalSteps = data.total_steps;
            if (data.preview) {
              this.taskState.previewImage = data.preview;
            }
            // 收到进度更新说明已经在生成中，确保状态正确
            if (this.taskState.status !== 'generating' && this.taskState.status !== 'completed' && this.taskState.status !== 'failed') {
              this.taskState.status = 'generating';
            }
            this.emit();
          }
        }
      } catch (e) {
        console.error('WebSocket message parse error:', e);
      }
    };

    this.ws.onerror = (error) => {
      console.error('[BotService] WebSocket 错误:', error);
    };

    this.ws.onclose = (event) => {
      console.log('[BotService] WebSocket 已断开, code:', event.code, 'reason:', event.reason);
      this.ws = null;
      // 尝试重连（仅在仍然授权状态下）
      if (this.authState.isAuthorized) {
        console.log('[BotService] 3秒后尝试重连...');
        setTimeout(() => {
          if (this.authState.isAuthorized) {
            this.connectWebSocket();
          }
        }, 3000);
      }
    };
  }

  /**
   * 提交生成任务
   */
  async submitTask(params: Record<string, unknown>): Promise<boolean> {
    if (!this.authState.isAuthorized || !this.authState.sessionId) {
      this.taskState.error = '未授权';
      this.emit();
      return false;
    }

    // 重置所有任务状态
    this.taskState = {
      taskId: null,
      status: 'pending',
      queuePosition: 0,
      result: null,
      error: null,
      step: 0,
      totalSteps: 0,
      previewImage: null,
    };
    this.emit();

    try {
      const response = await fetch(`${this.getServerUrl()}/api/bot/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: this.authState.sessionId,
          params,
        }),
      });

      let data: any = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }

      if (response.ok && data) {
        if (data.success) {
          this.taskState.taskId = data.task_id;
          this.emit();

          // 订阅任务进度（新增：通过 WebSocket 订阅）
          if (this.ws?.readyState === WebSocket.OPEN && data.task_id) {
            this.ws.send(
              JSON.stringify({
                action: 'subscribe_task',
                task_id: data.task_id,
              })
            );
          }

          return true;
        }
      }

      this.taskState.status = 'failed';
      this.taskState.error = data?.message || data?.detail || '提交任务失败';
      this.emit();
      return false;
    } catch (e) {
      this.taskState.status = 'failed';
      this.taskState.error = String(e);
      this.emit();
      return false;
    }
  }

  /**
   * 等待任务完成（WebSocket + HTTP 轮询双保险）
   */
  async waitForTask(timeoutMs: number = 5 * 60 * 1000): Promise<BotTaskResult | null> {
    const taskId = this.taskState.taskId;
    if (!taskId) {
      return null;
    }

    const startTime = Date.now();
    const pollInterval = 2000; // HTTP 轮询间隔 2 秒
    let lastPollTime = 0;

    return new Promise((resolve) => {
      const checkStatus = async () => {
        // 检查 WebSocket 更新的状态
        if (this.taskState.status === 'completed') {
          resolve(this.taskState.result);
          return;
        }
        if (this.taskState.status === 'failed') {
          resolve(null);
          return;
        }
        if (Date.now() - startTime > timeoutMs) {
          this.taskState.status = 'failed';
          this.taskState.error = '生成超时，请重试';
          this.emit();
          resolve(null);
          return;
        }

        // HTTP 轮询作为备用（每 pollInterval 毫秒轮询一次）
        const now = Date.now();
        if (now - lastPollTime >= pollInterval) {
          lastPollTime = now;
          try {
            const response = await fetch(`${this.getServerUrl()}/api/task/${taskId}`);
            if (response.status === 404) {
              // 任务不存在（服务重启或任务过期），停止轮询
              this.taskState.status = 'failed';
              this.taskState.error = '任务不存在，可能服务已重启，请重新生成';
              this.emit();
              resolve(null);
              return;
            }
            if (response.ok) {
              const data = await response.json();
              // 更新本地状态
              if (data.status === 'completed' || data.status === 'failed') {
                this.taskState.status = data.status;
                this.taskState.step = data.step || 0;
                this.taskState.totalSteps = data.total_steps || 0;
                if (data.result) {
                  this.taskState.result = data.result;
                }
                if (data.error) {
                  this.taskState.error = data.error;
                }
                this.emit();

                if (data.status === 'completed') {
                  resolve(this.taskState.result);
                  return;
                } else {
                  resolve(null);
                  return;
                }
              } else {
                // 更新进度信息（防止过期轮询覆盖 WebSocket 的更新数据）
                // 只在轮询结果的 step 更大时初才更新，避免进度回退
                const pollStep = data.step || 0;
                if (data.status === 'queued' && this.taskState.status === 'generating') {
                  // WebSocket 已经通知 generating，不要被过期的 queued 轮询回退
                } else if (data.status === 'generating' && pollStep < this.taskState.step) {
                  // 轮询返回的进度比当前小，忽略
                } else {
                  this.taskState.status = data.status;
                  this.taskState.step = pollStep;
                  this.taskState.totalSteps = data.total_steps || 0;
                  this.taskState.queuePosition = data.queue_position || 0;
                  this.emit();
                }
              }
            }
          } catch (e) {
            console.warn('HTTP 轮询任务状态失败:', e);
          }
        }

        // 继续检查
        setTimeout(checkStatus, 500);
      };
      checkStatus();
    });
  }

  abortTask(reason: string) {
    if (this.taskState.status !== 'completed' && this.taskState.status !== 'failed') {
      this.taskState.status = 'failed';
      this.taskState.error = reason;
      this.emit();
    }
  }

  /**
   * 取消排队中的任务
   */
  async cancelTask(): Promise<boolean> {
    const taskId = this.taskState.taskId;
    if (!taskId || this.taskState.status !== 'queued') {
      return false;
    }

    try {
      const response = await fetch(`${this.getServerUrl()}/api/task/${taskId}`, {
        method: 'DELETE',
      });

      if (response.ok) {
        this.taskState.status = 'failed';
        this.taskState.error = '已取消';
        this.emit();
        return true;
      }
      return false;
    } catch (e) {
      console.error('取消任务失败:', e);
      return false;
    }
  }

  /**
   * 登出
   */
  logout() {
    this.ws?.close();
    this.ws = null;
    this.stopAuthCheck();

    this.authState = {
      isAuthorized: false,
      sessionId: null,
      botUserId: null,
      authCode: null,
      authCodeExpires: null,
    };

    this.taskState = {
      taskId: null,
      status: 'idle',
      queuePosition: 0,
      result: null,
      error: null,
      step: 0,
      totalSteps: 0,
      previewImage: null,
    };

    this.emit();
  }

  /**
   * 从localStorage恢复会话
   */
  async restoreSession(): Promise<boolean> {
    const saved = localStorage.getItem('bot_session');
    if (!saved) return false;

    let data: { sessionId?: string; botUserId?: string; expiresAt?: number };
    try {
      data = JSON.parse(saved);
    } catch {
      localStorage.removeItem('bot_session');
      return false;
    }
    if (!data.sessionId) {
      localStorage.removeItem('bot_session');
      return false;
    }

    // 后端是基于 last_active 的滑动窗口，本地 expiresAt 只是上次同步的快照。
    // 不能用本地 expiresAt 作闸门 —— 否则 SPA 长期不刷新时，本地缓存先到期，
    // 即使后端 session 仍然活着也会被误判登出。统一交给后端 validate 裁决。
    this.authState.isAuthorized = true;
    this.authState.sessionId = data.sessionId;
    this.authState.botUserId = data.botUserId ?? null;

    const result = await this.validateSession(data.sessionId);
    if (!result.valid) {
      console.warn('Bot session已在服务端过期，需要重新登录');
      this.logout();
      localStorage.removeItem('bot_session');
      return false;
    }

    if (result.expiresAtMs) {
      localStorage.setItem(
        'bot_session',
        JSON.stringify({
          sessionId: data.sessionId,
          botUserId: data.botUserId,
          expiresAt: result.expiresAtMs,
        })
      );
    }

    this.emit();
    try {
      this.connectWebSocket();
    } catch (e) {
      console.warn('Bot WebSocket 连接失败，但会话已恢复:', e);
    }
    return true;
  }

  /**
   * 验证session是否在服务端有效
   * 返回 valid 与后端滑动窗口最新过期时间（毫秒）
   */
  private async validateSession(
    sessionId: string
  ): Promise<{ valid: boolean; expiresAtMs?: number }> {
    try {
      const response = await fetch(`${this.getServerUrl()}/api/bot/auth/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId }),
      });
      if (response.ok) {
        const data = await response.json();
        return {
          valid: data.valid === true,
          expiresAtMs: typeof data.expires_at_ms === 'number' ? data.expires_at_ms : undefined,
        };
      }
      return { valid: false };
    } catch {
      // 网络错误时假设有效，让后续请求处理
      return { valid: true };
    }
  }

  /**
   * 保存会话到localStorage
   */
  saveSession() {
    if (this.authState.isAuthorized && this.authState.sessionId) {
      localStorage.setItem(
        'bot_session',
        JSON.stringify({
          sessionId: this.authState.sessionId,
          botUserId: this.authState.botUserId,
          expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7天，与后端SESSION_EXPIRE保持一致
        })
      );
    }
  }

  /**
   * 获取Bot点数（anlas）
   */
  async getAnlas(): Promise<{ anlas: number; fresh: boolean } | null> {
    try {
      const info = await sidecarApi.getAnlas();
      if (!info) return null;
      return {
        anlas: info.fixedTrainingStepsLeft + info.purchasedTrainingSteps,
        fresh: true,
      };
    } catch (error) {
      console.error('获取点数失败:', error);
    }
    return null;
  }
}

export const botService = new BotService();

export * from './publicLibrary';

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


// ==================== 在线人数服务（心跳统计） ====================

type OnlineCountListener = (count: number) => void;

class OnlineService {
  private listeners: Set<OnlineCountListener> = new Set();
  private count: number = 0;
  private heartbeatTimer: number | null = null;
  private userId: string;

  constructor() {
    // 生成或获取用户ID
    let userId = localStorage.getItem('online_user_id');
    if (!userId) {
      userId = `user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      localStorage.setItem('online_user_id', userId);
    }
    this.userId = userId;
  }

  getCount(): number {
    return this.count;
  }

  addEventListener(listener: OnlineCountListener): () => void {
    this.listeners.add(listener);
    listener(this.count);
    return () => this.listeners.delete(listener);
  }

  private emit(count: number) {
    this.count = count;
    this.listeners.forEach((listener) => {
      try {
        listener(count);
      } catch (e) {
        console.error('Online count listener error:', e);
      }
    });
  }

  /**
   * 启动心跳（每60秒发送一次）
   */
  start() {
    // 立即发送一次心跳
    this.sendHeartbeat();

    // 定时发送心跳
    this.heartbeatTimer = window.setInterval(() => {
      this.sendHeartbeat();
    }, 60000); // 60秒一次
  }

  private async sendHeartbeat() {
    try {
      const data = await sidecarApi.postJson<{ count: number }>('/api/online/heartbeat', { user_id: this.userId });
      this.emit(data.count);
    } catch (e) {
      // 静默失败，不影响用户体验
    }
  }

  /**
   * 仅获取在线人数（不发送心跳）
   */
  async fetchCount() {
    try {
      const data = await sidecarApi.getJson<{ count: number }>('/api/online/count');
      this.emit(data.count);
    } catch (e) {
      // 静默失败
    }
  }

  stop() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}

export const onlineService = new OnlineService();
