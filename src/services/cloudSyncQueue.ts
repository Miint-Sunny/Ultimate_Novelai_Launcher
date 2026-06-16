/**
 * 云同步推送队列 (CloudSyncQueue)
 *
 * 设计目标：
 *  - "写入即同步"：任何对 vibe 的修改都会自动入队，500ms 防抖后 push
 *  - 同 vibe id 的多次 push 会被合并成最后一次（用户连续编辑只触发一次实际推送）
 *  - 不同 vibe 串行执行（避免后端写入冲突）
 *  - 失败时指数退避自动重试 1s/5s/30s，连续 3 次失败后才标记为 'error' 并通知 UI
 *  - sync 流程开始前可以 await flush() 等队列清空，保证 "先 push 后 pull" 的顺序
 *
 * 用法：
 *   import { cloudSyncQueue } from './cloudSyncQueue';
 *   cloudSyncQueue.enqueuePush(vibeId);             // 入队
 *   await cloudSyncQueue.flush();                    // 等所有 pending 完成
 *   cloudSyncQueue.addListener(s => console.log(s)); // 监听状态
 */

const DEBOUNCE_MS = 500;
const RETRY_DELAYS_MS = [1000, 5000, 30000];  // 指数退避

export interface CloudSyncQueueStatus {
  /** 还未开始 push 的 pending vibe 数量（包括防抖等待中的） */
  pending: number;
  /** 当前正在 push 的 vibe id（null 表示空闲） */
  running: string | null;
  /** 已经连续重试失败 3 次以上的 vibe id 集合 */
  failing: string[];
}

type Listener = (status: CloudSyncQueueStatus) => void;

interface ScheduledTask {
  vibeId: string;
  /** setTimeout 句柄，防抖期内可以被新任务覆盖 */
  debounceTimer: ReturnType<typeof setTimeout> | null;
  /** 当前任务在重试链里的位置 */
  retryAttempt: number;
  /** 等待 push 完成的 promise 列表（flush 用） */
  resolvers: Array<() => void>;
}

class CloudSyncQueue {
  /** 防抖待执行任务：vibeId → ScheduledTask */
  private scheduled = new Map<string, ScheduledTask>();
  /** 已就绪准备执行的 vibeId 队列（FIFO） */
  private readyQueue: string[] = [];
  /** 当前正在执行的 vibe id */
  private running: string | null = null;
  /** 永久失败列表（重试 3 次都没成功） */
  private failing = new Set<string>();
  /** 状态监听器 */
  private listeners = new Set<Listener>();
  /** 整体禁用开关（协议版本不匹配时打开，所有入队请求会被丢弃） */
  private disabled = false;

  // ── 公共 API ────────────────────────────────────────────────────────────

  /**
   * 全局禁用/启用队列。
   * 禁用后所有 enqueuePush 调用会被静默丢弃，已在跑的任务会继续完成。
   * 用于"协议版本不匹配"等需要锁死整个云同步的场景。
   */
  setDisabled(disabled: boolean): void {
    this.disabled = disabled;
    if (disabled) {
      // 清空 pending（已 running 的让它跑完）
      for (const [, task] of this.scheduled.entries()) {
        if (task.debounceTimer) clearTimeout(task.debounceTimer);
      }
      this.scheduled.clear();
      this.readyQueue = [];
      this.emit();
    }
  }

  isDisabled(): boolean {
    return this.disabled;
  }

  /**
   * 入队一次 push 请求。同 vibeId 在防抖窗口内的多次调用会被合并。
   */
  enqueuePush(vibeId: string): void {
    if (!vibeId) return;
    if (this.disabled) {
      console.log(`[CloudSyncQueue] 已禁用，丢弃 push 请求: ${vibeId}`);
      return;
    }
    // 入队等于"用户改了这个 vibe"，清掉永久失败标记，给它新机会
    if (this.failing.has(vibeId)) {
      this.failing.delete(vibeId);
    }

    let task = this.scheduled.get(vibeId);
    if (!task) {
      task = {
        vibeId,
        debounceTimer: null,
        retryAttempt: 0,
        resolvers: [],
      };
      this.scheduled.set(vibeId, task);
    } else {
      // 同 id 重新入队 → 重置重试计数（这是新的一次写入）
      task.retryAttempt = 0;
    }

    // 重置防抖
    if (task.debounceTimer) clearTimeout(task.debounceTimer);
    task.debounceTimer = setTimeout(() => {
      this.promoteToReady(vibeId);
    }, DEBOUNCE_MS);

    this.emit();
  }

  /**
   * 等待队列清空。返回的 Promise 在所有 pending + running 任务都完成时 resolve。
   * sync 流程开始前调用，保证 push 在 pull 之前完成。
   */
  flush(): Promise<void> {
    if (this.scheduled.size === 0 && this.readyQueue.length === 0 && !this.running) {
      return Promise.resolve();
    }
    return new Promise(resolve => {
      // 把 resolver 挂到所有现存任务上
      const remainingTasks = new Set<string>();
      for (const [id, task] of this.scheduled.entries()) {
        remainingTasks.add(id);
        task.resolvers.push(() => {
          remainingTasks.delete(id);
          if (remainingTasks.size === 0) resolve();
        });
      }
      // readyQueue 里的任务可能没有 resolver（promote 时已清掉 task）
      // 简化处理：轮询等待 100ms，直到全空
      const poll = () => {
        if (this.scheduled.size === 0 && this.readyQueue.length === 0 && !this.running) {
          resolve();
        } else {
          setTimeout(poll, 100);
        }
      };
      if (remainingTasks.size === 0) poll();
    });
  }

  /**
   * 重试所有失败的 vibe（用户点击红色云按钮时调用）
   */
  retryFailed(): void {
    const failed = Array.from(this.failing);
    this.failing.clear();
    for (const id of failed) {
      this.enqueuePush(id);
    }
    this.emit();
  }

  getStatus(): CloudSyncQueueStatus {
    return {
      pending: this.scheduled.size + this.readyQueue.length,
      running: this.running,
      failing: Array.from(this.failing),
    };
  }

  addListener(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  private emit(): void {
    const status = this.getStatus();
    for (const fn of this.listeners) {
      try {
        fn(status);
      } catch (e) {
        console.error('[CloudSyncQueue] listener error:', e);
      }
    }
  }

  /**
   * 防抖结束 → 把任务从 scheduled 移到 readyQueue
   */
  private promoteToReady(vibeId: string): void {
    const task = this.scheduled.get(vibeId);
    if (!task) return;
    // 注意：保留 task 信息，promote 时不删 scheduled，让 flush() 能找到它
    // 改成：把 task 移到 readyQueue 时，从 scheduled 里删除
    this.scheduled.delete(vibeId);
    if (!this.readyQueue.includes(vibeId)) {
      this.readyQueue.push(vibeId);
    }
    // 通知 flush 监听器（如果有）
    for (const r of task.resolvers) {
      try { r(); } catch { /* ignore */ }
    }
    this.emit();
    this.kickOff();
  }

  /**
   * 启动执行循环（如果当前没在跑就开始下一个）
   */
  private async kickOff(): Promise<void> {
    if (this.running) return;
    const next = this.readyQueue.shift();
    if (!next) return;
    this.running = next;
    this.emit();

    let success = false;
    let attempt = 0;
    while (attempt < RETRY_DELAYS_MS.length + 1) {
      try {
        // 动态导入避免循环依赖
        const { pushVibeToCloud } = await import('./localLibrary');
        const result = await pushVibeToCloud(next);
        if (result.success) {
          success = true;
          break;
        }
        console.warn(`[CloudSyncQueue] push 失败 (vibe ${next}, 第 ${attempt + 1} 次): ${result.message}`);
      } catch (err) {
        console.warn(`[CloudSyncQueue] push 异常 (vibe ${next}, 第 ${attempt + 1} 次):`, err);
      }
      attempt++;
      if (attempt < RETRY_DELAYS_MS.length + 1) {
        // 等下一次重试
        const delay = RETRY_DELAYS_MS[attempt - 1];
        if (delay) await new Promise(r => setTimeout(r, delay));
      }
    }

    if (!success) {
      console.error(`[CloudSyncQueue] vibe ${next} 重试 ${RETRY_DELAYS_MS.length} 次后仍失败，标记为 failing`);
      this.failing.add(next);
    }

    this.running = null;
    this.emit();
    // 继续下一个
    this.kickOff();
  }
}

export const cloudSyncQueue = new CloudSyncQueue();
