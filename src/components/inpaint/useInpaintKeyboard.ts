import { useEffect, type Dispatch, type SetStateAction } from 'react';

interface UseInpaintKeyboardParams {
  onClose: () => void;
  setSpacePressed: Dispatch<SetStateAction<boolean>>;
  setIsPanning: Dispatch<SetStateAction<boolean>>;
  /** 照官方画布的快捷键:b 笔刷、e 橡皮、l 套索、s 焦点框、[ ] 笔刷大小,Cmd/Ctrl+Z 撤销、Shift 加 Z 或 Y 重做。 */
  onUndo?: () => void;
  onRedo?: () => void;
  onBrush?: () => void;
  onEraser?: () => void;
  onLasso?: () => void;
  onToggleCrop?: () => void;
  onBrushSizeDelta?: (delta: number) => void;
}

const isTypingTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
};

export function useInpaintKeyboard({
  onClose,
  setSpacePressed,
  setIsPanning,
  onUndo,
  onRedo,
  onBrush,
  onEraser,
  onLasso,
  onToggleCrop,
  onBrushSizeDelta,
}: UseInpaintKeyboardParams) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code === 'Space') {
        if (isTypingTarget(event.target)) return;
        event.preventDefault();
        setSpacePressed(true);
        return;
      }
      if (event.code === 'Escape') {
        onClose();
        return;
      }
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.code === 'KeyZ') {
        if (isTypingTarget(event.target)) return;
        event.preventDefault();
        if (event.shiftKey) onRedo?.(); else onUndo?.();
        return;
      }
      if (mod && event.code === 'KeyY') {
        if (isTypingTarget(event.target)) return;
        event.preventDefault();
        onRedo?.();
        return;
      }
      if (mod || event.altKey || isTypingTarget(event.target)) return;
      switch (event.code) {
        case 'KeyB': onBrush?.(); break;
        case 'KeyE': onEraser?.(); break;
        case 'KeyL': onLasso?.(); break;
        case 'KeyS': onToggleCrop?.(); break;
        case 'BracketLeft': onBrushSizeDelta?.(event.shiftKey ? -20 : -5); break;
        case 'BracketRight': onBrushSizeDelta?.(event.shiftKey ? 20 : 5); break;
        default: return;
      }
      event.preventDefault();
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') {
        setSpacePressed(false);
        setIsPanning(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [onBrush, onBrushSizeDelta, onClose, onEraser, onLasso, onRedo, onToggleCrop, onUndo, setIsPanning, setSpacePressed]);
}
