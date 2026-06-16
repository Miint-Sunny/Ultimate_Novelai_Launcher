import type { Dispatch, SetStateAction } from 'react';
import { Check, File, Plus, Tag, X } from 'lucide-react';
import type { VibeImportItem } from './useVibeImportFlow';

interface VibeImportDialogProps {
  importItems: VibeImportItem[];
  setImportItems: Dispatch<SetStateAction<VibeImportItem[] | null>>;
  tagPool: string[];
  importItemNewTagDraft: Record<string, string>;
  setImportItemNewTagDraft: Dispatch<SetStateAction<Record<string, string>>>;
  toggleItemTag: (uid: string, tag: string) => void;
  addNewTagToItem: (uid: string, tag: string) => void;
  confirmVibeImport: () => Promise<void>;
}

export function VibeImportDialog({
  importItems,
  setImportItems,
  tagPool,
  importItemNewTagDraft,
  setImportItemNewTagDraft,
  toggleItemTag,
  addNewTagToItem,
  confirmVibeImport,
}: VibeImportDialogProps) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => setImportItems(null)}>
      <div
        className="bg-nai-panel border border-gray-700 rounded-xl shadow-2xl w-[520px] max-h-[85vh] flex flex-col overflow-hidden animate-in zoom-in-95 duration-200"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-gray-800 flex items-center justify-between bg-nai-dark/50 shrink-0">
          <div className="flex items-center gap-2">
            <File className="w-5 h-5 text-nai-accent" />
            <span className="font-bold text-white text-base">
              {importItems.length === 1 ? '导入 Vibe' : `导入 ${importItems.length} 个 Vibe`}
            </span>
          </div>
          <button onClick={() => setImportItems(null)} className="text-gray-400 hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {importItems.map((item, idx) => (
            <div
              key={item.uid}
              className="bg-nai-input/60 border border-gray-700/50 rounded-xl overflow-hidden hover:border-gray-600/60 transition-colors"
            >
              <div className="flex items-start gap-4 p-4 pb-3">
                <div className="shrink-0 w-20 h-20 rounded-lg overflow-hidden bg-gray-900 border border-gray-700/60 flex items-center justify-center">
                  {item.vibeData.preview ? (
                    <img src={item.vibeData.preview} alt={item.name} className="w-full h-full object-cover" />
                  ) : (
                    <File className="w-8 h-8 text-gray-600" />
                  )}
                </div>
                <div className="flex-1 min-w-0 pt-0.5">
                  <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-1 font-semibold">名称</div>
                  <input
                    type="text"
                    value={item.name}
                    onChange={(event) => {
                      const newName = event.target.value;
                      setImportItems(items => items?.map(current =>
                        current.uid === item.uid ? { ...current, name: newName } : current
                      ) || null);
                    }}
                    placeholder="为这个 Vibe 起个名字"
                    className="w-full bg-nai-dark text-white text-sm rounded-md px-3 py-2 border border-gray-700/80 focus:border-nai-accent focus:outline-none transition-colors"
                    autoFocus={idx === 0}
                  />
                </div>
                {importItems.length > 1 && (
                  <button
                    onClick={() => {
                      setImportItems(items => items?.filter(current => current.uid !== item.uid) || null);
                    }}
                    className="shrink-0 p-1.5 text-gray-500 hover:text-red-400 rounded-md hover:bg-red-400/10 transition-colors"
                    title="从导入列表移除"
                  >
                    <X className="w-4 h-4" />
                  </button>
                )}
              </div>

              <div className="px-4 pb-3 grid grid-cols-2 gap-x-4 gap-y-2">
                <div>
                  <div className="flex justify-between items-baseline mb-1.5">
                    <label className="text-xs text-gray-400">Strength</label>
                    <span className="text-xs text-nai-accent font-mono tabular-nums">{item.strength.toFixed(2)}</span>
                  </div>
                  <input
                    type="range" min="0" max="1" step="0.01"
                    value={item.strength}
                    onChange={(event) => {
                      const value = parseFloat(event.target.value);
                      setImportItems(items => items?.map(current =>
                        current.uid === item.uid ? { ...current, strength: value } : current
                      ) || null);
                    }}
                    className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-nai-accent"
                  />
                </div>
                <div>
                  <div className="flex justify-between items-baseline mb-1.5">
                    <label className="text-xs text-gray-400">Info Extracted</label>
                    <span className="text-xs text-nai-accent font-mono tabular-nums">{item.infoExtracted.toFixed(2)}</span>
                  </div>
                  <input
                    type="range" min="0" max="1" step="0.01"
                    value={item.infoExtracted}
                    onChange={(event) => {
                      const value = parseFloat(event.target.value);
                      setImportItems(items => items?.map(current =>
                        current.uid === item.uid ? { ...current, infoExtracted: value } : current
                      ) || null);
                    }}
                    className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-nai-accent"
                  />
                </div>
              </div>

              <div className="border-t border-gray-700/50 bg-nai-dark/30 px-4 py-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-1.5 text-xs text-gray-400">
                    <Tag className="w-3 h-3" />
                    <span>标签</span>
                  </div>
                  {item.tags.size > 0 && (
                    <span className="text-[10px] text-nai-accent">{item.tags.size} 个已选</span>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {tagPool.length === 0 && (
                    <span className="text-[11px] text-gray-600 italic">还没有标签，下方输入框创建第一个</span>
                  )}
                  {tagPool.map(tag => {
                    const active = item.tags.has(tag);
                    return (
                      <button
                        key={tag}
                        onClick={() => toggleItemTag(item.uid, tag)}
                        className={`px-2.5 py-1 text-[11px] font-bold rounded-full transition-colors flex items-center gap-1 border ${
                          active
                            ? 'bg-nai-accent text-black border-nai-accent shadow-sm'
                            : 'bg-gray-800/80 text-gray-400 border-gray-700/50 hover:text-gray-200 hover:border-gray-600 hover:bg-gray-700/60'
                        }`}
                      >
                        {tag}
                      </button>
                    );
                  })}
                  {importItemNewTagDraft[item.uid] !== undefined ? (
                    <div className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-gray-800 border border-nai-accent/50">
                      <input
                        type="text"
                        autoFocus
                        value={importItemNewTagDraft[item.uid] || ''}
                        onChange={(event) => setImportItemNewTagDraft(prev => ({ ...prev, [item.uid]: event.target.value }))}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            const value = (importItemNewTagDraft[item.uid] || '').trim();
                            if (value) addNewTagToItem(item.uid, value);
                            setImportItemNewTagDraft(prev => { const next = { ...prev }; delete next[item.uid]; return next; });
                          }
                          if (event.key === 'Escape') {
                            setImportItemNewTagDraft(prev => { const next = { ...prev }; delete next[item.uid]; return next; });
                          }
                        }}
                        onBlur={() => {
                          const value = (importItemNewTagDraft[item.uid] || '').trim();
                          if (value) addNewTagToItem(item.uid, value);
                          setImportItemNewTagDraft(prev => { const next = { ...prev }; delete next[item.uid]; return next; });
                        }}
                        placeholder="标签名"
                        className="w-16 bg-transparent text-[11px] text-white focus:outline-none placeholder:text-gray-500 leading-none"
                      />
                      <button
                        onMouseDown={(event) => {
                          event.preventDefault();
                          const value = (importItemNewTagDraft[item.uid] || '').trim();
                          if (value) addNewTagToItem(item.uid, value);
                          setImportItemNewTagDraft(prev => { const next = { ...prev }; delete next[item.uid]; return next; });
                        }}
                        className="p-0.5 text-green-400 hover:text-green-300 transition-colors"
                      >
                        <Check className="w-3 h-3" />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setImportItemNewTagDraft(prev => ({ ...prev, [item.uid]: '' }))}
                      className="px-2.5 py-1 text-[11px] rounded-full bg-gray-800/80 text-gray-400 border border-gray-700/50 hover:text-gray-200 hover:border-gray-600 transition-colors flex items-center gap-1"
                    >
                      <Plus className="w-3 h-3" />
                      新建
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="px-5 py-4 border-t border-gray-800 flex gap-3 shrink-0 bg-nai-dark/30">
          <button
            onClick={() => setImportItems(null)}
            className="flex-1 py-2.5 bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium rounded-lg transition-colors"
          >
            取消
          </button>
          <button
            onClick={confirmVibeImport}
            disabled={importItems.length === 0}
            className="flex-1 py-2.5 bg-nai-accent hover:bg-[#ebd576] text-black text-sm font-bold rounded-lg transition-colors disabled:opacity-50"
          >
            确认导入{importItems.length > 1 ? ` (${importItems.length})` : ''}
          </button>
        </div>
      </div>
    </div>
  );
}
