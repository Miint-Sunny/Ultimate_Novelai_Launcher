import { useCallback, useState } from 'react';
import type { ClipboardEvent, Dispatch, RefObject, SetStateAction } from 'react';
import { getTagSuggestionsDebounced, type TagSuggestion } from '../../services/tagAutocomplete';
import { isInsideUnclosedQuote } from '../../utils/textRenderHints';

interface EditingTagState {
  index: number;
  text: string;
  width: number;
  height: number;
}

interface UseDesktopChipInputParams {
  value: string;
  parsedTags: string[];
  editingTag: EditingTagState | null;
  inputRef: RefObject<HTMLInputElement | null>;
  editInputRef: RefObject<HTMLInputElement | null>;
  saveValue: (newValue: string) => void;
  rebuildValue: (tags: string[]) => void;
  setEditingTag: Dispatch<SetStateAction<EditingTagState | null>>;
  setSuggestionPos: Dispatch<SetStateAction<{ top: number; left: number } | null>>;
  setShowSuggestions: Dispatch<SetStateAction<boolean>>;
  setSuggestions: Dispatch<SetStateAction<TagSuggestion[]>>;
  setSelectedSuggIdx: Dispatch<SetStateAction<number>>;
  /** V5 文字渲染:输入落在未闭合引号内时不弹 Danbooru 补全。 */
  suppressAutocompleteInQuotes?: boolean;
}

export function useDesktopChipInput({
  value,
  parsedTags,
  editingTag,
  inputRef,
  editInputRef,
  saveValue,
  rebuildValue,
  setEditingTag,
  setSuggestionPos,
  setShowSuggestions,
  setSuggestions,
  setSelectedSuggIdx,
  suppressAutocompleteInQuotes = false,
}: UseDesktopChipInputParams) {
  const [inputText, setInputText] = useState('');

  const commitInput = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const newValue = value ? `${value}, ${trimmed}` : trimmed;
    saveValue(newValue);
    setInputText('');
    setShowSuggestions(false);
    setSuggestions([]);
  }, [value, saveValue, setShowSuggestions, setSuggestions]);

  const triggerAutocomplete = useCallback((text: string) => {
    const trimmed = text.trim();
    // V5 文字渲染:输入落在未闭合引号内时这段是「要画进图里的文字」,
    // 弹 Danbooru tag 补全是错误引导,直接让路。
    if (suppressAutocompleteInQuotes && isInsideUnclosedQuote(trimmed)) {
      setShowSuggestions(false);
      setSuggestions([]);
      return;
    }
    const hasChinese = /[\u4e00-\u9fa5]/.test(trimmed);
    const minLen = hasChinese ? 1 : 2;
    if (trimmed.length >= minLen) {
      const posRef = editingTag ? editInputRef.current : inputRef.current;
      if (posRef) {
        const rect = posRef.getBoundingClientRect();
        setSuggestionPos({ top: rect.bottom + window.scrollY, left: rect.left + window.scrollX });
      }
      getTagSuggestionsDebounced(trimmed, (newSuggestions) => {
        if (newSuggestions.length > 0) {
          setSuggestions([...newSuggestions]);
          setShowSuggestions(true);
          setSelectedSuggIdx(prev => Math.min(prev, newSuggestions.length - 1));
        } else {
          setShowSuggestions(false);
          setSuggestions([]);
        }
      }, 250);
    } else {
      setShowSuggestions(false);
      setSuggestions([]);
    }
  }, [editingTag, editInputRef, inputRef, setSelectedSuggIdx, setShowSuggestions, setSuggestionPos, setSuggestions, suppressAutocompleteInQuotes]);

  const handleInputChange = useCallback((text: string) => {
    const commaMatch = text.match(/[,，]/);
    if (commaMatch) {
      const beforeComma = text.slice(0, commaMatch.index);
      const hasChinese = /[\u4e00-\u9fa5]/.test(beforeComma);
      if (!hasChinese) {
        const parts = text.split(/[,，]/);
        const tagsToCommit = parts.slice(0, -1).map(part => part.trim()).filter(Boolean);
        if (tagsToCommit.length > 0) {
          const allTags = tagsToCommit.join(', ');
          const newValue = value ? `${value}, ${allTags}` : allTags;
          saveValue(newValue);
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
  }, [value, saveValue, setShowSuggestions, setSuggestions, triggerAutocomplete]);

  const commitEdit = useCallback((index: number, newText: string) => {
    const trimmed = newText.trim();
    if (!trimmed) {
      rebuildValue(parsedTags.filter((_, tagIndex) => tagIndex !== index));
    } else if (trimmed !== parsedTags[index]?.trim()) {
      const tags = [...parsedTags];
      tags[index] = trimmed;
      rebuildValue(tags);
    }
    setEditingTag(null);
  }, [parsedTags, rebuildValue, setEditingTag]);

  const cancelEdit = useCallback(() => {
    if (editingTag) {
      const rawTag = parsedTags[editingTag.index];
      if (rawTag && rawTag.trim() === 'new_tag') {
        rebuildValue(parsedTags.filter((_, tagIndex) => tagIndex !== editingTag.index));
      }
    }
    setEditingTag(null);
  }, [editingTag, parsedTags, rebuildValue, setEditingTag]);

  const handlePaste = useCallback((event: ClipboardEvent<HTMLInputElement>) => {
    const pasted = event.clipboardData.getData('text');
    if (!pasted) return;
    const lines = pasted.split(/\r?\n/).map(line =>
      line.split(/[,，]/).map(part => part.trim()).filter(Boolean).join(', ')
    ).filter(Boolean);
    if (lines.length === 0) return;
    if (lines.length === 1 && !lines[0].includes(',')) return;
    event.preventDefault();
    const allTags = lines.join('\n');
    const newValue = value ? `${value}, ${allTags}` : allTags;
    saveValue(newValue);
    setInputText('');
    setShowSuggestions(false);
    setSuggestions([]);
  }, [value, saveValue, setShowSuggestions, setSuggestions]);

  return {
    inputText,
    setInputText,
    commitInput,
    triggerAutocomplete,
    handleInputChange,
    commitEdit,
    cancelEdit,
    handlePaste,
  };
}
