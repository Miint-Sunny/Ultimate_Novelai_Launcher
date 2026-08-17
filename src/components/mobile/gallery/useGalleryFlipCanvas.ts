import { useCallback, useRef } from 'react';
import type { HistoryItem } from '../../../contexts/GenerationContext';
import { usePagerPanGesture } from '../pager/usePagerPanGesture';
import {
  galleryPageCount,
  historyIndexToPage,
  pageToHistoryIndex,
} from './galleryViewLogic';

// P5 翻图画布领域状态:页序列 = 在跑任务卡头页(hasLiveTask 时占第 0 页) +
// history 一项一页,页 0 = 最新在左,换算一律走 galleryViewLogic 的页码谓词。
// 当前页由图片身份(imageUrl 在 history 中的位置)逐渲染推导,不存裸下标 ——
// history 前插一张(新生成入库)所有下标 +1,画布仍停留在同一张图上;
// 生成结束头页消失、页序列左移一位,也因为按身份推导而不跳页。
// 横滑手势复用壳层 usePagerPanGesture(同一套跟手/吸附/橡皮筋/方向裁决契约,
// 壳在图库页永不出让水平竞技场,这里接管页内横滑)。

interface UseGalleryFlipCanvasOptions {
  history: HistoryItem[];
  imageUrl: string | null;
  isGenerating: boolean;
  isQueuing: boolean;
  viewingHistory: boolean;
  /** inpaint 模式下置 false:画布被 overlay 取代,不响应横滑 */
  enabled: boolean;
  selectHistoryItem: (id: string) => void;
  setViewingHistory: (v: boolean) => void;
}

export function useGalleryFlipCanvas({
  history,
  imageUrl,
  isGenerating,
  isQueuing,
  viewingHistory,
  enabled,
  selectHistoryItem,
  setViewingHistory,
}: UseGalleryFlipCanvasOptions) {
  const hasLiveTask = isGenerating || isQueuing;
  // 跟随在跑任务:停在头页看预览;viewingHistory 时停对应历史页
  const followingLive = hasLiveTask && !viewingHistory;
  const pageCount = galleryPageCount(history.length, hasLiveTask);
  const currentIndex = imageUrl
    ? history.findIndex((item) => item.imageUrl === imageUrl)
    : -1;
  const activePage = followingLive
    ? 0
    : currentIndex >= 0
      ? historyIndexToPage(currentIndex, hasLiveTask)
      : 0; // 兜底:当前图不在 history(空历史/被删)时停第 0 页(最新)

  // 翻页落定:头页 → 回跟随态;历史页 → 选中该张
  // (selectHistoryItem 内部已按生成中状态置 viewingHistory,无需再手动 set)
  const hasLiveTaskRef = useRef(hasLiveTask);
  hasLiveTaskRef.current = hasLiveTask;
  const historyRef = useRef(history);
  historyRef.current = history;
  const settleToPage = useCallback(
    (page: number) => {
      const historyIndex = pageToHistoryIndex(page, hasLiveTaskRef.current);
      if (historyIndex === null) {
        setViewingHistory(false);
        return;
      }
      const item = historyRef.current[historyIndex];
      if (item) selectHistoryItem(item.id);
    },
    [selectHistoryItem, setViewingHistory],
  );

  const { dragOffset, containerProps } = usePagerPanGesture({
    activePage,
    pageCount,
    enabled,
    onNavigate: settleToPage,
  });

  return {
    hasLiveTask,
    followingLive,
    pageCount,
    currentIndex,
    activePage,
    /** 跟手位移(px);null = 未在拖动(此时轨道带吸附 transition) */
    dragOffset,
    containerProps,
  };
}
