import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import { cancelPendingAutocomplete, type TagSuggestion } from '../../services/tagAutocomplete';
import { translateToNaturalLanguage } from '../../services/translate';

interface EditingTagState {
  index: number;
  text: string;
  width: number;
  height: number;
}

interface UseDesktopSuggestionSelectionParams {
  value: string;
  inputText: string;
  editingTag: EditingTagState | null;
  tagTranslations: Map<string, string>;
  saveValue: (newValue: string) => void;
  commitInput: (text: string) => void;
  commitEdit: (index: number, newText: string) => void;
  setInputText: Dispatch<SetStateAction<string>>;
  setShowSuggestions: Dispatch<SetStateAction<boolean>>;
  setSuggestions: Dispatch<SetStateAction<TagSuggestion[]>>;
  setTagTranslations: Dispatch<SetStateAction<Map<string, string>>>;
}

export function useDesktopSuggestionSelection({
  value,
  inputText,
  editingTag,
  tagTranslations,
  saveValue,
  commitInput,
  commitEdit,
  setInputText,
  setShowSuggestions,
  setSuggestions,
  setTagTranslations,
}: UseDesktopSuggestionSelectionParams) {
  const [nlTranslating, setNlTranslating] = useState(false);

  const clearSuggestions = useCallback(() => {
    setShowSuggestions(false);
    setSuggestions([]);
  }, [setShowSuggestions, setSuggestions]);

  const cacheChineseName = useCallback((suggestion: TagSuggestion) => {
    if (!suggestion.chineseName) return;
    const cleanKey = suggestion.value.replace(/_/g, ' ').trim();
    if (cleanKey && !tagTranslations.has(cleanKey)) {
      setTagTranslations(prev => new Map(prev).set(cleanKey, suggestion.chineseName!));
    }
  }, [setTagTranslations, tagTranslations]);

  const selectSuggestion = useCallback((suggestion: TagSuggestion) => {
    if (editingTag) {
      if (suggestion.isNaturalLanguage || suggestion.isArtist || suggestion.isOC) {
        clearSuggestions();
        return;
      }
      commitEdit(editingTag.index, suggestion.value);
      clearSuggestions();
      cacheChineseName(suggestion);
      return;
    }

    if (suggestion.isChunk) {
      // 芯片里存的是 `!macro:Label!` 引用本身,正文在发送时才展开(官方:片段不进元数据)。
      commitInput(suggestion.value);
      clearSuggestions();
      return;
    }

    if (suggestion.isNaturalLanguage) {
      const chineseText = inputText.trim();
      setInputText('');
      clearSuggestions();
      cancelPendingAutocomplete();
      setNlTranslating(true);
      translateToNaturalLanguage(chineseText).then((translated) => {
        setNlTranslating(false);
        if (translated && translated !== chineseText) {
          const newValue = value ? `${value}, ${translated}` : translated;
          saveValue(newValue);
        } else {
          setInputText(chineseText);
        }
      });
      return;
    }

    if (suggestion.isArtist && suggestion.artistContent) {
      const artistMarker = `<<artist:${suggestion.label}:${suggestion.artistContent}>>`;
      const newValue = value ? `${value}, ${artistMarker}` : artistMarker;
      saveValue(newValue);
      setInputText('');
      clearSuggestions();
      return;
    }

    if (suggestion.isOC && suggestion.ocContent) {
      const ocMarker = `<<oc:${suggestion.label}:${suggestion.ocContent}>>`;
      const newValue = value ? `${value}, ${ocMarker}` : ocMarker;
      saveValue(newValue);
      setInputText('');
      clearSuggestions();
      return;
    }

    commitInput(suggestion.value);
    clearSuggestions();
    cacheChineseName(suggestion);
  }, [cacheChineseName, clearSuggestions, commitEdit, commitInput, editingTag, inputText, saveValue, setInputText, value]);

  return {
    nlTranslating,
    selectSuggestion,
  };
}
