import { Check, Cloud, Download, FileUp, Globe, HardDrive, Image as ImageIcon, Loader2, Palette, Plus, Search, Settings, Tag, Trash2, X } from 'lucide-react';
import { CloudManageModal } from '../vibe/CloudManageModal';
import type { useMobileVibeLibrary } from './generate/useMobileVibeLibrary';
import { MobileVibeListItem } from './MobileVibeListItem';
import { MobileVibeTagSheets } from './MobileVibeTagSheets';

type MobileVibeLibrary = ReturnType<typeof useMobileVibeLibrary>;

interface MobileVibeManagerSheetProps {
  isOpen: boolean;
  onClose: () => void;
  library: MobileVibeLibrary;
}

export function MobileVibeManagerSheet({ isOpen, onClose, library }: MobileVibeManagerSheetProps) {
  if (!isOpen) return null;

  const closeSheet = () => {
    library.setVibeMenuOpenId(null);
    library.setVibeFabOpen(false);
    onClose();
  };

  const switchTabBySwipe = (event: React.TouchEvent<HTMLDivElement>) => {
    const target = event.currentTarget as HTMLDivElement & { _tsx?: number; _tsy?: number };
    const startX = target._tsx;
    const startY = target._tsy;
    if (startX === undefined || startY === undefined) return;
    const touch = event.changedTouches[0];
    const deltaX = touch.clientX - startX;
    const deltaY = touch.clientY - startY;
    if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 50) {
      if (deltaX > 0 && library.vibeTab === 'local') library.setVibeTab('public');
      else if (deltaX < 0 && library.vibeTab === 'public') library.setVibeTab('local');
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/70 flex items-end animate-fade-in">
        <div className="absolute inset-0" onClick={closeSheet} />
        <div className="relative w-full bg-nai-panel rounded-t-2xl h-[85vh] flex flex-col animate-slide-in-from-bottom safe-area-bottom">
          <div className="flex-shrink-0 flex items-center justify-between px-4 py-3 border-b border-gray-700">
            <div className="flex items-center gap-2">
              <Settings className="w-5 h-5 text-nai-accent" />
              <h3 className="text-lg font-bold text-white">Vibe管理器</h3>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => library.setVibeCloudMenuOpen(true)}
                className="w-9 h-9 rounded-lg flex items-center justify-center border border-gray-700 bg-gray-800 text-gray-400 active:text-nai-accent transition-colors"
              >
                <Cloud className="w-4 h-4" />
              </button>
              <button onClick={closeSheet} className="p-1.5 text-gray-400">
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          <div className="flex-shrink-0 px-3 py-2 border-b border-gray-700/50">
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
              <input
                type="text"
                value={library.vibeSearchQuery}
                onChange={(event) => library.setVibeSearchQuery(event.target.value)}
                placeholder="搜索..."
                className="w-full h-10 bg-gray-800/70 text-sm text-gray-200 rounded-lg pl-9 pr-9 border border-gray-700 focus:border-nai-accent focus:outline-none"
              />
              {library.vibeSearchQuery && (
                <button onClick={() => library.setVibeSearchQuery('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500"><X className="w-4 h-4" /></button>
              )}
            </div>
          </div>

          <div className="flex-shrink-0 flex border-b border-gray-700">
            <button className={`flex-1 py-3 text-sm font-bold transition-colors border-b-2 ${library.vibeTab === 'public' ? 'border-nai-accent text-white bg-white/5' : 'border-transparent text-gray-400'}`} onClick={() => library.setVibeTab('public')}>
              <div className="flex items-center justify-center gap-1.5"><Globe className="w-4 h-4" />公共 Vibe</div>
            </button>
            <button className={`flex-1 py-3 text-sm font-bold transition-colors border-b-2 ${library.vibeTab === 'local' ? 'border-nai-accent text-white bg-white/5' : 'border-transparent text-gray-400'}`} onClick={() => library.setVibeTab('local')}>
              <div className="flex items-center justify-center gap-1.5"><HardDrive className="w-4 h-4" />我的Vibe</div>
            </button>
          </div>

          <div
            className="flex-1 overflow-hidden relative flex flex-col min-h-0"
            onTouchStart={(event) => {
              const touch = event.touches[0];
              const target = event.currentTarget as HTMLDivElement & { _tsx?: number; _tsy?: number };
              target._tsx = touch.clientX;
              target._tsy = touch.clientY;
            }}
            onTouchEnd={switchTabBySwipe}
          >
            <div className="h-full overflow-y-auto">
              {library.isLoadingVibes ? (
                <div className="flex items-center justify-center py-12"><Loader2 className="w-8 h-8 animate-spin text-gray-400" /></div>
              ) : library.vibeTab === 'public' ? (
                <div className="p-3 space-y-2">
                  <div className="flex items-center gap-1.5 text-sm text-gray-400 mb-1.5">
                    <Globe className="w-4 h-4" />
                    <span className="font-bold">公共库</span>
                    <span className="text-gray-500">({library.filteredPublicVibes.length})</span>
                  </div>
                  {library.filteredPublicVibes.length === 0 ? (
                    <div className="flex flex-col items-center py-12 text-gray-500"><Palette className="w-12 h-12 mb-3 opacity-50" /><p className="text-sm">暂无公共Vibe</p></div>
                  ) : library.filteredPublicVibes.map((vibe) => {
                    const isAdded = library.activeVibes.some((active) => active.id === vibe.id);
                    return (
                      <MobileVibeListItem
                        key={vibe.id}
                        vibe={vibe}
                        isPublic
                        isAdded={isAdded}
                        isCompatible={library.isVibeCompatibleWithModel(vibe)}
                        isCollected={library.localVibeFiles.some((local) => local.id === vibe.id)}
                        isCollecting={library.collectingVibeIds.has(vibe.id)}
                        onToggle={() => { if (isAdded) library.setActiveVibes((prev) => prev.filter((active) => active.id !== vibe.id)); else void library.handleAddVibe(vibe); }}
                        onCollect={() => library.handleCollectPublicVibe(vibe)}
                      />
                    );
                  })}
                </div>
              ) : (
                <div className="p-3 space-y-2">
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-1.5 text-sm text-gray-400">
                      <span className="font-bold">{library.vibeSelectedTagFilter.size > 0 ? '已筛选' : '全部 Vibe'}</span>
                      <span className="text-gray-500">({library.vibeTagFilteredLocalFiles.length})</span>
                    </div>
                    <button onClick={() => library.setVibeTagSettingsOpen(true)} className="p-1.5 text-gray-500 active:text-nai-accent rounded active:bg-white/5 transition-colors" title="标签管理"><Settings className="w-4 h-4" /></button>
                  </div>

                  {library.vibeTagPool.length > 0 && (
                    <div className="flex items-center gap-1.5 overflow-x-auto pb-1.5 scrollbar-hide mb-1.5">
                      <button onClick={() => library.setVibeSelectedTagFilter(new Set())}
                        className={`shrink-0 px-3 py-1.5 text-xs font-bold rounded-full ${library.vibeSelectedTagFilter.size === 0 ? 'bg-nai-accent text-black' : 'bg-gray-800 text-gray-400'}`}>全部</button>
                      {library.vibeTagPool.map((tag) => (
                        <button key={tag} onClick={() => library.setVibeSelectedTagFilter((prev) => { const next = new Set(prev); if (next.has(tag)) next.delete(tag); else next.add(tag); return next; })}
                          className={`shrink-0 px-3 py-1.5 text-xs font-bold rounded-full flex items-center gap-1 ${library.vibeSelectedTagFilter.has(tag) ? 'bg-nai-accent text-black' : 'bg-gray-800 text-gray-400'}`}>
                          <Tag className="w-3 h-3" />{tag}
                        </button>
                      ))}
                    </div>
                  )}

                  {library.vibeTagFilteredLocalFiles.length === 0 ? (
                    <div className="flex flex-col items-center py-10 text-gray-500"><Palette className="w-10 h-10 mb-2 opacity-30" /><p className="text-sm">暂无我的Vibe</p><p className="text-xs mt-1 text-gray-600">点击上方按钮导入</p></div>
                  ) : library.vibeTagFilteredLocalFiles.map((vibe) => {
                    const isAdded = library.activeVibes.some((active) => active.id === vibe.id);
                    return (
                      <MobileVibeListItem
                        key={vibe.id}
                        vibe={vibe}
                        isAdded={isAdded}
                        isCompatible={library.isVibeCompatibleWithModel(vibe)}
                        menuOpen={library.vibeMenuOpenId === vibe.id}
                        onToggle={() => { if (isAdded) library.setActiveVibes((prev) => prev.filter((active) => active.id !== vibe.id)); else void library.handleAddVibe(vibe); }}
                        onOpenMenu={() => library.setVibeMenuOpenId((prev) => prev === vibe.id ? null : vibe.id)}
                        onCloseMenu={() => library.setVibeMenuOpenId(null)}
                        onEditTags={() => {
                          library.setVibeMenuOpenId(null);
                          library.setVibeTagEditorTarget({ vibeId: vibe.id, current: new Set((vibe as { tags?: string[] }).tags || []) });
                        }}
                        onDelete={async () => {
                          library.setVibeMenuOpenId(null);
                          await library.deleteLocalVibe(vibe);
                        }}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="flex-shrink-0 relative border-t border-gray-700 bg-nai-panel">
            {library.vibeTab === 'local' && (
              <>
                {library.vibeFabOpen && <div className="fixed inset-0 z-[8]" onClick={() => library.setVibeFabOpen(false)} />}
                <button
                  onClick={() => library.setVibeFabOpen((prev) => !prev)}
                  className={`absolute -top-16 right-4 z-10 w-12 h-12 rounded-full shadow-lg flex items-center justify-center active:scale-95 transition-colors ${library.vibeFabOpen ? 'bg-gray-700 border border-gray-600' : 'bg-nai-accent border border-nai-accent'}`}
                >
                  <Plus className={`w-6 h-6 transition-transform duration-200 ${library.vibeFabOpen ? 'text-white rotate-45' : 'text-black rotate-0'}`} />
                </button>
                {library.vibeFabOpen && (
                  <div className="absolute -top-40 right-4 z-10 flex flex-col items-end gap-2 animate-in fade-in slide-in-from-bottom-2 duration-150">
                    <label className="flex items-center gap-2 pl-4 pr-5 py-2.5 bg-gray-800 border border-gray-600 rounded-full shadow-lg cursor-pointer active:bg-gray-700 transition-colors">
                      <ImageIcon className="w-4 h-4 text-nai-accent" />
                      <span className="text-sm font-bold text-white">导入图片</span>
                      <input type="file" accept="image/*" className="hidden" onChange={async (event) => { const file = event.target.files?.[0]; if (!file) return; await library.handleUnifiedVibeImport(file); event.target.value = ''; library.setVibeFabOpen(false); }} />
                    </label>
                    <label className="flex items-center gap-2 pl-4 pr-5 py-2.5 bg-gray-800 border border-gray-600 rounded-full shadow-lg cursor-pointer active:bg-gray-700 transition-colors">
                      <FileUp className="w-4 h-4 text-nai-accent" />
                      <span className="text-sm font-bold text-white">导入文件</span>
                      <input type="file" accept=".naiv4vibe,.naiv4vibebundle" className="hidden" onChange={async (event) => { const file = event.target.files?.[0]; if (!file) return; await library.handleUnifiedVibeImport(file); event.target.value = ''; library.setVibeFabOpen(false); }} />
                    </label>
                  </div>
                )}
              </>
            )}
            <div className="p-3">
              <div className="flex items-center gap-2">
                {library.vibeTab === 'local' && library.activeVibes.length > 0 && (
                  <>
                    <button onClick={library.deleteSelectedLocalVibes} className="h-10 w-10 rounded-lg border border-red-800/50 bg-gray-800 flex items-center justify-center text-red-400 active:bg-red-900/30 transition-colors shrink-0" title="删除">
                      <Trash2 className="w-4 h-4" />
                    </button>
                    <button onClick={library.exportSelectedVibes} className="h-10 w-10 rounded-lg border border-gray-700 bg-gray-800 flex items-center justify-center text-gray-400 active:text-nai-accent active:border-nai-accent/50 transition-colors shrink-0" title="打包下载">
                      <Download className="w-4 h-4" />
                    </button>
                    <button onClick={() => { library.setVibeBatchTagOpen(true); library.setVibeBatchTagsToAdd(new Set()); }} className="h-10 w-10 rounded-lg border border-gray-700 bg-gray-800 flex items-center justify-center text-gray-400 active:text-nai-accent active:border-nai-accent/50 transition-colors shrink-0" title="添加标签">
                      <Tag className="w-4 h-4" />
                    </button>
                  </>
                )}
                <div className="flex-1" />
                <button onClick={() => library.setActiveVibes([])} disabled={library.activeVibes.length === 0}
                  className="h-10 px-4 bg-gray-800 border border-gray-700 text-gray-300 font-bold rounded-lg text-sm active:scale-[0.98] transition-all disabled:opacity-50 shrink-0">清空</button>
                <button onClick={closeSheet} className="h-10 px-5 bg-nai-accent text-black font-bold rounded-lg text-sm active:scale-[0.98] transition-all shrink-0">确认 {library.activeVibes.length > 0 && `(${library.activeVibes.length})`}</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <MobileVibeTagSheets
        activeVibes={library.activeVibes}
        vibeTagPool={library.vibeTagPool}
        vibeTagUsageCounts={library.vibeTagUsageCounts}
        vibeTagEditorTarget={library.vibeTagEditorTarget}
        setVibeTagEditorTarget={library.setVibeTagEditorTarget}
        vibeTagSettingsOpen={library.vibeTagSettingsOpen}
        setVibeTagSettingsOpen={library.setVibeTagSettingsOpen}
        vibeTagSettingsCreating={library.vibeTagSettingsCreating}
        setVibeTagSettingsCreating={library.setVibeTagSettingsCreating}
        vibeTagSettingsNewName={library.vibeTagSettingsNewName}
        setVibeTagSettingsNewName={library.setVibeTagSettingsNewName}
        vibeBatchTagOpen={library.vibeBatchTagOpen}
        setVibeBatchTagOpen={library.setVibeBatchTagOpen}
        vibeBatchTagsToAdd={library.vibeBatchTagsToAdd}
        setVibeBatchTagsToAdd={library.setVibeBatchTagsToAdd}
        onSaveVibeTags={library.saveVibeTags}
        onCreateVibeTag={library.createVibeTag}
        onDeleteVibeTag={library.deleteVibeTag}
        onApplyBatchTags={library.applyBatchTags}
      />

      <CloudManageModal
        isOpen={library.vibeCloudMenuOpen}
        onClose={() => library.setVibeCloudMenuOpen(false)}
        onDataChanged={async () => {
          await library.refreshLocalVibes();
          await library.reloadVibeTagPool();
        }}
      />
    </>
  );
}
