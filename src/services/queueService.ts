/**
 * 排队服务 - 管理多用户共享Token时的生成队列
 */

import { getUserId } from './localLibrary';

export interface QueueState {
  connected: boolean;
  inQueue: boolean;
  position: number;
  queueSize: number;
  ticket: string | null;
  isMyTurn: boolean;
  error: string | null;
}

export type QueueEventType = 
  | 'connected'
  | 'disconnected'
  | 'joined'
  | 'position_update'
  | 'your_turn'
  | 'done'
  | 'left'
  | 'timeout'
  | 'error';

export interface QueueEvent {
  type: QueueEventType;
  data?: Record<string, unknown>;
}

type QueueEventListener = (event: QueueEvent, state: QueueState) => void;

/**
 * 计算Token哈希（只使用前8位，保护隐私）
 */
async function computeTokenHash(token: string): Promise<string> {
  const prefix = token.substring(0, 8);
  const encoder = new TextEncoder();
  const data = encoder.encode(prefix);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

class QueueService {
  private ws: WebSocket | null = null;
  private serverUrl: string = '';
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private heartbeatInterval: number | null = null;
  private listeners: Set<QueueEventListener> = new Set();
  
  private state: QueueState = {
    connected: false,
    inQueue: false,
    position: 0,
    queueSize: 0,
    ticket: null,
    isMyTurn: false,
    error: null,
  };

  /**
   * 获取当前状态
   */
  getState(): QueueState {
    return { ...this.state };
  }

  /**
   * 添加事件监听器
   */
  addEventListener(listener: QueueEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * 触发事件
   */
  private emit(type: QueueEventType, data?: Record<string, unknown>) {
    const event: QueueEvent = { type, data };
    this.listeners.forEach(listener => {
      try {
        listener(event, this.getState());
      } catch (e) {
        console.error('Queue event listener error:', e);
      }
    });
  }

  /**
   * 更新状态并触发事件
   */
  private updateState(updates: Partial<QueueState>, eventType?: QueueEventType, eventData?: Record<string, unknown>) {
    this.state = { ...this.state, ...updates };
    if (eventType) {
      this.emit(eventType, eventData);
    }
  }

  /**
   * 连接到排队服务器
   */
  async connect(serverUrl: string): Promise<boolean> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return true;
    }

    this.serverUrl = serverUrl;
    
    return new Promise((resolve) => {
      try {
        const wsUrl = serverUrl.replace(/^http/, 'ws') + '/ws/queue';
        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
          console.log('Queue WebSocket connected');
          this.reconnectAttempts = 0;
          this.updateState({ connected: true, error: null }, 'connected');
          this.startHeartbeat();
          resolve(true);
        };

        this.ws.onclose = () => {
          console.log('Queue WebSocket disconnected');
          this.updateState({ 
            connected: false, 
            inQueue: false, 
            isMyTurn: false,
            ticket: null 
          }, 'disconnected');
          this.stopHeartbeat();
          this.attemptReconnect();
        };

        this.ws.onerror = (error) => {
          console.error('Queue WebSocket error:', error);
          this.updateState({ error: '连接错误' }, 'error', { error: String(error) });
          resolve(false);
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data);
        };

      } catch (error) {
        console.error('Failed to connect:', error);
        this.updateState({ error: '连接失败' }, 'error', { error: String(error) });
        resolve(false);
      }
    });
  }

  /**
   * 断开连接
   */
  disconnect() {
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.updateState({
      connected: false,
      inQueue: false,
      position: 0,
      queueSize: 0,
      ticket: null,
      isMyTurn: false,
    }, 'disconnected');
  }

  /**
   * 加入队列
   */
  async joinQueue(userId?: string): Promise<boolean> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error('WebSocket not connected');
      return false;
    }

    const tokenHash = await computeTokenHash(getUserId() || 'sidecar-token');
    
    this.ws.send(JSON.stringify({
      action: 'join_queue',
      token_hash: tokenHash,
      user_id: userId || 'anonymous',
    }));

    return true;
  }

  /**
   * 离开队列
   */
  leaveQueue() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    this.ws.send(JSON.stringify({
      action: 'leave_queue',
    }));
  }

  /**
   * 通知生成完成
   */
  notifyDone() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    this.ws.send(JSON.stringify({
      action: 'done',
      ticket: this.state.ticket,
    }));

    this.updateState({
      inQueue: false,
      isMyTurn: false,
      ticket: null,
      position: 0,
    }, 'done');
  }

  /**
   * 处理服务器消息
   */
  private handleMessage(data: string) {
    try {
      const msg = JSON.parse(data);
      const action = msg.action;

      switch (action) {
        case 'joined':
          this.updateState({
            inQueue: true,
            ticket: msg.ticket,
            position: msg.position,
            isMyTurn: false,
            error: null,
          }, 'joined', msg);
          break;

        case 'position_update':
          this.updateState({
            position: msg.position,
            queueSize: msg.queue_size,
          }, 'position_update', msg);
          break;

        case 'your_turn':
          this.updateState({
            isMyTurn: true,
            position: 0,
          }, 'your_turn', msg);
          break;

        case 'left':
          this.updateState({
            inQueue: false,
            ticket: null,
            position: 0,
            isMyTurn: false,
          }, 'left', msg);
          break;

        case 'timeout':
          this.updateState({
            inQueue: false,
            ticket: null,
            position: 0,
            isMyTurn: false,
            error: msg.message || '生成超时',
          }, 'timeout', msg);
          break;

        case 'done_ack':
          // 确认完成
          break;

        case 'heartbeat_ack':
          // 心跳响应
          if (msg.position !== undefined) {
            this.updateState({ position: msg.position });
          }
          break;

        case 'error':
          this.updateState({ error: msg.message }, 'error', msg);
          break;
      }
    } catch (e) {
      console.error('Failed to parse queue message:', e);
    }
  }

  /**
   * 启动心跳
   */
  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatInterval = window.setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ action: 'heartbeat' }));
      }
    }, 30000);
  }

  /**
   * 停止心跳
   */
  private stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * 尝试重连
   */
  private attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log('Max reconnect attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    
    console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    
    setTimeout(() => {
      if (this.serverUrl) {
        this.connect(this.serverUrl);
      }
    }, delay);
  }
}

// 单例导出
export const queueService = new QueueService();
