import { CheckSquare, Download, Loader2, Package, Square, Trash2, X } from 'lucide-react';
import type { HistoryItem } from '../../contexts/GenerationContext';

interface MobileExpandedGallerySheetProps {
  isOpen: boolean;
  history: HistoryItem[];
  isGenerating: boolean;
  isQueuing: boolean;
  viewingHistory: boolean;
  setViewingHistory: (viewing: boolean) => void;
  previewUrl: string | null;
  queuePosition: number;
  currentStep: number;
  totalSteps: number;
  isSelectionMode: boolean;
  setIsSelectionMode: (enabled: boolean) => void;
  selectedItems: Set<string>;
  clearSelection: () => void;
  selectAll: () => void;
  deselectAll: () => void;
  toggleSelectItem: (id: string) => void;
  selectHistoryItem: (id: string) => void;
  closeGallery: () => void;
  isDownloading: boolean;
  handleDownloadAll: () => void;
  handleDownloadSelected: () => void;
  handleDeleteSelected: () => void;
  downloadAndSaveImage: (url: string, seed: number | string, timestamp?: number) => void;
  deleteHistoryItem: (id: string) => void;
}

export function MobileExpandedGallerySheet({
  isOpen,
  history,
  isGenerating,
  isQueuing,
  viewingHistory,
  setViewingHistory,
  previewUrl,
  queuePosition,
  currentStep,
  totalSteps,
  isSelectionMode,
  setIsSelectionMode,
  selectedItems,
  clearSelection,
  selectAll,
  deselectAll,
  toggleSelectItem,
  selectHistoryItem,
  closeGallery,
  isDownloading,
  handleDownloadAll,
  handleDownloadSelected,
  handleDeleteSelected,
  downloadAndSaveImage,
  deleteHistoryItem,
}: MobileExpandedGallerySheetProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-nai-bg flex flex-col">
      <header className="flex-shrink-0 flex items-center justify-between px-4 py-3 bg-nai-panel border-b border-gray-800">
        <div className="flex items-center gap-3">
          <button
            onClick={closeGallery}
            className="p-1.5 text-gray-400 active:text-white"
          >
            <X className="w-6 h-6" />
          </button>
          <span className="font-medium">全部图片</span>
          <span className="text-sm text-gray-500">({history.length})</span>
        </div>
        <div className="flex items-center gap-2">
          {isSelectionMode ? (
            <>
              <button
                onClick={selectedItems.size === history.length ? deselectAll : selectAll}
                className="px-3 py-1.5 text-sm text-gray-300 bg-gray-800 rounded-lg"
              >
                {selectedItems.size === history.length ? '取消全选' : '全选'}
              </button>
              <button
                onClick={() => {
                  setIsSelectionMode(false);
                  clearSelection();
                }}
                className="px-3 py-1.5 text-sm text-gray-400"
              >
                取消
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => setIsSelectionMode(true)}
                className="p-1.5 text-gray-400 active:text-white"
                title="选择"
              >
                <CheckSquare className="w-5 h-5" />
              </button>
              <button
                onClick={handleDownloadAll}
                disabled={isDownloading || history.length === 0}
                className="p-1.5 text-gray-400 active:text-white disabled:opacity-50"
                title="打包下载全部"
              >
                {isDownloading ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <Package className="w-5 h-5" />
                )}
              </button>
            </>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-2">
        <div className="grid grid-cols-3 gap-2">
          {(isGenerating || isQueuing) && (
            <div
              className={`relative aspect-square bg-gray-800 rounded-lg overflow-hidden ${!viewingHistory ? 'ring-2 ring-nai-accent' : ''}`}
              onClick={() => {
                setViewingHistory(false);
                closeGallery();
              }}
            >
              {previewUrl ? (
                <img src={previewUrl} alt="生成中" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <div className="relative w-8 h-8">
                    <div className="absolute inset-0 bg-nai-accent/30 rounded-full animate-ping" />
                    <div className="absolute inset-1.5 bg-nai-accent/60 rounded-full animate-pulse" />
                  </div>
                </div>
              )}
              <div className="absolute inset-x-0 bottom-0 bg-black/70 p-1.5">
                {isQueuing ? (
                  <div className="text-[10px] text-nai-accent text-center font-bold">排队 #{queuePosition > 0 ? queuePosition : '-'}</div>
                ) : (
                  <div className="space-y-0.5">
                    <div className="w-full h-1 bg-gray-700 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-nai-accent rounded-full transition-all duration-200"
                        style={{ width: `${totalSteps > 0 ? (currentStep / totalSteps) * 100 : 0}%` }}
                      />
                    </div>
                    <div className="text-[10px] text-gray-400 font-mono text-center">{currentStep}/{totalSteps}</div>
                  </div>
                )}
              </div>
            </div>
          )}

          {history.map((item) => (
            <div
              key={item.id}
              className={`relative aspect-square bg-gray-800 rounded-lg overflow-hidden ${isSelectionMode && selectedItems.has(item.id) ? 'ring-2 ring-nai-accent' : ''
                }`}
              onClick={() => {
                if (isSelectionMode) {
                  toggleSelectItem(item.id);
                } else {
                  selectHistoryItem(item.id);
                  closeGallery();
                }
              }}
            >
              <img
                src={item.imageUrl}
                alt={`Seed: ${item.seed}`}
                className="w-full h-full object-cover"
              />
              {isSelectionMode && (
                <div className="absolute top-2 left-2">
                  {selectedItems.has(item.id) ? (
                    <CheckSquare className="w-6 h-6 text-nai-accent" />
                  ) : (
                    <Square className="w-6 h-6 text-white/60" />
                  )}
                </div>
              )}
              {item.isUpscaled && (
                <div className="absolute top-1 right-1 px-1.5 py-0.5 bg-green-500/80 rounded text-[10px] text-white font-bold">
                  {item.upscaleScale || 4}x
                </div>
              )}
              {item.isInpainted && !item.isUpscaled && (
                <div className="absolute top-1 right-1 px-1.5 py-0.5 bg-blue-500/80 rounded text-[10px] text-white font-bold">
                  重绘
                </div>
              )}
              {item.isBananaRepaint && !item.isUpscaled && !item.isInpainted && (
                <div className="absolute top-1 right-1 px-1.5 py-0.5 bg-yellow-500/80 rounded text-[10px] text-black font-bold">
                  🍌
                </div>
              )}
              {!isSelectionMode && (
                <div className="absolute bottom-1 right-1 flex gap-1">
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      downloadAndSaveImage(item.imageUrl, item.seed);
                    }}
                    className="p-1.5 bg-black/60 rounded-lg text-white/80 active:bg-black/80"
                  >
                    <Download className="w-4 h-4" />
                  </button>
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      deleteHistoryItem(item.id);
                    }}
                    className="p-1.5 bg-black/60 rounded-lg text-red-400 active:bg-black/80"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              )}
              <div className="absolute bottom-1 left-1 px-1.5 py-0.5 bg-black/60 rounded text-[10px] text-white/80 font-mono">
                {item.seed}
              </div>
            </div>
          ))}
        </div>
      </div>

      {isSelectionMode && selectedItems.size > 0 && (
        <div className="flex-shrink-0 bg-nai-panel border-t border-gray-800 px-4 py-3 flex items-center justify-between">
          <span className="text-sm text-gray-400">已选择 {selectedItems.size} 张</span>
          <div className="flex items-center gap-3">
            <button
              onClick={handleDownloadSelected}
              disabled={isDownloading}
              className="flex items-center gap-2 px-4 py-2 bg-nai-accent text-black font-medium rounded-lg disabled:opacity-50"
            >
              {isDownloading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Download className="w-4 h-4" />
              )}
              <span>{selectedItems.size > 1 ? '打包下载' : '下载'}</span>
            </button>
            <button
              onClick={handleDeleteSelected}
              className="flex items-center gap-2 px-4 py-2 bg-red-500/20 text-red-400 font-medium rounded-lg"
            >
              <Trash2 className="w-4 h-4" />
              <span>删除</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
