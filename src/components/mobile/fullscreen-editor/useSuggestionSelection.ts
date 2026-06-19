import { useCallback, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from 'react';
import { translateToNaturalLanguage } from '../../../services/translate';
import {
  cancelPendingAutocomplete,
  type TagSuggestion,
} from '../../../services/tagAutocomplete';

interface UseSuggestionSelectionArgs {
  rawMode: boolean;
  value: string;
  inputText: string;
  editingTagText: string | null;
  selectedTags: Set<number>;
  parsedTags: string[];
  tagTranslations: Map<string, string>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  suppressChipClickRef: MutableRefObject<boolean>;
  saveValue: (value: string) => void;
  commitInput: (text: string) => void;
  rebuildValue: (tags: string[]) => void;
  setInputText: (text: string) => void;
  setShowSuggestions: (show: boolean) => void;
  setSuggestions: (suggestions: TagSuggestion[]) => void;
  setNlTranslating: (loading: boolean) => void;
  setSelectedTags: (tags: Set<number>) => void;
  setEditingTagText: (text: string | null) => void;
  setTagTranslations: Dispatch<SetStateAction<Map<string, string>>>;
}

const insertIntoRawText = (
  textarea: HTMLTextAreaElement,
  value: string,
  inserted: string,
  saveValue: (value: string) => void,
) => {
  const pos = textarea.selectionStart;
  const before = value.slice(0, pos);
  const after = value.slice(pos);
  const lastComma = Math.max(before.lastIndexOf(','), before.lastIndexOf('，'));
  const newBefore = before.slice(0, lastComma + 1) + (lastComma >= 0 ? ' ' : '') + inserted;
  saveValue(newBefore + after);
  const newPos = newBefore.length;
  requestAnimationFrame(() => {
    textarea.selectionStart = textarea.selectionEnd = newPos;
  });
};

export const useSuggestionSelection = ({
  rawMode,
  value,
  inputText,
  editingTagText,
  selectedTags,
  parsedTags,
  tagTranslations,
  textareaRef,
  suppressChipClickRef,
  saveValue,
  commitInput,
  rebuildValue,
  setInputText,
  setShowSuggestions,
  setSuggestions,
  setNlTranslating,
  setSelectedTags,
  setEditingTagText,
  setTagTranslations,
}: UseSuggestionSelectionArgs) => {
  return useCallback((suggestion: TagSuggestion) => {
    if (editingTagText !== null && selectedTags.size === 1) {
      if (suggestion.isNaturalLanguage || suggestion.isArtist || suggestion.isOC) {
        setShowSuggestions(false);
        setSuggestions([]);
        return;
      }
      const idx = Array.from(selectedTags)[0];
      const t = [...parsedTags];
      t[idx] = suggestion.value;
      rebuildValue(t);
      setSelectedTags(new Set());
      setEditingTagText(null);
      setShowSuggestions(false);
      setSuggestions([]);
      if (suggestion.chineseName) {
        const cleanKey = suggestion.value.replace(/_/g, ' ').trim();
        if (cleanKey && !tagTranslations.has(cleanKey)) {
          setTagTranslations(prev => new Map(prev).set(cleanKey, suggestion.chineseName!));
        }
      }
      return;
    }
    if (suggestion.isNaturalLanguage) {
      const chineseText = inputText.trim();
      setInputText('');
      setShowSuggestions(false);
      setSuggestions([]);
      cancelPendingAutocomplete();
      setNlTranslating(true);
      translateToNaturalLanguage(chineseText).then((translated) => {
        setNlTranslating(false);
        if (translated && translated !== chineseText) {
          commitInput(translated);
        } else {
          setInputText(chineseText);
        }
      });
      return;
    }
    if (suggestion.isArtist && suggestion.artistContent) {
      const artistMarker = `<<artist:${suggestion.label}:${suggestion.artistContent}>>`;
      if (rawMode && textareaRef.current) {
        insertIntoRawText(textareaRef.current, value, artistMarker, saveValue);
      } else {
        const newVal = value ? value + ', ' + artistMarker : artistMarker;
        saveValue(newVal);
      }
      setInputText('');
      setShowSuggestions(false);
      setSuggestions([]);
      suppressChipClickRef.current = true;
      setTimeout(() => { suppressChipClickRef.current = false; }, 300);
      return;
    }
    if (suggestion.isOC && suggestion.ocContent) {
      const ocMarker = `<<oc:${suggestion.label}:${suggestion.ocContent}>>`;
      if (rawMode && textareaRef.current) {
        insertIntoRawText(textareaRef.current, value, ocMarker, saveValue);
      } else {
        const newVal = value ? value + ', ' + ocMarker : ocMarker;
        saveValue(newVal);
      }
      setInputText('');
      setShowSuggestions(false);
      setSuggestions([]);
      suppressChipClickRef.current = true;
      setTimeout(() => { suppressChipClickRef.current = false; }, 300);
      return;
    }
    if (rawMode && textareaRef.current) {
      insertIntoRawText(textareaRef.current, value, suggestion.value, saveValue);
    } else {
      commitInput(suggestion.value);
    }
    setShowSuggestions(false);
    setSuggestions([]);
    if (suggestion.chineseName) {
      const cleanKey = suggestion.value.replace(/_/g, ' ').trim();
      if (cleanKey && !tagTranslations.has(cleanKey)) {
        setTagTranslations(prev => new Map(prev).set(cleanKey, suggestion.chineseName!));
      }
    }
    suppressChipClickRef.current = true;
    setTimeout(() => { suppressChipClickRef.current = false; }, 300);
  }, [
    rawMode,
    value,
    saveValue,
    commitInput,
    tagTranslations,
    inputText,
    editingTagText,
    selectedTags,
    parsedTags,
    rebuildValue,
    textareaRef,
    suppressChipClickRef,
    setInputText,
    setShowSuggestions,
    setSuggestions,
    setNlTranslating,
    setSelectedTags,
    setEditingTagText,
    setTagTranslations,
  ]);
};
