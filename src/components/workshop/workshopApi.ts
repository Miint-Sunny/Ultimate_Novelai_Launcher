// 工坊：生成 / 重试 / 轮询 / 任务恢复 / 额度查询
// 模块级单例，UI 组件可以挂载/卸载，但任务流不会中断

import { useTaskStore, type Task } from '../../stores/taskStore';
import { botService } from '../../services/botService';
import { appBackendApi } from '../../api/appBackendApi';
import { MODELS, getClosestRatio, compressImageFile, type UploadedImage } from './models';

const activeIntervals = new Map<string, ReturnType<typeof setInterval>>();

export interface QuotaInfo {
    daily_limit: number;
    daily_balance: number;
    extra_balance: number;
    total_available: number;
}

export type QuotaListener = (info: QuotaInfo | null) => void;
const quotaListeners = new Set<QuotaListener>();
let lastQuotaInfo: QuotaInfo | null = null;

export function subscribeQuota(listener: QuotaListener): () => void {
    quotaListeners.add(listener);
    listener(lastQuotaInfo);
    return () => { quotaListeners.delete(listener); };
}

export async function fetchQuota(): Promise<void> {
    try {
        const auth = botService.getAuthState();
        if (!auth.isAuthorized || !auth.sessionId) return;
        const resp = await appBackendApi.request('/api/workshop/quota', undefined, {
            session_id: auth.sessionId,
        });
        if (!resp.ok) return;
        const data = await resp.json();
        lastQuotaInfo = data;
        quotaListeners.forEach(l => l(data));
    } catch { /* ignore */ }
}

function startPolling(taskId: string) {
    if (activeIntervals.has(taskId)) return;
    const auth = botService.getAuthState();
    if (!auth.sessionId) return;
    const sessionId = auth.sessionId;
    const interval = setInterval(async () => {
        try {
            const resp = await appBackendApi.request('/api/workshop/tasks', undefined, {
                session_id: sessionId,
            });
            if (!resp.ok) return;
            const data = await resp.json();
            const task = (data.tasks || []).find((t: any) => t.task_id === taskId);
            if (!task) return;
            if (task.status === 'success' && task.image_url) {
                stopPolling(taskId);
                const imageUrl = await appBackendApi.objectUrl(task.image_url);
                useTaskStore.getState().updateTask(taskId, { status: 'success', imageUrl });
                fetchQuota();
            } else if (task.status === 'error') {
                stopPolling(taskId);
                useTaskStore.getState().updateTask(taskId, { status: 'error', error: task.error || '生成失败' });
                fetchQuota();
            }
        } catch { /* retry next tick */ }
    }, 2000);
    activeIntervals.set(taskId, interval);
}

function stopPolling(taskId: string) {
    const interval = activeIntervals.get(taskId);
    if (interval) {
        clearInterval(interval);
        activeIntervals.delete(taskId);
    }
}

async function fetchEstimatedSeconds(modelId: string): Promise<number> {
    const fallback = MODELS.find(m => m.id === modelId)?.speed ?? 30;
    try {
        const resp = await appBackendApi.request('/api/workshop/models/stats');
        if (!resp.ok) return fallback;
        const data = await resp.json();
        const stat = data?.[modelId];
        return stat?.avg_seconds ? Math.round(stat.avg_seconds) : fallback;
    } catch { return fallback; }
}

export interface GenerateParams {
    prompt: string;
    modelId: string;
    aspectRatio: string;
    refImages?: UploadedImage[];
    /** 已经是 data URI 的参考图（用于重试场景，跳过重新读取本地 File） */
    refImagesB64?: string[];
}

async function postGenerate(taskId: string, params: GenerateParams) {
    const { prompt, modelId, aspectRatio, refImages, refImagesB64 } = params;
    const store = useTaskStore.getState();

    const estimated = await fetchEstimatedSeconds(modelId);
    store.updateTask(taskId, { estimatedSeconds: estimated });

    try {
        const auth = botService.getAuthState();
        if (!auth.isAuthorized || !auth.sessionId) {
            store.updateTask(taskId, { status: 'error', error: '请先登录 Bot 账号' });
            return;
        }

        let imageBase64List: string[] = refImagesB64 ? [...refImagesB64] : [];
        if (imageBase64List.length === 0 && refImages && refImages.length > 0) {
            for (const img of refImages) {
                try { imageBase64List.push(await compressImageFile(img.file, 1536, 0.7)); } catch { /* skip */ }
            }
        }

        let finalAspectRatio = aspectRatio;
        if (finalAspectRatio === 'auto' && refImages && refImages.length > 0) {
            const first = refImages[0];
            if (first.width > 0 && first.height > 0) {
                finalAspectRatio = getClosestRatio(first.width, first.height);
            }
        }

        const reqBody: Record<string, unknown> = {
            session_id: auth.sessionId,
            model: modelId,
            prompt,
            aspect_ratio: finalAspectRatio,
        };
        if (imageBase64List.length > 0) {
            reqBody.images = imageBase64List;
            store.updateTask(taskId, { refImages: imageBase64List });
        }

        const resp = await appBackendApi.request('/api/workshop/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(reqBody),
        });
        const data = await resp.json();

        if (!data.success || !data.task_id) {
            store.updateTask(taskId, { status: 'error', error: data.error || '提交失败' });
            return;
        }

        store.replaceTaskId(taskId, data.task_id);
        startPolling(data.task_id);
    } catch (e) {
        store.updateTask(taskId, { status: 'error', error: `请求失败: ${e}` });
    }
}

export async function generate(params: GenerateParams): Promise<string> {
    const taskId = `gen_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    useTaskStore.getState().addTask({
        id: taskId,
        status: 'generating',
        imageUrl: '',
        prompt: params.prompt,
        modelId: params.modelId,
        timestamp: Date.now(),
        aspectRatio: params.aspectRatio,
        estimatedSeconds: null,
    });
    postGenerate(taskId, params);
    return taskId;
}

export async function retry(task: Task): Promise<string> {
    useTaskStore.getState().removeTask(task.id);
    const newId = `gen_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    useTaskStore.getState().addTask({
        id: newId,
        status: 'generating',
        imageUrl: '',
        prompt: task.prompt,
        modelId: task.modelId,
        timestamp: Date.now(),
        aspectRatio: task.aspectRatio,
        estimatedSeconds: null,
        refImages: task.refImages,
    });
    postGenerate(newId, {
        prompt: task.prompt,
        modelId: task.modelId,
        aspectRatio: task.aspectRatio,
        refImagesB64: task.refImages,
    });
    return newId;
}

export async function retryWithPrompt(task: Task, newPrompt: string): Promise<string> {
    useTaskStore.getState().removeTask(task.id);
    const newId = `gen_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    useTaskStore.getState().addTask({
        id: newId,
        status: 'generating',
        imageUrl: '',
        prompt: newPrompt,
        modelId: task.modelId,
        timestamp: Date.now(),
        aspectRatio: task.aspectRatio,
        estimatedSeconds: null,
        refImages: task.refImages,
    });
    postGenerate(newId, {
        prompt: newPrompt,
        modelId: task.modelId,
        aspectRatio: task.aspectRatio,
        refImagesB64: task.refImages,
    });
    return newId;
}

let restored = false;
export async function restoreTasks(): Promise<void> {
    if (restored) return;
    restored = true;

    const auth = botService.getAuthState();
    if (!auth.isAuthorized || !auth.sessionId) return;
    // 先恢复 store 中正在生成的任务的轮询
    for (const t of useTaskStore.getState().tasks) {
        if (t.status === 'generating') startPolling(t.id);
    }

    try {
        const resp = await appBackendApi.request('/api/workshop/tasks', undefined, {
            session_id: auth.sessionId,
        });
        if (!resp.ok) return;
        const data = await resp.json();
        const serverTasks = data.tasks || [];
        if (serverTasks.length === 0) return;

        let modelStats: Record<string, any> = {};
        try {
            const statsResp = await appBackendApi.request('/api/workshop/models/stats');
            if (statsResp.ok) modelStats = await statsResp.json();
        } catch { /* ignore */ }

        const newTasks: Task[] = [];
        for (const task of serverTasks) {
            const modelCfg = MODELS.find(m => m.id === task.model);
            const stat = modelStats[task.model];
            const est = stat?.avg_seconds ? Math.round(stat.avg_seconds) : (modelCfg?.speed ?? null);
            const t: Task = {
                id: task.task_id,
                status: task.status === 'success' ? 'success' : task.status === 'error' ? 'error' : 'generating',
                imageUrl: task.image_url ? await appBackendApi.objectUrl(task.image_url) : '',
                modelId: task.model,
                prompt: task.prompt || '',
                timestamp: task.created_at ? task.created_at * 1000 : Date.now(),
                aspectRatio: task.aspect_ratio || 'auto',
                estimatedSeconds: task.status === 'generating' ? est : null,
            };
            if (task.status === 'error') t.error = task.error || '生成失败';
            newTasks.push(t);
        }

        if (newTasks.length > 0) {
            useTaskStore.getState().mergeTasks(newTasks);
            for (const t of newTasks) {
                if (t.status === 'generating') startPolling(t.id);
            }
        }
    } catch { /* ignore */ }
}

/** 应用退出 / 模块卸载时清理轮询（一般不会触发） */
export function cleanupAll(): void {
    for (const [, interval] of activeIntervals) clearInterval(interval);
    activeIntervals.clear();
}
