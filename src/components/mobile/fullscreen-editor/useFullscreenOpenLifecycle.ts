import { useEffect, type RefObject } from 'react';

interface UseFullscreenOpenLifecycleArgs {
  isOpen: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  clearSelection: () => void;
  clearEditing: () => void;
}

export function useFullscreenOpenLifecycle({
  isOpen,
  inputRef,
  clearSelection,
  clearEditing,
}: UseFullscreenOpenLifecycleArgs) {
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 100);
    } else {
      clearSelection();
      clearEditing();
    }
  }, [clearEditing, clearSelection, inputRef, isOpen]);
}
