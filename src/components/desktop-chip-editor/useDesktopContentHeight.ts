import { useEffect } from 'react';
import type { RefObject } from 'react';

export function useDesktopContentHeight(
  value: string,
  chipContainerRef: RefObject<HTMLDivElement | null>,
  onContentHeightChange?: (height: number) => void,
) {
  useEffect(() => {
    if (!onContentHeightChange || !chipContainerRef.current) return;
    requestAnimationFrame(() => {
      if (chipContainerRef.current) {
        onContentHeightChange(chipContainerRef.current.offsetHeight + 16);
      }
    });
  }, [value, chipContainerRef, onContentHeightChange]);
}
