import { useEffect, useMemo, useState } from 'react';
import type React from 'react';
import { AlertTriangle, Plus, Puzzle, Trash2, X } from 'lucide-react';
import { chunkReference, lintPromptChunk } from '../../services/promptChunkMacros';
import type { PromptChunkData } from '../../services/localLibrary/promptChunks';
import { usePromptChunks } from './usePromptChunks';

interface PromptChunkManagerModalProps {
  isOpen: boolean;
  onClose: () => void;
  showToast: (message: string, type: 'success' | 'error') => void;
}

const COLORS = ['#5eead4', '#fcd34d', '#f0abfc', '#86efac', '#7dd3fc', '#fda4af', '#a5b4fc'];

interface Draft {
  id: string;
  label: string;
  expansion: string;
  category: string;
  color: string;
  createdAt?: number;
}

const emptyDraft = (): Draft => ({
  id: `chunk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  label: '',
  expansion: '',
  category: '',
  color: COLORS[0],
});

const toDraft = (chunk: PromptChunkData): Draft => ({
  id: chunk.id,
  label: chunk.label,
  expansion: chunk.expansion,
  category: chunk.category ?? '',
  color: chunk.color ?? COLORS[0],
  createdAt: chunk.createdAt,
});

/**
 * 片段管理:官方 Prompt Chunks 的本地版。列表按文件夹分组;右侧编辑一条。
 * 引用规则(`@` 插入、`!macro:名字!` 嵌套)与展开细节见 services/promptChunkMacros。
 */
export const PromptChunkManagerModal: React.FC<PromptChunkManagerModalProps> = ({ isOpen, onClose, showToast }) => {
  const { chunks, loaded, save, remove } = usePromptChunks(isOpen);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (isOpen) setDraft(emptyDraft());
  }, [isOpen]);

  const grouped = useMemo(() => {
    const map = new Map<string, PromptChunkData[]>();
    for (const chunk of chunks) {
      const key = chunk.category ?? '';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(chunk);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [chunks]);

  const lints = useMemo(() => lintPromptChunk(draft.label, draft.expansion), [draft.label, draft.expansion]);
  const hasError = lints.some((lint) => lint.level === 'error') || !draft.expansion.trim();
  const isEditingExisting = chunks.some((chunk) => chunk.id === draft.id);

  if (!isOpen) return null;

  const handleSave = async () => {
    if (hasError || saving) return;
    setSaving(true);
    try {
      const result = await save({
        id: draft.id,
        label: draft.label,
        expansion: draft.expansion,
        category: draft.category || undefined,
        color: draft.color,
        createdAt: draft.createdAt,
      });
      if (!result.ok) {
        showToast(result.reason, 'error');
        return;
      }
      showToast(isEditingExisting ? '片段已更新' : '片段已保存', 'success');
      if (!isEditingExisting) setDraft(emptyDraft());
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (chunk: PromptChunkData) => {
    await remove(chunk.id);
    if (draft.id === chunk.id) setDraft(emptyDraft());
    showToast(`已删除「${chunk.label}」`, 'success');
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-nai-panel border border-gray-700 rounded-xl shadow-2xl w-[760px] max-w-[95vw] h-[560px] max-h-[90vh] flex flex-col animate-in zoom-in-95 duration-200"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex justify-between items-center px-4 py-3 border-b border-gray-700/70">
          <h3 className="font-bold text-white flex items-center gap-2">
            <Puzzle className="w-4 h-4 text-teal-300" />
            提示词片段
            <span className="text-xs font-normal text-gray-500">提示词里打 <code className="text-teal-200">@</code> 插入;片段内用 <code className="text-teal-200">!macro:名字!</code> 嵌套</span>
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex flex-1 min-h-0">
          <div className="w-[260px] border-r border-gray-700/70 flex flex-col">
            <button
              onClick={() => setDraft(emptyDraft())}
              className="m-2 py-1.5 rounded text-xs font-bold border border-gray-700 bg-black/20 text-gray-300 hover:text-white hover:border-gray-500 transition-all flex items-center justify-center gap-1.5"
            >
              <Plus className="w-3.5 h-3.5" />
              新建片段
            </button>
            <div className="flex-1 overflow-y-auto px-2 pb-2">
              {loaded && chunks.length === 0 && (
                <div className="text-xs text-gray-500 text-center mt-8 px-4 leading-relaxed">
                  还没有片段。把常用的一段词存起来,以后在提示词里打 <code className="text-teal-200">@</code> 就能插。
                </div>
              )}
              {grouped.map(([category, items]) => (
                <div key={category || '__root'} className="mb-2">
                  {category && <div className="text-[10px] uppercase tracking-wide text-gray-500 px-1 py-1">{category}</div>}
                  {items.map((chunk) => (
                    <button
                      key={chunk.id}
                      onClick={() => setDraft(toDraft(chunk))}
                      className={`w-full text-left px-2 py-1.5 rounded flex items-center gap-2 transition-colors ${draft.id === chunk.id ? 'bg-white/[0.08]' : 'hover:bg-white/[0.04]'}`}
                      title={chunk.expansion}
                    >
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: chunk.color ?? COLORS[0] }} />
                      <span className="text-sm text-white/85 truncate flex-1">@{chunk.label}</span>
                      <span
                        role="button"
                        onClick={(event) => { event.stopPropagation(); void handleDelete(chunk); }}
                        className="text-gray-600 hover:text-red-400 transition-colors"
                        title="删除"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>

          <div className="flex-1 flex flex-col p-4 gap-3 min-w-0">
            <div className="flex gap-3">
              <label className="flex-1 flex flex-col gap-1">
                <span className="text-[11px] text-gray-500">名字(引用时区分大小写)</span>
                <input
                  value={draft.label}
                  onChange={(event) => setDraft({ ...draft, label: event.target.value })}
                  placeholder="例如 Face"
                  className="bg-black/30 border border-gray-700 rounded px-2 py-1.5 text-sm text-white outline-none focus:border-teal-400/60"
                />
              </label>
              <label className="w-[180px] flex flex-col gap-1">
                <span className="text-[11px] text-gray-500">文件夹(可空)</span>
                <input
                  value={draft.category}
                  onChange={(event) => setDraft({ ...draft, category: event.target.value })}
                  placeholder="例如 角色"
                  className="bg-black/30 border border-gray-700 rounded px-2 py-1.5 text-sm text-white outline-none focus:border-teal-400/60"
                />
              </label>
            </div>
            <label className="flex-1 flex flex-col gap-1 min-h-0">
              <span className="text-[11px] text-gray-500">正文(建议以逗号结尾;发送前重复逗号会自动去掉)</span>
              <textarea
                value={draft.expansion}
                onChange={(event) => setDraft({ ...draft, expansion: event.target.value })}
                placeholder="red eyes, long hair, "
                className="flex-1 min-h-[120px] resize-none bg-black/30 border border-gray-700 rounded px-2 py-1.5 text-sm font-tag text-white outline-none focus:border-teal-400/60"
              />
            </label>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-gray-500">颜色</span>
              {COLORS.map((color) => (
                <button
                  key={color}
                  onClick={() => setDraft({ ...draft, color })}
                  className={`w-4 h-4 rounded-full border ${draft.color === color ? 'border-white scale-110' : 'border-transparent'} transition-transform`}
                  style={{ backgroundColor: color }}
                  aria-label={color}
                />
              ))}
              <span className="ml-auto text-[11px] font-mono text-gray-500">{draft.label.trim() ? chunkReference(draft.label.trim()) : ''}</span>
            </div>
            {lints.length > 0 && (
              <div className="flex flex-col gap-1">
                {lints.map((lint) => (
                  <div key={lint.message} className={`flex items-start gap-1.5 text-[11px] ${lint.level === 'error' ? 'text-red-400' : 'text-amber-400/90'}`}>
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
                    <span>{lint.message}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => void handleSave()}
                disabled={hasError || saving}
                className="px-4 py-1.5 rounded text-xs font-bold bg-nai-accent text-black disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
              >
                {isEditingExisting ? '保存修改' : '保存片段'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
