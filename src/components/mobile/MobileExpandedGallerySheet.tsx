// 「›」展开的全部图片网格弹层(P5 对齐 Plana):按日期分段;搜索 + 模型/时间筛选
// (全 AND,谓词在 gallery/galleryViewLogic,筛选态为弹层内自治、关弹层即重置);
// 勾选集随筛选收敛,全选只圈当前可见;删除只在多选态且需两段确认。

import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckSquare, Download, Loader2, Package, Search, Square, Trash2, X } from 'lucide-react';
import type { HistoryItem } from '../../contexts/GenerationContext';
import {
  EMPTY_GALLERY_FILTER,
  UNKNOWN_MODEL_KEY,
  distinctModelKeys,
  filterHistory,
  formatSectionTime,
  groupHistoryByDate,
  isGalleryFilterActive,
  type GalleryFilter,
  type GalleryTimeRange,
} from './gallery/galleryViewLogic';

// 时间筛选分段控件选项 ↔ GalleryTimeRange
const TIME_RANGE_OPTIONS: Array<{ value: GalleryTimeRange; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'today', label: '今天' },
  { value: 'yesterday', label: '昨天' },
  { value: 'last7d', label: '7天' },
  { value: 'last30d', label: '30天' },
];

// 底栏删除两段确认的第二次点击有效窗口
const DELETE_CONFIRM_TIMEOUT_MS = 3000;

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
  selectAll: (ids?: string[]) => void;
  deselectAll: () => void;
  toggleSelectItem: (id: string) => void;
  selectHistoryItem: (id: string) => void;
  closeGallery: () => void;
  isDownloading: boolean;
  handleDownloadAll: () => void;
  handleDownloadSelected: () => void;
  handleDeleteSelected: () => void;
  downloadAndSaveImage: (url: string, seed: number | string, timestamp?: number) => void;
  convergeSelection: (visibleIds: ReadonlySet<string>) => void;
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
  convergeSelection,
}: MobileExpandedGallerySheetProps) {
  // ---- 检索/筛选(弹层内临时态,关弹层即重置) ----
  const [filter, setFilter] = useState<GalleryFilter>(EMPTY_GALLERY_FILTER);
  const [searchOpen, setSearchOpen] = useState(false);

  // ---- 底栏删除两段确认 ----
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearDeleteTimer = () => {
    if (deleteTimerRef.current !== null) {
      clearTimeout(deleteTimerRef.current);
      deleteTimerRef.current = null;
    }
  };

  // 「现在」在弹层打开/历史变化时取一次,避免渲染期间跨日漂移
  const now = useMemo(() => Date.now(), [isOpen, history]);
  const filtered = useMemo(() => filterHistory(history, filter, now), [history, filter, now]);
  const groups = useMemo(() => groupHistoryByDate(filtered, now), [filtered, now]);
  // 模型选项按整库统计(不按筛选后,免得选中一个后其余选项消失)
  const modelKeys = useMemo(() => distinctModelKeys(history), [history]);
  const filterActive = isGalleryFilterActive(filter);

  // 筛选/搜索是弹层内临时态:关弹层即重置(对齐 Plana)
  useEffect(() => {
    if (!isOpen) {
      setFilter(EMPTY_GALLERY_FILTER);
      setSearchOpen(false);
    }
  }, [isOpen]);

  // 勾选集随筛选收敛:仅当确有选中项被筛出可见集时才回调
  // (convergeSelection 无变化也会写入新 Set,不做前置判断会死循环)
  useEffect(() => {
    if (selectedItems.size === 0) return;
    const visibleIds = new Set(filtered.map((item) => item.id));
    for (const id of selectedItems) {
      if (!visibleIds.has(id)) {
        convergeSelection(visibleIds);
        return;
      }
    }
  }, [filtered, selectedItems, convergeSelection]);

  // 勾选集变化 → 删除确认态自动复原
  useEffect(() => {
    clearDeleteTimer();
    setDeleteConfirm(false);
  }, [selectedItems]);

  // 卸载清定时器
  useEffect(() => clearDeleteTimer, []);

  // 全选/取消全选以可见集合为基准
  const allVisibleSelected =
    filtered.length > 0 && filtered.every((item) => selectedItems.has(item.id));

  // 关闭搜索即清词(否则筛选在搜索框收起后仍隐形生效)
  const toggleSearch = () => {
    if (searchOpen) setFilter((prev) => ({ ...prev, query: '' }));
    setSearchOpen(!searchOpen);
  };

  const toggleModelFilter = (key: string) => {
    setFilter((prev) => ({
      ...prev,
      models: prev.models.includes(key)
        ? prev.models.filter((k) => k !== key)
        : [...prev.models, key],
    }));
  };

  // 两段确认:第一次点进入确认态,3 秒内再点才真删
  const handleDeleteClick = () => {
    if (!deleteConfirm) {
      setDeleteConfirm(true);
      clearDeleteTimer();
      deleteTimerRef.current = setTimeout(() => {
        deleteTimerRef.current = null;
        setDeleteConfirm(false);
      }, DELETE_CONFIRM_TIMEOUT_MS);
      return;
    }
    clearDeleteTimer();
    setDeleteConfirm(false);
    handleDeleteSelected();
  };

  if (!isOpen) return null;

  const renderHistoryCell = (item: HistoryItem) => (
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
        </div>
      )}
      {/* 段头已给出日期,段内只标时刻;seed 徽标合并成一行 */}
      <div className="absolute bottom-1 left-1 px-1.5 py-0.5 bg-black/60 rounded text-[10px] text-white/80 font-mono">
        {formatSectionTime(item.timestamp)} · {item.seed}
      </div>
    </div>
  );

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
          <span className="text-sm text-gray-500">
            {filterActive ? `筛选 ${filtered.length} / 共 ${history.length}` : `(${history.length})`}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {isSelectionMode ? (
            <>
              <button
                onClick={() => (allVisibleSelected ? deselectAll() : selectAll(filtered.map((item) => item.id)))}
                className="px-3 py-1.5 text-sm text-gray-300 bg-gray-800 rounded-lg"
              >
                {allVisibleSelected ? '取消全选' : '全选'}
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
                onClick={toggleSearch}
                className={`p-1.5 ${searchOpen ? 'text-nai-accent' : 'text-gray-400 active:text-white'}`}
                title="搜索"
              >
                <Search className="w-5 h-5" />
              </button>
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

      {/* 搜索 + 筛选栏(搜索框点放大镜展开;模型多选 chip + 时间分段) */}
      <div className="flex-shrink-0 bg-nai-panel border-b border-gray-800 px-4 py-2 space-y-2">
        {searchOpen && (
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
            <input
              autoFocus
              value={filter.query}
              onChange={(event) => setFilter((prev) => ({ ...prev, query: event.target.value }))}
              placeholder="搜索 seed / 提示词 / 模型"
              className="w-full bg-gray-800 rounded-lg pl-8 pr-8 py-1.5 text-sm text-gray-200 placeholder-gray-500 outline-none"
            />
            {filter.query !== '' && (
              <button
                onClick={() => setFilter((prev) => ({ ...prev, query: '' }))}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 active:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        )}
        {modelKeys.length > 0 && (
          <div className="flex gap-1.5 overflow-x-auto">
            {modelKeys.map((key) => {
              const active = filter.models.includes(key);
              return (
                <button
                  key={key}
                  onClick={() => toggleModelFilter(key)}
                  className={`flex-shrink-0 px-2.5 py-1 rounded-full text-xs ${active ? 'bg-nai-accent text-black font-medium' : 'bg-gray-800 text-gray-400'}`}
                >
                  {key === UNKNOWN_MODEL_KEY ? '未知模型' : key}
                </button>
              );
            })}
          </div>
        )}
        <div className="flex bg-gray-800 rounded-lg p-0.5">
          {TIME_RANGE_OPTIONS.map((option) => (
            <button
              key={option.value}
              onClick={() => setFilter((prev) => ({ ...prev, timeRange: option.value }))}
              className={`flex-1 py-1 text-xs rounded-md ${filter.timeRange === option.value ? 'bg-nai-accent text-black font-medium' : 'text-gray-400'}`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-3">
        {(isGenerating || isQueuing) && (
          <div className="grid grid-cols-3 gap-2">
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
          </div>
        )}

        {filterActive && filtered.length === 0 ? (
          <div className="py-16 text-center text-sm text-gray-500">无匹配图片</div>
        ) : (
          groups.map((group) => (
            <section key={group.key}>
              <div className="flex items-baseline gap-2 px-1 pb-1.5">
                <span className="text-sm font-medium text-gray-200">{group.label}</span>
                <span className="text-xs text-gray-500">{group.items.length} 张</span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {group.items.map(renderHistoryCell)}
              </div>
            </section>
          ))
        )}
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
              onClick={handleDeleteClick}
              className={`flex items-center gap-2 px-4 py-2 font-medium rounded-lg ${deleteConfirm ? 'bg-red-500 text-white' : 'bg-red-500/20 text-red-400'}`}
            >
              <Trash2 className="w-4 h-4" />
              <span>{deleteConfirm ? `确认删除 ${selectedItems.size} 张?` : '删除'}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
