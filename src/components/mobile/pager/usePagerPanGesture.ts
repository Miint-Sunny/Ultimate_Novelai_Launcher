import { useCallback, useRef, useState } from 'react';

// 壳层横滑 pan 手势(P3)。手势分层契约(硬规则):
//   - 图库页永不出让:壳以 enabled=false 停用手势(页内横滑翻图是主手势);
//   - 覆盖物(mine sheet / 创作室 inpaint·upscale / 全屏编辑器)打开期间 enabled=false;
//   - 边缘豁免:起手 x 在屏幕左右 EDGE_EXEMPTION_PX 内不触发(让位 iOS Safari 边缘返回);
//   - 方向裁决:位移未超 DRAG_DECIDE_PX 不表态;水平分量显著大于垂直才接管,
//     否则作废让给页内垂直滚动(容器需配合 touch-action: pan-y)。
const EDGE_EXEMPTION_PX = 20;
const DRAG_DECIDE_PX = 8;
const HORIZONTAL_BIAS = 1.2;
const SNAP_DISTANCE_RATIO = 0.25;
const FLICK_VELOCITY_PX_PER_MS = 0.4;
const RUBBER_BAND = 0.35;

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  decided: boolean;
  panning: boolean;
  lastX: number;
  lastT: number;
  velocity: number;
}

interface UsePagerPanGestureOptions {
  activePage: number;
  pageCount: number;
  enabled: boolean;
  onNavigate: (page: number) => void;
}

export function usePagerPanGesture({
  activePage,
  pageCount,
  enabled,
  onNavigate,
}: UsePagerPanGestureOptions) {
  const [dragOffset, setDragOffset] = useState<number | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const suppressClickRef = useRef(false);
  const widthRef = useRef(1);

  // 处理器用 ref 读最新值,保持回调引用稳定(pointer capture 期间不换 handler)
  const activePageRef = useRef(activePage);
  activePageRef.current = activePage;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!enabledRef.current || !event.isPrimary || dragRef.current) return;
    if (
      event.clientX < EDGE_EXEMPTION_PX ||
      event.clientX > window.innerWidth - EDGE_EXEMPTION_PX
    ) {
      return;
    }
    widthRef.current = window.innerWidth;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      decided: false,
      panning: false,
      lastX: event.clientX,
      lastT: event.timeStamp,
      velocity: 0,
    };
  }, []);

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;

    if (!drag.decided) {
      if (Math.abs(dx) < DRAG_DECIDE_PX && Math.abs(dy) < DRAG_DECIDE_PX) return;
      drag.decided = true;
      drag.panning = Math.abs(dx) > Math.abs(dy) * HORIZONTAL_BIAS;
      if (drag.panning) {
        event.currentTarget.setPointerCapture?.(event.pointerId);
        setDragOffset(0);
      } else {
        // 垂直意图:作废,让位页内滚动
        dragRef.current = null;
        return;
      }
    }
    if (!drag.panning) return;

    const dt = Math.max(1, event.timeStamp - drag.lastT);
    drag.velocity = (event.clientX - drag.lastX) / dt;
    drag.lastX = event.clientX;
    drag.lastT = event.timeStamp;

    // 边界阻尼:第一页右拉 / 最后一页左拉橡皮筋
    const page = activePageRef.current;
    const offset =
      (page === 0 && dx > 0) || (page === pageCount - 1 && dx < 0)
        ? dx * RUBBER_BAND
        : dx;
    setDragOffset(offset);
  }, [pageCount]);

  const finish = useCallback((event: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    dragRef.current = null;
    setDragOffset(null);
    if (!drag.panning) return;

    // 横滑后的松手点击一律吞掉,避免误触页内按钮
    suppressClickRef.current = true;
    if (cancelled) return;

    const dx = event.clientX - drag.startX;
    const page = activePageRef.current;
    const threshold = widthRef.current * SNAP_DISTANCE_RATIO;
    let target = page;
    if (dx <= -threshold || (drag.velocity <= -FLICK_VELOCITY_PX_PER_MS && dx < 0)) {
      target = page + 1;
    } else if (dx >= threshold || (drag.velocity >= FLICK_VELOCITY_PX_PER_MS && dx > 0)) {
      target = page - 1;
    }
    target = Math.max(0, Math.min(pageCount - 1, target));
    if (target !== page) onNavigateRef.current(target);
  }, [pageCount]);

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => finish(event, false),
    [finish],
  );
  const onPointerCancel = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => finish(event, true),
    [finish],
  );

  const onClickCapture = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      event.preventDefault();
      event.stopPropagation();
    }
  }, []);

  return {
    /** 跟手位移(px);null = 未在拖动(壳此时给轨道加 transition) */
    dragOffset,
    containerProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onClickCapture,
    },
  };
}
