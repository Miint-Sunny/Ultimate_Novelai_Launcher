import { useState, useEffect } from 'react';
import { Banana, Check, X, Clock, History, RotateCcw, Pencil } from 'lucide-react';

export interface BananaTask {
  id: string;
  taskId: string;
  status: 'pending' | 'generating' | 'completed' | 'failed';
  prompt: string;
  estimatedSeconds: number;
  startTime: number;
  resultImageUrl?: string;
  resultHistoryId?: string;
  error?: string;
  width: number;
  height: number;
  seed?: number;
  imageBase64?: string; // 保存原始图片用于重试
}

interface BananaTaskFloatProps {
  tasks: BananaTask[];
  onViewHistory: (historyId: string) => void;
  onDismiss: (taskId: string) => void;
  onRetry?: (task: BananaTask) => void;
  onEdit?: (task: BananaTask) => void;
}

export const BananaTaskFloat: React.FC<BananaTaskFloatProps> = ({
  tasks,
  onViewHistory,
  onDismiss,
  onRetry,
  onEdit,
}) => {
  const [now, setNow] = useState(Date.now());

  // 每秒更新时间
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // 只显示最近的任务（最多3个）
  const visibleTasks = tasks.slice(0, 3);

  if (visibleTasks.length === 0) return null;

  return (
    <div className="absolute bottom-16 right-6 z-30 flex flex-col gap-1.5 items-end">
      {visibleTasks.map((task) => {
        const elapsed = Math.floor((now - task.startTime) / 1000);
        const remaining = Math.max(0, task.estimatedSeconds - elapsed);
        const progress = task.estimatedSeconds > 0 
          ? Math.min(100, (elapsed / task.estimatedSeconds) * 100) 
          : 0;

        return (
          <div
            key={task.id}
            className={`
              bg-gray-900/90 backdrop-blur-sm rounded-lg border shadow-lg
              transition-all duration-200
              ${task.status === 'completed' 
                ? 'border-green-500/40' 
                : task.status === 'failed'
                ? 'border-red-500/40'
                : 'border-yellow-500/30'
              }
            `}
          >
            <div className="px-2.5 py-1.5 flex items-center gap-2 min-w-[180px]">
              {/* 图标 */}
              <div className={`
                w-6 h-6 rounded flex items-center justify-center shrink-0
                ${task.status === 'completed' 
                  ? 'bg-green-500/20' 
                  : task.status === 'failed'
                  ? 'bg-red-500/20'
                  : 'bg-yellow-500/20'
                }
              `}>
                {task.status === 'completed' ? (
                  <Check className="w-3.5 h-3.5 text-green-400" />
                ) : task.status === 'failed' ? (
                  <X className="w-3.5 h-3.5 text-red-400" />
                ) : (
                  <Banana className="w-3.5 h-3.5 text-yellow-400 animate-pulse" />
                )}
              </div>

              {/* 内容 */}
              <div className="flex-1 min-w-0">
                {task.status === 'pending' || task.status === 'generating' ? (
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-1 bg-gray-700 rounded-full overflow-hidden">
                      <div 
                        className="h-full bg-yellow-400 rounded-full transition-all duration-1000"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                    <span className="text-[10px] text-gray-400 tabular-nums">
                      {remaining > 0 ? `${remaining}s` : '...'}
                    </span>
                  </div>
                ) : task.status === 'completed' ? (
                  <span className="text-[11px] text-green-400">完成</span>
                ) : (
                  <span className="text-[11px] text-red-400 truncate block">失败</span>
                )}
              </div>

              {/* 操作按钮 */}
              <div className="flex items-center shrink-0">
                {task.status === 'completed' && task.resultHistoryId && (
                  <button
                    onClick={() => onViewHistory(task.resultHistoryId!)}
                    className="p-1 rounded text-green-400 hover:bg-green-500/20 transition-colors"
                    title="查看"
                  >
                    <History className="w-3.5 h-3.5" />
                  </button>
                )}
                {task.status === 'failed' && onRetry && (
                  <button
                    onClick={() => onRetry(task)}
                    className="p-1 rounded text-yellow-400 hover:bg-yellow-500/20 transition-colors"
                    title="重试"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                  </button>
                )}
                {task.status === 'failed' && onEdit && (
                  <button
                    onClick={() => onEdit(task)}
                    className="p-1 rounded text-blue-400 hover:bg-blue-500/20 transition-colors"
                    title="编辑"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                )}
                <button
                  onClick={() => onDismiss(task.id)}
                  className="p-1 rounded text-gray-500 hover:text-white hover:bg-white/10 transition-colors"
                  title="关闭"
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
