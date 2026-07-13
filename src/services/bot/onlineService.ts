/**
 * 在线人数服务（心跳统计）。通过 sidecar 上报心跳并广播在线人数。
 * 由 botService.ts 门面统一导出。
 */

import { appBackendApi } from '../../api/appBackendApi';

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
      const data = await appBackendApi.postJson<{ count: number }>('/api/online/heartbeat', { user_id: this.userId });
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
      const data = await appBackendApi.getJson<{ count: number }>('/api/online/count');
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
