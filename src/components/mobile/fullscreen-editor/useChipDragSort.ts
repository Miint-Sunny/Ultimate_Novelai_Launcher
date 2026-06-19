import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  cleanTagName,
  parseCollapsibleMarker,
} from '../../../utils/promptTags';
import { getMarkerVisual } from '../../tag-manager/markerVisual';

interface DragState {
  index: number;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
  chipW: number;
  chipH: number;
  longPressTimer: ReturnType<typeof setTimeout> | null;
  activated: boolean;
  chipPositions: Array<{ idx: number; left: number; top: number; width: number; height: number }>;
  startScrollTop: number;
}

interface DragGhost {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  sub?: string;
}

interface UseChipDragSortArgs {
  parsedTags: string[];
  tagTranslations: Map<string, string>;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  rebuildValue: (tags: string[]) => void;
  onClearSelection: () => void;
}

export const useChipDragSort = ({
  parsedTags,
  tagTranslations,
  scrollRef,
  rebuildValue,
  onClearSelection,
}: UseChipDragSortArgs) => {
  const dragState = useRef<DragState | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragGhost, setDragGhost] = useState<DragGhost | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const chipRefsMap = useRef<Map<number, HTMLElement>>(new Map());
  const autoScrollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const cleanup = () => {
      if (dragState.current?.activated) {
        if (dragState.current.longPressTimer) clearTimeout(dragState.current.longPressTimer);
        dragState.current = null;
        setIsDragging(false);
        setDragGhost(null);
        setDragOverIndex(null);
        if (autoScrollTimer.current) { clearInterval(autoScrollTimer.current); autoScrollTimer.current = null; }
      }
    };
    window.addEventListener('touchend', cleanup);
    window.addEventListener('touchcancel', cleanup);
    return () => {
      window.removeEventListener('touchend', cleanup);
      window.removeEventListener('touchcancel', cleanup);
    };
  }, []);

  const handleChipTouchStart = useCallback((e: React.TouchEvent, index: number) => {
    const touch = e.touches[0];
    const chip = e.currentTarget as HTMLElement;
    const rect = chip.getBoundingClientRect();
    dragState.current = {
      index,
      startX: touch.clientX,
      startY: touch.clientY,
      offsetX: touch.clientX - rect.left,
      offsetY: touch.clientY - rect.top,
      chipW: rect.width,
      chipH: rect.height,
      longPressTimer: setTimeout(() => {
        if (!dragState.current) return;
        dragState.current.activated = true;
        const positions: DragState['chipPositions'] = [];
        chipRefsMap.current.forEach((el, idx) => {
          const r = el.getBoundingClientRect();
          positions.push({ idx, left: r.left, top: r.top, width: r.width, height: r.height });
        });
        dragState.current.chipPositions = positions;
        dragState.current.startScrollTop = scrollRef.current?.scrollTop ?? 0;
        setIsDragging(true);
        setDragOverIndex(index);
        if (navigator.vibrate) navigator.vibrate(30);
        const ds = dragState.current;
        const rawTag = parsedTags[index];
        const ghostMarker = parseCollapsibleMarker(rawTag);
        const ghostBase = { x: ds.startX - ds.offsetX, y: ds.startY - ds.offsetY, w: ds.chipW, h: ds.chipH };
        if (ghostMarker) {
          const tagCount = ghostMarker.content.split(/[,，]/).filter(t => t.trim()).length;
          setDragGhost({ ...ghostBase, text: `${getMarkerVisual(ghostMarker.type).label} · ${ghostMarker.name}`, sub: `${tagCount} 个标签` });
        } else {
          const clean = cleanTagName(rawTag);
          setDragGhost({ ...ghostBase, text: rawTag.trim(), sub: tagTranslations.get(clean) });
        }
      }, 300),
      activated: false,
      chipPositions: [],
      startScrollTop: 0,
    };
  }, [parsedTags, scrollRef, tagTranslations]);

  const handleChipTouchMove = useCallback((e: React.TouchEvent) => {
    const ds = dragState.current;
    if (!ds) return;
    const touch = e.touches[0];
    if (!ds.activated) {
      if (Math.abs(touch.clientX - ds.startX) > 10 || Math.abs(touch.clientY - ds.startY) > 10) {
        if (ds.longPressTimer) clearTimeout(ds.longPressTimer);
        ds.longPressTimer = null;
      }
      return;
    }
    e.preventDefault();
    setDragGhost(prev => prev ? {
      ...prev,
      x: touch.clientX - ds.offsetX,
      y: touch.clientY - ds.offsetY,
    } : null);
    const cx = touch.clientX;
    const cy = touch.clientY;

    const container = scrollRef.current;
    if (container) {
      const rect = container.getBoundingClientRect();
      const edgeZone = 60;
      const distTop = cy - rect.top;
      const distBottom = rect.bottom - cy;
      let scrollSpeed = 0;
      if (distTop < edgeZone && container.scrollTop > 0) {
        scrollSpeed = -Math.max(4, (edgeZone - distTop) / 2);
      } else if (distBottom < edgeZone && container.scrollTop < container.scrollHeight - container.clientHeight) {
        scrollSpeed = Math.max(4, (edgeZone - distBottom) / 2);
      }
      if (scrollSpeed !== 0) {
        if (autoScrollTimer.current) clearInterval(autoScrollTimer.current);
        autoScrollTimer.current = setInterval(() => {
          container.scrollTop += scrollSpeed;
        }, 16);
      } else if (autoScrollTimer.current) {
        clearInterval(autoScrollTimer.current);
        autoScrollTimer.current = null;
      }
    }

    const scrollDelta = (container?.scrollTop ?? 0) - ds.startScrollTop;
    let closest = -1;
    let minDist = Infinity;
    for (const pos of ds.chipPositions) {
      if (pos.idx === ds.index) continue;
      const mx = pos.left + pos.width / 2;
      const my = pos.top + pos.height / 2 - scrollDelta;
      const dist = Math.hypot(cx - mx, cy - my);
      if (dist < minDist) { minDist = dist; closest = pos.idx; }
    }
    if (closest >= 0) {
      const pos = ds.chipPositions.find(p => p.idx === closest)!;
      const insertAfter = cx > pos.left + pos.width / 2;
      const dropIdx = insertAfter ? closest + 1 : closest;
      setDragOverIndex(dropIdx);
    }
  }, [scrollRef]);

  const handleChipTouchEnd = useCallback(() => {
    if (autoScrollTimer.current) { clearInterval(autoScrollTimer.current); autoScrollTimer.current = null; }
    const ds = dragState.current;
    if (ds?.longPressTimer) clearTimeout(ds.longPressTimer);
    if (ds?.activated && dragOverIndex !== null && dragOverIndex !== ds.index && dragOverIndex !== ds.index + 1) {
      const tags = [...parsedTags];
      const [moved] = tags.splice(ds.index, 1);
      const insertAt = dragOverIndex > ds.index ? dragOverIndex - 1 : dragOverIndex;
      tags.splice(insertAt, 0, moved);
      rebuildValue(tags);
      onClearSelection();
    }
    dragState.current = null;
    setIsDragging(false);
    setDragGhost(null);
    setDragOverIndex(null);
  }, [parsedTags, dragOverIndex, rebuildValue, onClearSelection]);

  return {
    dragState,
    isDragging,
    dragGhost,
    dragOverIndex,
    chipRefsMap,
    handleChipTouchStart,
    handleChipTouchMove,
    handleChipTouchEnd,
  };
};
