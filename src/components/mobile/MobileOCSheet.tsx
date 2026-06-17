import { Check, Copy, Edit2, Filter, Loader2, Plus, RefreshCw, User, X } from 'lucide-react';
import { copyToClipboard } from '../../utils/clipboard';
import type { useMobileOCManager } from './generate/useMobileOCManager';

type MobileOCManager = ReturnType<typeof useMobileOCManager>;

interface MobileOCSheetProps {
  isOpen: boolean;
  onClose: () => void;
  characterPromptCount: number;
  manager: MobileOCManager;
}

export function MobileOCSheet({ isOpen, onClose, characterPromptCount, manager }: MobileOCSheetProps) {
  if (!isOpen) return null;

  const switchTabBySwipe = (event: React.TouchEvent<HTMLDivElement>) => {
    const target = event.currentTarget as HTMLDivElement & { _touchStartX?: number; _touchStartY?: number };
    const startX = target._touchStartX;
    const startY = target._touchStartY;
    if (startX === undefined || startY === undefined) return;
    const touch = event.changedTouches[0];
    const deltaX = touch.clientX - startX;
    const deltaY = touch.clientY - startY;
    if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 50) {
      if (deltaX > 0 && manager.ocTab === 'local') manager.setOcTab('public');
      else if (deltaX < 0 && manager.ocTab === 'public') manager.setOcTab('local');
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-end animate-fade-in">
      <div className="absolute inset-0" onClick={onClose} />
      <div className="relative w-full bg-nai-panel rounded-t-2xl h-[85vh] flex flex-col animate-slide-in-from-bottom safe-area-bottom">
        <div className="flex-shrink-0 flex items-center justify-between p-4 border-b border-gray-700">
          <div className="flex items-center gap-2">
            <User className="w-5 h-5 text-cyan-400" />
            <h3 className="text-lg font-bold text-white">OC 角色</h3>
            {manager.isLoadingOCs && <Loader2 className="w-4 h-4 text-gray-400 animate-spin" />}
          </div>
          <div className="flex items-center gap-1">
            <button onClick={manager.loadOCs} className="p-2 text-gray-400 active:scale-95 transition-all" title="刷新">
              <RefreshCw className="w-4 h-4" />
            </button>
            <button onClick={onClose} className="p-2 -mr-2 text-gray-400">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="flex-shrink-0 flex border-b border-gray-700">
          <button
            className={`flex-1 py-3 text-sm font-medium transition-colors border-b-2 ${manager.ocTab === 'public' ? 'border-cyan-500 text-white bg-white/5' : 'border-transparent text-gray-400'}`}
            onClick={() => manager.setOcTab('public')}
          >
            公共OC ({manager.ocPublicFiles.length})
          </button>
          <button
            className={`flex-1 py-3 text-sm font-medium transition-colors border-b-2 ${manager.ocTab === 'local' ? 'border-cyan-500 text-white bg-white/5' : 'border-transparent text-gray-400'}`}
            onClick={() => manager.setOcTab('local')}
          >
            我的OC ({manager.ocLocalFiles.length})
          </button>
        </div>

        <div
          className="flex-1 overflow-hidden relative flex flex-col min-h-0"
          onTouchStart={(event) => {
            const touch = event.touches[0];
            const target = event.currentTarget as HTMLDivElement & { _touchStartX?: number; _touchStartY?: number };
            target._touchStartX = touch.clientX;
            target._touchStartY = touch.clientY;
          }}
          onTouchEnd={switchTabBySwipe}
        >
          <div className="flex-shrink-0 p-3 border-b border-gray-700/50 bg-nai-panel/60">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input
                  type="text"
                  value={manager.ocSearchQuery}
                  onChange={(event) => manager.setOcSearchQuery(event.target.value)}
                  placeholder={manager.ocTab === 'public' ? '搜索公共 OC...' : '搜索我的 OC...'}
                  className="w-full rounded-xl border border-gray-700 bg-gray-800/60 px-3 py-2.5 pr-10 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:border-cyan-500"
                />
                <Filter className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
              </div>
              {manager.ocTab === 'local' && (
                <button onClick={manager.openCreateOC} className="flex items-center justify-center gap-2 rounded-xl bg-cyan-500/15 px-4 py-2.5 text-cyan-300 active:scale-[0.98] transition-all">
                  <Plus className="w-4 h-4" />
                  <span className="text-sm font-medium">添加</span>
                </button>
              )}
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto">
            {manager.isLoadingOCs ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
              </div>
            ) : manager.filteredOCs.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-gray-500">
                <User className="w-12 h-12 mb-3 opacity-50" />
                <p>{manager.ocTab === 'public' ? '暂无公共OC' : '暂无我的OC'}</p>
                {manager.ocTab === 'local' && <p className="text-xs mt-2 text-gray-600">点击上方按钮添加</p>}
                <p className="text-xs mt-4 text-gray-600">← 左右滑动切换 →</p>
              </div>
            ) : (
              <div className="p-3 pb-24 grid grid-cols-3 gap-2">
                {manager.filteredOCs.map((oc) => {
                  const isSelected = manager.selectedOCIds.has(oc.id);
                  return (
                    <div
                      key={oc.id}
                      className={`relative rounded-xl border overflow-hidden transition-all ${isSelected ? 'border-cyan-500 ring-2 ring-cyan-500/30' : 'border-gray-700 active:border-gray-600'}`}
                      onClick={() => manager.handleToggleOCSelection(oc)}
                    >
                      <div className="aspect-[3/4] bg-gray-800">
                        {oc.preview ? (
                          <img src={oc.preview} alt={oc.name} className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center">
                            <User className="w-8 h-8 text-gray-600" />
                          </div>
                        )}
                      </div>
                      <div className={`px-2 py-1.5 text-xs font-medium truncate text-center ${isSelected ? 'bg-cyan-500/20 text-cyan-300' : 'bg-gray-800/80 text-gray-300'}`}>
                        {oc.name}
                      </div>
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          copyToClipboard(oc.positive);
                          manager.setCopiedOCId(oc.id);
                          window.setTimeout(() => {
                            manager.setCopiedOCId((prev) => (prev === oc.id ? null : prev));
                          }, 1200);
                        }}
                        className={`absolute top-1.5 right-1.5 h-8 min-w-8 rounded-full px-2 flex items-center justify-center ${manager.copiedOCId === oc.id ? 'bg-green-600 text-white' : 'bg-black/65 text-gray-100'}`}
                        title={manager.copiedOCId === oc.id ? '已复制' : '复制提示词'}
                      >
                        {manager.copiedOCId === oc.id ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                      </button>
                      {manager.ocTab === 'local' && (
                        <button
                          onClick={(event) => {
                            event.stopPropagation();
                            manager.openEditOC(oc);
                          }}
                          className="absolute top-1.5 left-1.5 h-8 min-w-8 rounded-full bg-black/65 px-2 flex items-center justify-center text-gray-100"
                          title="编辑"
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="flex-shrink-0 p-4 border-t border-gray-700 bg-nai-panel">
          <div className="grid grid-cols-3 gap-2">
            <button
              onClick={() => manager.setSelectedOCIds(new Set())}
              disabled={manager.selectedOCIds.size === 0}
              className="py-3 bg-gray-700 text-gray-300 font-bold rounded-xl active:scale-[0.98] transition-all disabled:opacity-50 disabled:active:scale-100"
            >
              清空选择
            </button>
            <button
              onClick={manager.handleConfirmOC}
              disabled={manager.selectedOCIds.size === 0 || characterPromptCount >= 6}
              className="col-span-2 py-3 bg-cyan-500 text-white font-bold rounded-xl active:scale-[0.98] transition-all disabled:opacity-50"
            >
              添加{manager.selectedOCIds.size > 0 && ` (${manager.selectedOCIds.size})`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
