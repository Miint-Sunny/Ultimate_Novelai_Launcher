import { useState, useEffect, useMemo } from 'react';
import { Sparkles, Check, X, RotateCcw, Eye } from 'lucide-react';
import { useTaskStore, type Task } from '../../stores/taskStore';
import { MODELS, extractErrorSummary } from './models';
import { retry as retryTask } from './workshopApi';

interface WorkshopTaskFloatProps {
    onView: (task: Task) => void;
    /** 重绘浮卡占用底部空间，工坊浮卡上移一些避免重叠 */
    bottomOffset?: number;
}

const MAX_VISIBLE = 4;
// 已完成任务在浮卡上的最长保留秒数（之后用户需要去历史里看）
const COMPLETED_LINGER_MS = 60_000;

export const WorkshopTaskFloat: React.FC<WorkshopTaskFloatProps> = ({ onView, bottomOffset = 16 }) => {
    const { tasks, removeTask } = useTaskStore();
    const [now, setNow] = useState(Date.now());
    const [dismissed, setDismissed] = useState<Set<string>>(new Set());

    useEffect(() => {
        const t = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
    }, []);

    // 显示策略：
    // - 全部生成中任务
    // - 完成 < 60s 的成功 / 失败任务
    // - 用户主动 dismiss 过的不再显示
    const visible = useMemo(() => {
        const list = tasks
            .filter(t => !dismissed.has(t.id))
            .filter(t => {
                if (t.status === 'generating') return true;
                const age = now - t.timestamp;
                return age < COMPLETED_LINGER_MS;
            })
            .slice(0, MAX_VISIBLE);
        return list;
    }, [tasks, dismissed, now]);

    if (visible.length === 0) return null;

    const handleDismiss = (id: string) => {
        setDismissed(prev => new Set(prev).add(id));
    };

    return (
        <div
            className="fixed right-4 z-30 flex flex-col gap-1.5 items-end pointer-events-none"
            style={{ bottom: bottomOffset }}
        >
            {visible.map(task => {
                const model = MODELS.find(m => m.id === task.modelId);
                const isLoading = task.status === 'generating';
                const isError = task.status === 'error';
                const isSuccess = task.status === 'success';

                const elapsed = Math.max(0, Math.floor((now - task.timestamp) / 1000));
                const est = task.estimatedSeconds || model?.speed || 30;
                const remaining = Math.max(0, est - elapsed);
                const progress = est > 0 ? Math.min(100, (elapsed / est) * 100) : 0;

                return (
                    <div
                        key={task.id}
                        className={`
                            pointer-events-auto bg-gray-900/90 backdrop-blur-sm rounded-lg border shadow-xl
                            transition-all duration-200 min-w-[220px] max-w-[280px]
                            ${isSuccess ? 'border-emerald-500/40' : isError ? 'border-red-500/40' : 'border-amber-500/30'}
                        `}
                    >
                        <div className="px-2.5 py-1.5 flex items-center gap-2">
                            {/* 图标 */}
                            <div className={`
                                w-6 h-6 rounded flex items-center justify-center shrink-0
                                ${isSuccess ? 'bg-emerald-500/20' : isError ? 'bg-red-500/20' : 'bg-amber-500/20'}
                            `}>
                                {isSuccess ? (
                                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                                ) : isError ? (
                                    <X className="w-3.5 h-3.5 text-red-400" />
                                ) : (
                                    <Sparkles className="w-3.5 h-3.5 text-amber-400 animate-pulse" />
                                )}
                            </div>

                            {/* 内容 */}
                            <div className="flex-1 min-w-0">
                                {isLoading && (
                                    <div className="flex items-center gap-2">
                                        <div className="flex-1 h-1 bg-gray-700/60 rounded-full overflow-hidden">
                                            <div
                                                className="h-full bg-amber-400 rounded-full transition-all duration-1000"
                                                style={{ width: `${progress}%` }}
                                            />
                                        </div>
                                        <span className="text-[10px] text-gray-400 tabular-nums shrink-0">
                                            {remaining > 0 ? `${remaining}s` : '…'}
                                        </span>
                                    </div>
                                )}
                                {isSuccess && (
                                    <div className="flex flex-col">
                                        <span className="text-[11px] text-emerald-400 font-medium leading-tight">完成</span>
                                        <span className="text-[10px] text-gray-500 truncate leading-tight">{task.prompt || '无提示词'}</span>
                                    </div>
                                )}
                                {isError && (
                                    <div className="flex flex-col group/err relative">
                                        <span className="text-[11px] text-red-400 font-medium leading-tight">失败</span>
                                        <span className="text-[10px] text-gray-500 truncate leading-tight">{extractErrorSummary(task.error)}</span>
                                        {task.error && (
                                            <div className="hidden group-hover/err:block absolute right-0 bottom-full mb-1.5 w-60 max-h-32 overflow-y-auto p-2 rounded-lg bg-gray-950/95 border border-white/10 text-[10px] text-red-300/90 leading-relaxed whitespace-pre-wrap break-all shadow-2xl z-10">
                                                {task.error}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>

                            {/* 操作按钮 */}
                            <div className="flex items-center shrink-0">
                                {isSuccess && (
                                    <button
                                        onClick={() => onView(task)}
                                        className="p-1 rounded text-emerald-400 hover:bg-emerald-500/20 transition-colors"
                                        title="查看"
                                    >
                                        <Eye className="w-3.5 h-3.5" />
                                    </button>
                                )}
                                {isError && (
                                    <button
                                        onClick={() => retryTask(task)}
                                        className="p-1 rounded text-amber-400 hover:bg-amber-500/20 transition-colors"
                                        title="重试"
                                    >
                                        <RotateCcw className="w-3.5 h-3.5" />
                                    </button>
                                )}
                                <button
                                    onClick={() => {
                                        if (isError) removeTask(task.id);
                                        handleDismiss(task.id);
                                    }}
                                    className="p-1 rounded text-gray-500 hover:text-white hover:bg-white/10 transition-colors"
                                    title={isLoading ? '隐藏（任务继续）' : '关闭'}
                                >
                                    <X className="w-3.5 h-3.5" />
                                </button>
                            </div>
                        </div>
                    </div>
                );
            })}
        </div>
    );
};
