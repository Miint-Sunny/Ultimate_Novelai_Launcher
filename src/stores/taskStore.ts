import { create } from 'zustand';

export type TaskStatus = 'generating' | 'success' | 'error';

export interface Task {
    id: string;           // 服务端 task_id（唯一标识）
    status: TaskStatus;
    imageUrl: string;     // 图片 URL（非 base64）
    modelId: string;
    prompt: string;
    timestamp: number;
    aspectRatio: string;
    error?: string;
    estimatedSeconds: number | null;
    refImages?: string[]; // 参考图 base64（用于重试）
}

interface TaskStore {
    tasks: Task[];
    deletedIds: Set<string>;

    addTask: (task: Task) => void;
    updateTask: (id: string, patch: Partial<Task>) => void;
    removeTask: (id: string) => void;
    replaceTaskId: (oldId: string, newId: string) => void;
    mergeTasks: (newTasks: Task[]) => void;
}

export const useTaskStore = create<TaskStore>((set, get) => ({
    tasks: [],
    deletedIds: new Set<string>(),

    addTask: (task) => set((state) => ({
        tasks: [task, ...state.tasks],
    })),

    updateTask: (id, patch) => set((state) => ({
        tasks: state.tasks.map(t => t.id === id ? { ...t, ...patch } : t),
    })),

    removeTask: (id) => {
        const deletedIds = new Set(get().deletedIds);
        deletedIds.add(id);
        set((state) => ({
            tasks: state.tasks.filter(t => t.id !== id),
            deletedIds,
        }));
    },

    // 提交后用 serverTaskId 替换临时 localId
    replaceTaskId: (oldId, newId) => set((state) => ({
        tasks: state.tasks.map(t => t.id === oldId ? { ...t, id: newId } : t),
    })),

    // 从服务器增量合并（只添加不存在的任务）
    mergeTasks: (newTasks) => set((state) => {
        const existingIds = new Set(state.tasks.map(t => t.id));
        const toAdd = newTasks.filter(t =>
            !existingIds.has(t.id) && !state.deletedIds.has(t.id)
        );
        if (toAdd.length === 0) return state;
        return { tasks: [...toAdd, ...state.tasks] };
    }),
}));
