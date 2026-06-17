import { Check, Image as ImageIcon, Loader2, User, X } from 'lucide-react';
import type { useMobilePreciseReferences } from './generate/useMobilePreciseReferences';

type MobilePreciseReferenceLibrary = ReturnType<typeof useMobilePreciseReferences>;

interface MobilePreciseReferenceSheetProps {
  isOpen: boolean;
  onClose: () => void;
  library: MobilePreciseReferenceLibrary;
}

export function MobilePreciseReferenceSheet({
  isOpen,
  onClose,
  library,
}: MobilePreciseReferenceSheetProps) {
  if (!isOpen) return null;

  const currentFiles = library.crTab === 'public' ? library.crPublicFiles : library.crLocalFiles;

  const switchTabBySwipe = (event: React.TouchEvent<HTMLDivElement>) => {
    const target = event.currentTarget as HTMLDivElement & { _touchStartX?: number; _touchStartY?: number };
    const startX = target._touchStartX;
    const startY = target._touchStartY;
    if (startX === undefined || startY === undefined) return;
    const touch = event.changedTouches[0];
    const deltaX = touch.clientX - startX;
    const deltaY = touch.clientY - startY;
    if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 50) {
      if (deltaX > 0 && library.crTab === 'local') library.setCrTab('public');
      else if (deltaX < 0 && library.crTab === 'public') library.setCrTab('local');
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-end animate-fade-in">
      <div className="absolute inset-0" onClick={onClose} />
      <div className="relative w-full bg-nai-panel rounded-t-2xl h-[85vh] flex flex-col animate-slide-in-from-bottom safe-area-bottom">
        <div className="flex-shrink-0 flex items-center justify-between p-4 border-b border-gray-700">
          <h3 className="text-lg font-bold text-white">角色管理器</h3>
          <button onClick={onClose} className="p-2 -mr-2 text-gray-400">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-shrink-0 flex border-b border-gray-700">
          <button
            className={`flex-1 py-3 text-sm font-medium transition-colors border-b-2 ${library.crTab === 'public' ? 'border-cyan-500 text-white bg-white/5' : 'border-transparent text-gray-400'}`}
            onClick={() => library.setCrTab('public')}
          >
            公共 ({library.crPublicFiles.length})
          </button>
          <button
            className={`flex-1 py-3 text-sm font-medium transition-colors border-b-2 ${library.crTab === 'local' ? 'border-cyan-500 text-white bg-white/5' : 'border-transparent text-gray-400'}`}
            onClick={() => library.setCrTab('local')}
          >
            我的 ({library.crLocalFiles.length})
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
          {library.crTab === 'local' && (
            <div className="flex-shrink-0 p-3 border-b border-gray-700/50">
              <label className="flex items-center justify-center gap-2 py-2.5 bg-gray-700/50 text-gray-300 rounded-xl active:scale-[0.98] active:bg-gray-600/50 transition-all cursor-pointer">
                <ImageIcon className="w-4 h-4" />
                <span className="text-sm font-medium">导入图片</span>
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    await library.importLocalCRImage(file);
                    event.target.value = '';
                  }}
                />
              </label>
            </div>
          )}

          <div className="h-full overflow-y-auto">
            {library.isLoadingCRs ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
              </div>
            ) : currentFiles.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-gray-500">
                <User className="w-12 h-12 mb-3 opacity-50" />
                <p>{library.crTab === 'public' ? '暂无公共角色' : '暂无我的角色'}</p>
                {library.crTab === 'local' && <p className="text-xs mt-2 text-gray-600">点击上方按钮添加</p>}
                <p className="text-xs mt-4 text-gray-600">← 左右滑动切换 →</p>
              </div>
            ) : (
              <div className="p-3 space-y-2">
                {currentFiles.map((cr) => {
                  const isSelected = library.activePreciseRefs.some((item) => item.id === cr.id);
                  return (
                    <div
                      key={cr.id}
                      className={`flex items-center gap-3 p-3 rounded-xl border transition-all ${isSelected ? 'bg-cyan-500/10 border-cyan-500/50' : 'bg-gray-800/50 border-gray-700 active:bg-gray-700/50'}`}
                      onClick={() => library.handleSelectCR(cr)}
                    >
                      <div className={`w-6 h-6 rounded-full border-2 flex items-center justify-center transition-colors ${isSelected ? 'bg-cyan-500 border-cyan-500' : 'border-gray-500 bg-transparent'}`}>
                        {isSelected && <Check className="w-4 h-4 text-white" />}
                      </div>
                      {cr.preview ? (
                        <img src={cr.preview} alt={cr.name} className="w-12 h-12 rounded-lg object-cover" />
                      ) : (
                        <div className="w-12 h-12 rounded-lg bg-gray-700 flex items-center justify-center">
                          <User className="w-5 h-5 text-gray-500" />
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className={`font-medium truncate ${isSelected ? 'text-cyan-300' : 'text-white'}`}>
                          {cr.name}
                        </div>
                      </div>
                      {library.crTab === 'local' && (
                        <button
                          onClick={async (event) => {
                            event.stopPropagation();
                            await library.deleteLocalCR(cr);
                          }}
                          className="w-8 h-8 rounded-full bg-gray-700/50 flex items-center justify-center text-gray-500 hover:text-red-400 active:scale-95 transition-all"
                        >
                          <X className="w-4 h-4" />
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
          <div className="flex gap-3">
            <button
              onClick={() => library.setActivePreciseRefs([])}
              disabled={library.activePreciseRefs.length === 0}
              className="flex-1 py-3 bg-gray-700 text-gray-300 font-bold rounded-xl active:scale-[0.98] transition-all disabled:opacity-50 disabled:active:scale-100"
            >
              清空
            </button>
            <button
              onClick={onClose}
              className="flex-1 py-3 bg-cyan-500 text-white font-bold rounded-xl active:scale-[0.98] transition-all"
            >
              确认 {library.activePreciseRefs.length > 0 && `(${library.activePreciseRefs.length})`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
