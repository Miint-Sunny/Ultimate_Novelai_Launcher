import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
    Sparkles,
    X,
    Image as ImageIcon,
    Download,
    Loader2,
    ChevronDown,
    Clock,
    ZoomIn,
    ZoomOut,
    Copy,
    CheckCircle2,
    AlertCircle,
    Plus,
    RotateCcw,
    Trash2,
} from 'lucide-react';
import { botService } from '../services/botService';
import { getQueueServerUrl } from '../utils/apiConfig';
import { useTaskStore } from '../stores/taskStore';
import type { Task, TaskStatus } from '../stores/taskStore';
import { getAppSettings } from '../services/localLibrary';

// ============ 模型配置 ============
export interface ModelConfig {
    id: string;
    name: string;
    description: string;
    icon: string;    // emoji
    color: string;   // tailwind gradient classes
    accentColor: string; // hex color for accents
    resolution: string;
    aspectRatioMode: 'auto' | 'fixed';
    supportImg2Img: boolean;
    maxImages: number;
    tag?: string;    // 样式标签，如 '无审查'
    tagColor?: 'green' | 'red'; // 标签颜色，默认 green
    strength: number; // 强度 1-5
    speed: number;    // 速度，秒
}

export const MODELS: ModelConfig[] = [
    {
        id: 'gpt-image',
        name: '大GPT',
        description: 'GPT Image 2',
        icon: '✨',
        color: 'from-emerald-500/20 to-green-600/20',
        accentColor: '#10b981',
        resolution: '2k',
        aspectRatioMode: 'auto',
        supportImg2Img: true,
        maxImages: 5,
        strength: 5,
        speed: 30,
    },
    {
        id: 'gpt-image-4k',
        name: '超大GPT',
        description: 'GPT Image 2',
        icon: '✨',
        color: 'from-rose-500/20 to-pink-600/20',
        accentColor: '#f43f5e',
        resolution: '4k',
        aspectRatioMode: 'auto',
        supportImg2Img: true,
        maxImages: 5,
        tag: 'x2额度',
        tagColor: 'red',
        strength: 5,
        speed: 60,
    },
];

// 强度等级配置
const STRENGTH_LEVELS: Record<number, { label: string; color: string; bg: string }> = {
    1: { label: '极弱', color: 'text-gray-400', bg: 'bg-gray-500/15' },
    2: { label: '较弱', color: 'text-blue-400', bg: 'bg-blue-500/15' },
    3: { label: '一般', color: 'text-cyan-400', bg: 'bg-cyan-500/15' },
    4: { label: '中等', color: 'text-amber-400', bg: 'bg-amber-500/15' },
    5: { label: '优秀', color: 'text-orange-400', bg: 'bg-orange-500/15' },
};

// 模型指标组件 - 强度文字 + 速度
const ModelStats: React.FC<{ strength: number; speed: number }> = ({ strength, speed }) => {
    const level = STRENGTH_LEVELS[strength] || STRENGTH_LEVELS[1];
    return (
        <div className="flex items-center gap-1.5 mt-0.5">
            <span className={`text-[9px] px-1.5 py-[1px] rounded ${level.bg} ${level.color} font-medium`}>{level.label}</span>
            <span className="text-[10px] text-gray-600 tabular-nums">~{speed}s</span>
        </div>
    );
};

// ============ 比例配置 ============
interface AspectRatio {
    label: string;
    value: string;
    w: number; // 比例宽度用于绘制 SVG 图标
    h: number; // 比例高度用于绘制 SVG 图标
}

const ASPECT_RATIOS: AspectRatio[] = [
    { label: '自动', value: 'auto', w: 1, h: 1 },
    { label: '1:1', value: '1:1', w: 1, h: 1 },
    { label: '4:3', value: '4:3', w: 4, h: 3 },
    { label: '3:4', value: '3:4', w: 3, h: 4 },
    { label: '16:9', value: '16:9', w: 16, h: 9 },
    { label: '9:16', value: '9:16', w: 9, h: 16 },
    { label: '3:2', value: '3:2', w: 3, h: 2 },
    { label: '2:3', value: '2:3', w: 2, h: 3 },
    { label: '5:4', value: '5:4', w: 5, h: 4 },
    { label: '4:5', value: '4:5', w: 4, h: 5 },
    { label: '21:9', value: '21:9', w: 21, h: 9 },
];

// 根据图片尺寸匹配最接近的支持比例（与 Bot 端 _BIG_GPT_RATIO_TABLE 键集一致）
const SUPPORTED_RATIOS = [[1, 1], [2, 3], [3, 2], [3, 4], [4, 3], [4, 5], [5, 4], [9, 16], [16, 9], [21, 9], [9, 21]];
function getClosestRatio(width: number, height: number): string {
    if (width <= 0 || height <= 0) return '1:1';
    const imgRatio = width / height;
    let closest = SUPPORTED_RATIOS[0];
    let minDiff = Infinity;
    for (const r of SUPPORTED_RATIOS) {
        const diff = Math.abs(imgRatio - r[0] / r[1]);
        if (diff < minDiff) {
            minDiff = diff;
            closest = r;
        }
    }
    return `${closest[0]}:${closest[1]}`;
}

// 比例图标组件 - 简洁矩形
const RatioIcon: React.FC<{ w: number; h: number; isAuto?: boolean; active?: boolean }> = ({ w, h, isAuto, active }) => {
    const maxDim = 14;
    const scale = maxDim / Math.max(w, h);
    const rw = Math.round(w * scale);
    const rh = Math.round(h * scale);
    const color = active ? 'rgba(252, 237, 164, 0.8)' : 'rgba(255, 255, 255, 0.35)';

    if (isAuto) {
        return (
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <rect x="2" y="2" width="14" height="14" rx="2" stroke={color} strokeWidth="1.5" strokeDasharray="3 2" />
                <text x="9" y="12" textAnchor="middle" fill={color} fontSize="8" fontWeight="500">A</text>
            </svg>
        );
    }

    return (
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <rect
                x={(18 - rw) / 2}
                y={(18 - rh) / 2}
                width={rw}
                height={rh}
                rx="1.5"
                stroke={color}
                strokeWidth="1.5"
                fill={active ? 'rgba(252, 237, 164, 0.1)' : 'none'}
            />
        </svg>
    );
};

// ============ 上传的图片 ============
interface UploadedImage {
    id: string;
    file: File;
    previewUrl: string;
    width: number;
    height: number;
}

// ============ 压缩工具 ============
/** 将 File 压缩为不超过 maxDim 像素的 JPEG data URI（减小请求体积） */
async function compressImageFile(file: File, maxDim = 2048, quality = 0.8): Promise<string> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            let { naturalWidth: w, naturalHeight: h } = img;
            // 等比缩放
            if (w > maxDim || h > maxDim) {
                const scale = maxDim / Math.max(w, h);
                w = Math.round(w * scale);
                h = Math.round(h * scale);
            }
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d')!
            ctx.drawImage(img, 0, 0, w, h);
            // 输出 JPEG (体积远小于 PNG)
            const dataUri = canvas.toDataURL('image/jpeg', quality);
            URL.revokeObjectURL(img.src);
            resolve(dataUri);
        };
        img.onerror = () => {
            URL.revokeObjectURL(img.src);
            reject(new Error('图片加载失败'));
        };
        img.src = URL.createObjectURL(file);
    });
}

/** 从原始错误信息中提取简短摘要 */
function extractErrorSummary(error?: string): string {
    if (!error) return '未知错误';
    const lower = error.toLowerCase();
    if (lower.includes('nsfw')) return 'NSFW 内容限制';
    if (lower.includes('timeout') || lower.includes('超时')) return '请求超时';
    if (lower.includes('额度不足') || lower.includes('quota')) return '额度不足';
    if (lower.includes('rate limit') || lower.includes('429')) return '请求过于频繁';
    if (lower.includes('unauthorized') || lower.includes('401') || lower.includes('未登录')) return '未授权';
    if (lower.includes('network') || lower.includes('fetch') || lower.includes('connection')) return '网络错误';
    if (lower.includes('server') || lower.includes('500') || lower.includes('502') || lower.includes('503')) return '服务器错误';
    if (lower.includes('blocked') || lower.includes('safety')) return '安全过滤';
    // 截取前 30 字符
    const short = error.replace(/^(生成错误|生成异常|请求失败|image generation failed)[:\s]*/i, '').trim();
    return short.length > 30 ? short.slice(0, 30) + '…' : short || '生成失败';
}

// ============ 组件 ============
export const ImageGenPage: React.FC<{ onBack?: () => void; initialImageUrl?: string }> = ({ onBack, initialImageUrl }) => {
    // Zustand store
    const { tasks, addTask, updateTask, removeTask, replaceTaskId, mergeTasks } = useTaskStore();

    // 本地 UI 状态
    const [selectedModel, setSelectedModel] = useState<ModelConfig>(MODELS[0]);
    const [prompt, setPrompt] = useState('');
    const [aspectRatio, setAspectRatio] = useState('auto');
    const [isModelSelectorOpen, setIsModelSelectorOpen] = useState(false);
    const [isRatioSelectorOpen, setIsRatioSelectorOpen] = useState(false);
    const [uploadedImages, setUploadedImages] = useState<UploadedImage[]>([]);
    const [viewingResult, setViewingResult] = useState<Task | null>(null);
    const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
    const [imageScale, setImageScale] = useState(1);
    const [quotaInfo, setQuotaInfo] = useState<{ daily_limit: number; daily_balance: number; extra_balance: number; total_available: number } | null>(null);
    const [isRestoringTasks, setIsRestoringTasks] = useState(tasks.length === 0);

    // Refs
    const promptRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const modelSelectorRef = useRef<HTMLDivElement>(null);
    const ratioSelectorRef = useRef<HTMLDivElement>(null);
    const activeIntervalsRef = useRef<ReturnType<typeof setInterval>[]>([]);

    // 组件卸载时清理所有活跃的 interval
    useEffect(() => {
        return () => {
            activeIntervalsRef.current.forEach(id => clearInterval(id));
            activeIntervalsRef.current = [];
        };
    }, []);

    // 自动调整文本框高度
    useEffect(() => {
        const textarea = promptRef.current;
        if (textarea) {
            textarea.style.height = 'auto';
            textarea.style.height = Math.min(Math.max(textarea.scrollHeight, 100), 240) + 'px';
        }
    }, [prompt]);

    // 点击外部关闭选择器
    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (modelSelectorRef.current && !modelSelectorRef.current.contains(e.target as Node)) {
                setIsModelSelectorOpen(false);
            }
            if (ratioSelectorRef.current && !ratioSelectorRef.current.contains(e.target as Node)) {
                setIsRatioSelectorOpen(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);

    // Toast 自动消失
    useEffect(() => {
        if (toast) {
            const timer = setTimeout(() => setToast(null), 3000);
            return () => clearTimeout(timer);
        }
    }, [toast]);

    // 获取额度
    const fetchQuota = useCallback(async () => {
        try {
            const authState = botService.getAuthState();
            if (!authState.isAuthorized || !authState.sessionId) return;
            const serverUrl = getQueueServerUrl();
            const resp = await fetch(`${serverUrl}/api/workshop/quota?session_id=${encodeURIComponent(authState.sessionId)}`);
            if (resp.ok) {
                const data = await resp.json();
                setQuotaInfo(data);
            }
        } catch {
            // ignore
        }
    }, []);

    // 登录后自动获取额度
    useEffect(() => {
        fetchQuota();
    }, [fetchQuota]);

    // 参考图区域高亮状态
    const [refImageHighlight, setRefImageHighlight] = useState(false);

    // 将 initialImageUrl 添加为参考图的快捷方法
    const handleAddInitialImage = useCallback(async () => {
        if (!initialImageUrl) return;
        try {
            const resp = await fetch(initialImageUrl);
            const blob = await resp.blob();
            const file = new File([blob], `ref_${Date.now()}.png`, { type: blob.type || 'image/png' });
            const previewUrl = URL.createObjectURL(file);
            const dimensions = await new Promise<{ width: number; height: number }>((resolve) => {
                const img = new Image();
                img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
                img.onerror = () => resolve({ width: 0, height: 0 });
                img.src = previewUrl;
            });
            setUploadedImages(prev => {
                if (prev.length >= selectedModel.maxImages) return prev;
                return [...prev, {
                    id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                    file,
                    previewUrl,
                    width: dimensions.width,
                    height: dimensions.height,
                }];
            });
        } catch (e) {
            console.warn('加载图片失败:', e);
            setToast({ type: 'error', message: '加载图片失败' });
        }
    }, [initialImageUrl, selectedModel.maxImages]);

    // 上传图片
    const handleUploadImage = useCallback(async (files: FileList | File[]) => {
        const model = selectedModel;
        const newImages: UploadedImage[] = [];

        for (const file of Array.from(files)) {
            if (!file.type.startsWith('image/')) continue;
            if (uploadedImages.length + newImages.length >= model.maxImages) break;

            const previewUrl = URL.createObjectURL(file);

            // 获取图片尺寸
            const dimensions = await new Promise<{ width: number; height: number }>((resolve) => {
                const img = new Image();
                img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
                img.onerror = () => resolve({ width: 0, height: 0 });
                img.src = previewUrl;
            });

            newImages.push({
                id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                file,
                previewUrl,
                width: dimensions.width,
                height: dimensions.height,
            });
        }

        setUploadedImages((prev) => [...prev, ...newImages]);
    }, [selectedModel, uploadedImages]);

    // 删除上传的图片
    const handleRemoveImage = useCallback((id: string) => {
        setUploadedImages((prev) => {
            const removed = prev.find((img) => img.id === id);
            if (removed) URL.revokeObjectURL(removed.previewUrl);
            return prev.filter((img) => img.id !== id);
        });
    }, []);

    // 拖放处理
    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer.files.length > 0) {
            handleUploadImage(e.dataTransfer.files);
        }
    }, [handleUploadImage]);

    const handleDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
    }, []);

    // ====== 通用轮询函数 ======
    const startPolling = useCallback((taskId: string) => {
        const authState = botService.getAuthState();
        if (!authState.sessionId) return;
        const serverUrl = getQueueServerUrl();
        const pollInterval = setInterval(async () => {
            try {
                const pollResp = await fetch(`${serverUrl}/api/workshop/tasks?session_id=${authState.sessionId}`);
                if (!pollResp.ok) return;
                const pollData = await pollResp.json();
                const task = (pollData.tasks || []).find((t: any) => t.task_id === taskId);
                if (!task) return;
                if (task.status === 'success' && task.image_url) {
                    clearInterval(pollInterval);
                    updateTask(taskId, { status: 'success', imageUrl: `${serverUrl}${task.image_url}` });
                    fetchQuota().catch(() => { });
                } else if (task.status === 'error') {
                    clearInterval(pollInterval);
                    updateTask(taskId, { status: 'error', error: task.error || '生成失败' });
                    fetchQuota().catch(() => { });
                }
            } catch { /* retry next interval */ }
        }, 2000);
        activeIntervalsRef.current.push(pollInterval);
    }, [updateTask, fetchQuota]);

    // ====== 核心生成函数（支持首次 + 重试） ======
    const doGenerate = useCallback(async (taskId: string, genPrompt: string, genModelId: string, genAspectRatio: string, retryImages?: string[]) => {
        let estimated: number | null = null;
        const model = MODELS.find(m => m.id === genModelId) || MODELS[0];
        try {
            const serverUrl = getQueueServerUrl();
            const statsResp = await fetch(`${serverUrl}/api/workshop/models/stats`);
            if (statsResp.ok) {
                const statsData = await statsResp.json();
                const modelStat = statsData[genModelId];
                estimated = modelStat?.avg_seconds ? Math.round(modelStat.avg_seconds) : model.speed;
            } else { estimated = model.speed; }
        } catch { estimated = model.speed; }

        updateTask(taskId, { estimatedSeconds: estimated });

        try {
            const authState = botService.getAuthState();
            if (!authState.isAuthorized || !authState.sessionId) {
                updateTask(taskId, { status: 'error', error: '请先登录 Bot 账号' });
                return;
            }

            let imageBase64List: string[] = retryImages || [];
            if (imageBase64List.length === 0) {
                const curModel = MODELS.find(m => m.id === genModelId);
                if (curModel?.supportImg2Img && uploadedImages.length > 0) {
                    for (const img of uploadedImages) {
                        try { imageBase64List.push(await compressImageFile(img.file, 1536, 0.7)); } catch { /* skip */ }
                    }
                }
            }

            const serverUrl = getQueueServerUrl();
            let finalAspectRatio = genAspectRatio;
            if (finalAspectRatio === 'auto' && uploadedImages.length > 0) {
                const first = uploadedImages[0];
                if (first.width > 0 && first.height > 0) finalAspectRatio = getClosestRatio(first.width, first.height);
            }

            const reqBody: Record<string, unknown> = {
                session_id: authState.sessionId, model: genModelId, prompt: genPrompt, aspect_ratio: finalAspectRatio,
            };
            if (imageBase64List.length > 0) {
                reqBody.images = imageBase64List;
                updateTask(taskId, { refImages: imageBase64List });
            }

            const submitResp = await fetch(`${serverUrl}/api/workshop/generate`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reqBody),
            });
            const submitData = await submitResp.json();

            if (!submitData.success || !submitData.task_id) {
                updateTask(taskId, { status: 'error', error: submitData.error || '提交失败' });
                return;
            }

            const serverTaskId = submitData.task_id as string;
            replaceTaskId(taskId, serverTaskId);
            startPolling(serverTaskId);
        } catch (e) {
            updateTask(taskId, { status: 'error', error: `请求失败: ${e}` });
        }
    }, [uploadedImages, fetchQuota, updateTask, replaceTaskId, startPolling]);

    // ====== 组件挂载时从服务器恢复任务 ======
    useEffect(() => {
        const authState = botService.getAuthState();
        if (!authState.isAuthorized || !authState.sessionId) {
            setIsRestoringTasks(false);
            return;
        }
        const serverUrl = getQueueServerUrl();

        // 恢复 store 中正在生成的任务的轮询
        for (const t of tasks) {
            if (t.status === 'generating') startPolling(t.id);
        }

        // 从服务器增量合并
        const restoreTasks = async () => {
            if (tasks.length === 0) setIsRestoringTasks(true);
            try {
                const resp = await fetch(`${serverUrl}/api/workshop/tasks?session_id=${authState.sessionId}`);
                if (!resp.ok) return;
                const data = await resp.json();
                const serverTasks = data.tasks || [];
                if (serverTasks.length === 0) return;

                let modelStats: Record<string, any> = {};
                try {
                    const statsResp = await fetch(`${serverUrl}/api/workshop/models/stats`);
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
                        imageUrl: task.image_url ? `${serverUrl}${task.image_url}` : '',
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
                    mergeTasks(newTasks);
                    for (const t of newTasks) {
                        if (t.status === 'generating') startPolling(t.id);
                    }
                }
            } catch { /* restore failed */ }
            finally { setIsRestoringTasks(false); }
        };
        restoreTasks();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // 发起新生成
    const handleGenerate = useCallback(async () => {
        if (!prompt.trim() && uploadedImages.length === 0) return;
        const taskId = `gen_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        addTask({
            id: taskId, status: 'generating', imageUrl: '', prompt: prompt.trim(),
            modelId: selectedModel.id, timestamp: Date.now(), aspectRatio, estimatedSeconds: null,
        });
        doGenerate(taskId, prompt.trim(), selectedModel.id, aspectRatio);
    }, [prompt, uploadedImages, selectedModel, aspectRatio, doGenerate, addTask]);

    // 重试（同参数）
    const handleRetry = useCallback((result: Task) => {
        const newId = `gen_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        removeTask(result.id);
        addTask({
            id: newId, status: 'generating', imageUrl: '', prompt: result.prompt,
            modelId: result.modelId, timestamp: Date.now(), aspectRatio: result.aspectRatio,
            estimatedSeconds: null, refImages: result.refImages,
        });
        doGenerate(newId, result.prompt, result.modelId, result.aspectRatio, result.refImages);
    }, [doGenerate, removeTask, addTask]);

    // 修改提示词后重试
    const handleRetryWithPrompt = useCallback((result: Task, newPrompt: string) => {
        const newId = `gen_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        removeTask(result.id);
        addTask({
            id: newId, status: 'generating', imageUrl: '', prompt: newPrompt,
            modelId: result.modelId, timestamp: Date.now(), aspectRatio: result.aspectRatio,
            estimatedSeconds: null, refImages: result.refImages,
        });
        doGenerate(newId, newPrompt, result.modelId, result.aspectRatio, result.refImages);
    }, [doGenerate, removeTask, addTask]);

    // 删除结果
    const handleDeleteResult = useCallback((id: string) => {
        removeTask(id);
        if (viewingResult?.id === id) setViewingResult(null);
    }, [viewingResult, removeTask]);

    // 快捷键：Ctrl+Enter 生成
    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            handleGenerate();
        }
    }, [handleGenerate]);

    // 全局回车拦截
    useEffect(() => {
        const handleGlobalKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
                const settings = getAppSettings();
                if (settings.enterBehavior === 'generate') {
                    if (!e.shiftKey) {
                        const target = e.target as HTMLElement;
                        if (target && target.closest('[data-no-enter-intercept="true"]')) {
                            return;
                        }
                        e.preventDefault();
                        e.stopPropagation();
                        handleGenerate();
                    }
                }
            }
        };

        document.addEventListener('keydown', handleGlobalKeyDown, true);
        return () => {
            document.removeEventListener('keydown', handleGlobalKeyDown, true);
        };
    }, [handleGenerate]);

    // 下载结果图
    const handleDownloadResult = useCallback((result: Task) => {
        const link = document.createElement('a');
        link.href = result.imageUrl;
        link.download = `${result.modelId}_${result.timestamp}.png`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }, []);

    // 复制图片到剪贴板
    const handleCopyResult = useCallback(async (result: Task) => {
        try {
            const response = await fetch(result.imageUrl);
            const blob = await response.blob();
            await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
            setToast({ type: 'success', message: '已复制到剪贴板' });
        } catch {
            setToast({ type: 'error', message: '复制失败' });
        }
    }, []);

    // 当前比例信息
    const currentRatio = ASPECT_RATIOS.find((r) => r.value === aspectRatio) || ASPECT_RATIOS[0];

    return (
        <div className="flex flex-col h-full bg-nai-bg text-white overflow-hidden rounded-2xl">
            {/* ===== 顶部栏 ===== */}
            <header className="flex-shrink-0 flex items-center gap-3 px-4 py-2.5 border-b border-white/5 bg-nai-panel/80">
                <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-nai-accent/30 to-amber-500/20 flex items-center justify-center">
                        <Sparkles className="w-3.5 h-3.5 text-nai-accent" />
                    </div>
                    <h1 className="text-sm font-semibold tracking-tight">图像编辑</h1>
                </div>

                {/* 生成历史数量 */}
                {tasks.length > 0 && (
                    <div className="text-xs text-gray-500">
                        {tasks.length} 张
                    </div>
                )}

                {onBack && (
                    <button
                        onClick={onBack}
                        className="ml-auto p-1.5 rounded-lg hover:bg-white/10 text-gray-500 hover:text-white transition-all"
                        title="关闭"
                    >
                        <X className="w-4 h-4" />
                    </button>
                )}
            </header>

            {/* ===== 主内容区 ===== */}
            <div className="flex-1 flex overflow-hidden">
                {/* ---- 左面板：控制区 ---- */}
                <div className="w-[280px] flex-shrink-0 flex flex-col border-r border-white/5 bg-nai-panel/30">
                    <div className="flex-1 overflow-y-auto p-3 space-y-2">
                        {/* 模型选择器 */}
                        <div ref={modelSelectorRef} className="relative">
                            <label className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-1.5 block">模型</label>
                            <button
                                onClick={() => setIsModelSelectorOpen(!isModelSelectorOpen)}
                                className={`w-full flex items-center gap-3 p-2.5 rounded-xl border-none transition-all duration-200 ${isModelSelectorOpen
                                    ? 'bg-nai-accent/[0.08]'
                                    : 'bg-white/[0.02] hover:bg-white/[0.04]'
                                    }`}
                            >
                                <div className="w-9 h-9 rounded-lg flex items-center justify-center text-lg bg-nai-accent/[0.08]">
                                    {selectedModel.icon}
                                </div>
                                <div className="flex-1 text-left min-w-0">
                                    <div className="text-[13px] font-medium text-white/90">
                                        {selectedModel.name}
                                        {selectedModel.tag && (
                                            <span className={`ml-1.5 text-[9px] px-1.5 py-0.5 rounded font-normal ${selectedModel.tagColor === 'red' ? 'bg-red-500/20 text-red-400' : 'bg-emerald-500/20 text-emerald-400'}`}>{selectedModel.tag}</span>
                                        )}
                                    </div>
                                    <div className="text-[11px] text-gray-500 truncate">{selectedModel.description} · {selectedModel.resolution}</div>
                                    <ModelStats strength={selectedModel.strength} speed={selectedModel.speed} />
                                </div>
                                <ChevronDown className={`w-3.5 h-3.5 text-gray-600 transition-transform duration-200 ${isModelSelectorOpen ? 'rotate-180' : ''}`} />
                            </button>

                            {/* 模型下拉菜单 */}
                            {isModelSelectorOpen && (
                                <div className="absolute top-full left-0 right-0 mt-1 z-50 bg-nai-panel/98 backdrop-blur-xl rounded-xl shadow-2xl shadow-black/60 overflow-hidden animate-fade-in py-1 max-h-[280px] overflow-y-auto">
                                    {MODELS.map((model) => {
                                        const isSelected = model.id === selectedModel.id;
                                        return (
                                            <button
                                                key={model.id}
                                                onClick={() => {
                                                    setSelectedModel(model);
                                                    setIsModelSelectorOpen(false);
                                                }}
                                                className={`w-full flex items-center gap-3 px-3 py-2.5 transition-all relative ${isSelected
                                                    ? 'bg-nai-accent/[0.08]'
                                                    : 'hover:bg-white/[0.03]'
                                                    }`}
                                            >
                                                {/* 左侧选中指示条 */}
                                                {isSelected && (
                                                    <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-r-full bg-nai-accent" />
                                                )}
                                                <div className="w-8 h-8 rounded-lg flex items-center justify-center text-base bg-nai-accent/[0.08]">
                                                    {model.icon}
                                                </div>
                                                <div className="flex-1 text-left min-w-0">
                                                    <div className="text-[13px] font-medium text-white/85">
                                                        {model.name}
                                                        {model.tag && (
                                                            <span className={`ml-1.5 text-[9px] px-1.5 py-0.5 rounded font-normal ${model.tagColor === 'red' ? 'bg-red-500/20 text-red-400' : 'bg-emerald-500/20 text-emerald-400'}`}>{model.tag}</span>
                                                        )}
                                                    </div>
                                                    <div className="text-[10px] text-gray-500">{model.description} · {model.resolution}</div>
                                                    <ModelStats strength={model.strength} speed={model.speed} />
                                                </div>
                                                {isSelected && (
                                                    <div className="w-4 h-4 rounded-full bg-nai-accent flex items-center justify-center flex-shrink-0">
                                                        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2.5 5L4.5 7L7.5 3.5" stroke="black" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                                                    </div>
                                                )}
                                            </button>
                                        );
                                    })}
                                </div>
                            )}
                        </div>

                        {/* 比例选择器 - 下拉 */}
                        <div ref={ratioSelectorRef} className="relative">
                            <label className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-1.5 block">比例</label>
                            <button
                                onClick={() => setIsRatioSelectorOpen(!isRatioSelectorOpen)}
                                className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl border-none transition-all ${isRatioSelectorOpen
                                    ? 'bg-nai-accent/[0.08]'
                                    : 'bg-white/[0.02] hover:bg-white/[0.04]'
                                    }`}
                            >
                                <RatioIcon w={currentRatio.w} h={currentRatio.h} isAuto={currentRatio.value === 'auto'} active={false} />
                                <span className="text-sm text-white/80">{currentRatio.label}</span>
                                <ChevronDown className={`w-3.5 h-3.5 text-gray-600 ml-auto transition-transform duration-200 ${isRatioSelectorOpen ? 'rotate-180' : ''}`} />
                            </button>

                            {isRatioSelectorOpen && (
                                <div className="absolute top-full left-0 right-0 mt-1 z-50 bg-nai-panel/98 backdrop-blur-xl rounded-xl shadow-2xl shadow-black/60 overflow-hidden animate-fade-in py-1 max-h-[200px] overflow-y-auto">
                                    {ASPECT_RATIOS.map((ratio) => {
                                        const isActive = ratio.value === aspectRatio;
                                        return (
                                            <button
                                                key={ratio.value}
                                                onClick={() => {
                                                    setAspectRatio(ratio.value);
                                                    setIsRatioSelectorOpen(false);
                                                }}
                                                className={`w-full flex items-center gap-2.5 px-3 py-2 transition-all relative ${isActive
                                                    ? 'bg-white/[0.04]'
                                                    : 'hover:bg-white/[0.03]'
                                                    }`}
                                            >
                                                {isActive && (
                                                    <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-4 rounded-r-full bg-nai-accent" />
                                                )}
                                                <RatioIcon w={ratio.w} h={ratio.h} isAuto={ratio.value === 'auto'} active={isActive} />
                                                <span className={`text-sm ${isActive ? 'text-nai-accent' : 'text-white/70'}`}>{ratio.label}</span>
                                            </button>
                                        );
                                    })}
                                </div>
                            )}
                        </div>

                        {/* 提示词输入 */}
                        <div>
                            <label className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-1.5 block">提示词</label>
                            <div className="relative">
                                <textarea
                                    ref={promptRef}
                                    value={prompt}
                                    onChange={(e) => setPrompt(e.target.value)}
                                    onKeyDown={handleKeyDown}
                                    placeholder="描述你想要生成的图片..."
                                    className="w-full bg-white/[0.02] border-none rounded-xl px-3.5 py-3 text-sm text-white/90 placeholder-gray-600 resize-none outline-none focus:bg-white/[0.04] transition-all duration-200"
                                    style={{ minHeight: '100px' }}
                                />
                                <div className="absolute bottom-2.5 right-3 text-[10px] text-gray-600/60">
                                    Ctrl+Enter
                                </div>
                            </div>
                        </div>

                        {/* 参考图上传 */}
                        {selectedModel.supportImg2Img && (
                            <div className={`rounded-lg p-2 -m-2 transition-all duration-500 ${refImageHighlight ? 'ring-1 ring-nai-accent/50 bg-nai-accent/5' : ''}`}>
                                <div className="flex items-center justify-between mb-1.5">
                                    <label className="text-xs font-medium text-gray-400 uppercase tracking-wider">
                                        参考图
                                        <span className="text-gray-600 ml-1 normal-case">({uploadedImages.length}/{selectedModel.maxImages})</span>
                                    </label>
                                    {initialImageUrl && uploadedImages.length < selectedModel.maxImages && (
                                        <button
                                            onClick={handleAddInitialImage}
                                            className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-nai-accent/[0.08] hover:bg-nai-accent/[0.15] text-nai-accent/70 hover:text-nai-accent text-[10px] transition-all duration-200"
                                            title="使用当前图片作为参考图"
                                        >
                                            <ImageIcon className="w-3 h-3" />
                                            使用生成图片
                                        </button>
                                    )}
                                </div>
                                <div
                                    className="grid grid-cols-3 gap-2"
                                    onDrop={handleDrop}
                                    onDragOver={handleDragOver}
                                >
                                    {/* 已上传的图片 */}
                                    {uploadedImages.map((img) => (
                                        <div key={img.id} className="group relative aspect-square rounded-lg overflow-hidden border border-white/6 bg-white/[0.02]">
                                            <img
                                                src={img.previewUrl}
                                                alt="参考图"
                                                className="w-full h-full object-cover"
                                            />
                                            <button
                                                onClick={() => handleRemoveImage(img.id)}
                                                className="absolute top-1 right-1 p-1 bg-black/60 rounded-full opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-500/80"
                                            >
                                                <X className="w-3 h-3" />
                                            </button>
                                            <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/60 to-transparent px-1.5 py-1">
                                                <span className="text-[9px] text-gray-300">{img.width}×{img.height}</span>
                                            </div>
                                        </div>
                                    ))}

                                    {/* 添加按钮 - 正方形图片卡片样式 */}
                                    {uploadedImages.length < selectedModel.maxImages && (
                                        <button
                                            onClick={() => fileInputRef.current?.click()}
                                            className="aspect-square rounded-lg border-none bg-white/[0.03] hover:bg-white/[0.06] flex flex-col items-center justify-center gap-1.5 text-gray-600 hover:text-gray-400 transition-all duration-200"
                                        >
                                            <Plus className="w-5 h-5" />
                                        </button>
                                    )}

                                    <input
                                        ref={fileInputRef}
                                        type="file"
                                        accept="image/*"
                                        multiple
                                        className="hidden"
                                        onChange={(e) => {
                                            if (e.target.files) handleUploadImage(e.target.files);
                                            e.target.value = '';
                                        }}
                                    />
                                </div>
                            </div>
                        )}
                    </div>

                    {/* 额度 + 生成按钮 */}
                    <div className="flex-shrink-0 p-3 border-t border-white/5">
                        {quotaInfo && quotaInfo.daily_limit > 0 && (
                            <div className="flex items-center justify-between text-[11px] mb-2 px-1">
                                <span className="text-gray-600">今日额度</span>
                                <div className="flex items-center gap-1.5">
                                    <span className={`font-medium tabular-nums ${quotaInfo.total_available <= 0 ? 'text-red-400' :
                                        quotaInfo.total_available <= 5 ? 'text-amber-400' :
                                            'text-gray-400'
                                        }`}>
                                        {quotaInfo.daily_balance}/{quotaInfo.daily_limit}
                                    </span>
                                    {quotaInfo.extra_balance > 0 && (
                                        <span className="text-emerald-500/70">+{quotaInfo.extra_balance}</span>
                                    )}
                                </div>
                            </div>
                        )}
                        <button
                            onClick={handleGenerate}
                            disabled={!prompt.trim() && uploadedImages.length === 0}
                            className={`w-full flex items-center justify-center gap-2 py-3 rounded-xl font-medium text-sm transition-all duration-200 ${!prompt.trim() && uploadedImages.length === 0
                                ? 'bg-white/5 text-gray-600 cursor-not-allowed'
                                : 'bg-nai-accent hover:brightness-110 text-black'
                                }`}
                            style={(prompt.trim() || uploadedImages.length > 0) ? { boxShadow: '0 8px 32px rgba(252, 237, 164, 0.15)' } : undefined}
                        >
                            <Sparkles className="w-4 h-4" />
                            生成
                        </button>
                    </div>
                </div>

                {/* ---- 右面板：画布/结果区 ---- */}
                <div className="flex-1 flex flex-col overflow-hidden relative">
                    {/* 查看单张大图 */}
                    {viewingResult ? (
                        <div className="flex-1 flex flex-col bg-nai-bg">
                            {/* 大图顶栏 */}
                            <div className="flex-shrink-0 flex items-center gap-2 px-4 py-2.5 border-b border-white/5">
                                <button
                                    onClick={() => { setViewingResult(null); setImageScale(1); }}
                                    className="p-2 rounded-lg hover:bg-white/5 text-gray-400 hover:text-white transition-all"
                                >
                                    <X className="w-4 h-4" />
                                </button>
                                <div className="flex-1 text-xs text-gray-500 truncate">
                                    {MODELS.find((m) => m.id === viewingResult.modelId)?.name} · {viewingResult.prompt.slice(0, 50)}
                                </div>
                                <div className="flex items-center gap-1">
                                    <button
                                        onClick={() => setImageScale((s) => Math.max(0.25, s / 1.5))}
                                        className="p-1.5 rounded-lg hover:bg-white/5 text-gray-400 hover:text-white transition-all"
                                        title="缩小"
                                    >
                                        <ZoomOut className="w-4 h-4" />
                                    </button>
                                    <button
                                        onClick={() => { setImageScale(1); }}
                                        className="px-2 py-1 rounded-lg hover:bg-white/5 text-[11px] text-gray-400 hover:text-white transition-all tabular-nums"
                                        title="重置"
                                    >
                                        {Math.round(imageScale * 100)}%
                                    </button>
                                    <button
                                        onClick={() => setImageScale((s) => Math.min(8, s * 1.5))}
                                        className="p-1.5 rounded-lg hover:bg-white/5 text-gray-400 hover:text-white transition-all"
                                        title="放大"
                                    >
                                        <ZoomIn className="w-4 h-4" />
                                    </button>
                                    <span className="w-px h-4 bg-white/10 mx-1" />
                                    <button
                                        onClick={() => handleCopyResult(viewingResult)}
                                        className="p-1.5 rounded-lg hover:bg-white/5 text-gray-400 hover:text-white transition-all"
                                        title="复制"
                                    >
                                        <Copy className="w-4 h-4" />
                                    </button>
                                    <button
                                        onClick={() => handleDownloadResult(viewingResult)}
                                        className="p-1.5 rounded-lg hover:bg-white/5 text-gray-400 hover:text-white transition-all"
                                        title="下载"
                                    >
                                        <Download className="w-4 h-4" />
                                    </button>
                                    <button
                                        onClick={() => { handleRetry(viewingResult); setViewingResult(null); setImageScale(1); }}
                                        className="p-1.5 rounded-lg hover:bg-white/5 text-gray-400 hover:text-white transition-all"
                                        title="重试"
                                    >
                                        <RotateCcw className="w-4 h-4" />
                                    </button>
                                    <span className="w-px h-4 bg-white/10 mx-0.5" />
                                    <button
                                        onClick={() => { setPrompt(viewingResult.prompt); setViewingResult(null); setImageScale(1); }}
                                        className="px-2 py-1 rounded-lg hover:bg-white/5 text-[11px] text-gray-400 hover:text-white transition-all whitespace-nowrap"
                                        title="使用此提示词"
                                    >
                                        使用提示词
                                    </button>
                                </div>
                            </div>
                            {/* 大图画布 */}
                            <div className="flex-1 flex items-center justify-center overflow-auto bg-[#060810]">
                                <img
                                    src={viewingResult.imageUrl}
                                    alt=""
                                    className="shadow-2xl"
                                    style={{
                                        transform: `scale(${imageScale})`,
                                        transition: 'transform 0.15s ease-out',
                                        maxWidth: imageScale <= 1 ? '90%' : undefined,
                                        maxHeight: imageScale <= 1 ? '90%' : undefined,
                                    }}
                                />
                            </div>
                        </div>
                    ) : isRestoringTasks ? (
                        /* 加载动画 */
                        <div className="flex-1 flex flex-col items-center justify-center">
                            <div className="relative w-12 h-12 mb-3">
                                <div className="absolute inset-0 rounded-full border-2 border-white/10" />
                                <div className="absolute inset-0 rounded-full border-2 border-t-nai-accent border-r-transparent border-b-transparent border-l-transparent animate-spin" />
                            </div>
                            <div className="text-sm text-gray-500">加载中...</div>
                        </div>
                    ) : tasks.length > 0 ? (
                        /* 结果图库网格 */
                        <div className="flex-1 overflow-y-auto p-4">
                            <div className="grid grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-3">
                                {tasks.map((result) => {
                                    const model = MODELS.find((m) => m.id === result.modelId);
                                    const isLoading = result.status === 'generating';
                                    const isError = result.status === 'error';
                                    const isSuccess = result.status === 'success';

                                    return (
                                        <div
                                            key={result.id}
                                            className={`group relative aspect-square rounded-xl overflow-hidden border transition-all duration-200 ${isLoading ? 'border-white/10 bg-white/[0.02]' :
                                                isError ? 'border-red-500/20 bg-red-950/10' :
                                                    'border-white/5 hover:border-white/15 bg-white/[0.02] cursor-pointer hover:shadow-lg hover:shadow-black/30'
                                                }`}
                                            onClick={() => isSuccess && setViewingResult(result)}
                                        >
                                            {/* === 生成中 === */}
                                            {isLoading && (
                                                <div className="absolute inset-0 flex flex-col items-center justify-center z-10 gap-2">
                                                    {/* 旋转 spinner */}
                                                    <div className="relative w-12 h-12">
                                                        <div className="absolute inset-0 rounded-full border-2 border-white/10" />
                                                        <div className="absolute inset-0 rounded-full border-2 border-t-nai-accent border-r-transparent border-b-transparent border-l-transparent animate-spin" />
                                                        <div className="absolute inset-0 flex items-center justify-center">
                                                            <span className="text-base">{model?.icon}</span>
                                                        </div>
                                                    </div>
                                                    {/* 预估时间 */}
                                                    <div className="text-xs text-gray-500">
                                                        {result.estimatedSeconds ? `预计 ~${result.estimatedSeconds}s` : '生成中...'}
                                                    </div>
                                                </div>
                                            )}

                                            {/* === 失败 === */}
                                            {isError && (
                                                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 z-10 px-4">
                                                    <AlertCircle className="w-8 h-8 text-red-400/60" />
                                                    <div className="group/err relative text-xs text-red-400/80 text-center truncate max-w-full cursor-default">
                                                        生成失败: {extractErrorSummary(result.error)}
                                                        {/* 悬浮完整错误 */}
                                                        <div className="hidden group-hover/err:block absolute left-1/2 -translate-x-1/2 top-full mt-2 w-64 max-h-40 overflow-y-auto p-3 rounded-xl bg-gray-900/95 backdrop-blur-xl border border-white/10 shadow-2xl text-[11px] text-red-300/90 text-left whitespace-pre-wrap break-all z-50 leading-relaxed">
                                                            {result.error}
                                                        </div>
                                                    </div>
                                                    <div className="flex items-center gap-2 mt-1">
                                                        <button
                                                            onClick={(e) => { e.stopPropagation(); handleRetry(result); }}
                                                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-xs text-gray-300 transition-all"
                                                        >
                                                            <RotateCcw className="w-3.5 h-3.5" />
                                                            重试
                                                        </button>
                                                        <button
                                                            onClick={(e) => { e.stopPropagation(); handleDeleteResult(result.id); }}
                                                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-red-500/20 text-xs text-gray-500 hover:text-red-400 transition-all"
                                                        >
                                                            <Trash2 className="w-3.5 h-3.5" />
                                                        </button>
                                                    </div>
                                                </div>
                                            )}

                                            {/* === 成功的图片 === */}
                                            {isSuccess && (
                                                <img src={result.imageUrl} alt="" className="w-full h-full object-cover" />
                                            )}

                                            {/* 底部信息（始终显示模型） */}
                                            <div className={`absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/60 to-transparent pt-12 pb-2.5 px-3 transition-opacity duration-200 ${isSuccess ? 'opacity-0 group-hover:opacity-100' : 'opacity-100'
                                                }`}>
                                                <div className="flex items-center gap-1 mb-0.5">
                                                    <span className="text-xs drop-shadow-lg">{model?.icon}</span>
                                                    <span className="text-[11px] font-medium text-white drop-shadow-lg">{model?.name}</span>
                                                </div>
                                                <div className="text-[10px] text-gray-300 truncate drop-shadow-lg">{result.prompt}</div>
                                            </div>


                                            {/* 操作按钮（成功时 hover 显示） */}
                                            {isSuccess && (
                                                <div className="absolute top-2 right-2 flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                                                    <button
                                                        onClick={(e) => { e.stopPropagation(); handleRetry(result); }}
                                                        className="p-2 rounded-lg bg-black/50 backdrop-blur-sm hover:bg-black/70 text-white/80 hover:text-white transition-all"
                                                        title="重试"
                                                    >
                                                        <RotateCcw className="w-4 h-4" />
                                                    </button>
                                                    <button
                                                        onClick={(e) => { e.stopPropagation(); handleDownloadResult(result); }}
                                                        className="p-2 rounded-lg bg-black/50 backdrop-blur-sm hover:bg-black/70 text-white/80 hover:text-white transition-all"
                                                        title="下载"
                                                    >
                                                        <Download className="w-4 h-4" />
                                                    </button>
                                                    <button
                                                        onClick={(e) => { e.stopPropagation(); handleDeleteResult(result.id); }}
                                                        className="p-2 rounded-lg bg-black/50 backdrop-blur-sm hover:bg-red-500/30 text-white/60 hover:text-red-400 transition-all"
                                                        title="删除"
                                                    >
                                                        <Trash2 className="w-4 h-4" />
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    ) : (
                        /* 空状态 */
                        <div className="flex-1 flex flex-col items-center justify-center text-center">
                            <div className="w-16 h-16 rounded-2xl bg-white/[0.03] border border-white/5 flex items-center justify-center mb-4">
                                <ImageIcon className="w-7 h-7 text-gray-600" />
                            </div>
                            <h3 className="text-sm font-medium text-gray-400">选择模型，输入描述</h3>
                        </div>
                    )}
                </div>
            </div>

            {/* ===== Toast 提示 ===== */}
            {
                toast && (
                    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] animate-fade-in">
                        <div className={`flex items-center gap-2 px-4 py-2.5 rounded-xl shadow-2xl backdrop-blur-xl border ${toast.type === 'success'
                            ? 'bg-green-900/80 border-green-500/30 text-green-300'
                            : 'bg-red-900/80 border-red-500/30 text-red-300'
                            }`}>
                            {toast.type === 'success' ? (
                                <CheckCircle2 className="w-4 h-4" />
                            ) : (
                                <AlertCircle className="w-4 h-4" />
                            )}
                            <span className="text-sm">{toast.message}</span>
                        </div>
                    </div>
                )
            }
        </div >
    );
};
