import { useCallback, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import {
  getTagSuggestionsDebounced,
  type TagSuggestion,
} from '../../../services/tagAutocomplete';

interface UseFullscreenInputWorkflowArgs {
  value: string;
  parsedTags: string[];
  saveValue: (value: string) => void;
  rebuildValue: (tags: string[]) => void;
  scrollToBottom: () => void;
}

export function useFullscreenInputWorkflow({
  value,
  parsedTags,
  saveValue,
  rebuildValue,
  scrollToBottom,
}: UseFullscreenInputWorkflowArgs) {
  const [inputText, setInputText] = useState('');
  const [suggestions, setSuggestions] = useState<TagSuggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedSuggIdx, setSelectedSuggIdx] = useState(0);

  const commitInput = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const newVal = value ? value + ', ' + trimmed : trimmed;
    saveValue(newVal);
    setInputText('');
    setShowSuggestions(false);
    setSuggestions([]);
  }, [saveValue, value]);

  const triggerAutocomplete = useCallback((text: string) => {
    const trimmed = text.trim();
    const hasChinese = /[\u4e00-\u9fa5]/.test(trimmed);
    const minLen = hasChinese ? 1 : 2;
    if (trimmed.length >= minLen) {
      getTagSuggestionsDebounced(trimmed, (newSuggestions) => {
        if (newSuggestions.length > 0) {
          setSuggestions([...newSuggestions]);
          setShowSuggestions(true);
          setSelectedSuggIdx(-1);
          scrollToBottom();
        } else {
          setShowSuggestions(false);
          setSuggestions([]);
        }
      }, 250);
    } else {
      setShowSuggestions(false);
      setSuggestions([]);
    }
  }, [scrollToBottom]);

  const handleInputChange = useCallback((text: string) => {
    const commaMatch = text.match(/[,，]/);
    if (commaMatch) {
      const beforeComma = text.slice(0, commaMatch.index);
      const hasChinese = /[\u4e00-\u9fa5]/.test(beforeComma);
      if (!hasChinese) {
        const parts = text.split(/[,，]/);
        const tagsToCommit = parts.slice(0, -1).map((part) => part.trim()).filter(Boolean);
        if (tagsToCommit.length > 0) {
          const allTags = tagsToCommit.join(', ');
          const newVal = value ? value + ', ' + allTags : allTags;
          saveValue(newVal);
        }
        const remaining = parts[parts.length - 1];
        setInputText(remaining);
        setShowSuggestions(false);
        setSuggestions([]);
        triggerAutocomplete(remaining);
        return;
      }
    }
    setInputText(text);
    triggerAutocomplete(text);
  }, [saveValue, triggerAutocomplete, value]);

  const handlePaste = useCallback((event: ClipboardEvent<HTMLInputElement>) => {
    const pasted = event.clipboardData.getData('text');
    if (!pasted) return;
    const lines = pasted.split(/\r?\n/).map((line) =>
      line.split(/[,，]/).map((part) => part.trim()).filter(Boolean).join(', ')
    ).filter(Boolean);
    if (lines.length === 0) return;
    if (lines.length === 1 && !lines[0].includes(',')) return;
    event.preventDefault();
    const allTags = lines.join('\n');
    const newVal = value ? value + ', ' + allTags : allTags;
    saveValue(newVal);
    setInputText('');
    setShowSuggestions(false);
    setSuggestions([]);
  }, [saveValue, value]);

  const handleInputKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (inputText.trim()) {
        commitInput(inputText);
      }
    } else if (event.key === 'ArrowDown' && showSuggestions) {
      event.preventDefault();
      setSelectedSuggIdx((prev) => (prev + 1) % suggestions.length);
    } else if (event.key === 'ArrowUp' && showSuggestions) {
      event.preventDefault();
      setSelectedSuggIdx((prev) => (prev - 1 + suggestions.length) % suggestions.length);
    } else if (event.key === 'Backspace' && !inputText && parsedTags.length > 0) {
      event.preventDefault();
      const tags = [...parsedTags];
      tags.pop();
      rebuildValue(tags);
    }
  }, [commitInput, inputText, parsedTags, rebuildValue, showSuggestions, suggestions.length]);

  return {
    inputText,
    setInputText,
    suggestions,
    setSuggestions,
    showSuggestions,
    setShowSuggestions,
    selectedSuggIdx,
    commitInput,
    triggerAutocomplete,
    handleInputChange,
    handlePaste,
    handleInputKeyDown,
  };
}
