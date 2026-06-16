import { useCallback, useRef } from 'react';
import { NEWLINE_SENTINEL } from '../../utils/promptTags';

interface UseDesktopChipValueParams {
  value: string;
  onChange: (value: string) => void;
}

export function useDesktopChipValue({ value, onChange }: UseDesktopChipValueParams) {
  const undoStackRef = useRef<string[]>([]);
  const isUndoingRef = useRef(false);

  const saveValue = useCallback((newValue: string) => {
    if (!isUndoingRef.current && newValue !== value) {
      undoStackRef.current.push(value);
      if (undoStackRef.current.length > 50) undoStackRef.current.shift();
    }
    onChange(newValue);
  }, [onChange, value]);

  const rebuildValue = useCallback((tags: string[]) => {
    let result = '';
    for (const tag of tags) {
      if (tag === NEWLINE_SENTINEL) {
        result = result.replace(/,\s*$/, '');
        result += '\n';
      } else {
        if (result && !result.endsWith('\n')) {
          result += ', ';
        }
        result += tag;
      }
    }
    saveValue(result.replace(/,\s*$/, ''));
  }, [saveValue]);

  return { saveValue, rebuildValue, undoStackRef, isUndoingRef };
}
