import { useCallback, useState } from 'react';
import type { HistoryItem } from '../../../contexts/GenerationContext';

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

  const selectAll = useCallback(() => {
    setSelectedItems(new Set(history.map((item) => item.id)));
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
    selectAll,
    deselectAll,
  };
}
