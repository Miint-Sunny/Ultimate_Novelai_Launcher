import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, DragEvent, RefObject, SetStateAction } from 'react';
import { cleanTagName, parseCollapsibleMarker } from '../../utils/promptTags';
import { getMarkerVisual } from '../tag-manager/markerVisual';

interface UseDesktopChipDragParams {
  parsedTags: string[];
  tagTranslations: Map<string, string>;
  scrollRef: RefObject<HTMLDivElement | null>;
  rebuildValue: (tags: string[]) => void;
  setSelectedTags: Dispatch<SetStateAction<Set<number>>>;
}

export function useDesktopChipDrag({
  parsedTags,
  tagTranslations,
  scrollRef,
  rebuildValue,
  setSelectedTags,
}: UseDesktopChipDragParams) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [dragGhostInfo, setDragGhostInfo] = useState<{ text: string; sub?: string } | null>(null);
  const dragMouseY = useRef<number | null>(null);

  const handleDragStart = useCallback((event: DragEvent, index: number) => {
    setDragIndex(index);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(index));

    const emptyImg = new Image();
    emptyImg.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    event.dataTransfer.setDragImage(emptyImg, 0, 0);
    (event.currentTarget as HTMLElement).style.opacity = '0.4';

    const rawTag = parsedTags[index];
    const markerInfo = parseCollapsibleMarker(rawTag);
    if (markerInfo) {
      const tagCount = markerInfo.content.split(/[,，]/).filter(tag => tag.trim()).length;
      setDragGhostInfo({ text: `${getMarkerVisual(markerInfo.type).label} · ${markerInfo.name}`, sub: `${tagCount} 个标签` });
      return;
    }

    const clean = cleanTagName(rawTag);
    setDragGhostInfo({ text: rawTag.trim(), sub: tagTranslations.get(clean) || undefined });
  }, [parsedTags, tagTranslations]);

  const handleDragEnd = useCallback((event: DragEvent) => {
    (event.currentTarget as HTMLElement).style.opacity = '1';
    if (dragIndex !== null && dragOverIndex !== null && dragIndex !== dragOverIndex) {
      const tags = [...parsedTags];
      const [moved] = tags.splice(dragIndex, 1);
      tags.splice(dragOverIndex > dragIndex ? dragOverIndex - 1 : dragOverIndex, 0, moved);
      rebuildValue(tags);
      setSelectedTags(new Set());
    }
    setDragIndex(null);
    setDragOverIndex(null);
    setDragGhostInfo(null);
  }, [dragIndex, dragOverIndex, parsedTags, rebuildValue, setSelectedTags]);

  const handleDragOver = useCallback((event: DragEvent, index: number) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDragOverIndex(index);
  }, []);

  useEffect(() => {
    if (dragIndex === null) {
      dragMouseY.current = null;
      return;
    }
    const timer = setInterval(() => {
      const container = scrollRef.current;
      const y = dragMouseY.current;
      if (!container || y === null) return;
      const rect = container.getBoundingClientRect();
      const edgeZone = 50;
      if (y < rect.top + edgeZone) {
        const intensity = Math.max(2, Math.round((rect.top + edgeZone - y) / edgeZone * 12));
        container.scrollTop -= intensity;
      } else if (y > rect.bottom - edgeZone) {
        const intensity = Math.max(2, Math.round((y - (rect.bottom - edgeZone)) / edgeZone * 12));
        container.scrollTop += intensity;
      }
    }, 16);
    return () => clearInterval(timer);
  }, [dragIndex, scrollRef]);

  const handleContainerDragOver = useCallback((event: DragEvent) => {
    event.preventDefault();
    dragMouseY.current = event.clientY;
  }, []);

  useEffect(() => {
    if (dragIndex === null) return;
    const container = scrollRef.current;
    if (!container) return;
    const handleWheel = (event: WheelEvent) => {
      container.scrollTop += event.deltaY;
    };
    window.addEventListener('wheel', handleWheel, { capture: true, passive: true });
    return () => {
      window.removeEventListener('wheel', handleWheel, { capture: true } as EventListenerOptions);
    };
  }, [dragIndex, scrollRef]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleWheel = (event: WheelEvent) => {
      if (dragIndex !== null) return;

      if (event.shiftKey && el.scrollHeight > el.clientHeight) {
        event.preventDefault();
        const delta = event.deltaY !== 0 ? event.deltaY : event.deltaX;
        el.scrollTop += delta;
        return;
      }

      if (el.scrollHeight <= el.clientHeight) {
        return;
      }

      const isAtTop = el.scrollTop <= 0;
      const isAtBottom = Math.ceil(el.scrollTop + el.clientHeight) >= el.scrollHeight - 1;

      if ((isAtTop && event.deltaY < 0) || (isAtBottom && event.deltaY > 0)) {
        const outerScroll = el.parentElement?.closest('.overflow-y-auto, .custom-scrollbar') as HTMLElement;
        if (outerScroll) {
          event.preventDefault();
          let delta = event.deltaY;
          if (event.deltaMode === 1) delta *= 40;
          else if (event.deltaMode === 2) delta *= outerScroll.clientHeight || 800;
          const isTouchpad = event.deltaMode === 0 && (Math.abs(event.deltaY) < 50 || event.deltaY % 1 !== 0);
          outerScroll.scrollBy({ top: delta, behavior: isTouchpad ? 'auto' : 'smooth' });
        }
      }
    };
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [dragIndex, scrollRef]);

  return {
    dragIndex,
    dragOverIndex,
    dragGhostInfo,
    handleDragStart,
    handleDragEnd,
    handleDragOver,
    handleContainerDragOver,
  };
}
