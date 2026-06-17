import { Check, Plus, Settings, Tag, Trash2, X } from 'lucide-react';
import type { ActiveVibe } from './types';

interface MobileVibeTagSheetsProps {
  activeVibes: ActiveVibe[];
  vibeTagPool: string[];
  vibeTagUsageCounts: Map<string, number>;
  vibeTagEditorTarget: { vibeId: string; current: Set<string> } | null;
  setVibeTagEditorTarget: React.Dispatch<React.SetStateAction<{ vibeId: string; current: Set<string> } | null>>;
  vibeTagSettingsOpen: boolean;
  setVibeTagSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  vibeTagSettingsCreating: boolean;
  setVibeTagSettingsCreating: React.Dispatch<React.SetStateAction<boolean>>;
  vibeTagSettingsNewName: string;
  setVibeTagSettingsNewName: React.Dispatch<React.SetStateAction<string>>;
  vibeBatchTagOpen: boolean;
  setVibeBatchTagOpen: React.Dispatch<React.SetStateAction<boolean>>;
  vibeBatchTagsToAdd: Set<string>;
  setVibeBatchTagsToAdd: React.Dispatch<React.SetStateAction<Set<string>>>;
  onSaveVibeTags: () => void;
  onCreateVibeTag: (tag: string) => void;
  onDeleteVibeTag: (tag: string) => void;
  onApplyBatchTags: () => void;
}

export function MobileVibeTagSheets({
  activeVibes,
  vibeTagPool,
  vibeTagUsageCounts,
  vibeTagEditorTarget,
  setVibeTagEditorTarget,
  vibeTagSettingsOpen,
  setVibeTagSettingsOpen,
  vibeTagSettingsCreating,
  setVibeTagSettingsCreating,
  vibeTagSettingsNewName,
  setVibeTagSettingsNewName,
  vibeBatchTagOpen,
  setVibeBatchTagOpen,
  vibeBatchTagsToAdd,
  setVibeBatchTagsToAdd,
  onSaveVibeTags,
  onCreateVibeTag,
  onDeleteVibeTag,
  onApplyBatchTags,
}: MobileVibeTagSheetsProps) {
  const closeTagSettings = () => {
    setVibeTagSettingsOpen(false);
    setVibeTagSettingsCreating(false);
  };

  const closeBatchTag = () => {
    setVibeBatchTagOpen(false);
    setVibeBatchTagsToAdd(new Set());
  };

  return (
    <>
      {vibeTagEditorTarget && (
        <div className="fixed inset-0 z-[60] bg-black/50 flex items-end" onClick={() => setVibeTagEditorTarget(null)}>
          <div className="relative w-full bg-nai-panel rounded-t-2xl max-h-[60vh] flex flex-col animate-slide-in-from-bottom" onClick={(event) => event.stopPropagation()}>
            <div className="px-4 py-3 border-b border-gray-700 flex items-center justify-between">
              <span className="font-bold text-white text-base">编辑标签</span>
              <button onClick={() => setVibeTagEditorTarget(null)} className="text-gray-400"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-4 space-y-2 overflow-y-auto">
              {vibeTagPool.map((tag) => {
                const checked = vibeTagEditorTarget.current.has(tag);
                return (
                  <label key={tag} className="flex items-center gap-2 cursor-pointer text-sm text-gray-200">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        setVibeTagEditorTarget((prev) => {
                          if (!prev) return prev;
                          const next = new Set(prev.current);
                          if (next.has(tag)) next.delete(tag);
                          else next.add(tag);
                          return { ...prev, current: next };
                        });
                      }}
                      className="accent-nai-accent"
                    />
                    <Tag className="w-3 h-3 text-gray-500" />{tag}
                  </label>
                );
              })}
              {vibeTagPool.length === 0 && <p className="text-xs text-gray-500 text-center py-4">暂无标签，请在标签管理中新建</p>}
            </div>
            <div className="p-4 border-t border-gray-700 flex gap-3">
              <button onClick={() => setVibeTagEditorTarget(null)} className="flex-1 py-3 bg-gray-700 text-gray-300 font-bold rounded-xl text-sm">取消</button>
              <button onClick={onSaveVibeTags} className="flex-1 py-3 bg-nai-accent text-black font-bold rounded-xl text-sm">保存</button>
            </div>
          </div>
        </div>
      )}

      {vibeTagSettingsOpen && (
        <div className="fixed inset-0 z-[60] bg-black/50 flex items-end" onClick={closeTagSettings}>
          <div className="relative w-full bg-nai-panel rounded-t-2xl max-h-[70vh] flex flex-col animate-slide-in-from-bottom" onClick={(event) => event.stopPropagation()}>
            <div className="px-4 py-3 border-b border-gray-700 flex items-center justify-between">
              <div className="flex items-center gap-2"><Settings className="w-4 h-4 text-nai-accent" /><span className="font-bold text-white text-base">标签管理</span><span className="text-xs text-gray-500">{vibeTagPool.length} 个</span></div>
              <button onClick={closeTagSettings} className="text-gray-400"><X className="w-5 h-5" /></button>
            </div>
            <div className="px-4 pt-3 pb-2">
              {!vibeTagSettingsCreating ? (
                <button onClick={() => { setVibeTagSettingsCreating(true); setVibeTagSettingsNewName(''); }}
                  className="w-full flex items-center justify-center gap-2 py-2 rounded-lg border-2 border-dashed border-gray-700 text-gray-400 text-xs font-bold"><Plus className="w-3.5 h-3.5" /> 新建标签</button>
              ) : (() => {
                const tag = vibeTagSettingsNewName.trim();
                const duplicate = tag.length > 0 && vibeTagPool.includes(tag);
                const canCreate = tag.length > 0 && !duplicate;
                return (
                  <div className="rounded-lg border border-nai-accent/40 bg-nai-dark/60 p-2.5 space-y-2">
                    <input
                      type="text"
                      autoFocus
                      value={vibeTagSettingsNewName}
                      onChange={(event) => setVibeTagSettingsNewName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && canCreate) onCreateVibeTag(tag);
                        if (event.key === 'Escape') {
                          setVibeTagSettingsCreating(false);
                          setVibeTagSettingsNewName('');
                        }
                      }}
                      placeholder="输入新标签名"
                      className="w-full bg-nai-dark text-white text-sm rounded-md px-3 py-2 border border-gray-700 focus:border-nai-accent focus:outline-none"
                    />
                    {duplicate && <p className="text-[11px] text-red-400">标签 "{tag}" 已存在</p>}
                    <div className="flex justify-end gap-2">
                      <button onClick={() => { setVibeTagSettingsCreating(false); setVibeTagSettingsNewName(''); }} className="px-3 py-1 text-xs text-gray-400">取消</button>
                      <button
                        disabled={!canCreate}
                        onClick={() => onCreateVibeTag(tag)}
                        className="px-3 py-1 bg-nai-accent text-black text-xs font-bold rounded-md disabled:opacity-30 flex items-center gap-1"
                      >
                        <Check className="w-3 h-3" /> 创建
                      </button>
                    </div>
                  </div>
                );
              })()}
            </div>
            <div className="flex-1 overflow-y-auto px-4 pb-4">
              {vibeTagPool.length === 0 ? (
                <div className="flex flex-col items-center py-10 text-gray-500"><Tag className="w-8 h-8 mb-2 opacity-30" /><p className="text-xs">还没有标签</p></div>
              ) : vibeTagPool.map((tag) => {
                const usage = vibeTagUsageCounts.get(tag) || 0;
                const isProtected = tag === '收藏';
                return (
                  <div key={tag} className="flex items-center gap-2 px-3 py-2.5 rounded-md">
                    <Tag className="w-3.5 h-3.5 text-gray-500 shrink-0" />
                    <span className="flex-1 text-sm text-gray-200 truncate">{tag}</span>
                    <span className="text-xs text-gray-500">{usage > 0 ? `${usage} 个` : '未使用'}</span>
                    {!isProtected && <button onClick={() => onDeleteVibeTag(tag)} className="p-1 text-gray-400 active:text-red-400"><Trash2 className="w-3.5 h-3.5" /></button>}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {vibeBatchTagOpen && (
        <div className="fixed inset-0 z-[60] bg-black/50 flex items-end" onClick={closeBatchTag}>
          <div className="relative w-full bg-nai-panel rounded-t-2xl max-h-[60vh] flex flex-col animate-slide-in-from-bottom" onClick={(event) => event.stopPropagation()}>
            <div className="px-4 py-3 border-b border-gray-700 flex items-center justify-between">
              <span className="font-bold text-white text-base">批量添加标签 ({activeVibes.length})</span>
              <button onClick={closeBatchTag} className="text-gray-400"><X className="w-5 h-5" /></button>
            </div>
            <div className="p-4 space-y-2 overflow-y-auto">
              {vibeTagPool.map((tag) => {
                const checked = vibeBatchTagsToAdd.has(tag);
                return (
                  <label key={tag} className="flex items-center gap-2 cursor-pointer text-sm text-gray-200">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        setVibeBatchTagsToAdd((prev) => {
                          const next = new Set(prev);
                          if (next.has(tag)) next.delete(tag);
                          else next.add(tag);
                          return next;
                        });
                      }}
                      className="accent-nai-accent"
                    />
                    <Tag className="w-3 h-3 text-gray-500" />{tag}
                  </label>
                );
              })}
              {vibeTagPool.length === 0 && <p className="text-xs text-gray-500 text-center py-4">暂无标签，请在标签管理中新建</p>}
            </div>
            <div className="p-4 border-t border-gray-700 flex gap-3">
              <button onClick={closeBatchTag} className="flex-1 py-3 bg-gray-700 text-gray-300 font-bold rounded-xl text-sm">取消</button>
              <button onClick={onApplyBatchTags} className="flex-1 py-3 bg-nai-accent text-black font-bold rounded-xl text-sm">应用</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
