// 通用批量添加标签弹窗 - character / artist-style 共用
// 改进版 (vs 旧 ArtistManagerModal): 支持"+ 新建标签"直接在弹窗内创建,
// 解决"标签池空时无法启动"的死循环
import React, { useState } from 'react';
import { Plus, Tag, X } from 'lucide-react';

interface Props {
  isOpen: boolean;
  title?: string;
  selectedCount: number;
  tagPool: string[];
  onClose: () => void;
  onApply: (selectedTags: Set<string>) => void | Promise<void>;
  onCreatePoolTag?: (tag: string) => void | Promise<void>;
}

export const BatchTagModal: React.FC<Props> = ({
  isOpen, title = '批量添加标签', selectedCount,
  tagPool, onClose, onApply, onCreatePoolTag,
}) => {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [newTagInput, setNewTagInput] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  React.useEffect(() => {
    if (isOpen) {
      setSelected(new Set());
      setNewTagInput('');
      setIsCreating(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const toggle = (t: string) => {
    setSelected(prev => {
      const n = new Set(prev);
      if (n.has(t)) n.delete(t);
      else n.add(t);
      return n;
    });
  };

  const handleCreate = async () => {
    const trimmed = newTagInput.trim();
    if (!trimmed || tagPool.includes(trimmed)) return;
    if (onCreatePoolTag) await onCreatePoolTag(trimmed);
    // 创建后默认选中新标签
    setSelected(prev => {
      const n = new Set(prev);
      n.add(trimmed);
      return n;
    });
    setNewTagInput('');
    setIsCreating(false);
  };

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/55 backdrop-blur-md animate-in fade-in duration-150"
      onClick={onClose}
    >
      <div
        className="bg-nai-panel border border-gray-700 rounded-lg shadow-2xl w-[380px] flex flex-col overflow-hidden animate-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between bg-nai-dark/50">
          <div className="flex items-center gap-2">
            <Tag className="w-5 h-5 text-nai-accent" />
            <span className="font-bold text-white text-base">{title} ({selectedCount})</span>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 新建标签区 */}
        {onCreatePoolTag && (
          <div className="px-4 pt-3 pb-2 border-b border-gray-800/50">
            {isCreating ? (
              <div className="flex items-center gap-2">
                <Tag className="w-4 h-4 text-nai-accent shrink-0" />
                <input
                  type="text"
                  autoFocus
                  value={newTagInput}
                  onChange={(e) => setNewTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleCreate();
                    if (e.key === 'Escape') { setIsCreating(false); setNewTagInput(''); }
                  }}
                  placeholder="输入新标签名,回车确认"
                  className="flex-1 min-w-0 h-8 px-2.5 text-[13px] text-white bg-gray-800/60 border border-gray-700 rounded focus:border-nai-accent outline-none"
                />
                <button
                  onClick={handleCreate}
                  disabled={!newTagInput.trim() || tagPool.includes(newTagInput.trim())}
                  className="h-8 px-2.5 text-[12px] font-bold bg-nai-accent text-[#1a1410] rounded hover:bg-nai-accent-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
                >
                  添加
                </button>
                <button
                  onClick={() => { setIsCreating(false); setNewTagInput(''); }}
                  className="h-8 px-2 text-[12px] text-gray-400 hover:text-white transition-colors cursor-pointer"
                >
                  取消
                </button>
              </div>
            ) : (
              <button
                onClick={() => setIsCreating(true)}
                className="w-full flex items-center justify-center gap-2 py-2 rounded-md border border-dashed border-gray-700 hover:border-nai-accent/40 text-gray-400 hover:text-nai-accent hover:bg-nai-accent/[0.04] text-[12.5px] font-semibold transition-colors cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                新建标签
              </button>
            )}
          </div>
        )}

        <div className="px-4 py-3 space-y-1.5 max-h-64 overflow-y-auto custom-scrollbar">
          {tagPool.map(tag => (
            <label
              key={tag}
              className="flex items-center gap-2 py-1 px-1.5 rounded cursor-pointer text-sm text-gray-200 hover:text-white hover:bg-white/[0.04] transition-colors"
            >
              <input
                type="checkbox"
                checked={selected.has(tag)}
                onChange={() => toggle(tag)}
                className="accent-nai-accent"
              />
              <Tag className="w-3 h-3 text-gray-500" />
              <span className="flex-1 truncate">{tag}</span>
            </label>
          ))}
          {tagPool.length === 0 && !onCreatePoolTag && (
            <p className="text-xs text-gray-500 text-center py-4">暂无标签</p>
          )}
          {tagPool.length === 0 && onCreatePoolTag && !isCreating && (
            <p className="text-xs text-gray-500 text-center py-4">标签池为空,点击上方「新建标签」开始</p>
          )}
        </div>

        <div className="px-4 py-3 border-t border-gray-800 flex gap-3 bg-nai-dark/50">
          <button
            onClick={onClose}
            className="flex-1 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm font-bold rounded-md transition-colors cursor-pointer"
          >
            取消
          </button>
          <button
            onClick={async () => {
              await onApply(selected);
              onClose();
            }}
            disabled={selected.size === 0}
            className="flex-1 py-2 bg-nai-accent hover:bg-nai-accent-hover text-[#1a1410] text-sm font-bold rounded-md transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            应用
          </button>
        </div>
      </div>
    </div>
  );
};
