import { useCallback, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { Editor } from '@tiptap/core';
import { cancelPendingAutocomplete, type TagSuggestion } from '../../services/tagAutocomplete';
import { translateToNaturalLanguage } from '../../services/translate';

interface ScreenPosition {
  top: number;
  left: number;
}

interface UseSuggestionSelectionParams {
  editor: Editor | null;
  currentWord: string;
  wordStart: number;
  cursorPosition: ScreenPosition | null;
  justSelectedRef: MutableRefObject<boolean>;
  setSuggestions: Dispatch<SetStateAction<TagSuggestion[]>>;
  setShowSuggestions: Dispatch<SetStateAction<boolean>>;
}

export function useSuggestionSelection({
  editor,
  currentWord,
  wordStart,
  cursorPosition,
  justSelectedRef,
  setSuggestions,
  setShowSuggestions,
}: UseSuggestionSelectionParams) {
  const [nlTranslating, setNlTranslating] = useState<ScreenPosition | null>(null);

  const clearSuggestions = useCallback(() => {
    setShowSuggestions(false);
    setSuggestions([]);
  }, [setShowSuggestions, setSuggestions]);

  const replaceCurrentWord = useCallback((text: string) => {
    if (!editor) return;
    editor.chain()
      .focus()
      .command(({ tr }) => {
        tr.delete(wordStart, wordStart + currentWord.length);
        tr.insertText(text, wordStart);
        return true;
      })
      .run();
  }, [currentWord.length, editor, wordStart]);

  const selectSuggestion = useCallback((suggestion: TagSuggestion) => {
    if (!editor) return;

    justSelectedRef.current = true;

    if (suggestion.isNaturalLanguage) {
      const chineseText = currentWord;
      const insertPos = wordStart;
      editor.chain()
        .focus()
        .command(({ tr }) => {
          tr.delete(wordStart, wordStart + currentWord.length);
          return true;
        })
        .run();
      clearSuggestions();
      cancelPendingAutocomplete();
      setNlTranslating(cursorPosition);
      translateToNaturalLanguage(chineseText).then((translated) => {
        setNlTranslating(null);
        if (!editor) return;
        const result = translated && translated !== chineseText ? translated : chineseText;
        editor.chain()
          .focus()
          .command(({ tr }) => {
            tr.insertText(result, insertPos);
            return true;
          })
          .run();
      });
      return;
    }

    if (suggestion.isArtist && suggestion.artistContent) {
      replaceCurrentWord(`<<artist:${suggestion.label}:${suggestion.artistContent}>>`);
      clearSuggestions();
      return;
    }

    if (suggestion.isOC && suggestion.ocContent) {
      replaceCurrentWord(`<<oc:${suggestion.label}:${suggestion.ocContent}>>`);
      clearSuggestions();
      return;
    }

    replaceCurrentWord(suggestion.value);
    clearSuggestions();
  }, [clearSuggestions, currentWord, cursorPosition, editor, justSelectedRef, replaceCurrentWord, wordStart]);

  return {
    nlTranslating,
    selectSuggestion,
  };
}
