import { useState, useEffect, useCallback } from 'react';
import { X, ZoomIn, ZoomOut, Copy, Download, RotateCcw, Pencil } from 'lucide-react';
import { type Task } from '../../stores/taskStore';
import { MODELS } from './models';
import { retry as retryTask } from './workshopApi';

interface WorkshopResultViewerProps {
    task: Task | null;
    onClose: () => void;
    /** 用"使用提示词"按钮触发，回到输入面板复用此提示词 */
    onUsePrompt?: (prompt: string) => void;
}

export const WorkshopResultViewer: React.FC<WorkshopResultViewerProps> = ({ task, onClose, onUsePrompt }) => {
    const [scale, setScale] = useState(1);
    const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

    useEffect(() => {
        if (task) setScale(1);
    }, [task?.id]);

    useEffect(() => {
        if (!task) return;
        const handler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [task, onClose]);

    useEffect(() => {
        if (toast) {
            const t = setTimeout(() => setToast(null), 2000);
            return () => clearTimeout(t);
        }
    }, [toast]);

    const handleCopy = useCallback(async () => {
        if (!task) return;
        try {
            const resp = await fetch(task.imageUrl);
            const blob = await resp.blob();
            await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
            setToast({ type: 'success', message: '已复制到剪贴板' });
        } catch {
            setToast({ type: 'error', message: '复制失败' });
        }
    }, [task]);

    const handleDownload = useCallback(() => {
        if (!task) return;
        const a = document.createElement('a');
        a.href = task.imageUrl;
        a.download = `${task.modelId}_${task.timestamp}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }, [task]);

    const handleRetry = useCallback(() => {
        if (!task) return;
        retryTask(task);
        onClose();
    }, [task, onClose]);

    if (!task) return null;

    const model = MODELS.find(m => m.id === task.modelId);

    return (
        <div className="fixed inset-0 z-[60] flex flex-col bg-black/85 backdrop-blur-sm" onClick={onClose}>
            {/* 顶部工具栏 */}
            <div
                className="flex-shrink-0 flex items-center gap-2 px-4 py-2.5 bg-nai-panel/80 border-b border-white/5"
                onClick={(e) => e.stopPropagation()}
            >
                <button
                    onClick={onClose}
                    className="p-1.5 rounded-lg hover:bg-white/10 text-gray-400 hover:text-white transition-all"
                    title="关闭 (Esc)"
                >
                    <X className="w-4 h-4" />
                </button>
                <div className="flex-1 text-xs text-gray-400 truncate">
                    {model?.icon} {model?.name} · {task.prompt.slice(0, 80) || '无提示词'}
                </div>
                <div className="flex items-center gap-1">
                    <button
                        onClick={() => setScale(s => Math.max(0.25, s / 1.5))}
                        className="p-1.5 rounded-lg hover:bg-white/10 text-gray-400 hover:text-white transition-all"
                        title="缩小"
                    >
                        <ZoomOut className="w-4 h-4" />
                    </button>
                    <button
                        onClick={() => setScale(1)}
                        className="px-2 py-1 rounded-lg hover:bg-white/10 text-[11px] text-gray-400 hover:text-white tabular-nums transition-all"
                    >
                        {Math.round(scale * 100)}%
                    </button>
                    <button
                        onClick={() => setScale(s => Math.min(8, s * 1.5))}
                        className="p-1.5 rounded-lg hover:bg-white/10 text-gray-400 hover:text-white transition-all"
                        title="放大"
                    >
                        <ZoomIn className="w-4 h-4" />
                    </button>
                    <span className="w-px h-4 bg-white/10 mx-1" />
                    <button
                        onClick={handleCopy}
                        className="p-1.5 rounded-lg hover:bg-white/10 text-gray-400 hover:text-white transition-all"
                        title="复制"
                    >
                        <Copy className="w-4 h-4" />
                    </button>
                    <button
                        onClick={handleDownload}
                        className="p-1.5 rounded-lg hover:bg-white/10 text-gray-400 hover:text-white transition-all"
                        title="下载"
                    >
                        <Download className="w-4 h-4" />
                    </button>
                    <button
                        onClick={handleRetry}
                        className="p-1.5 rounded-lg hover:bg-white/10 text-gray-400 hover:text-white transition-all"
                        title="重试"
                    >
                        <RotateCcw className="w-4 h-4" />
                    </button>
                    {onUsePrompt && (
                        <button
                            onClick={() => { onUsePrompt(task.prompt); onClose(); }}
                            className="flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-white/10 text-[11px] text-gray-400 hover:text-white transition-all"
                            title="将提示词带入输入面板"
                        >
                            <Pencil className="w-3.5 h-3.5" />
                            使用提示词
                        </button>
                    )}
                </div>
            </div>

            {/* 图片区 */}
            <div className="flex-1 flex items-center justify-center overflow-auto" onClick={(e) => e.stopPropagation()}>
                <img
                    src={task.imageUrl}
                    alt=""
                    className="shadow-2xl select-none"
                    style={{
                        transform: `scale(${scale})`,
                        transition: 'transform 0.15s ease-out',
                        maxWidth: scale <= 1 ? '92vw' : undefined,
                        maxHeight: scale <= 1 ? '88vh' : undefined,
                    }}
                />
            </div>

            {/* Toast */}
            {toast && (
                <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[70] animate-fade-in">
                    <div className={`px-4 py-2 rounded-lg text-sm border ${toast.type === 'success' ? 'bg-emerald-900/80 border-emerald-500/30 text-emerald-300' : 'bg-red-900/80 border-red-500/30 text-red-300'}`}>
                        {toast.message}
                    </div>
                </div>
            )}
        </div>
    );
};
