import { useCallback, useEffect, useRef, useState } from 'react';
import type { HTMLAttributes } from 'react';
import {
  genModuleDef,
  moveVisibleGenModule,
  type SortableGenModuleKey,
} from '../../generation/genModules';

const LONG_PRESS_MS = 400;
// 长按计时前指针移动超过该阈值视为滚动意图,取消起拖
const MOVE_CANCEL_PX = 10;

interface UseMobileCardDragSortOptions {
  /** 完整顺序(含当前不可见模块;隐藏模块保槽位) */
  order: SortableGenModuleKey[];
  /** 当前可见序列(order 的子序列,渲染顺序) */
  visibleKeys: SortableGenModuleKey[];
  onOrderChange: (next: SortableGenModuleKey[]) => void;
}

interface DragSession {
  key: SortableGenModuleKey;
  pointerId: number;
  startX: number;
  startY: number;
  longPressTimer: ReturnType<typeof setTimeout> | null;
  dragging: boolean;
  handleMove: (event: PointerEvent) => void;
  handleEnd: (event: PointerEvent) => void;
  touchMovePreventer: ((event: TouchEvent) => void) | null;
}

export type MobileCardDragHandleProps = Pick<
  HTMLAttributes<HTMLDivElement>,
  'onPointerDown' | 'onClickCapture' | 'onContextMenu' | 'title'
>;

// 卡头长按起拖的拖拽排序(对齐 Plana SliverReorderableList 的卡头 ReorderableDragStartListener
// 语义:手势只挂卡头/标题区,不挂输入区,避免抢文本框手势)。实现要点:
//   - pointerdown 起 400ms 计时,期间移动超阈值 = 滚动意图,取消起拖;
//   - 起拖后挂 window 级非 passive touchmove preventDefault 阻断滚动,并禁用文本选择;
//   - 拖动中按指针纵坐标与各卡中线的关系实时重排(写回完整 order,隐藏模块槽位不动);
//   - 松手(或 pointercancel)结束;拖过的那一次 click 被吞掉,避免误触卡头展开/收起。
export function useMobileCardDragSort({
  order,
  visibleKeys,
  onOrderChange,
}: UseMobileCardDragSortOptions) {
  const [draggingKey, setDraggingKey] = useState<SortableGenModuleKey | null>(null);
  const cardElsRef = useRef(new Map<SortableGenModuleKey, HTMLDivElement>());
  const sessionRef = useRef<DragSession | null>(null);
  const suppressClickRef = useRef(false);
  // window 级监听在会话期内驻留,经 ref 读最新 props,避免每次重排重建监听
  const latestRef = useRef({ order, visibleKeys, onOrderChange });
  latestRef.current = { order, visibleKeys, onOrderChange };

  const endSession = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    sessionRef.current = null;
    if (session.longPressTimer) clearTimeout(session.longPressTimer);
    window.removeEventListener('pointermove', session.handleMove);
    window.removeEventListener('pointerup', session.handleEnd);
    window.removeEventListener('pointercancel', session.handleEnd);
    if (session.touchMovePreventer) {
      window.removeEventListener('touchmove', session.touchMovePreventer);
    }
    document.body.style.userSelect = '';
    document.body.style.removeProperty('-webkit-user-select');
    if (session.dragging) {
      // 吞掉紧随 pointerup 的那次 click(否则卡头会被误触展开/收起)
      suppressClickRef.current = true;
      setDraggingKey(null);
    }
  }, []);

  // 卸载兜底:拖拽中途组件卸载时拆除全部监听与滚动守卫
  useEffect(() => endSession, [endSession]);

  const reorderTo = useCallback((clientY: number) => {
    const session = sessionRef.current;
    if (!session?.dragging) return;
    const { order, visibleKeys, onOrderChange } = latestRef.current;
    const from = visibleKeys.indexOf(session.key);
    if (from < 0) return;
    // 在「拖动项之外」的卡片里找插入位:第一张中线在指针下方的卡之前
    const others = visibleKeys.filter((key) => key !== session.key);
    let insertAt = others.length;
    for (let i = 0; i < others.length; i += 1) {
      const el = cardElsRef.current.get(others[i]);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        insertAt = i;
        break;
      }
    }
    // insertAt 以「移除拖动项后」的序列(= others)为基准,与
    // moveVisibleGenModule 的 splice(from,1)+splice(to,0) 同基准,直接对齐
    const next = moveVisibleGenModule(order, visibleKeys, from, insertAt);
    if (next !== order) onOrderChange(next);
  }, []);

  const getDragHandleProps = useCallback((key: SortableGenModuleKey): MobileCardDragHandleProps => ({
    title: `${genModuleDef(key).title}:长按拖动调整顺序`,
    onPointerDown: (event) => {
      // 只响应主指针/左键;已有会话或多指/右键不启动
      if (sessionRef.current || (event.pointerType === 'mouse' && event.button !== 0)) return;
      const session = {
        key,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        longPressTimer: null,
        dragging: false,
        handleMove: () => {},
        handleEnd: () => {},
        touchMovePreventer: null,
      } as DragSession;

      session.handleMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== session.pointerId) return;
        if (!session.dragging) {
          const dist = Math.hypot(moveEvent.clientX - session.startX, moveEvent.clientY - session.startY);
          if (dist > MOVE_CANCEL_PX) endSession();
          return;
        }
        reorderTo(moveEvent.clientY);
      };
      session.handleEnd = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== session.pointerId) return;
        endSession();
      };

      session.longPressTimer = setTimeout(() => {
        session.longPressTimer = null;
        session.dragging = true;
        setDraggingKey(key);
        // 阻断起拖后的页面滚动与文本选择(touchmove 需非 passive 才能 preventDefault)
        session.touchMovePreventer = (e: TouchEvent) => e.preventDefault();
        window.addEventListener('touchmove', session.touchMovePreventer, { passive: false });
        document.body.style.userSelect = 'none';
        document.body.style.setProperty('-webkit-user-select', 'none');
      }, LONG_PRESS_MS);

      sessionRef.current = session;
      window.addEventListener('pointermove', session.handleMove);
      window.addEventListener('pointerup', session.handleEnd);
      window.addEventListener('pointercancel', session.handleEnd);
    },
    onClickCapture: (event) => {
      if (suppressClickRef.current) {
        suppressClickRef.current = false;
        event.preventDefault();
        event.stopPropagation();
      }
    },
    onContextMenu: (event) => event.preventDefault(),
  }), [endSession, reorderTo]);

  const registerCard = useCallback((key: SortableGenModuleKey) => (el: HTMLDivElement | null) => {
    if (el) {
      cardElsRef.current.set(key, el);
    } else {
      cardElsRef.current.delete(key);
    }
  }, []);

  return { draggingKey, getDragHandleProps, registerCard };
}
