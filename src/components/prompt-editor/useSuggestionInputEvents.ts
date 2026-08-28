import { useEffect, type MutableRefObject, type RefObject, type Dispatch, type SetStateAction } from 'react';
import type { Editor } from '@tiptap/core';
import { lookupCharacterChineseName, type TagSuggestion } from '../../services/tagAutocomplete';
import { requestAutocompleteAtSelection } from './usePromptTipTapEditor';

interface UseSuggestionInputEventsParams {
  editor: Editor | null;
  suggestions: TagSuggestion[];
  showSuggestions: boolean;
  selectedIndex: number;
  suggestionsRef: RefObject<HTMLDivElement | null>;
  suggestionScrollLockRef: MutableRefObject<boolean>;
  isComposingRef: MutableRefObject<boolean>;
  onSelectSuggestion: (suggestion: TagSuggestion) => void;
  setSuggestions: Dispatch<SetStateAction<TagSuggestion[]>>;
  setShowSuggestions: Dispatch<SetStateAction<boolean>>;
  setSelectedIndex: Dispatch<SetStateAction<number>>;
  setCurrentWord: Dispatch<SetStateAction<string>>;
  setWordStart: Dispatch<SetStateAction<number>>;
  setCursorPosition: Dispatch<SetStateAction<{ top: number; left: number } | null>>;
  /** V5 文字渲染:光标在未闭合引号内时不弹 tag 补全。 */
  suppressAutocompleteInQuotes?: boolean;
}

export function useSuggestionInputEvents({
  editor,
  suggestions,
  showSuggestions,
  selectedIndex,
  suggestionsRef,
  suggestionScrollLockRef,
  isComposingRef,
  onSelectSuggestion,
  setSuggestions,
  setShowSuggestions,
  setSelectedIndex,
  setCurrentWord,
  setWordStart,
  setCursorPosition,
  suppressAutocompleteInQuotes,
}: UseSuggestionInputEventsParams) {
  useEffect(() => {
    if (!showSuggestions || !suggestionsRef.current) return;
    if (suggestionScrollLockRef.current) {
      suggestionScrollLockRef.current = false;
      return;
    }
    const el = suggestionsRef.current.querySelector(`[data-sugg-idx="${selectedIndex}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex, showSuggestions, suggestionScrollLockRef, suggestionsRef]);

  useEffect(() => {
    if (!editor) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!showSuggestions || suggestions.length === 0) return;

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          setSelectedIndex(prev => {
            let next = (prev + 1) % suggestions.length;
            if (suggestions[next]?.isAiLoading) next = (next + 1) % suggestions.length;
            return next;
          });
          break;
        case 'ArrowUp':
          event.preventDefault();
          setSelectedIndex(prev => {
            let next = (prev - 1 + suggestions.length) % suggestions.length;
            if (suggestions[next]?.isAiLoading) next = (next - 1 + suggestions.length) % suggestions.length;
            return next;
          });
          break;
        case 'Tab':
        case 'Enter': {
          const selectedSuggestion = suggestions[selectedIndex];
          if (!selectedSuggestion) break;
          event.preventDefault();
          if (selectedSuggestion.isAiLoading) break;
          if (selectedSuggestion.isOrigin) {
            const chars = selectedSuggestion.originCharacters || [];
            if (chars.length > 0) {
              const randomChar = chars[Math.floor(Math.random() * chars.length)];
              onSelectSuggestion({
                ...selectedSuggestion,
                value: randomChar,
                chineseName: lookupCharacterChineseName(randomChar),
                isOrigin: false,
              });
            }
          } else {
            onSelectSuggestion(selectedSuggestion);
          }
          break;
        }
        case 'Escape':
          setShowSuggestions(false);
          break;
      }
    };

    const editorDom = editor.view.dom;
    editorDom.addEventListener('keydown', handleKeyDown);

    return () => {
      editorDom.removeEventListener('keydown', handleKeyDown);
    };
  }, [editor, onSelectSuggestion, selectedIndex, setSelectedIndex, setShowSuggestions, showSuggestions, suggestions]);

  useEffect(() => {
    if (!editor) return;

    const editorDom = editor.view.dom;

    const handleCompositionStart = () => {
      isComposingRef.current = true;
    };

    const handleCompositionEnd = () => {
      isComposingRef.current = false;
      requestAnimationFrame(() => {
        setTimeout(() => {
          if (!editor || editor.isDestroyed) return;
          requestAutocompleteAtSelection({
            editor,
            isComposingRef,
            setSuggestions,
            setShowSuggestions,
            setSelectedIndex,
            setCurrentWord,
            setWordStart,
            setCursorPosition,
            suppressAutocompleteInQuotes,
          });
        }, 20);
      });
    };

    editorDom.addEventListener('compositionstart', handleCompositionStart);
    editorDom.addEventListener('compositionend', handleCompositionEnd);

    return () => {
      editorDom.removeEventListener('compositionstart', handleCompositionStart);
      editorDom.removeEventListener('compositionend', handleCompositionEnd);
    };
  }, [editor, isComposingRef, setCursorPosition, setCurrentWord, setSelectedIndex, setShowSuggestions, setSuggestions, setWordStart, suppressAutocompleteInQuotes]);
}
