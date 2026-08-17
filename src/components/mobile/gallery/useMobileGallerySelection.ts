import { useCallback, useState } from 'react';
import type { HistoryItem } from '../../../contexts/GenerationContext';
import { convergeSelectionIds } from './galleryViewLogic';

export function useMobileGallerySelection(history: HistoryItem[]) {
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [isSelectionMode, setIsSelectionMode] = useState(false);

  const clearSelection = useCallback(() => {
    setSelectedItems(new Set());
  }, []);

  const toggleSelectItem = useCallback((id: string) => {
    setSelectedItems((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // 胶片条长按直达网格多选:进入多选态并预选此张
  const enterSelectionWith = useCallback((id: string) => {
    setSelectedItems(new Set([id]));
    setIsSelectionMode(true);
  }, []);

  // 勾选集随筛选收敛:筛掉的 id 从勾选集中移除(谓词在 galleryViewLogic)
  const convergeSelection = useCallback((visibleIds: ReadonlySet<string>) => {
    setSelectedItems((prev) => convergeSelectionIds(prev, visibleIds));
  }, []);

  // ids 缺省 = 全部历史;网格筛选态下传可见项 id,全选只圈当前可见
  const selectAll = useCallback((ids?: string[]) => {
    setSelectedItems(new Set(ids ?? history.map((item) => item.id)));
  }, [history]);

  const deselectAll = useCallback(() => {
    setSelectedItems(new Set());
  }, []);

  return {
    selectedItems,
    setSelectedItems,
    isSelectionMode,
    setIsSelectionMode,
    clearSelection,
    toggleSelectItem,
    enterSelectionWith,
    convergeSelection,
    selectAll,
    deselectAll,
  };
}
