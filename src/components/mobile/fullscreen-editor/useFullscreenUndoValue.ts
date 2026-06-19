import { useCallback, useEffect, useRef, useState } from 'react';

interface UseFullscreenUndoValueArgs {
  isOpen: boolean;
  type: 'prompt' | 'undesired';
  value: string;
  onChange: (value: string) => void;
  clearSelection: () => void;
  clearEditing: () => void;
}

export function useFullscreenUndoValue({
  isOpen,
  type,
  value,
  onChange,
  clearSelection,
  clearEditing,
}: UseFullscreenUndoValueArgs) {
  const undoStackRef = useRef<string[]>([]);
  const isUndoingRef = useRef(false);
  const lastUndoPushRef = useRef(0);
  const [undoDepth, setUndoDepth] = useState(0);

  const saveValue = useCallback((newValue: string) => {
    if (!isUndoingRef.current && newValue !== value) {
      const now = Date.now();
      if (now - lastUndoPushRef.current > 800) {
        undoStackRef.current.push(value);
        if (undoStackRef.current.length > 50) undoStackRef.current.shift();
        setUndoDepth(undoStackRef.current.length);
      }
      lastUndoPushRef.current = now;
    }
    onChange(newValue);
  }, [onChange, value]);

  const handleUndo = useCallback(() => {
    const prev = undoStackRef.current.pop();
    if (prev === undefined) return;
    setUndoDepth(undoStackRef.current.length);
    isUndoingRef.current = true;
    saveValue(prev);
    isUndoingRef.current = false;
    lastUndoPushRef.current = 0;
    clearSelection();
    clearEditing();
  }, [clearEditing, clearSelection, saveValue]);

  useEffect(() => {
    undoStackRef.current = [];
    lastUndoPushRef.current = 0;
    setUndoDepth(0);
  }, [isOpen, type]);

  return {
    saveValue,
    handleUndo,
    undoDepth,
  };
}
