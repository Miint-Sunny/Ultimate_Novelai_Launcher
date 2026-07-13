/**
 * Bot 会话与任务服务 - 管理 Bot 授权、WebSocket 会话与生成任务轮询。
 *
 * 通过 botService.ts 门面对外暴露，导出形状保持不变。
 */

import { appBackendApi } from '../../api/appBackendApi';
import { sidecarApi } from '../../api/sidecar';

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
  private authPollToken: string | null = null;

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

  /**
   * 生成授权码
   */
  async generateAuthCode(): Promise<string | null> {
    try {
      const response = await appBackendApi.request('/api/bot/auth/generate', {
        method: 'POST',
      });

      if (response.ok) {
        const data = await response.json();
        if (typeof data.poll_token !== 'string' || data.poll_token.length < 32) {
          throw new Error('授权服务未返回安全轮询凭据');
        }
        this.authState.authCode = data.code;
        this.authState.authCodeExpires = Date.now() + data.expires_in * 1000;
        this.authPollToken = data.poll_token;
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
      if (!this.authState.authCode || !this.authPollToken) {
        this.stopAuthCheck();
        return;
      }

      // 检查是否过期
      if (this.authState.authCodeExpires && Date.now() > this.authState.authCodeExpires) {
        this.authState.authCode = null;
        this.authState.authCodeExpires = null;
        this.authPollToken = null;
        this.stopAuthCheck();
        this.emit();
        return;
      }

      try {
        const response = await appBackendApi.request('/api/bot/auth/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code: this.authState.authCode,
            poll_token: this.authPollToken,
          }),
        });

        if (response.ok) {
          const data = await response.json();
          if (data.verified && data.session_id) {
            if (this.authState.sessionId !== data.session_id) {
              appBackendApi.revokeObjectUrls();
            }
            this.authState.isAuthorized = true;
            this.authState.sessionId = data.session_id;
            this.authState.authCode = null;
            this.authState.authCodeExpires = null;
            this.authPollToken = null;
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

    const wsUrl = appBackendApi.webSocketUrl('/ws/bot');
    console.log('[BotService] 正在连接 WebSocket:', wsUrl);
    this.ws = new WebSocket(wsUrl, `bot-session.${this.authState.sessionId}`);

    this.ws.onopen = () => {
      console.log('[BotService] WebSocket 已连接');
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
      if (event.code === 4401) {
        this.logout();
        return;
      }
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
      const response = await appBackendApi.request('/api/bot/generate', {
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
            const sessionId = this.authState.sessionId;
            if (!sessionId) {
              throw new Error('Bot 会话已失效');
            }
            const response = await appBackendApi.request(
              `/api/task/${encodeURIComponent(taskId)}`,
              undefined,
              { session_id: sessionId },
            );
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
      const sessionId = this.authState.sessionId;
      if (!sessionId) {
        return false;
      }
      const response = await appBackendApi.request(
        `/api/task/${encodeURIComponent(taskId)}`,
        {
          method: 'DELETE',
        },
        { session_id: sessionId },
      );

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
    localStorage.removeItem('bot_session');
    appBackendApi.revokeObjectUrls();
    this.ws?.close();
    this.ws = null;
    this.stopAuthCheck();
    this.authPollToken = null;

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
    if (this.authState.sessionId !== data.sessionId) {
      appBackendApi.revokeObjectUrls();
    }
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
      const response = await appBackendApi.request('/api/bot/auth/validate', {
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
