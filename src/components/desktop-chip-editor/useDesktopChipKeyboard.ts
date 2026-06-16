import { useCallback } from 'react';
import type { Dispatch, KeyboardEvent, MutableRefObject, SetStateAction } from 'react';
import { lookupCharacterChineseName, type TagSuggestion } from '../../services/tagAutocomplete';

interface TagPanelState {
  index: number;
  rawTag: string;
  tag: string;
  translation: string;
  screenX: number;
  screenY: number;
}

interface UseDesktopChipKeyboardParams {
  inputText: string;
  parsedTags: string[];
  selectedTags: Set<number>;
  tagPanel: TagPanelState | null;
  showSuggestions: boolean;
  displaySuggs: TagSuggestion[];
  selectedSuggIdx: number;
  undoStackRef: MutableRefObject<string[]>;
  isUndoingRef: MutableRefObject<boolean>;
  selectSuggestion: (suggestion: TagSuggestion) => void;
  commitInput: (text: string) => void;
  rebuildValue: (tags: string[]) => void;
  saveValue: (newValue: string) => void;
  setSelectedSuggIdx: Dispatch<SetStateAction<number>>;
  setSelectedTags: Dispatch<SetStateAction<Set<number>>>;
  setShowSuggestions: Dispatch<SetStateAction<boolean>>;
  setSuggestions: Dispatch<SetStateAction<TagSuggestion[]>>;
  setTagPanel: Dispatch<SetStateAction<TagPanelState | null>>;
}

function selectSuggestionOrOrigin(suggestion: TagSuggestion, selectSuggestion: (suggestion: TagSuggestion) => void) {
  if (suggestion.isAiLoading) return;
  if (suggestion.isOrigin) {
    const chars = suggestion.originCharacters || [];
    if (chars.length > 0) {
      const randomCharacter = chars[Math.floor(Math.random() * chars.length)];
      selectSuggestion({
        ...suggestion,
        value: randomCharacter,
        chineseName: lookupCharacterChineseName(randomCharacter),
        isOrigin: false,
      });
    }
    return;
  }
  selectSuggestion(suggestion);
}

export function useDesktopChipKeyboard({
  inputText,
  parsedTags,
  selectedTags,
  tagPanel,
  showSuggestions,
  displaySuggs,
  selectedSuggIdx,
  undoStackRef,
  isUndoingRef,
  selectSuggestion,
  commitInput,
  rebuildValue,
  saveValue,
  setSelectedSuggIdx,
  setSelectedTags,
  setShowSuggestions,
  setSuggestions,
  setTagPanel,
}: UseDesktopChipKeyboardParams) {
  const handleInputKeyDown = useCallback((event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'a' && !inputText) {
      event.preventDefault();
      if (parsedTags.length > 0) {
        const allIndices = new Set<number>();
        for (let index = 0; index < parsedTags.length; index++) allIndices.add(index);
        setSelectedTags(allIndices);
        setTagPanel(null);
      }
      return;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      if (showSuggestions && displaySuggs.length > 0) {
        event.preventDefault();
        const index = selectedSuggIdx >= 0 && selectedSuggIdx < displaySuggs.length ? selectedSuggIdx : 0;
        selectSuggestionOrOrigin(displaySuggs[index], selectSuggestion);
      } else if (event.key === 'Enter' && inputText.trim()) {
        event.preventDefault();
        commitInput(inputText);
      }
    } else if (event.key === 'ArrowDown' && showSuggestions && displaySuggs.length > 0) {
      event.preventDefault();
      setSelectedSuggIdx(prev => {
        let next = (prev + 1) % displaySuggs.length;
        if (displaySuggs[next]?.isAiLoading) next = (next + 1) % displaySuggs.length;
        return next;
      });
    } else if (event.key === 'ArrowUp' && showSuggestions && displaySuggs.length > 0) {
      event.preventDefault();
      setSelectedSuggIdx(prev => {
        let next = (prev - 1 + displaySuggs.length) % displaySuggs.length;
        if (displaySuggs[next]?.isAiLoading) next = (next - 1 + displaySuggs.length) % displaySuggs.length;
        return next;
      });
    } else if (event.key === 'Escape') {
      if (showSuggestions) {
        setShowSuggestions(false);
        setSuggestions([]);
      } else if (tagPanel) {
        setTagPanel(null);
      } else if (selectedTags.size > 0) {
        setSelectedTags(new Set());
      }
    } else if (event.key === 'Backspace' && !inputText && parsedTags.length > 0) {
      event.preventDefault();
      const tags = [...parsedTags];
      tags.pop();
      rebuildValue(tags);
    }
  }, [
    commitInput,
    displaySuggs,
    inputText,
    parsedTags,
    rebuildValue,
    selectSuggestion,
    selectedSuggIdx,
    selectedTags,
    setSelectedSuggIdx,
    setSelectedTags,
    setShowSuggestions,
    setSuggestions,
    setTagPanel,
    showSuggestions,
    tagPanel,
  ]);

  const handleContainerKeyDown = useCallback((event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'a') {
      if (inputText) return;
      event.preventDefault();
      if (parsedTags.length > 0) {
        const allIndices = new Set<number>();
        for (let index = 0; index < parsedTags.length; index++) allIndices.add(index);
        setSelectedTags(allIndices);
        setTagPanel(null);
      }
    }

    if ((event.ctrlKey || event.metaKey) && event.key === 'c' && selectedTags.size > 0 && !inputText) {
      event.preventDefault();
      const indices = Array.from(selectedTags).sort((a, b) => a - b);
      const tagsToCopy = indices.map(index => parsedTags[index]).join(', ');
      navigator.clipboard.writeText(tagsToCopy).catch(() => { });
    }

    if ((event.key === 'Delete' || event.key === 'Backspace') && selectedTags.size > 0 && !inputText) {
      event.preventDefault();
      rebuildValue(parsedTags.filter((_, index) => !selectedTags.has(index)));
      setSelectedTags(new Set());
      setTagPanel(null);
    }

    if ((event.ctrlKey || event.metaKey) && event.key === 'z' && !inputText) {
      const prev = undoStackRef.current.pop();
      if (prev !== undefined) {
        event.preventDefault();
        isUndoingRef.current = true;
        saveValue(prev);
        isUndoingRef.current = false;
        setSelectedTags(new Set());
        setTagPanel(null);
      }
    }
  }, [
    inputText,
    isUndoingRef,
    parsedTags,
    rebuildValue,
    saveValue,
    selectedTags,
    setSelectedTags,
    setTagPanel,
    undoStackRef,
  ]);

  return { handleInputKeyDown, handleContainerKeyDown };
}
