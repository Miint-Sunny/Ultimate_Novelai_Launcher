import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    AlertTriangle,
    Check,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    CircleHelp,
    Copy,
    Download,
    Eye,
    EyeOff,
    Image as ImageIcon,
    Images,
    KeyRound,
    Layers,
    Loader2,
    Minus,
    Plus,
    RotateCcw,
    Search,
    Server,
    Settings,
    Sparkles,
    Trash2,
    WandSparkles,
    X,
} from 'lucide-react';
import { MODELS, ASPECT_RATIOS, type UploadedImage, type AspectRatio } from './models';
import { generate, fetchQuota, subscribeQuota, retry as retryTask, type QuotaInfo } from './workshopApi';
import { useTaskStore, type Task } from '../../stores/taskStore';
import { getAppSettings } from '../../services/localLibrary';

interface WorkshopInputBarProps {
    isOpen: boolean;
    onClose: () => void;
    initialImageUrl?: string;
}

type ProviderMode = 'server' | 'custom';
type Quality = 'low' | 'medium' | 'high';
type MultiImageLayout = 'horizontal' | 'vertical';

const CUSTOM_PROVIDER_STORAGE = 'workshop_custom_provider_draft';

const defaultCustomProvider = {
    name: 'Custom API',
    baseUrl: '',
    apiKey: '',
    model: 'gpt-image-2',
};

const blue = '#346aea';
const ink = '#1a1a1a';
const muted = '#616161';
const faint = '#919191';
const soft = '#f5f5f5';
const line = 'rgb(0 0 0 / 0.1)';

const QUALITIES: Array<{ id: Quality; label: string }> = [
    { id: 'low', label: '低' },
    { id: 'medium', label: '中' },
    { id: 'high', label: '高' },
];

const QUALITY_CN: Record<string, string> = {
    low: '低',
    medium: '中',
    high: '高',
};

function readCustomProvider() {
    try {
        const raw = localStorage.getItem(CUSTOM_PROVIDER_STORAGE);
        if (!raw) return defaultCustomProvider;
        const provider = { ...defaultCustomProvider, ...JSON.parse(raw), apiKey: '' };
        localStorage.setItem(CUSTOM_PROVIDER_STORAGE, JSON.stringify(provider));
        return provider;
    } catch {
        return defaultCustomProvider;
    }
}

function formatSeconds(seconds: number) {
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function formatTime(ts: number) {
    return new Date(ts).toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });
}

function gcd(a: number, b: number): number {
    while (b) [a, b] = [b, a % b];
    return a || 1;
}

function ratioFromSize(w: number, h: number) {
    const d = gcd(w, h);
    return `${Math.round(w / d)}:${Math.round(h / d)}`;
}

function taskModelLabel(task: Task) {
    return MODELS.find((model) => model.id === task.modelId)?.description || task.modelId;
}

const demoImageA = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 960 720'%3E%3Cdefs%3E%3ClinearGradient id='a' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%23dbeafe'/%3E%3Cstop offset='.55' stop-color='%23ffffff'/%3E%3Cstop offset='1' stop-color='%23fde68a'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='960' height='720' fill='url(%23a)'/%3E%3Ccircle cx='660' cy='230' r='130' fill='%23346aea' opacity='.18'/%3E%3Crect x='190' y='180' width='420' height='360' rx='42' fill='%23fff' opacity='.82'/%3E%3Cpath d='M275 430c90-130 157-95 215-15 38-62 78-82 145 25v55H275z' fill='%23346aea' opacity='.28'/%3E%3Ccircle cx='360' cy='295' r='48' fill='%23f59e0b' opacity='.55'/%3E%3Ctext x='480' y='640' text-anchor='middle' font-family='Arial' font-size='36' fill='%23616161'%3EHistory Preview%3C/text%3E%3C/svg%3E";
const demoImageB = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 720 960'%3E%3Cdefs%3E%3ClinearGradient id='b' x1='0' y1='0' x2='0' y2='1'%3E%3Cstop offset='0' stop-color='%23f5f5f5'/%3E%3Cstop offset='1' stop-color='%23dbeafe'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='720' height='960' fill='url(%23b)'/%3E%3Crect x='150' y='130' width='420' height='650' rx='52' fill='%23fff' opacity='.86'/%3E%3Ccircle cx='360' cy='310' r='92' fill='%23346aea' opacity='.18'/%3E%3Crect x='235' y='455' width='250' height='34' rx='17' fill='%231a1a1a' opacity='.18'/%3E%3Crect x='205' y='525' width='310' height='28' rx='14' fill='%23346aea' opacity='.22'/%3E%3Crect x='255' y='590' width='210' height='28' rx='14' fill='%23f59e0b' opacity='.28'/%3E%3Ctext x='360' y='855' text-anchor='middle' font-family='Arial' font-size='30' fill='%23616161'%3EEdit Result%3C/text%3E%3C/svg%3E";

const demoTasks: Task[] = [
    {
        id: 'demo_success_landscape',
        status: 'success',
        imageUrl: demoImageA,
        modelId: 'gpt-image',
        prompt: '示例：柔和自然光下的室内插画，干净构图，细腻色彩',
        timestamp: Date.now() - 1000 * 60 * 8,
        aspectRatio: '4:3',
        estimatedSeconds: 34,
    },
    {
        id: 'demo_success_portrait',
        status: 'success',
        imageUrl: demoImageB,
        modelId: 'gpt-image-4k',
        prompt: '示例：基于参考图进行角色服装和背景重绘，保持主体轮廓',
        timestamp: Date.now() - 1000 * 60 * 21,
        aspectRatio: '3:4',
        estimatedSeconds: 58,
        refImages: [demoImageA],
    },
    {
        id: 'demo_generating',
        status: 'generating',
        imageUrl: '',
        modelId: 'gpt-image',
        prompt: '示例：排队中的生成任务会显示进度条和预计耗时',
        timestamp: Date.now() - 1000 * 12,
        aspectRatio: 'auto',
        estimatedSeconds: 45,
    },
    {
        id: 'demo_error',
        status: 'error',
        imageUrl: '',
        modelId: 'gpt-image',
        prompt: '示例：失败任务会显示错误信息和重试入口',
        timestamp: Date.now() - 1000 * 60 * 35,
        aspectRatio: '1:1',
        estimatedSeconds: null,
        error: '示例错误：上游服务暂时不可用',
    },
];

function isDemoTask(task: Task) {
    return task.id.startsWith('demo_');
}

const RatioIcon: React.FC<{ w: number; h: number; isAuto?: boolean; active?: boolean }> = ({ w, h, isAuto, active }) => {
    const maxDim = 15;
    const scale = maxDim / Math.max(w, h);
    const rw = Math.max(5, Math.round(w * scale));
    const rh = Math.max(5, Math.round(h * scale));
    const color = active ? ink : faint;

    if (isAuto) {
        return (
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
                <rect x="3" y="3" width="12" height="12" rx="2.2" stroke={color} strokeWidth="1.4" strokeDasharray="2.4 1.8" />
                <path d="M6.4 11.6L9 6.3L11.6 11.6M7.4 9.9H10.6" stroke={color} strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
        );
    }

    return (
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
            <rect
                x={(18 - rw) / 2}
                y={(18 - rh) / 2}
                width={rw}
                height={rh}
                rx="2"
                stroke={color}
                strokeWidth="1.4"
                fill={active ? 'rgb(0 0 0 / 0.04)' : 'none'}
            />
        </svg>
    );
};

const CardFooter: React.FC<{
    task: Task;
    providerName: string;
    quality: Quality;
    imageCount?: number;
    error?: string;
    onRetry?: () => void;
    children?: React.ReactNode;
}> = ({ task, providerName, quality, imageCount, error, onRetry, children }) => (
    <div className="flex flex-col gap-1.5 rounded-t-xl p-2.5" style={{ background: '#fafafa' }}>
        {task.prompt && <p className="line-clamp-1 text-xs font-medium" style={{ color: ink }}>{task.prompt}</p>}
        {children}
        <div className="flex flex-wrap items-center gap-2">
            {task.aspectRatio && task.aspectRatio !== 'auto' && (
                <span className="rounded-full px-2 py-0.5 text-[10px] font-medium" style={{ background: 'rgb(0 0 0 / 0.04)', color: muted }}>{task.aspectRatio}</span>
            )}
            <span className="rounded-full px-2 py-0.5 text-[10px] font-medium" style={{ background: 'rgb(0 0 0 / 0.04)', color: muted }}>{taskModelLabel(task)}</span>
            <span className="text-[10px]" style={{ color: faint }}>{providerName}</span>
            <span className="rounded-full px-2 py-0.5 text-[10px] font-medium" style={{ background: task.refImages?.length ? 'rgb(37 99 235 / 0.08)' : 'rgb(22 163 74 / 0.08)', color: task.refImages?.length ? '#2563eb' : '#16a34a' }}>{task.refImages?.length ? '图生图' : '文生图'}</span>
            <span className="rounded-full px-2 py-0.5 text-[10px] font-medium" style={{ background: 'rgb(0 0 0 / 0.04)', color: muted }}>质量：{QUALITY_CN[quality]}</span>
            {imageCount != null && imageCount > 0 && (
                <span className="rounded-full px-2 py-0.5 text-[10px] font-medium" style={{ background: 'rgb(0 0 0 / 0.04)', color: muted }}>{imageCount} 张</span>
            )}
            {error && onRetry && (
                <button onClick={(e) => { e.stopPropagation(); onRetry(); }} className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-2 py-0.5 text-[10px] font-medium transition-colors hover:opacity-90" style={{ background: '#d3482b', color: '#fff' }}>
                    <RotateCcw className="h-3 w-3" />重试
                </button>
            )}
        </div>
        <div className="flex items-center justify-between">
            <span className="text-[10px]" style={{ color: faint }}>{task.estimatedSeconds ? `约 ${formatSeconds(task.estimatedSeconds)}` : ''}</span>
            <span className="text-[10px]" style={{ color: '#bfbfbf' }}>{formatTime(task.timestamp)}</span>
        </div>
    </div>
);

const SettingsModal: React.FC<{
    providerMode: ProviderMode;
    setProviderMode: (mode: ProviderMode) => void;
    customProvider: typeof defaultCustomProvider;
    persistCustomProvider: (next: typeof defaultCustomProvider) => void;
    showKey: boolean;
    setShowKey: (value: boolean) => void;
    maxHistoryItems: number;
    setMaxHistoryItems: (value: number) => void;
    multiImageLayout: MultiImageLayout;
    setMultiImageLayout: (value: MultiImageLayout) => void;
    historyCount: number;
    localStorageUsage: { usedBytes: number; quotaBytes: number };
    onClose: () => void;
}> = ({
    providerMode,
    setProviderMode,
    customProvider,
    persistCustomProvider,
    showKey,
    setShowKey,
    maxHistoryItems,
    setMaxHistoryItems,
    multiImageLayout,
    setMultiImageLayout,
    historyCount,
    localStorageUsage,
    onClose,
}) => {
    useEffect(() => {
        const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [onClose]);

    return (
        <div className="fixed inset-0 z-[80] flex items-center justify-center px-4" style={{ background: 'rgba(0,0,0,0.4)' }} onClick={onClose}>
            <div className="flex w-full max-w-md flex-col overflow-hidden rounded-2xl shadow-2xl" style={{ background: '#fff', maxHeight: '90vh' }} onClick={(e) => e.stopPropagation()}>
                <div className="flex shrink-0 items-center gap-3 border-b px-5 py-4" style={{ borderColor: line }}>
                    <div className="flex h-9 w-9 items-center justify-center rounded-lg" style={{ background: 'rgb(0 0 0 / 0.04)' }}>
                        <Settings className="h-4 w-4" style={{ color: muted }} />
                    </div>
                    <div>
                        <h2 className="text-base font-semibold" style={{ color: ink }}>API 设置</h2>
                        <p className="rounded-md px-2 py-1 text-xs" style={{ color: muted, background: 'transparent' }}>
                            自定义通道迁移到 sidecar 后再开放
                        </p>
                    </div>
                    <button onClick={onClose} className="ml-auto flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-black/10">
                        <X className="h-4 w-4" style={{ color: muted }} />
                    </button>
                </div>

                <div className="space-y-4 overflow-y-auto p-5">
                    <button className="flex w-full items-center gap-2 rounded-xl border px-4 py-3 text-left transition-colors hover:opacity-90" style={{ background: 'rgb(52 106 234 / 0.06)', borderColor: 'rgb(52 106 234 / 0.25)' }}>
                        <CircleHelp className="h-4 w-4 shrink-0" style={{ color: blue }} />
                        <span className="text-[13px] font-semibold" style={{ color: blue }}>使用方法</span>
                        <span className="ml-auto text-[11px]" style={{ color: blue, opacity: 0.6 }}>服务器 / 自定义 Key →</span>
                    </button>

                    <div className="space-y-2">
                        <span className="text-xs font-semibold" style={{ color: muted }}>供应商</span>
                        <div className="flex flex-wrap gap-2">
                            <button onClick={() => setProviderMode('server')} className="rounded-lg px-3 py-1.5 text-xs font-medium transition-colors" style={{ background: providerMode === 'server' ? blue : 'rgb(0 0 0 / 0.04)', color: providerMode === 'server' ? '#fff' : muted }}>服务器提供</button>
                            <button disabled className="rounded-lg px-3 py-1.5 text-xs font-medium opacity-50" style={{ background: 'rgb(0 0 0 / 0.04)', color: muted }}>自定义</button>
                        </div>
                    </div>

                    <div className="rounded-xl border px-4 py-3" style={{ borderColor: 'rgb(0 0 0 / 0.1)', background: 'rgb(0 0 0 / 0.03)' }}>
                        <div className="flex items-start gap-2">
                            <KeyRound className="mt-0.5 h-4 w-4 shrink-0" style={{ color: muted }} />
                            <div>
                                <div className="text-sm font-semibold" style={{ color: ink }}>自定义 API Key 已禁用</div>
                                <p className="mt-1 text-xs leading-relaxed" style={{ color: muted }}>
                                    后续会改为 sidecar 安全配置；当前不会在浏览器保存 provider key。
                                </p>
                            </div>
                        </div>
                    </div>

                    <label className="block">
                        <span className="mb-2 block text-xs font-semibold" style={{ color: muted }}>最大历史条数</span>
                        <div className="flex items-center gap-2">
                            <input value={maxHistoryItems || ''} onChange={(e) => setMaxHistoryItems(Math.min(500, Number(e.target.value) || 0))} onBlur={() => setMaxHistoryItems(Math.max(10, maxHistoryItems))} type="number" min={10} max={500} className="h-10 w-28 rounded-lg border px-3 text-sm outline-none transition-colors focus:ring-2 focus:ring-[#346aea]/20" style={{ background: '#fff', borderColor: 'rgb(0 0 0 / 0.15)', color: ink }} />
                            <span className="text-xs" style={{ color: faint }}>当前 {historyCount} 条 · 占用 {(localStorageUsage.usedBytes / 1024).toFixed(1)} KB / {(localStorageUsage.quotaBytes / 1024 / 1024).toFixed(1)} MB</span>
                        </div>
                    </label>

                    <div>
                        <span className="mb-2 block text-xs font-semibold" style={{ color: muted }}>多图卡片布局</span>
                        <div className="relative flex gap-1 overflow-hidden rounded-lg p-0.5" style={{ background: 'rgb(0 0 0 / 0.04)' }}>
                            <div className="absolute inset-y-0.5 rounded-md transition-all duration-300 ease-out" style={{ left: multiImageLayout === 'horizontal' ? '2px' : 'calc(50% + 2px)', width: 'calc(50% - 4px)', background: ink }} />
                            <button onClick={() => setMultiImageLayout('horizontal')} className="relative h-8 flex-1 rounded-md text-xs font-medium transition-colors" style={{ color: multiImageLayout === 'horizontal' ? '#fff' : muted }}>横向</button>
                            <button onClick={() => setMultiImageLayout('vertical')} className="relative h-8 flex-1 rounded-md text-xs font-medium transition-colors" style={{ color: multiImageLayout === 'vertical' ? '#fff' : muted }}>纵向</button>
                        </div>
                    </div>
                </div>

                <div className="flex shrink-0 items-center justify-end gap-2 border-t px-5 py-4" style={{ borderColor: line }}>
                    <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm transition-colors hover:bg-black/10" style={{ background: 'rgb(0 0 0 / 0.04)', color: muted }}>取消</button>
                    <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm font-medium transition-colors" style={{ background: blue, color: '#fff' }}>保存</button>
                </div>
            </div>
        </div>
    );
};

export const WorkshopInputBar: React.FC<WorkshopInputBarProps> = ({ isOpen, onClose, initialImageUrl }) => {
    const [selectedModel, setSelectedModel] = useState(MODELS[0]);
    const [prompt, setPrompt] = useState('');
    const [aspectRatio, setAspectRatio] = useState<string>('auto');
    const [quality, setQuality] = useState<Quality>('medium');
    const [count, setCount] = useState(1);
    const [providerMode, setProviderMode] = useState<ProviderMode>('server');
    const [customProvider, setCustomProvider] = useState(defaultCustomProvider);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [showKey, setShowKey] = useState(false);
    const [maxHistoryItems, setMaxHistoryItems] = useState(300);
    const [multiImageLayout, setMultiImageLayout] = useState<MultiImageLayout>('horizontal');
    const [isRatioOpen, setIsRatioOpen] = useState(false);
    const [isModelOpen, setIsModelOpen] = useState(false);
    const [uploadedImages, setUploadedImages] = useState<UploadedImage[]>([]);
    const [quota, setQuota] = useState<QuotaInfo | null>(null);
    const [isDraggingRefs, setIsDraggingRefs] = useState(false);
    const [dragRefIndex, setDragRefIndex] = useState<number | null>(null);
    const [previewTask, setPreviewTask] = useState<Task | null>(null);
    const [previewRefUrl, setPreviewRefUrl] = useState<string | null>(null);
    const [previewImageSize, setPreviewImageSize] = useState<{ w: number; h: number } | null>(null);
    const [searchQuery, setSearchQuery] = useState('');
    const [toast, setToast] = useState('');
    const [copyPromptLabel, setCopyPromptLabel] = useState('');
    const [copyImageLabel, setCopyImageLabel] = useState('');

    const tasks = useTaskStore((s) => s.tasks);
    const removeTask = useTaskStore((s) => s.removeTask);

    const inputRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const ratioRef = useRef<HTMLDivElement>(null);
    const modelRef = useRef<HTMLDivElement>(null);
    const initialImageHandledRef = useRef<string | undefined>(undefined);

    const activeTasks = useMemo(() => tasks.filter((task) => task.status === 'generating'), [tasks]);
    const visibleTasks = useMemo(() => {
        const q = searchQuery.trim().toLowerCase();
        const list = q ? tasks.filter((task) => task.prompt.toLowerCase().includes(q)) : tasks;
        return list.slice(0, maxHistoryItems);
    }, [maxHistoryItems, searchQuery, tasks]);
    const visibleDemoTasks = useMemo(() => {
        const q = searchQuery.trim().toLowerCase();
        return q ? demoTasks.filter((task) => task.prompt.toLowerCase().includes(q)) : demoTasks;
    }, [searchQuery]);
    const displayTasks = visibleTasks.length > 0 ? visibleTasks : visibleDemoTasks;
    const isShowingDemoHistory = visibleTasks.length === 0 && visibleDemoTasks.length > 0;
    const currentRatio: AspectRatio = ASPECT_RATIOS.find((r) => r.value === aspectRatio) || ASPECT_RATIOS[0];
    const primaryPreview = uploadedImages[0];
    const customReady = Boolean(customProvider.baseUrl.trim() && customProvider.apiKey.trim() && customProvider.model.trim());
    const canSubmit = Boolean(prompt.trim() || uploadedImages.length > 0) && (providerMode === 'server' || customReady);
    const providerLabel = providerMode === 'server' ? '服务器提供' : customProvider.name || 'Custom API';
    const localStorageUsage = useMemo(() => {
        let usedBytes = 0;
        try {
            for (let i = 0; i < localStorage.length; i += 1) {
                const key = localStorage.key(i);
                if (!key) continue;
                usedBytes += (key.length + (localStorage.getItem(key) || '').length) * 2;
            }
        } catch {
            usedBytes = 0;
        }
        return { usedBytes, quotaBytes: 5 * 1024 * 1024 };
    }, [tasks.length, customProvider]);

    useEffect(() => {
        if (!isOpen) return;
        setCustomProvider(readCustomProvider());
        fetchQuota();
        return subscribeQuota(setQuota);
    }, [isOpen]);

    useEffect(() => {
        if (isOpen) {
            setTimeout(() => inputRef.current?.focus(), 100);
            return;
        }
        setPrompt('');
        setSettingsOpen(false);
        setSearchQuery('');
        setPreviewTask(null);
        setPreviewImageSize(null);
        setUploadedImages((prev) => {
            prev.forEach((img) => URL.revokeObjectURL(img.previewUrl));
            return [];
        });
        initialImageHandledRef.current = undefined;
    }, [isOpen]);

    useEffect(() => {
        if (!toast) return;
        const timer = setTimeout(() => setToast(''), 3000);
        return () => clearTimeout(timer);
    }, [toast]);

    useEffect(() => {
        if (!copyPromptLabel) return;
        const timer = setTimeout(() => setCopyPromptLabel(''), 2000);
        return () => clearTimeout(timer);
    }, [copyPromptLabel]);

    useEffect(() => {
        if (!copyImageLabel) return;
        const timer = setTimeout(() => setCopyImageLabel(''), 2000);
        return () => clearTimeout(timer);
    }, [copyImageLabel]);

    useEffect(() => {
        if (!isOpen || !initialImageUrl) return;
        if (initialImageHandledRef.current === initialImageUrl) return;
        initialImageHandledRef.current = initialImageUrl;

        (async () => {
            try {
                const resp = await fetch(initialImageUrl);
                const blob = await resp.blob();
                const file = new File([blob], `reference_${Date.now()}.png`, { type: blob.type || 'image/png' });
                const previewUrl = URL.createObjectURL(file);
                const dim = await new Promise<{ width: number; height: number }>((resolve) => {
                    const img = new Image();
                    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
                    img.onerror = () => resolve({ width: 0, height: 0 });
                    img.src = previewUrl;
                });
                setUploadedImages((prev) => prev.length >= selectedModel.maxImages ? prev : [
                    ...prev,
                    {
                        id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                        file,
                        previewUrl,
                        width: dim.width,
                        height: dim.height,
                    },
                ]);
            } catch (e) {
                console.warn('Failed to load initial reference image:', e);
            }
        })();
    }, [isOpen, initialImageUrl, selectedModel.maxImages]);

    useEffect(() => {
        if (!isOpen) return;
        const handler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                if (previewRefUrl) setPreviewRefUrl(null);
                else if (previewTask) setPreviewTask(null);
                else onClose();
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [isOpen, onClose, previewRefUrl, previewTask]);

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (ratioRef.current && !ratioRef.current.contains(e.target as Node)) setIsRatioOpen(false);
            if (modelRef.current && !modelRef.current.contains(e.target as Node)) setIsModelOpen(false);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);

    useEffect(() => {
        if (!isOpen) return;
        const handler = (event: ClipboardEvent) => {
            if (event.clipboardData?.files.length) handleUploadFiles(event.clipboardData.files);
        };
        window.addEventListener('paste', handler);
        return () => window.removeEventListener('paste', handler);
    }, [isOpen]);

    const persistCustomProvider = useCallback((next = customProvider) => {
        const sanitized = { ...next, apiKey: '' };
        setCustomProvider(sanitized);
        localStorage.setItem(CUSTOM_PROVIDER_STORAGE, JSON.stringify(sanitized));
    }, [customProvider]);

    const handleUploadFiles = useCallback(async (files: FileList | File[]) => {
        const remaining = selectedModel.maxImages - uploadedImages.length;
        if (remaining <= 0) return;

        const queue: UploadedImage[] = [];
        for (const file of Array.from(files)) {
            if (queue.length >= remaining) break;
            if (!file.type.startsWith('image/')) continue;

            const previewUrl = URL.createObjectURL(file);
            const dim = await new Promise<{ width: number; height: number }>((resolve) => {
                const img = new Image();
                img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
                img.onerror = () => resolve({ width: 0, height: 0 });
                img.src = previewUrl;
            });
            queue.push({
                id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                file,
                previewUrl,
                width: dim.width,
                height: dim.height,
            });
        }
        setUploadedImages((prev) => [...prev, ...queue]);
    }, [selectedModel.maxImages, uploadedImages.length]);

    const handleRemoveImage = useCallback((id: string) => {
        setUploadedImages((prev) => {
            const removed = prev.find((img) => img.id === id);
            if (removed) URL.revokeObjectURL(removed.previewUrl);
            return prev.filter((img) => img.id !== id);
        });
    }, []);

    const clearRefs = useCallback(() => {
        setUploadedImages((prev) => {
            prev.forEach((img) => URL.revokeObjectURL(img.previewUrl));
            return [];
        });
    }, []);

    const reorderRefs = useCallback((from: number, to: number) => {
        setUploadedImages((prev) => {
            const next = [...prev];
            const [item] = next.splice(from, 1);
            next.splice(to, 0, item);
            return next;
        });
    }, []);

    const handleSubmit = useCallback(async () => {
        if (!canSubmit) return;
        if (providerMode === 'custom') {
            setSettingsOpen(true);
            return;
        }
        const runs = Math.max(1, Math.min(10, count));
        for (let i = 0; i < runs; i += 1) {
            await generate({
                prompt: prompt.trim(),
                modelId: selectedModel.id,
                aspectRatio,
                refImages: uploadedImages,
            });
        }
        setPrompt('');
    }, [aspectRatio, canSubmit, count, providerMode, prompt, selectedModel.id, uploadedImages]);

    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key !== 'Enter') return;
        const settings = getAppSettings();
        const enterGenerates = settings.enterBehavior === 'generate';
        if (enterGenerates ? !e.shiftKey : (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            handleSubmit();
        }
    }, [handleSubmit]);

    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setIsDraggingRefs(false);
        if (e.dataTransfer.files.length) handleUploadFiles(e.dataTransfer.files);
    }, [handleUploadFiles]);

    const copyPrompt = useCallback(async (text: string) => {
        try {
            await navigator.clipboard.writeText(text);
            setCopyPromptLabel('已复制');
        } catch {
            try {
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.style.position = 'fixed';
                ta.style.left = '-9999px';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
                setCopyPromptLabel('已复制');
            } catch {
                setCopyPromptLabel('复制失败');
            }
        }
    }, []);

    const handleCopyTask = useCallback(async (task: Task) => {
        if (!task.imageUrl) return;
        try {
            const resp = await fetch(task.imageUrl);
            const blob = await resp.blob();
            await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
            setCopyImageLabel('已复制');
        } catch {
            setCopyImageLabel('复制失败');
            setToast('复制图片需要 HTTPS 环境，可先下载图片');
        }
    }, []);

    const handleDownloadTask = useCallback((task: Task) => {
        if (!task.imageUrl) return;
        const a = document.createElement('a');
        a.href = task.imageUrl;
        a.download = `${task.modelId}_${task.timestamp}.png`;
        a.target = '_blank';
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }, []);

    const reuseTask = useCallback((task: Task) => {
        setPrompt(task.prompt);
        setAspectRatio(task.aspectRatio || 'auto');
        const model = MODELS.find((m) => m.id === task.modelId);
        if (model) setSelectedModel(model);
        setPreviewTask(null);
    }, []);

    const chooseModelByResolution = useCallback((resolution: '2k' | '4k') => {
        const next = MODELS.find((model) => model.resolution === resolution);
        if (next) setSelectedModel(next);
    }, []);

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-5" style={{ background: 'rgb(0 0 0 / 0.34)' }} onClick={onClose}>
            <div className="flex h-[min(790px,calc(100vh-44px))] w-[min(1220px,calc(100vw-36px))] overflow-hidden rounded-2xl shadow-2xl" style={{ background: '#fff', border: `1px solid ${line}`, color: ink }} onClick={(e) => e.stopPropagation()}>
                <aside className="flex w-[405px] shrink-0 flex-col overflow-hidden border-r" style={{ borderColor: line, background: '#fff' }}>
                    <header className="flex h-[66px] items-center gap-3 border-b px-5" style={{ borderColor: line }}>
                        <div className="grid h-11 w-11 place-items-center rounded-xl" style={{ background: 'rgb(52 106 234 / 0.1)', color: blue }}>
                            <Sparkles className="h-5 w-5" />
                        </div>
                        <div className="min-w-0">
                            <h2 className="truncate text-base font-semibold leading-5" style={{ color: ink }}>图像编辑</h2>
                            <p className="truncate text-sm" style={{ color: faint }}>GPT Image 工作台</p>
                        </div>
                        <button onClick={onClose} className="ml-auto grid h-8 w-8 place-items-center rounded-lg transition-colors hover:bg-black/5" style={{ color: muted }} title="关闭">
                            <X className="h-4 w-4" />
                        </button>
                    </header>

                    <div className="flex-1 overflow-y-auto px-5 py-4">
                        <section className="mb-5">
                            <div className="mb-3 flex items-center justify-between">
                                <span className="text-sm font-medium" style={{ color: muted }}>供应商</span>
                                <button onClick={() => setSettingsOpen(true)} className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs transition-colors hover:bg-black/5" style={{ color: muted }}>
                                    <Settings className="h-4 w-4" />
                                    设置
                                </button>
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                                <button
                                    onClick={() => setProviderMode('server')}
                                    className="flex h-14 items-center gap-3 rounded-xl border px-3 text-left transition-colors"
                                    style={{
                                        borderColor: providerMode === 'server' ? blue : line,
                                        background: providerMode === 'server' ? 'rgb(52 106 234 / 0.08)' : 'rgb(0 0 0 / 0.03)',
                                        color: providerMode === 'server' ? ink : muted,
                                    }}
                                >
                                    <Server className="h-5 w-5" />
                                    <span className="text-sm font-medium">服务器提供</span>
                                </button>
                                <button
                                    onClick={() => setProviderMode('custom')}
                                    className="flex h-14 items-center gap-3 rounded-xl border px-3 text-left transition-colors"
                                    style={{
                                        borderColor: providerMode === 'custom' ? blue : line,
                                        background: providerMode === 'custom' ? 'rgb(52 106 234 / 0.08)' : 'rgb(0 0 0 / 0.03)',
                                        color: providerMode === 'custom' ? ink : muted,
                                    }}
                                >
                                    <KeyRound className="h-5 w-5" />
                                    <span className="text-sm font-medium">自定义 API</span>
                                </button>
                            </div>
                        </section>

                        <section className="mb-5 grid grid-cols-2 gap-3">
                            <div ref={modelRef} className="relative">
                                <label className="mb-2 block text-sm font-medium" style={{ color: muted }}>模型</label>
                                <button onClick={() => setIsModelOpen((v) => !v)} className="flex h-12 w-full items-center gap-2 rounded-xl border px-3 text-left text-sm transition-colors hover:bg-black/5" style={{ borderColor: line, background: 'rgb(0 0 0 / 0.03)', color: ink }}>
                                    <Sparkles className="h-4 w-4" style={{ color: blue }} />
                                    <span className="min-w-0 flex-1 truncate">{selectedModel.name}</span>
                                    <span className="text-xs" style={{ color: faint }}>{selectedModel.resolution.toUpperCase()}</span>
                                    <ChevronDown className={`h-4 w-4 transition-transform ${isModelOpen ? 'rotate-180' : ''}`} style={{ color: faint }} />
                                </button>
                                {isModelOpen && (
                                    <div className="absolute left-0 right-0 top-full z-40 mt-1 overflow-hidden rounded-xl border bg-white py-1 shadow-2xl" style={{ borderColor: line }}>
                                        {MODELS.map((model) => (
                                            <button
                                                key={model.id}
                                                onClick={() => { setSelectedModel(model); setIsModelOpen(false); }}
                                                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-black/5"
                                                style={{ color: model.id === selectedModel.id ? blue : ink, background: model.id === selectedModel.id ? 'rgb(52 106 234 / 0.06)' : '#fff' }}
                                            >
                                                <span className="flex-1">{model.name}</span>
                                                <span className="text-xs" style={{ color: faint }}>{model.description}</span>
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>

                            <div ref={ratioRef} className="relative">
                                <label className="mb-2 block text-sm font-medium" style={{ color: muted }}>比例</label>
                                <button onClick={() => setIsRatioOpen((v) => !v)} className="flex h-12 w-full items-center gap-2 rounded-xl border px-3 text-left text-sm transition-colors hover:bg-black/5" style={{ borderColor: line, background: 'rgb(0 0 0 / 0.03)', color: ink }}>
                                    <RatioIcon w={currentRatio.w} h={currentRatio.h} isAuto={currentRatio.value === 'auto'} active />
                                    <span className="flex-1">{currentRatio.label}</span>
                                    <ChevronDown className={`h-4 w-4 transition-transform ${isRatioOpen ? 'rotate-180' : ''}`} style={{ color: faint }} />
                                </button>
                                {isRatioOpen && (
                                    <div className="absolute left-0 right-0 top-full z-40 mt-1 max-h-64 overflow-y-auto rounded-xl border bg-white py-1 shadow-2xl" style={{ borderColor: line }}>
                                        {ASPECT_RATIOS.map((ratio) => (
                                            <button key={ratio.value} onClick={() => { setAspectRatio(ratio.value); setIsRatioOpen(false); }} className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-black/5" style={{ color: ratio.value === aspectRatio ? blue : ink, background: ratio.value === aspectRatio ? 'rgb(52 106 234 / 0.06)' : '#fff' }}>
                                                <RatioIcon w={ratio.w} h={ratio.h} isAuto={ratio.value === 'auto'} active={ratio.value === aspectRatio} />
                                                {ratio.label}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </section>

                        <section className="mb-5">
                            <label className="mb-2 block text-sm font-medium" style={{ color: muted }}>提示词</label>
                            <div className="overflow-hidden rounded-xl border bg-white transition-colors focus-within:ring-2 focus-within:ring-[#346aea]/20" style={{ borderColor: line }}>
                                <textarea
                                    ref={inputRef}
                                    value={prompt}
                                    onChange={(e) => setPrompt(e.target.value)}
                                    onKeyDown={handleKeyDown}
                                    placeholder="描述你想要的修改，或直接写一张新图..."
                                    className="h-44 w-full resize-none bg-transparent px-4 py-3 text-sm leading-6 outline-none"
                                    style={{ color: ink }}
                                />
                            </div>
                            <div className="mt-1.5 flex items-center justify-between text-xs" style={{ color: faint }}>
                                <span>{getAppSettings().enterBehavior === 'generate' ? 'Enter 提交，Shift+Enter 换行' : 'Ctrl+Enter 提交'}</span>
                                <span>{prompt.length}</span>
                            </div>
                        </section>

                        <section className="mb-5 grid gap-3">
                            <div className="flex items-center justify-between">
                                <span className="text-sm font-medium" style={{ color: muted }}>生成数量</span>
                                <div className="inline-flex h-9 items-center overflow-hidden rounded-lg border" style={{ borderColor: line }}>
                                    <button onClick={() => setCount((v) => Math.max(1, v - 1))} className="grid h-9 w-9 place-items-center transition-colors hover:bg-black/5" style={{ color: muted }}><Minus className="h-4 w-4" /></button>
                                    <span className="grid h-9 w-10 place-items-center border-x text-sm font-medium" style={{ borderColor: line }}>{count}</span>
                                    <button onClick={() => setCount((v) => Math.min(10, v + 1))} className="grid h-9 w-9 place-items-center transition-colors hover:bg-black/5" style={{ color: muted }}><Plus className="h-4 w-4" /></button>
                                </div>
                            </div>

                            <div className="grid grid-cols-3 gap-2">
                                {(['1K', '2K', '4K'] as const).map((tier) => {
                                    const disabled = tier === '1K';
                                    const active = selectedModel.resolution.toUpperCase() === tier;
                                    return (
                                        <button
                                            key={tier}
                                            disabled={disabled}
                                            onClick={() => chooseModelByResolution(tier === '4K' ? '4k' : '2k')}
                                            className="h-9 rounded-lg border text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45"
                                            style={{
                                                borderColor: active ? blue : line,
                                                background: active ? 'rgb(52 106 234 / 0.08)' : '#fff',
                                                color: active ? blue : ink,
                                            }}
                                            title={disabled ? '服务器通道暂未提供 1K' : undefined}
                                        >
                                            {tier}
                                        </button>
                                    );
                                })}
                            </div>

                            <div className="grid grid-cols-3 gap-2">
                                {QUALITIES.map((item) => (
                                    <button
                                        key={item.id}
                                        onClick={() => setQuality(item.id)}
                                        className="h-9 rounded-lg border text-sm font-medium transition-colors"
                                        style={{
                                            borderColor: quality === item.id ? blue : line,
                                            background: quality === item.id ? 'rgb(52 106 234 / 0.08)' : '#fff',
                                            color: quality === item.id ? blue : ink,
                                        }}
                                    >
                                        {item.label}
                                    </button>
                                ))}
                            </div>

                            <p className="text-xs leading-5" style={{ color: faint }}>提示词越长、分辨率越高、质量越高，生成等待时间都会更长。</p>
                        </section>

                        <section
                            className="rounded-xl border p-3 transition-colors"
                            style={{ borderColor: isDraggingRefs ? blue : line, background: isDraggingRefs ? 'rgb(52 106 234 / 0.06)' : soft }}
                            onDragOver={(e) => { e.preventDefault(); setIsDraggingRefs(true); }}
                            onDragLeave={() => setIsDraggingRefs(false)}
                            onDrop={handleDrop}
                        >
                            <div className="mb-3 flex items-center justify-between">
                                <div>
                                    <div className="text-sm font-medium" style={{ color: ink }}>参考图</div>
                                    <div className="text-xs" style={{ color: faint }}>{uploadedImages.length}/{selectedModel.maxImages}</div>
                                </div>
                                <div className="flex items-center gap-1">
                                    {uploadedImages.length > 0 && (
                                        <button onClick={clearRefs} className="grid h-8 w-8 place-items-center rounded-lg transition-colors hover:bg-black/10" style={{ color: muted }} title="清空">
                                            <Trash2 className="h-4 w-4" />
                                        </button>
                                    )}
                                    <button onClick={() => fileInputRef.current?.click()} className="grid h-8 w-8 place-items-center rounded-lg transition-colors hover:bg-black/10" style={{ background: 'rgb(0 0 0 / 0.04)', color: ink }} title="添加参考图">
                                        <Plus className="h-4 w-4" />
                                    </button>
                                </div>
                                <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { if (e.target.files) handleUploadFiles(e.target.files); e.target.value = ''; }} />
                            </div>

                            {uploadedImages.length > 0 ? (
                                <div className="grid grid-cols-4 gap-2">
                                    {uploadedImages.map((img, idx) => (
                                        <div
                                            key={img.id}
                                            draggable
                                            onDragStart={() => setDragRefIndex(idx)}
                                            onDragEnter={() => { if (dragRefIndex != null && dragRefIndex !== idx) { reorderRefs(dragRefIndex, idx); setDragRefIndex(idx); } }}
                                            onDragEnd={() => setDragRefIndex(null)}
                                            onDrop={(e) => e.preventDefault()}
                                            onClick={() => setPreviewRefUrl(img.previewUrl)}
                                            className={`group relative aspect-square cursor-pointer overflow-hidden rounded-lg border bg-white transition-opacity ${dragRefIndex === idx ? 'opacity-40' : ''}`}
                                            style={{ borderColor: line }}
                                        >
                                            <img src={img.previewUrl} alt="" className="pointer-events-none h-full w-full object-cover" />
                                            <button onClick={(e) => { e.stopPropagation(); handleRemoveImage(img.id); }} className="absolute right-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-black/70 text-white opacity-0 transition-opacity hover:bg-red-500/80 group-hover:opacity-100">
                                                <X className="h-3 w-3" />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <button onClick={() => fileInputRef.current?.click()} className="flex h-24 w-full flex-col items-center justify-center rounded-xl border border-dashed bg-white transition-colors hover:bg-black/[0.02]" style={{ borderColor: line, color: muted }}>
                                    <ImageIcon className="mb-2 h-5 w-5" />
                                    <span className="text-sm">拖入、粘贴或选择参考图</span>
                                </button>
                            )}
                        </section>
                    </div>

                    <footer className="border-t px-5 py-4" style={{ borderColor: line }}>
                        <div className="mb-3 flex items-center justify-between rounded-xl px-3 py-2 text-sm" style={{ background: soft, color: muted }}>
                            <span className="inline-flex items-center gap-1.5"><Loader2 className="h-4 w-4" />约 {selectedModel.speed}s</span>
                            <span>{providerMode === 'server' ? '服务器通道' : '自定义通道'}</span>
                        </div>
                        <div className="mb-3 flex items-center justify-between gap-3 text-xs" style={{ color: muted }}>
                            <div className="min-w-0">
                                <div className="truncate font-medium" style={{ color: ink }}>{providerLabel} · {providerMode === 'server' ? selectedModel.description : customProvider.model}</div>
                                <div className="truncate">并发 {count} · {currentRatio.label} · 约 {selectedModel.speed}s</div>
                            </div>
                            <button onClick={() => setSettingsOpen(true)} className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border transition-colors hover:bg-black/5" style={{ borderColor: line, color: providerMode === 'custom' && !customReady ? '#d3482b' : muted, background: providerMode === 'custom' && !customReady ? 'rgb(211 72 43 / 0.06)' : '#fff' }} title="设置">
                                <Settings className={`h-4 w-4 ${providerMode === 'custom' && !customReady ? 'animate-pulse' : ''}`} />
                            </button>
                        </div>
                        <button
                            onClick={handleSubmit}
                            disabled={!canSubmit}
                            className="flex h-12 w-full items-center justify-center gap-2 rounded-xl text-sm font-semibold transition-all active:scale-[0.98] disabled:active:scale-100"
                            style={{
                                background: canSubmit ? blue : 'rgb(0 0 0 / 0.06)',
                                color: canSubmit ? '#fff' : faint,
                                cursor: canSubmit ? 'pointer' : 'not-allowed',
                            }}
                        >
                            <WandSparkles className="h-4 w-4" />
                            {providerMode === 'custom' && !customReady ? '请先配置 API Key' : activeTasks.length ? '生成中...' : '生成'}
                        </button>
                    </footer>
                </aside>

                <main className="relative flex min-w-0 flex-1 flex-col" style={{ background: soft }}>
                    <header className="flex h-[58px] items-center gap-3 border-b px-5" style={{ borderColor: line, background: '#fff' }}>
                        <div className="relative min-w-[240px] flex-1">
                            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" style={{ color: '#9a9a9a' }} />
                            <input value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="h-9 w-full rounded-lg border bg-white pl-9 pr-3 text-sm outline-none transition-colors focus:ring-2 focus:ring-[#346aea]/20" style={{ borderColor: line, color: ink }} placeholder="搜索提示词..." />
                        </div>
                        <div className="hidden items-center gap-2 text-xs md:flex" style={{ color: muted }}>
                            <span className="rounded-lg border bg-white px-2.5 py-1" style={{ borderColor: line }}>{providerLabel}</span>
                            <span className="rounded-lg border bg-white px-2.5 py-1" style={{ borderColor: line }}>{activeTasks.length > 0 ? `${activeTasks.length} 个任务中` : isShowingDemoHistory ? '示例历史' : '暂无任务'}</span>
                            {quota && quota.daily_limit > 0 && <span className="rounded-lg border bg-white px-2.5 py-1" style={{ borderColor: line }}>额度 {quota.daily_balance + quota.extra_balance}</span>}
                        </div>
                    </header>

                    <section className="min-h-0 flex-1 overflow-y-auto p-6">
                        {displayTasks.length > 0 ? (
                            <div className="grid items-start gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
                                {displayTasks.map((task) => {
                                    const isDemo = isDemoTask(task);
                                    const elapsed = Math.max(0, Math.floor((Date.now() - task.timestamp) / 1000));
                                    const estimate = task.estimatedSeconds || MODELS.find((m) => m.id === task.modelId)?.speed || 60;
                                    const progress = task.status === 'generating' ? Math.min(99, Math.max(8, Math.round((elapsed / estimate) * 100))) : 0;
                                    return (
                                        <div key={task.id} className="group/card relative cursor-pointer overflow-hidden rounded-xl border transition-shadow hover:shadow-lg" style={{ borderColor: task.imageUrl ? line : task.status === 'error' ? 'rgb(234 179 8 / 0.3)' : line, background: task.imageUrl ? '#fff' : task.status === 'error' ? '#fffbeb' : '#fff' }} onClick={() => task.imageUrl && setPreviewTask(task)}>
                                            {!isDemo && (
                                                <button onClick={(e) => { e.stopPropagation(); removeTask(task.id); }} className="absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity hover:bg-red-600 group-hover/card:opacity-100" title="删除">
                                                    <Trash2 className="h-3 w-3" />
                                                </button>
                                            )}
                                            {isDemo && (
                                                <span className="absolute left-2 top-2 z-10 rounded-full bg-white/90 px-2 py-0.5 text-[10px] font-medium shadow-sm" style={{ color: muted }}>示例</span>
                                            )}
                                            {task.imageUrl ? (
                                                <>
                                                    <img loading="lazy" src={task.imageUrl} alt="" style={{ width: '100%', height: 'auto', minHeight: 120, display: 'block', background: soft }} />
                                                    <CardFooter task={task} providerName={providerLabel} quality={quality} imageCount={1} onRetry={isDemo ? undefined : () => retryTask(task)} />
                                                </>
                                            ) : task.status === 'error' ? (
                                                <>
                                                    <div className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-3 px-6 text-center" style={{ background: soft }}>
                                                        <div className="flex h-10 w-10 items-center justify-center rounded-lg" style={{ background: 'rgb(211 72 43 / 0.1)', color: '#d3482b' }}>
                                                            <AlertTriangle className="h-4 w-4" />
                                                        </div>
                                                        <p className="text-sm font-semibold" style={{ color: ink }}>生成失败</p>
                                                        <p className="line-clamp-2 text-xs" style={{ color: muted }}>{task.error}</p>
                                                    </div>
                                                    <CardFooter task={task} providerName={providerLabel} quality={quality} error={task.error || '生成失败'} onRetry={isDemo ? undefined : () => retryTask(task)} />
                                                </>
                                            ) : (
                                                <>
                                                    <div className="flex aspect-[4/3] w-full items-center justify-center" style={{ background: soft }}>
                                                        <div className="w-full max-w-[200px] rounded-xl border bg-white p-3" style={{ borderColor: line }}>
                                                            <div className="mb-2 flex items-center justify-between text-xs" style={{ color: muted }}>
                                                                <span>生成中...</span>
                                                                <span>{formatSeconds(elapsed)}</span>
                                                            </div>
                                                            <div className="h-1.5 overflow-hidden rounded-full" style={{ background: 'rgb(0 0 0 / 0.06)' }}>
                                                                <div className="h-full rounded-full transition-all duration-700" style={{ width: `${progress}%`, background: blue }} />
                                                            </div>
                                                        </div>
                                                    </div>
                                                    <CardFooter task={task} providerName={providerLabel} quality={quality} />
                                                </>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        ) : (
                            <div className="flex h-full min-h-[440px] flex-col items-center justify-center gap-4 text-center" style={{ color: muted }}>
                                <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-2xl" style={{ background: 'rgb(0 0 0 / 0.04)' }}>
                                    {primaryPreview ? <img src={primaryPreview.previewUrl} alt="" className="h-full w-full object-cover" /> : <Images className="h-7 w-7" style={{ color: faint }} />}
                                </div>
                                <p className="text-sm">生成结果会显示在这里</p>
                            </div>
                        )}
                    </section>
                </main>
            </div>

            {settingsOpen && (
                <SettingsModal
                    providerMode={providerMode}
                    setProviderMode={setProviderMode}
                    customProvider={customProvider}
                    persistCustomProvider={persistCustomProvider}
                    showKey={showKey}
                    setShowKey={setShowKey}
                    maxHistoryItems={maxHistoryItems}
                    setMaxHistoryItems={setMaxHistoryItems}
                    multiImageLayout={multiImageLayout}
                    setMultiImageLayout={setMultiImageLayout}
                    historyCount={tasks.length}
                    localStorageUsage={localStorageUsage}
                    onClose={() => setSettingsOpen(false)}
                />
            )}

            {previewTask && (
                <div className="fixed inset-0 z-[70] flex flex-col items-center justify-center" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={() => setPreviewTask(null)}>
                    <div className="relative flex flex-col overflow-hidden rounded-2xl shadow-2xl" style={{ width: previewTask.imageUrl ? 'min(95vw, 1200px)' : 'min(95vw, 520px)', maxHeight: '90vh', background: '#fff' }} onClick={(e) => e.stopPropagation()}>
                        <div className="flex shrink-0 items-center gap-3 border-b px-4 py-3" style={{ borderColor: line }}>
                            <button onClick={() => setPreviewTask(null)} className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-black/5" style={{ color: muted }}>
                                <X className="h-4 w-4" />
                            </button>
                            <span className="text-xs font-medium" style={{ color: muted }}>1 / 1</span>
                            {previewTask.imageUrl && (
                                <>
                                    <button onClick={() => handleCopyTask(previewTask)} className="ml-auto flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-black/5" style={{ border: '1px solid rgb(0 0 0 / 0.15)', color: ink }}>
                                        <Copy className="h-3 w-3" />{copyImageLabel || '复制'}
                                    </button>
                                    <button onClick={() => handleDownloadTask(previewTask)} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors" style={{ background: blue, color: '#fff' }}>
                                        <Download className="h-3 w-3" />下载
                                    </button>
                                </>
                            )}
                            <button onClick={() => { removeTask(previewTask.id); setPreviewTask(null); }} className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-red-50" style={{ color: '#d3482b' }} title="删除">
                                <Trash2 className="h-3.5 w-3.5" />
                            </button>
                        </div>

                        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row">
                            {previewTask.imageUrl && (
                                <div className="relative flex flex-1 items-center justify-center" style={{ background: soft, minHeight: 300 }}>
                                    <img src={previewTask.imageUrl} alt="" className="max-h-full max-w-full object-contain" onLoad={(e) => setPreviewImageSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
                                    <button className="absolute left-3 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full opacity-30 shadow-md" style={{ background: 'rgba(255,255,255,0.9)', color: ink }} disabled><ChevronLeft className="h-3.5 w-3.5" /></button>
                                    <button className="absolute right-3 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full opacity-30 shadow-md" style={{ background: 'rgba(255,255,255,0.9)', color: ink }} disabled><ChevronRight className="h-3.5 w-3.5" /></button>
                                </div>
                            )}

                            <div className="flex w-full shrink-0 flex-col gap-3 p-4 lg:w-72" style={{ background: '#fafafa', borderLeft: previewTask.imageUrl ? '1px solid rgb(0 0 0 / 0.08)' : 'none', borderTop: '1px solid rgb(0 0 0 / 0.05)' }}>
                                <p className="text-sm leading-relaxed" style={{ color: ink }}>{previewTask.prompt || '无提示词'}</p>
                                <div className="flex gap-2">
                                    <button onClick={() => copyPrompt(previewTask.prompt)} className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors hover:bg-black/5" style={{ border: '1px solid rgb(0 0 0 / 0.15)', color: ink }}>
                                        <Copy className="h-3 w-3" />{copyPromptLabel || '复制提示词'}
                                    </button>
                                    <button onClick={() => reuseTask(previewTask)} className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors" style={{ background: blue, color: '#fff' }}>
                                        <RotateCcw className="h-3 w-3" />复用提示词
                                    </button>
                                </div>
                                {previewTask.refImages && previewTask.refImages.length > 0 && (
                                    <div className="flex flex-wrap gap-2">
                                        {previewTask.refImages.map((refUrl, i) => (
                                            <button key={i} onClick={() => setPreviewRefUrl(refUrl)} className="h-14 w-14 shrink-0 overflow-hidden rounded-lg border transition-colors hover:border-[#346aea]" style={{ borderColor: line }}>
                                                <img src={refUrl} alt="" className="h-full w-full object-cover" />
                                            </button>
                                        ))}
                                    </div>
                                )}
                                <div className="flex flex-wrap gap-1.5">
                                    <span className="rounded-full px-2 py-0.5 text-[10px] font-medium" style={{ background: 'rgb(0 0 0 / 0.04)', color: muted }}>请求 {previewTask.aspectRatio || 'auto'}</span>
                                    {previewImageSize && <span className="rounded-full px-2 py-0.5 text-[10px] font-medium" style={{ background: 'rgb(0 0 0 / 0.04)', color: muted }}>实际 {previewImageSize.w}x{previewImageSize.h} ({ratioFromSize(previewImageSize.w, previewImageSize.h)})</span>}
                                    <span className="rounded-full px-2 py-0.5 text-[10px] font-medium" style={{ background: 'rgb(0 0 0 / 0.04)', color: muted }}>质量：{QUALITY_CN[quality]}</span>
                                    <span className="rounded-full px-2 py-0.5 text-[10px] font-medium" style={{ background: 'rgb(0 0 0 / 0.04)', color: muted }}>{previewTask.refImages?.length ? '图生图' : '文生图'}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {toast && <div className="fixed left-1/2 top-6 z-[90] -translate-x-1/2 rounded-lg px-4 py-2.5 text-xs font-medium shadow-lg" style={{ background: '#d3482b', color: '#fff' }}>{toast}</div>}

            {previewRefUrl && (
                <div className="fixed inset-0 z-[85] flex items-center justify-center bg-black/80 p-6" onClick={() => setPreviewRefUrl(null)}>
                    <img src={previewRefUrl} alt="" className="max-h-[90vh] max-w-full rounded-lg object-contain" onClick={(e) => e.stopPropagation()} />
                    <button onClick={() => setPreviewRefUrl(null)} className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-lg text-white transition-colors hover:bg-white/10">
                        <X className="h-5 w-5" />
                    </button>
                </div>
            )}
        </div>
    );
};
