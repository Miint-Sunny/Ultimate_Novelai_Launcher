import type { MouseEvent, RefObject, UIEvent } from 'react';
import { Cloud, Download, File, Globe, Heart, Loader2, RefreshCw, Settings } from 'lucide-react';
import { VibeCard } from './VibeCard';
import type { VibeFile } from './types';

interface VibePublicListProps {
  publicScrollRef: RefObject<HTMLDivElement | null>;
  publicVibeEndRef: RefObject<HTMLDivElement | null>;
  handlePublicScroll: (event: UIEvent<HTMLDivElement>) => void;
  vibeTab: 'public' | 'local';
  publicFiles: VibeFile[];
  filteredPublicFiles: VibeFile[];
  visiblePublicVibeCount: number;
  currentBotUserId: string;
  myPublicUploadsCount: number;
  setPublicVibeManagerOpen: (open: boolean) => void;
  isLoadingPublicVibes: boolean;
  selectedModelId: string;
  selectedVibes: string[];
  toggleVibeSelection: (id: string) => void;
  savingVibeIds: Set<string>;
  handleSaveVibeToLocal: (file: VibeFile) => Promise<void>;
  downloadingVibeIds: Set<string>;
  handlePublicVibeDownload: (file: VibeFile, event: MouseEvent) => void;
  loadPublicVibes: (forceRefresh?: boolean) => Promise<void>;
  vibeSearchQuery: string;
  vibeModelFilter: string;
}

export function VibePublicList({
  publicScrollRef,
  publicVibeEndRef,
  handlePublicScroll,
  vibeTab,
  publicFiles,
  filteredPublicFiles,
  visiblePublicVibeCount,
  currentBotUserId,
  myPublicUploadsCount,
  setPublicVibeManagerOpen,
  isLoadingPublicVibes,
  selectedModelId,
  selectedVibes,
  toggleVibeSelection,
  savingVibeIds,
  handleSaveVibeToLocal,
  downloadingVibeIds,
  handlePublicVibeDownload,
  loadPublicVibes,
  vibeSearchQuery,
  vibeModelFilter,
}: VibePublicListProps) {
  return (
    <div
      ref={publicScrollRef}
      onScroll={handlePublicScroll}
      className={`absolute inset-0 overflow-y-auto p-2 transition-transform duration-200 ease-out will-change-transform ${vibeTab === 'public'
        ? 'translate-x-0'
        : '-translate-x-full pointer-events-none'
        }`}
      style={vibeTab !== 'public' ? { contentVisibility: 'hidden' } : undefined}
    >
      <div className="mb-2 px-1 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs text-gray-400">
          <Globe className="w-3.5 h-3.5" />
          <span className="font-bold">公共库</span>
          <span className="text-gray-500">({publicFiles.length})</span>
        </div>
        <button
          onClick={() => setPublicVibeManagerOpen(true)}
          disabled={!currentBotUserId}
          className="flex items-center gap-1 px-2 py-1 text-[11px] font-bold rounded-md bg-gray-800 border border-gray-700 text-gray-300 hover:text-nai-accent hover:border-nai-accent/50 hover:bg-nai-accent/5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-gray-300 disabled:hover:border-gray-700 disabled:hover:bg-gray-800"
          title={currentBotUserId ? '管理我上传到公共库的 Vibe' : '需 Bot 授权'}
        >
          <Settings className="w-3 h-3" />
          管理我上传的
          {currentBotUserId && (
            <span className="text-nai-accent">({myPublicUploadsCount})</span>
          )}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {filteredPublicFiles.slice(0, visiblePublicVibeCount).map((file) => {
          const isMine = !!currentBotUserId && file.uploaderId === currentBotUserId;
          return (
            <VibeCard
              key={file.id}
              file={file}
              isSelected={selectedVibes.includes(file.id)}
              selectedModelId={selectedModelId}
              onClick={() => toggleVibeSelection(file.id)}
              tagPrefix={isMine ? <span className="text-nai-accent" title="我上传的"><Cloud className="w-3.5 h-3.5" /></span> : undefined}
              actions={
                <>
                  <button
                    disabled={savingVibeIds.has(file.id)}
                    onClick={(event) => { event.stopPropagation(); handleSaveVibeToLocal(file); }}
                    className={`p-2 rounded transition-colors ${savingVibeIds.has(file.id) ? 'text-gray-500' : 'text-gray-400 hover:text-pink-400 hover:bg-white/10'}`}
                    title="收藏到我的Vibe"
                  >
                    {savingVibeIds.has(file.id) ? <Loader2 className="w-5 h-5 animate-spin" /> : <Heart className="w-5 h-5" />}
                  </button>
                  <button
                    disabled={downloadingVibeIds.has(file.id)}
                    onClick={(event) => handlePublicVibeDownload(file, event)}
                    className="p-2 text-gray-400 hover:text-nai-accent rounded hover:bg-white/10 transition-colors disabled:opacity-50"
                    title="下载"
                  >
                    {downloadingVibeIds.has(file.id) ? <Loader2 className="w-5 h-5 animate-spin" /> : <Download className="w-5 h-5" />}
                  </button>
                </>
              }
            />
          );
        })}
        {visiblePublicVibeCount < filteredPublicFiles.length && (
          <div ref={publicVibeEndRef} className="py-2 text-center text-xs text-gray-500">加载更多...</div>
        )}
      </div>

      {filteredPublicFiles.length === 0 && publicFiles.length > 0 && (vibeSearchQuery.trim() || vibeModelFilter !== 'all') && (
        <div className="flex flex-col items-center justify-center h-full text-gray-500 py-10">
          <File className="w-10 h-10 mb-2 opacity-20" />
          <p className="text-sm">无搜索结果</p>
        </div>
      )}
      {publicFiles.length === 0 && (
        <div className="flex flex-col items-center justify-center h-full text-gray-500 py-10">
          <File className="w-10 h-10 mb-2 opacity-20" />
          <p className="text-sm mb-3">未找到公共Vibe</p>
          <button
            onClick={() => loadPublicVibes(true)}
            disabled={isLoadingPublicVibes}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded text-xs font-bold text-gray-300 hover:text-white transition-colors border border-gray-700"
          >
            <RefreshCw className={`w-3 h-3 ${isLoadingPublicVibes ? 'animate-spin' : ''}`} />
            刷新
          </button>
        </div>
      )}
    </div>
  );
}
