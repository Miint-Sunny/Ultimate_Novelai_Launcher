import React, { useEffect, useRef } from 'react';
import { Image as ImageIcon } from 'lucide-react';
import type { HistoryItem } from '../../../contexts/GenerationContext';
import { pageToHistoryIndex } from './galleryViewLogic';
import { useGalleryFlipCanvas } from './useGalleryFlipCanvas';
import { useGalleryPrefetch } from './useGalleryPrefetch';
import { useImageBridge } from './useImageBridge';

interface MobileGalleryFlipCanvasProps {
  history: HistoryItem[];
  imageUrl: string | null;
  previewUrl: string | null;
  isGenerating: boolean;
  isQueuing: boolean;
  viewingHistory: boolean;
  /** inpaint 模式下置 false:画布被 overlay 取代,不响应横滑 */
  enabled: boolean;
  selectHistoryItem: (id: string) => void;
  setViewingHistory: (v: boolean) => void;
  /** 单击/双指 → 进入全屏缩放查看器 */
  onOpenFullscreen: () => void;
}

// P5 翻图画布(对齐 Plana PageView):在跑任务卡头页 + history 一项一页,
// 横滑跟手、松手吸附、边缘橡皮筋;相邻 ±1 页渲染真实 <img> 支持拖过一半预览,
// 其余页只占位不挂图(大历史不堆解码)。双指/单击进全屏;空态与原单图区一致。
export const MobileGalleryFlipCanvas: React.FC<MobileGalleryFlipCanvasProps> = ({
  history,
  imageUrl,
  previewUrl,
  isGenerating,
  isQueuing,
  viewingHistory,
  enabled,
  selectHistoryItem,
  setViewingHistory,
  onOpenFullscreen,
}) => {
  const {
    hasLiveTask,
    followingLive,
    pageCount,
    currentIndex,
    activePage,
    dragOffset,
    containerProps,
  } = useGalleryFlipCanvas({
    history,
    imageUrl,
    isGenerating,
    isQueuing,
    viewingHistory,
    enabled,
    selectHistoryItem,
    setViewingHistory,
  });

  // 邻页预解码:拖到一半邻页已经备好,不露空画框
  useGalleryPrefetch(history, currentIndex);

  const displayUrl = followingLive ? previewUrl : imageUrl;
  // 拖动翻页 / 跟随生成预览期间挂起桥接层(见 useImageBridge 头注)
  const { bridgeUrl, notifyLoaded } = useImageBridge(
    displayUrl,
    followingLive || dragOffset !== null,
  );

  // 轨道动画只在「拖动落定/回弹」那一帧启用:身份推导的页码平移(头页插入/
  // 消失、胶片条/网格跳选)必须瞬时到位,否则整列图会无理由滑一页
  const isDragging = dragOffset !== null;
  const wasDraggingRef = useRef(false);
  useEffect(() => {
    wasDraggingRef.current = isDragging;
  }, [isDragging]);
  const trackTransition =
    !isDragging && wasDraggingRef.current ? 'transform 300ms ease-out' : 'none';

  if (pageCount === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-500">
        <ImageIcon className="w-12 h-12 opacity-20 mb-2" />
        <span className="text-sm">未生成图像</span>
      </div>
    );
  }

  // 生成中且未切看历史时,预览页不进全屏(沿用原单图区行为)
  const canOpenFullscreen = (!isGenerating || viewingHistory) && !!imageUrl;

  return (
    <div
      className="absolute inset-0"
      style={{ touchAction: 'pan-y' }}
      {...containerProps}
      onTouchStart={(e) => {
        // 双指触摸 → 进入全屏缩放模式(沿用原单图区行为)
        if (e.touches.length >= 2 && canOpenFullscreen) {
          e.preventDefault();
          onOpenFullscreen();
        }
      }}
    >
      <div
        className="h-full flex"
        style={{
          width: `${pageCount * 100}%`,
          transform: `translateX(calc(${(-activePage * 100) / pageCount}% + ${dragOffset ?? 0}px))`,
          transition: trackTransition,
        }}
      >
        {Array.from({ length: pageCount }, (_, page) => {
          const historyIndex = pageToHistoryIndex(page, hasLiveTask);
          const item = historyIndex === null ? null : history[historyIndex];
          return (
            <div
              key={item ? item.id : '__live__'}
              className="h-full shrink-0 overflow-hidden"
              style={{ width: `${100 / pageCount}%` }}
            >
              {Math.abs(page - activePage) <= 1 && (
                <div className="w-full h-full flex items-center justify-center p-4">
                  {item ? (
                    <img
                      src={item.imageUrl}
                      alt="Generated"
                      draggable={false}
                      onLoad={() => notifyLoaded(item.imageUrl)}
                      onClick={() => canOpenFullscreen && onOpenFullscreen()}
                      className="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
                    />
                  ) : previewUrl ? (
                    <img
                      src={previewUrl}
                      alt="Preview"
                      draggable={false}
                      onLoad={() => notifyLoaded(previewUrl)}
                      className="max-w-full max-h-full object-contain rounded-lg shadow-2xl opacity-90"
                    />
                  ) : (
                    <div className="flex flex-col items-center justify-center h-full text-gray-500">
                      <ImageIcon className="w-12 h-12 opacity-20 mb-2" />
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 桥接层:非拖动切图的空窗,盖上一张已加载真图直到新图 onLoad(不裁切变形) */}
      {bridgeUrl && (
        <div className="absolute inset-0 p-4 flex items-center justify-center pointer-events-none">
          <img
            src={bridgeUrl}
            alt=""
            draggable={false}
            className="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
          />
        </div>
      )}
    </div>
  );
};
