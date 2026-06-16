/**
 * 香蕉重绘服务
 */

import { getBackendUrl } from '../utils/apiConfig';

export interface BananaRepaintResult {
  success: boolean;
  taskId?: string;
  message: string;
  estimatedSeconds?: number;
}

export interface BananaRepaintStatus {
  success: boolean;
  status: 'pending' | 'generating' | 'completed' | 'failed';
  imageBase64?: string;
  step: number;
  totalSteps: number;
  previewBase64?: string;
  message: string;
  quotaInfo?: {
    daily_balance: number;
    extra_balance: number;
    total_available: number;
  };
}

export interface BananaEstimate {
  estimatedSeconds: number;
  provider: string;
  failureRate: number;  // 0.0-1.0
}

/**
 * 获取香蕉重绘预估时间
 */
export async function getBananaEstimate(): Promise<BananaEstimate> {
  const backendUrl = getBackendUrl();

  try {
    const response = await fetch(`${backendUrl}/api/banana/estimate`);
    if (response.ok) {
      const data = await response.json();
      return {
        estimatedSeconds: data.estimated_seconds || 60,
        provider: data.provider || 'unknown',
        failureRate: data.failure_rate || 0,
      };
    }
  } catch (error) {
    console.error('获取预估时间失败:', error);
  }
  
  // 默认60秒
  return { estimatedSeconds: 60, provider: 'unknown', failureRate: 0 };
}

/**
 * 提交香蕉重绘任务
 */
export async function submitBananaRepaint(
  imageBase64: string,
  prompt: string
): Promise<BananaRepaintResult> {
  const backendUrl = getBackendUrl();

  try {
    const response = await fetch(`${backendUrl}/api/banana/repaint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image_base64: imageBase64,
        prompt: prompt,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return {
        success: false,
        message: data.detail || `HTTP ${response.status}`,
      };
    }

    return {
      success: data.success,
      taskId: data.task_id,
      message: data.message,
      estimatedSeconds: data.estimated_seconds,
    };
  } catch (error) {
    console.error('提交香蕉重绘任务失败:', error);
    return {
      success: false,
      message: error instanceof Error ? error.message : '网络错误',
    };
  }
}

/**
 * 获取香蕉重绘任务状态
 */
export async function getBananaRepaintStatus(taskId: string): Promise<BananaRepaintStatus> {
  const backendUrl = getBackendUrl();

  try {
    const response = await fetch(`${backendUrl}/api/banana/status/${taskId}`);
    const data = await response.json();

    return {
      success: data.success,
      status: data.status,
      imageBase64: data.image_base64,
      step: data.step || 0,
      totalSteps: data.total_steps || 0,
      previewBase64: data.preview_base64,
      message: data.message,
      quotaInfo: data.quota_info,
    };
  } catch (error) {
    console.error('获取香蕉重绘状态失败:', error);
    return {
      success: false,
      status: 'failed',
      step: 0,
      totalSteps: 0,
      message: error instanceof Error ? error.message : '网络错误',
    };
  }
}

/**
 * 轮询等待香蕉重绘完成
 */
export async function waitForBananaRepaint(
  taskId: string,
  onProgress?: (status: BananaRepaintStatus) => void,
  pollInterval: number = 1000,
  maxWaitTime: number = 300000 // 5分钟超时
): Promise<BananaRepaintStatus> {
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitTime) {
    const status = await getBananaRepaintStatus(taskId);

    if (onProgress) {
      onProgress(status);
    }

    if (status.status === 'completed' || status.status === 'failed') {
      return status;
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  return {
    success: false,
    status: 'failed',
    step: 0,
    totalSteps: 0,
    message: '请求超时',
  };
}
