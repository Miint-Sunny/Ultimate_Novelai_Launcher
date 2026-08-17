import { useCallback, useRef } from 'react';

// 长按判定(默认 ≥500ms 且位移不超限):touch 为主,mouse 兜底方便桌面调试。
// 长按触发后吞掉随后的 click,避免「长按进多选/设置」又连带触发点击语义;
// 位移超限(用户在拖动/滚动)立即作废,不与滑动手势冲突。
const MOVE_TOLERANCE_PX = 10;

interface UseLongPressOptions {
  onLongPress: () => void;
  /** 普通点击(长按已触发时不会调到) */
  onClick?: () => void;
  /** 触发时长,缺省 500ms */
  ms?: number;
}

export function useLongPress({ onLongPress, onClick, ms = 500 }: UseLongPressOptions) {
  const timerRef = useRef<number | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const firedRef = useRef(false);
  // 回调走 ref,保持手势处理器引用稳定
  const onLongPressRef = useRef(onLongPress);
  onLongPressRef.current = onLongPress;
  const onClickRef = useRef(onClick);
  onClickRef.current = onClick;

  const cancel = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    startRef.current = null;
  }, []);

  const start = useCallback(
    (x: number, y: number) => {
      cancel();
      startRef.current = { x, y };
      firedRef.current = false;
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        firedRef.current = true;
        onLongPressRef.current();
      }, ms);
    },
    [cancel, ms],
  );

  const move = useCallback(
    (x: number, y: number) => {
      const startPos = startRef.current;
      if (!startPos) return;
      if (
        Math.abs(x - startPos.x) > MOVE_TOLERANCE_PX ||
        Math.abs(y - startPos.y) > MOVE_TOLERANCE_PX
      ) {
        cancel();
      }
    },
    [cancel],
  );

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      const touch = e.touches[0];
      if (touch) start(touch.clientX, touch.clientY);
    },
    [start],
  );
  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      const touch = e.touches[0];
      if (touch) move(touch.clientX, touch.clientY);
    },
    [move],
  );
  const onTouchEnd = useCallback(() => cancel(), [cancel]);
  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button === 0) start(e.clientX, e.clientY);
    },
    [start],
  );
  const onMouseUp = useCallback(() => cancel(), [cancel]);
  const onMouseLeave = useCallback(() => cancel(), [cancel]);

  // 长按已触发 → 吞掉本次 click;否则按普通点击透传
  const handleClick = useCallback((e: React.MouseEvent) => {
    if (firedRef.current) {
      firedRef.current = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    onClickRef.current?.();
  }, []);

  return {
    handlers: {
      onTouchStart,
      onTouchMove,
      onTouchEnd,
      onTouchCancel: onTouchEnd,
      onMouseDown,
      onMouseUp,
      onMouseLeave,
      onClick: handleClick,
    },
  };
}
