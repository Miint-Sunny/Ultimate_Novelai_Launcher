/**
 * Bot 会话与任务服务 - 管理 Bot 授权、WebSocket 会话与生成任务轮询。
 *
 * 通过 botService.ts 门面对外暴露，导出形状保持不变。
 */

import { appBackendApi } from '../../api/appBackendApi';
import { sidecarApi } from '../../api/sidecar';
import { getAppSettings } from '../localLibrary/appSettings';

export interface BotAuthState {
  isAuthorized: boolean;
  sessionId: string | null;
  botUserId: string | null;
  authCode: string | null;
  authCodeExpires: number | null;
}

export interface BotTaskState {
  taskId: string | null;
  status: 'idle' | 'pending' | 'queued' | 'starting' | 'generating' | 'completed' | 'failed' | 'cancelled';
  queuePosition: number;
  result: BotTaskResult | null;
  error: string | null;
  // 流式进度
  step: number;
  totalSteps: number;
  previewImage: string | null;  // base64预览图
}

export interface BotTaskResult {
  // Plana 方言的 result 只有 imageBase64，没有 type；调用方按字段推断类型。
  type?: 'file' | 'data' | 'base64';
  path?: string;
  data?: string;
  imageBase64?: string;
}

type BotEventListener = (authState: BotAuthState, taskState: BotTaskState) => void;

/** 终态失败集合：cancelled 与 failed 同为终态，收到即停止等待（否则会空转到超时）。 */
const TERMINAL_FAILURE_STATUSES: ReadonlySet<BotTaskState['status']> = new Set([
  'failed',
  'cancelled',
]);

const isTerminalFailure = (status: BotTaskState['status']): boolean =>
  TERMINAL_FAILURE_STATUSES.has(status);

/**
 * 状态词表归一化。Plana：queued/starting/generating/completed/failed/cancelled；
 * 我们后端另有 cancelling/interrupted，映射与 plana_adapter 的 _STATUS_TO_PLANA 保持一致。
 * 无法识别的词返回 null，表示“保持当前状态”——不要把未知词写进 UI 依赖的状态机。
 */
const normalizeTaskStatus = (raw: unknown): BotTaskState['status'] | null => {
  if (typeof raw !== 'string') return null;
  switch (raw) {
    case 'pending':
    case 'queued':
    case 'starting':
    case 'generating':
    case 'completed':
    case 'failed':
    case 'cancelled':
      return raw;
    case 'canceled':
      return 'cancelled';
    case 'interrupted':
      return 'failed';
    case 'cancelling':
      return 'generating';
    default:
      return null;
  }
};

/** HTTP 轮询连续 404 达到该次数才判任务不存在（单次 404 可能只是路径方言探测失败）。 */
const TASK_NOT_FOUND_LIMIT = 3;

/** 授权码轮询连续失败到该次数时把后端 detail 冒泡到控制台一次（避免每 2 秒刷屏）。 */
const AUTH_CHECK_WARN_STREAK = 3;

/**
 * 连续多少轮“两种 WS 方言都握手失败”后退化为纯轮询模式。
 * 一轮 = 子协议绑定 + bind_session 绑定各试一次。
 */
const WS_MAX_DIALECT_ROUNDS = 3;

/** 纯轮询模式下 WS 的低频重试间隔：只为自愈，不再抢连接。 */
const WS_POLLING_ONLY_RETRY_MS = 30000;

class BotService {
  private ws: WebSocket | null = null;
  private listeners: Set<BotEventListener> = new Set();
  private authCheckInterval: number | null = null;
  private authPollToken: string | null = null;
  private wsHeartbeatTimer: number | null = null;
  // 心跳归属的那条连接：旧 socket 的 onclose 不能清掉新连接刚启动的心跳。
  private wsHeartbeatOwner: WebSocket | null = null;
  // WS 绑定方言：true=子协议 bot-session.<sid>（我们后端），false=连上后发 bind_session（Plana）。
  private wsUseSubprotocol = true;
  private wsDialectConfirmed = false;
  private wsFallbackTried = false;
  // 连续“两种方言都握手失败”的轮数，以及由它触发的纯轮询降级开关。
  private wsFailedRounds = 0;
  private wsPollingOnly = false;
  // 任务查询路径方言，探测一次后按会话缓存。
  private taskPathDialect: 'plana' | 'legacy' | null = null;

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
        headers: { 'Content-Type': 'application/json' },
        // Plana 后端期望 source 字段；我们后端该端点不声明请求体，多余字段会被忽略。
        body: JSON.stringify({ source: 'app' }),
      });

      if (response.ok) {
        const data = await response.json();
        this.authState.authCode = data.code;
        const expiresInSec = typeof data.expires_in === 'number' && data.expires_in > 0
          ? data.expires_in
          : 300;  // 缺省有效期兜底，避免 NaN 让过期闸门永远不生效
        this.authState.authCodeExpires = Date.now() + expiresInSec * 1000;
        // poll_token 是我们后端的防抢码凭据（check 时必填）；Plana 只返 {code, expires_in}，
        // 缺失时退化为纯 code 轮询，不能再当成硬错误。
        this.authPollToken = typeof data.poll_token === 'string' && data.poll_token.length >= 32
          ? data.poll_token
          : null;
        if (!this.authPollToken) {
          // 连 Plana 时这是正常的；但连我们自己的后端时说明凭据没下发，
          // 接下来的 check 会每 2 秒吃一个 422 —— 不出声会变成“配对码一直转圈”的哑故障。
          console.warn(
            '[BotService] 授权码响应未携带 poll_token，退化为纯 code 轮询；'
            + '若对端要求 poll_token，/api/bot/auth/check 将持续返回 422。',
          );
        }
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

    // 连续非 2xx 计数：达到阈值时把后端 detail 冒泡一次，避免“静默不授权”。
    let checkFailStreak = 0;

    this.authCheckInterval = window.setInterval(async () => {
      if (!this.authState.authCode) {
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
        // 我们后端的 check 模型是 extra=forbid 且 poll_token 必填，Plana 只收 {code}：
        // 有凭据就带上，没有就纯 code 轮询，两边都不会被请求体校验挡下。
        const checkBody: Record<string, unknown> = { code: this.authState.authCode };
        if (this.authPollToken) {
          checkBody.poll_token = this.authPollToken;
        }
        const response = await appBackendApi.request('/api/bot/auth/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(checkBody),
        });

        if (response.ok) {
          checkFailStreak = 0;
          const data = await response.json();
          // 拿到 session_id 即视为授权通过：我们后端同时给 verified=true，
          // 而 Plana 只保证返回会话本身，不要求它一定带 verified 标志。
          if (data.session_id && data.verified !== false) {
            const sessionId: string = data.session_id;
            // 先停轮询、清授权码：下面有 await，必须防止下一个 tick 重复进入本分支。
            this.authState.authCode = null;
            this.authState.authCodeExpires = null;
            this.authPollToken = null;
            this.stopAuthCheck();

            if (this.authState.sessionId !== sessionId) {
              appBackendApi.revokeObjectUrls();
            }

            // 首次配对必须自己把 bot_user_id 取回来：我们后端靠 WS 的 session_bound 补，
            // 而 Plana 没有这条消息 —— 不补的话个人云库 owner 会被写成 'local'。
            // 优先用 check 响应里可能带的字段，缺失才补一次 validate；失败不阻断授权（降级为 null）。
            let botUserId = typeof data.bot_user_id === 'string' && data.bot_user_id
              ? data.bot_user_id
              : null;
            if (!botUserId) {
              const validated = await this.validateSession(sessionId);
              botUserId = validated.botUserId ?? null;
              if (!botUserId) {
                console.warn('[BotService] 配对成功但未取到 bot_user_id，个人云库相关功能本次会话不可用');
              }
            }

            // 状态一次性写齐后再 emit：UI 的监听器会在 isAuthorized 时立刻调 saveSession()，
            // 提前 emit 会把 botUserId=null 落进 localStorage 的 bot_session。
            this.authState.isAuthorized = true;
            this.authState.sessionId = sessionId;
            this.authState.botUserId = botUserId;

            // 连接WebSocket
            this.connectWebSocket();

            this.emit();
          }
        } else {
          checkFailStreak += 1;
          if (checkFailStreak === AUTH_CHECK_WARN_STREAK) {
            let detail = '(无法解析响应体)';
            try {
              const errBody = await response.json();
              const raw = errBody?.detail ?? errBody?.message ?? errBody;
              detail = typeof raw === 'string' ? raw : JSON.stringify(raw);
            } catch {
              // 响应体不是 JSON 时保持占位文案
            }
            console.warn(
              `[BotService] 授权码轮询连续 ${checkFailStreak} 次失败 (HTTP ${response.status}): ${detail}`,
            );
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
   *
   * 双方言绑定：我们后端在握手阶段用子协议 `bot-session.<sid>` 认证，且收到 bind_session
   * 消息会以 4403 关闭连接（身份在连接期内不可重绑）；Plana 后端不回显该子协议，浏览器会
   * 直接握手失败、无法在同一条连接上降级。所以只能“带子协议连一次，握手失败再不带子协议
   * 重连并发 bind_session”，并记住成功的那一种，避免每次重连重复探测。
   */
  private connectWebSocket() {
    if (!this.authState.sessionId) return;

    // 如果已有连接且状态正常，不重复连接
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const sessionId = this.authState.sessionId;
    const wsUrl = appBackendApi.webSocketUrl('/ws/bot');
    const useSubprotocol = this.wsUseSubprotocol;
    console.log(
      '[BotService] 正在连接 WebSocket:',
      wsUrl,
      useSubprotocol ? '(子协议绑定)' : '(bind_session 绑定)',
    );
    const socket = useSubprotocol
      ? new WebSocket(wsUrl, `bot-session.${sessionId}`)
      : new WebSocket(wsUrl);
    this.ws = socket;
    let opened = false;

    socket.onopen = () => {
      opened = true;
      this.wsDialectConfirmed = true;
      this.wsFallbackTried = false;
      // 连上即认为链路健康：清掉降级计数，纯轮询模式也随之解除。
      this.wsFailedRounds = 0;
      this.wsPollingOnly = false;
      console.log('[BotService] WebSocket 已连接');
      if (!useSubprotocol) {
        // 只有降级连接才发 bind_session：我们后端把这条消息当成重绑定并立即 4403 断开。
        socket.send(JSON.stringify({ action: 'bind_session', session_id: sessionId }));
      }
      this.startWsHeartbeat(socket);
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.action === 'session_bound') {
          if (data.success) {
            this.authState.botUserId = data.bot_user_id;
            this.emit();
          }
        } else if (data.action === 'task_update') {
          this.taskState.taskId = data.task_id;
          const status = normalizeTaskStatus(data.status);
          if (status) {
            this.taskState.status = status;
          }
          this.taskState.queuePosition = data.queue_position || 0;
          if (data.result) {
            this.taskState.result = data.result;
          }
          if (data.error) {
            this.taskState.error = data.error;
          } else if (status === 'cancelled' && !this.taskState.error) {
            this.taskState.error = '任务已取消';
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
            if (
              this.taskState.status !== 'generating'
              && this.taskState.status !== 'completed'
              && !isTerminalFailure(this.taskState.status)
            ) {
              this.taskState.status = 'generating';
            }
            this.emit();
          }
        }
      } catch (e) {
        console.error('WebSocket message parse error:', e);
      }
    };

    socket.onerror = (error) => {
      console.error('[BotService] WebSocket 错误:', error);
    };

    socket.onclose = (event) => {
      console.log('[BotService] WebSocket 已断开, code:', event.code, 'reason:', event.reason);
      // 只停自己启动的那个心跳，避免旧 socket 的 onclose 清掉新连接的心跳
      this.stopWsHeartbeat(socket);
      // 只清理自己这条连接，避免旧 socket 的 onclose 把新连接置空
      if (this.ws === socket) {
        this.ws = null;
      }

      // 只有“确实 open 过”的连接上收到 4401 才代表会话失效。握手阶段被拒时浏览器一律
      // 报 1006，拿不到 4401；但换个部署（hypercorn / 认证挪到 accept 之后）回退连接
      // 可能带着 4401 关闭，此时若照样 logout 就会把用户静默踢出、逼他重输配对码。
      if (opened && event.code === 4401) {
        this.logout();
        return;
      }

      // 从未 open 过 = 握手阶段就失败：还没确认过方言时换另一种绑定方式立刻重试一次。
      // 两种都失败说明是会话/后端本身的问题，回到默认方言按 3 秒退避，避免高频空转。
      const handshakeFailed = !opened && !this.wsDialectConfirmed;
      let fastRetry = false;
      if (this.wsPollingOnly) {
        // 已降级：不再 500ms↔3000ms 高频翻转，只保留低频重试；
        // 但每次重试仍换一种绑定方式，后端恢复或换部署时还能自愈。
        if (handshakeFailed) {
          this.wsUseSubprotocol = !this.wsUseSubprotocol;
        }
      } else if (handshakeFailed && !this.wsFallbackTried) {
        this.wsFallbackTried = true;
        this.wsUseSubprotocol = !this.wsUseSubprotocol;
        fastRetry = true;
      } else if (handshakeFailed) {
        // 一整轮（两种方言各一次）都失败
        this.wsFallbackTried = false;
        this.wsUseSubprotocol = true;
        this.wsFailedRounds += 1;
        if (this.wsFailedRounds >= WS_MAX_DIALECT_ROUNDS) {
          // Plana 协议里 WS 只是可选的推送通道，HTTP 轮询（waitForTask）本就能独立完成出图，
          // 所以连不上时正确的做法是安静降级，而不是永远翻转方言重连。
          this.wsPollingOnly = true;
          console.warn(
            `[BotService] WebSocket 两种绑定方言连续 ${this.wsFailedRounds} 轮握手失败，`
            + `已降级为纯 HTTP 轮询模式（不影响出图），此后每 ${WS_POLLING_ONLY_RETRY_MS / 1000} 秒低频重试一次。`,
          );
        }
      }

      // 尝试重连（仅在仍然授权状态下）
      if (this.authState.isAuthorized) {
        const delay = this.wsPollingOnly
          ? WS_POLLING_ONLY_RETRY_MS
          : (fastRetry ? 500 : 3000);
        console.log(`[BotService] ${delay}ms 后尝试重连...`);
        setTimeout(() => {
          if (this.authState.isAuthorized) {
            this.connectWebSocket();
          }
        }, delay);
      }
    };
  }

  /**
   * WS 心跳：Plana 要求每 25 秒一条 {action:"heartbeat"} 才不会被判定掉线；
   * 我们后端对同名消息回 heartbeat_ack，两种方言都安全。
   */
  private startWsHeartbeat(socket: WebSocket) {
    // 无参调用 = 强制接管：先清掉上一条连接遗留的心跳，再登记新的归属。
    this.stopWsHeartbeat();
    this.wsHeartbeatOwner = socket;
    this.wsHeartbeatTimer = window.setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) {
        this.stopWsHeartbeat(socket);
        return;
      }
      try {
        socket.send(JSON.stringify({ action: 'heartbeat' }));
      } catch (e) {
        console.warn('[BotService] WebSocket 心跳发送失败:', e);
        this.stopWsHeartbeat(socket);
      }
    }, 25000);
  }

  /**
   * 停止心跳。传入 socket 时只在它就是心跳归属者时才停 —— 否则旧连接的 onclose
   * 会把新连接刚启动的心跳一起清掉，导致新连接 25 秒后被对端判为掉线。
   */
  private stopWsHeartbeat(socket?: WebSocket) {
    if (socket && this.wsHeartbeatOwner !== socket) {
      return;
    }
    if (this.wsHeartbeatTimer) {
      clearInterval(this.wsHeartbeatTimer);
      this.wsHeartbeatTimer = null;
    }
    this.wsHeartbeatOwner = null;
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
      // image_backend 两处都发：Plana 从顶层读，我们后端只从 params 里读（BotGenerateRequest
      // 不是 extra=forbid，顶层多出的字段会被忽略）。params 内原有写法保持不动。
      const topLevelBackend = typeof params.image_backend === 'string' && params.image_backend
        ? params.image_backend
        : 'novelai';
      const response = await appBackendApi.request('/api/bot/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: this.authState.sessionId,
          params,
          image_backend: topLevelBackend,
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
   * 查询任务状态（双方言）
   *
   * Plana 只有 `GET /api/bot/task/{id}`（Bearer 认证），我们后端只有
   * `GET /api/task/{id}?session_id=`。先试 Plana 方言，404 才回退到我们的路径；
   * 探测结果按会话缓存，避免每次轮询都打两条路径。
   */
  private async requestTaskStatus(taskId: string, sessionId: string): Promise<Response> {
    const encodedId = encodeURIComponent(taskId);
    const requestPlana = () => appBackendApi.request(`/api/bot/task/${encodedId}`);
    const requestLegacy = () => appBackendApi.request(
      `/api/task/${encodedId}`,
      undefined,
      { session_id: sessionId },
    );

    if (this.taskPathDialect === 'plana') return requestPlana();
    if (this.taskPathDialect === 'legacy') return requestLegacy();

    const probe = await requestPlana();
    if (probe.ok) {
      this.taskPathDialect = 'plana';
      return probe;
    }
    if (probe.status !== 404) {
      // 只有 2xx 才能证明方言。反代 403、限流 429、网关 502 这类中间层响应既不能作为
      // 锁定依据（会把方言永久错缓存），也不代表“路径不存在”——不要拿它去打另一条路径，
      // 否则对端的 404 会被 waitForTask 计进 notFoundStreak，误判成任务消失。
      // 直接把这次响应交给调用方按普通错误处理，下一轮轮询再探。
      return probe;
    }
    const fallback = await requestLegacy();
    if (fallback.ok) {
      this.taskPathDialect = 'legacy';
    }
    return fallback;
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
    let notFoundStreak = 0;

    return new Promise((resolve) => {
      const checkStatus = async () => {
        // 检查 WebSocket 更新的状态
        if (this.taskState.status === 'completed') {
          resolve(this.taskState.result);
          return;
        }
        if (isTerminalFailure(this.taskState.status)) {
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
            const response = await this.requestTaskStatus(taskId, sessionId);
            if (response.status === 404) {
              // 路径方言探测失败也会得到 404，首个 404 不能直接判任务不存在；
              // 连续多次才认定任务真的没了（服务重启或任务过期），停止轮询。
              notFoundStreak += 1;
              if (notFoundStreak >= TASK_NOT_FOUND_LIMIT) {
                this.taskState.status = 'failed';
                this.taskState.error = '任务不存在，可能服务已重启，请重新生成';
                this.emit();
                resolve(null);
                return;
              }
            } else if (response.ok) {
              notFoundStreak = 0;
              const data = await response.json();
              const status = normalizeTaskStatus(data.status);
              // 更新本地状态
              if (status === 'completed' || (status && isTerminalFailure(status))) {
                this.taskState.status = status;
                this.taskState.step = data.step || 0;
                this.taskState.totalSteps = data.total_steps || 0;
                if (data.result) {
                  this.taskState.result = data.result;
                }
                if (data.error) {
                  this.taskState.error = data.error;
                } else if (status === 'cancelled' && !this.taskState.error) {
                  this.taskState.error = '任务已取消';
                }
                this.emit();

                if (status === 'completed') {
                  resolve(this.taskState.result);
                  return;
                } else {
                  resolve(null);
                  return;
                }
              } else if (status) {
                // 更新进度信息（防止过期轮询覆盖 WebSocket 的更新数据）
                // 只在轮询结果的 step 更大时初才更新，避免进度回退
                const pollStep = data.step || 0;
                if ((status === 'queued' || status === 'starting') && this.taskState.status === 'generating') {
                  // WebSocket 已经通知 generating，不要被过期的排队/启动中轮询回退
                } else if (status === 'generating' && pollStep < this.taskState.step) {
                  // 轮询返回的进度比当前小，忽略
                } else {
                  this.taskState.status = status;
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
    if (this.taskState.status !== 'completed' && !isTerminalFailure(this.taskState.status)) {
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
    this.stopWsHeartbeat();
    this.authPollToken = null;
    // 后端可能在下次登录时换成另一种方言（本地 / 私有后端），方言探测结果不跨会话保留。
    this.wsUseSubprotocol = true;
    this.wsDialectConfirmed = false;
    this.wsFallbackTried = false;
    this.wsFailedRounds = 0;
    this.wsPollingOnly = false;
    this.taskPathDialect = null;

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

    // botUserId 的另一个来源是 WS 的 session_bound 消息，而 Plana 后端没有这条消息；
    // 不收下 validate 返回的 bot_user_id，连对方后端时 botUserId 会恒为 null，
    // 个人云库整组功能会静默失效。
    const botUserId = result.botUserId ?? data.botUserId ?? null;
    this.authState.botUserId = botUserId;

    if (result.expiresAtMs) {
      localStorage.setItem(
        'bot_session',
        JSON.stringify({
          sessionId: data.sessionId,
          botUserId,
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
   * 返回 valid、后端滑动窗口最新过期时间（毫秒）与 bot_user_id
   */
  private async validateSession(
    sessionId: string
  ): Promise<{ valid: boolean; expiresAtMs?: number; botUserId?: string }> {
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
          botUserId: typeof data.bot_user_id === 'string' && data.bot_user_id
            ? data.bot_user_id
            : undefined,
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
   *
   * custom 模式下点数属于所连后端（Plana 与我们的 legacy 服务器都暴露公开的
   * GET /api/anlas），本地 sidecar 的点数与它无关；本地模式仍走 sidecar。
   */
  async getAnlas(): Promise<{ anlas: number; fresh: boolean } | null> {
    try {
      if (getAppSettings().serverMode === 'custom') {
        const response = await appBackendApi.request('/api/anlas');
        if (!response.ok) return null;
        const data = await response.json();
        // 两种响应形状都接受：Plana/legacy 的 {anlas:int}（legacy 另带 fresh），
        // 以及 sidecar 风格的 AnlasInfo。
        const anlas = typeof data?.anlas === 'number'
          ? data.anlas
          : Number(data?.fixedTrainingStepsLeft || 0) + Number(data?.purchasedTrainingSteps || 0);
        if (!Number.isFinite(anlas)) return null;
        return {
          anlas,
          // 只有后端明确说 fresh 才算新鲜：Plana 不返回该字段，兜底成 true 等于替对端
          // 撒谎，会把可能过期的缓存点数标成实时值。
          fresh: typeof data?.fresh === 'boolean' ? data.fresh : false,
        };
      }

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
