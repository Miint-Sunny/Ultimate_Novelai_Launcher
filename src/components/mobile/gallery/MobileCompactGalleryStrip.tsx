import React, { useEffect, useRef } from 'react';
import { ChevronRight } from 'lucide-react';
import type { HistoryItem } from '../../../contexts/GenerationContext';
import { useLongPress } from './useLongPress';

interface MobileCompactGalleryStripProps {
  history: HistoryItem[];
  imageUrl: string | null;
  isGenerating: boolean;
  isQueuing: boolean;
  viewingHistory: boolean;
  previewUrl: string | null;
  queuePosition: number;
  currentStep: number;
  totalSteps: number;
  setViewingHistory: (viewingHistory: boolean) => void;
  selectHistoryItem: (id: string) => void;
  onExpand: () => void;
  /** 缩略图长按(≥500ms 无位移):直达网格多选并预选此张 */
  onLongPressItem: (id: string) => void;
}

// 历史缩略图:点击选中,长按进多选;长按判定在 useLongPress(与滑动冲突已处理)
const HistoryThumb: React.FC<{
  item: HistoryItem;
  selected: boolean;
  onSelect: () => void;
  onLongPress: () => void;
}> = ({ item, selected, onSelect, onLongPress }) => {
  const { handlers } = useLongPress({ onLongPress, onClick: onSelect });
  return (
    <div
      data-selected={selected ? 'true' : undefined}
      className={`flex-shrink-0 w-16 h-16 bg-gray-800 rounded-lg overflow-hidden relative ${selected ? 'ring-2 ring-nai-accent' : ''}`}
      {...handlers}
    >
      <img
        src={item.imageUrl}
        alt={`Seed: ${item.seed}`}
        draggable={false}
        // iOS 长按 img 会弹系统 callout,与长按进多选打架,这里压掉
        style={{ WebkitTouchCallout: 'none' }}
        className="w-full h-full object-cover select-none"
      />
      {item.isUpscaled && (
        <div className="absolute top-0.5 left-0.5 px-1 py-0.5 bg-green-500/80 rounded text-[8px] text-white font-bold">
          {item.upscaleScale || 4}x
        </div>
      )}
      {item.isInpainted && !item.isUpscaled && (
        <div className="absolute top-0.5 left-0.5 px-1 py-0.5 bg-blue-500/80 rounded text-[8px] text-white font-bold">
          重绘
        </div>
      )}
      {item.isBananaRepaint && !item.isUpscaled && !item.isInpainted && (
        <div className="absolute top-0.5 left-0.5 px-1 py-0.5 bg-yellow-500/80 rounded text-[8px] text-black font-bold">
          🍌
        </div>
      )}
    </div>
  );
};

export const MobileCompactGalleryStrip: React.FC<MobileCompactGalleryStripProps> = ({
  history,
  imageUrl,
  isGenerating,
  isQueuing,
  viewingHistory,
  previewUrl,
  queuePosition,
  currentStep,
  totalSteps,
  setViewingHistory,
  selectHistoryItem,
  onExpand,
  onLongPressItem,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pauseAutoScrollRef = useRef(false);
  const resumeTimerRef = useRef<number | null>(null);

  // 选中自动居中:选中项(imageUrl)/条内容变化时把选中缩略图滚到视野中央
  // (跟随在跑任务时居中头部任务卡);用户手指正在条上拖动时暂停,
  // pointerup 后留 400ms 余量覆盖惯性滚动,避免自动滚动与手指打架。
  useEffect(() => {
    if (pauseAutoScrollRef.current) return;
    const selected = scrollRef.current?.querySelector('[data-selected="true"]');
    selected?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }, [imageUrl, history.length, isGenerating, isQueuing, viewingHistory]);

  useEffect(
    () => () => {
      if (resumeTimerRef.current !== null) window.clearTimeout(resumeTimerRef.current);
    },
    [],
  );

  const pauseAutoScroll = () => {
    pauseAutoScrollRef.current = true;
    if (resumeTimerRef.current !== null) window.clearTimeout(resumeTimerRef.current);
  };
  const resumeAutoScrollSoon = () => {
    if (resumeTimerRef.current !== null) window.clearTimeout(resumeTimerRef.current);
    resumeTimerRef.current = window.setTimeout(() => {
      pauseAutoScrollRef.current = false;
    }, 400);
  };

  return (
    <div className="flex-shrink-0 bg-nai-panel border-t border-gray-800">
      {history.length === 0 && !isGenerating && !isQueuing ? (
        <div className="flex items-center justify-center h-20 text-gray-500">
          <span className="text-sm">暂无历史记录</span>
        </div>
      ) : (
        <div className="flex items-center p-2">
          <div
            ref={scrollRef}
            className="flex-1 overflow-x-auto scrollbar-hide"
            onPointerDown={pauseAutoScroll}
            onPointerUp={resumeAutoScrollSoon}
            onPointerCancel={resumeAutoScrollSoon}
          >
            <div className="flex flex-nowrap gap-2 items-center p-0.5">
              {(isGenerating || isQueuing) && (
                <div
                  data-selected={!viewingHistory ? 'true' : undefined}
                  className={`flex-shrink-0 w-16 h-16 bg-gray-800 rounded-lg overflow-hidden relative ${!viewingHistory ? 'ring-2 ring-nai-accent' : ''}`}
                  onClick={() => setViewingHistory(false)}
                >
                  {previewUrl ? (
                    <img src={previewUrl} alt="生成中" draggable={false} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <div className="relative w-5 h-5">
                        <div className="absolute inset-0 bg-nai-accent/30 rounded-full animate-ping" />
                        <div className="absolute inset-1 bg-nai-accent/60 rounded-full animate-pulse" />
                      </div>
                    </div>
                  )}
                  <div className="absolute inset-x-0 bottom-0 bg-black/70 px-1 py-0.5">
                    {isQueuing ? (
                      <div className="text-[8px] text-nai-accent text-center font-bold">
                        #{queuePosition > 0 ? queuePosition : '-'}
                      </div>
                    ) : (
                      <div className="w-full h-1 bg-gray-700 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-nai-accent rounded-full transition-all duration-200"
                          style={{ width: `${totalSteps > 0 ? (currentStep / totalSteps) * 100 : 0}%` }}
                        />
                      </div>
                    )}
                  </div>
                </div>
              )}
              {history.map((item) => (
                <HistoryThumb
                  key={item.id}
                  item={item}
                  selected={imageUrl === item.imageUrl}
                  onSelect={() => selectHistoryItem(item.id)}
                  onLongPress={() => onLongPressItem(item.id)}
                />
              ))}
            </div>
          </div>
          <div className="flex-shrink-0 flex items-center justify-center pl-2">
            <button
              onClick={onExpand}
              className="w-9 h-9 rounded-full bg-gray-700/80 flex items-center justify-center text-gray-400 active:bg-gray-600 active:text-white transition-colors"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
