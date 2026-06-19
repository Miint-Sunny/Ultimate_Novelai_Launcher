import { useCallback, useEffect, useRef } from 'react';

interface UseFullscreenTagEditingArgs {
  editingTagText: string | null;
  setEditingTagText: (text: string | null) => void;
  selectedTags: Set<number>;
  parsedTags: string[];
  rebuildValue: (tags: string[]) => void;
  setSelectedTags: (tags: Set<number>) => void;
  clearSuggestions: () => void;
}

export function useFullscreenTagEditing({
  editingTagText,
  setEditingTagText,
  selectedTags,
  parsedTags,
  rebuildValue,
  setSelectedTags,
  clearSuggestions,
}: UseFullscreenTagEditingArgs) {
  const prevSelectedRef = useRef(selectedTags);

  useEffect(() => {
    if (prevSelectedRef.current !== selectedTags) {
      prevSelectedRef.current = selectedTags;
      setEditingTagText(null);
    }
  }, [selectedTags]);

  const commitTagEdit = useCallback(() => {
    if (editingTagText === null || selectedTags.size !== 1) {
      setEditingTagText(null);
      return;
    }
    const idx = Array.from(selectedTags)[0];
    const trimmed = editingTagText.trim();
    if (!trimmed) {
      rebuildValue(parsedTags.filter((_, index) => index !== idx));
      setSelectedTags(new Set());
    } else if (trimmed !== parsedTags[idx]?.trim()) {
      const tags = [...parsedTags];
      tags[idx] = trimmed;
      rebuildValue(tags);
      setSelectedTags(new Set());
    }
    setEditingTagText(null);
    clearSuggestions();
  }, [clearSuggestions, editingTagText, parsedTags, rebuildValue, selectedTags, setSelectedTags]);

  const cancelTagEdit = useCallback(() => {
    setEditingTagText(null);
    clearSuggestions();
  }, [clearSuggestions]);

  return {
    commitTagEdit,
    cancelTagEdit,
  };
}
