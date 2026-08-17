import { useEffect } from 'react';
import type { HistoryItem } from '../../../contexts/GenerationContext';
import { prefetchWindowIndexes } from './galleryViewLogic';

// 邻页预取(对齐 Plana 邻页预解码):当前 history 下标变化时,对 ±radius 的项
// 做预解码 —— 拖到一半才起解码的话,滑进来的是个空画框。
// blob: URL 字节已在内存,无需重新下载;对象 URL 生命周期只归 GenerationContext
// 管,这里绝不出现 createObjectURL / revokeObjectURL。
export function useGalleryPrefetch(
  history: HistoryItem[],
  currentIndex: number,
  radius = 1,
) {
  useEffect(() => {
    for (const index of prefetchWindowIndexes(history.length, currentIndex, radius)) {
      const url = history[index]?.imageUrl;
      if (!url) continue;
      const img = new Image();
      img.src = url;
      img.decode?.().catch(() => {});
    }
  }, [history, currentIndex, radius]);
}
