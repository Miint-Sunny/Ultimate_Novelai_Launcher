import type { Dispatch, SetStateAction } from 'react';
import { Check, Plus, Tag, X } from 'lucide-react';

interface VibeBatchTagDialogProps {
  selectedCount: number;
  tagPool: string[];
  batchTagsToAdd: Set<string>;
  setBatchTagsToAdd: Dispatch<SetStateAction<Set<string>>>;
  batchNewTagCreating: boolean;
  setBatchNewTagCreating: Dispatch<SetStateAction<boolean>>;
  batchNewTagName: string;
  setBatchNewTagName: Dispatch<SetStateAction<string>>;
  batchTrimmedNewTagName: string;
  batchNewTagDuplicate: boolean;
  canCreateBatchNewTag: boolean;
  closeBatchTagEditor: () => void;
  submitNewBatchTag: () => void;
  applyBatchTags: () => Promise<void>;
}

export function VibeBatchTagDialog({
  selectedCount,
  tagPool,
  batchTagsToAdd,
  setBatchTagsToAdd,
  batchNewTagCreating,
  setBatchNewTagCreating,
  batchNewTagName,
  setBatchNewTagName,
  batchTrimmedNewTagName,
  batchNewTagDuplicate,
  canCreateBatchNewTag,
  closeBatchTagEditor,
  submitNewBatchTag,
  applyBatchTags,
}: VibeBatchTagDialogProps) {
  return (
    <div className="fixed inset-0 z-[101] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={closeBatchTagEditor}>
      <div className="bg-nai-panel border border-gray-700 rounded-lg shadow-2xl w-80 flex flex-col overflow-hidden animate-in zoom-in-95 duration-200" onClick={(event) => event.stopPropagation()}>
        <div className="p-4 border-b border-gray-800 flex items-center justify-between bg-nai-dark/50">
          <div className="flex items-center gap-2">
            <Tag className="w-5 h-5 text-nai-accent" />
            <span className="font-bold text-white text-base">批量添加标签 ({selectedCount})</span>
          </div>
          <button onClick={closeBatchTagEditor} className="text-gray-400 hover:text-white transition-colors"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-4 space-y-2 max-h-80 overflow-y-auto">
          {tagPool.map(tag => {
            const checked = batchTagsToAdd.has(tag);
            return (
              <label key={tag} className="flex items-center gap-2 cursor-pointer text-sm text-gray-200 hover:text-white">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => {
                    setBatchTagsToAdd(prev => {
                      const next = new Set(prev);
                      if (next.has(tag)) next.delete(tag);
                      else next.add(tag);
                      return next;
                    });
                  }}
                  className="accent-nai-accent"
                />
                <Tag className="w-3 h-3 text-gray-500" />
                {tag}
              </label>
            );
          })}
          {tagPool.length === 0 && (
            <div className="text-xs text-gray-500 text-center py-2">暂无标签，下方可新建</div>
          )}

          <div className="pt-2">
            {!batchNewTagCreating ? (
              <button
                onClick={() => { setBatchNewTagCreating(true); setBatchNewTagName(''); }}
                className="w-full flex items-center justify-center gap-2 py-2 rounded-lg border-2 border-dashed border-gray-700 hover:border-nai-accent/60 text-gray-400 hover:text-nai-accent hover:bg-nai-accent/5 text-xs font-bold transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                新建标签
              </button>
            ) : (
              <div className="rounded-lg border border-nai-accent/40 bg-nai-dark/60 p-2.5 space-y-2">
                <div className="flex items-center gap-2">
                  <Tag className="w-3.5 h-3.5 text-nai-accent shrink-0" />
                  <input
                    type="text"
                    autoFocus
                    value={batchNewTagName}
                    onChange={(event) => setBatchNewTagName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') submitNewBatchTag();
                      if (event.key === 'Escape') { setBatchNewTagCreating(false); setBatchNewTagName(''); }
                    }}
                    placeholder="输入新标签名"
                    className="flex-1 bg-nai-dark text-white text-xs rounded-md px-2 py-1.5 border border-gray-700 focus:border-nai-accent focus:outline-none transition-colors"
                  />
                </div>
                {batchNewTagDuplicate && (
                  <p className="text-[11px] text-red-400 pl-5">标签 "{batchTrimmedNewTagName}" 已存在</p>
                )}
                <div className="flex items-center justify-end gap-2">
                  <button
                    onClick={() => { setBatchNewTagCreating(false); setBatchNewTagName(''); }}
                    className="px-2.5 py-1 text-[11px] font-bold text-gray-400 hover:text-white hover:bg-white/5 rounded-md transition-colors"
                  >
                    取消
                  </button>
                  <button
                    onClick={submitNewBatchTag}
                    disabled={!canCreateBatchNewTag}
                    className="px-2.5 py-1 bg-nai-accent hover:bg-[#ebd576] text-black text-[11px] font-bold rounded-md transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex items-center gap-1"
                  >
                    <Check className="w-3 h-3" />
                    创建
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="p-4 border-t border-gray-800 flex gap-3">
          <button onClick={closeBatchTagEditor} className="flex-1 py-2.5 bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium rounded-lg transition-colors">取消</button>
          <button
            onClick={applyBatchTags}
            className="flex-1 py-2.5 bg-nai-accent hover:bg-nai-accent/90 text-black text-sm font-medium rounded-lg transition-colors"
          >
            应用
          </button>
        </div>
      </div>
    </div>
  );
}
