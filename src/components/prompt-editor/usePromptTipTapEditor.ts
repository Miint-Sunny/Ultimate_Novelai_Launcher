import { useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import { TextSelection } from '@tiptap/pm/state';
import type { Editor } from '@tiptap/core';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { getTagSuggestionsDebounced, type TagSuggestion } from '../../services/tagAutocomplete';
import { CollapsibleTagNode } from './collapsibleTagExtension';
import { docOffsetToTextIndex, textIndexToDocOffset } from './documentMapping';
import { extractEditorContent } from './promptEditorCommands';
import type { MultiSelectPanelState } from './MultiSelectQuickPanel';
import type { TagPanelState } from './TagQuickPanel';
import type { CollapsibleTag } from './types';
import { WeightHighlightExtension } from './weightHighlightExtension';

interface UsePromptTipTapEditorParams {
  className: string;
  placeholder?: string;
  disableCollapsibleTags: boolean;
  onChange?: (value: string) => void;
  onTagsChange?: (tags: CollapsibleTag[]) => void;
  isProgrammaticUpdateRef: MutableRefObject<boolean>;
  justSelectedRef: MutableRefObject<boolean>;
  isWeightUpdateRef: MutableRefObject<boolean>;
  isPanelActionRef: MutableRefObject<boolean>;
  isComposingRef: MutableRefObject<boolean>;
  setSuggestions: Dispatch<SetStateAction<TagSuggestion[]>>;
  setShowSuggestions: Dispatch<SetStateAction<boolean>>;
  setSelectedIndex: Dispatch<SetStateAction<number>>;
  setCurrentWord: Dispatch<SetStateAction<string>>;
  setWordStart: Dispatch<SetStateAction<number>>;
  setCursorPosition: Dispatch<SetStateAction<{ top: number; left: number } | null>>;
  setTagPanel: Dispatch<SetStateAction<TagPanelState | null>>;
  setMultiSelectPanel: Dispatch<SetStateAction<MultiSelectPanelState | null>>;
}

interface RequestAutocompleteParams {
  editor: Editor;
  isComposingRef: MutableRefObject<boolean>;
  setSuggestions: Dispatch<SetStateAction<TagSuggestion[]>>;
  setShowSuggestions: Dispatch<SetStateAction<boolean>>;
  setSelectedIndex: Dispatch<SetStateAction<number>>;
  setCurrentWord: Dispatch<SetStateAction<string>>;
  setWordStart: Dispatch<SetStateAction<number>>;
  setCursorPosition: Dispatch<SetStateAction<{ top: number; left: number } | null>>;
  debounceDelay?: number;
}

export function requestAutocompleteAtSelection({
  editor,
  isComposingRef,
  setSuggestions,
  setShowSuggestions,
  setSelectedIndex,
  setCurrentWord,
  setWordStart,
  setCursorPosition,
  debounceDelay = 250,
}: RequestAutocompleteParams) {
  const { state } = editor;
  const { selection } = state;
  const { $from } = selection;
  const textIndex = docOffsetToTextIndex($from.parent, $from.parentOffset);
  const textBefore = $from.parent.textContent.slice(0, textIndex);
  const textAfter = $from.parent.textContent.slice(textIndex);

  if (!textBefore) return;

  const matchBefore = textBefore.match(/(?:^|[,，\s])([a-zA-Z0-9_\u4e00-\u9fa5]+)$/);
  const hasChinese = matchBefore && /[\u4e00-\u9fa5]/.test(matchBefore[1]);
  const minLength = hasChinese ? 1 : 2;

  if (isComposingRef.current) return;

  if (matchBefore && matchBefore[1] && matchBefore[1].length >= minLength) {
    const word = matchBefore[1];
    setCurrentWord(word);
    setWordStart($from.pos - word.length);

    const coords = editor.view.coordsAtPos(selection.from);
    setCursorPosition({
      top: coords.bottom + window.scrollY,
      left: coords.left + window.scrollX,
    });

    getTagSuggestionsDebounced(word, (newSuggestions) => {
      if (newSuggestions.length > 0) {
        setSuggestions([...newSuggestions]);
        setShowSuggestions(true);
        setSelectedIndex(prev => Math.min(prev, newSuggestions.length - 1));
      } else {
        setShowSuggestions(false);
      }
    }, debounceDelay);
  } else if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]/.test(textAfter)) {
    setShowSuggestions(false);
  } else {
    setShowSuggestions(false);
  }
}

const handleDoubleClickTagSelection = (view: Editor['view'], pos: number): boolean => {
  const { state } = view;
  const $pos = state.doc.resolve(pos);
  const node = $pos.parent;

  if (!node.isTextblock) return false;

  const text = node.textContent;
  const offset = docOffsetToTextIndex(node, $pos.parentOffset);
  const nodeStart = $pos.start();
  let start = offset;
  let end = offset;

  while (start > 0 && text[start - 1] !== ',') {
    start--;
  }
  while (end < text.length && text[end] !== ',') {
    end++;
  }
  while (start < end && text[start] === ' ') start++;
  while (end > start && text[end - 1] === ' ') end--;

  if (start >= end) return false;

  const from = nodeStart + textIndexToDocOffset(node, start);
  const to = nodeStart + textIndexToDocOffset(node, end);
  view.dispatch(state.tr.setSelection(
    TextSelection.create(state.doc, from, to)
  ));
  return true;
};

export function usePromptTipTapEditor({
  className,
  placeholder,
  disableCollapsibleTags,
  onChange,
  onTagsChange,
  isProgrammaticUpdateRef,
  justSelectedRef,
  isWeightUpdateRef,
  isPanelActionRef,
  isComposingRef,
  setSuggestions,
  setShowSuggestions,
  setSelectedIndex,
  setCurrentWord,
  setWordStart,
  setCursorPosition,
  setTagPanel,
  setMultiSelectPanel,
}: UsePromptTipTapEditorParams) {
  return useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        blockquote: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        codeBlock: false,
        horizontalRule: false,
      }),
      ...(disableCollapsibleTags ? [] : [CollapsibleTagNode]),
      WeightHighlightExtension,
      Placeholder.configure({
        placeholder: placeholder || '',
        emptyEditorClass: 'is-editor-empty',
      }),
    ],
    content: '',
    editorProps: {
      attributes: {
        class: `prompt-editor-content outline-none min-h-full scrollbar-hide ${className}`,
        spellcheck: 'false',
      },
      handleDoubleClick: handleDoubleClickTagSelection,
    },
    onUpdate: ({ editor }) => {
      const { text, tags } = extractEditorContent(editor);
      onChange?.(text);
      onTagsChange?.(tags);

      if (isProgrammaticUpdateRef.current) {
        isProgrammaticUpdateRef.current = false;
        setShowSuggestions(false);
        setTagPanel(null);
        setMultiSelectPanel(null);
        return;
      }

      if (justSelectedRef.current) {
        justSelectedRef.current = false;
        return;
      }

      if (isWeightUpdateRef.current) {
        isWeightUpdateRef.current = false;
      } else {
        setTagPanel(null);
        setMultiSelectPanel(null);
      }

      if (isPanelActionRef.current) {
        isPanelActionRef.current = false;
        return;
      }

      requestAutocompleteAtSelection({
        editor,
        isComposingRef,
        setSuggestions,
        setShowSuggestions,
        setSelectedIndex,
        setCurrentWord,
        setWordStart,
        setCursorPosition,
      });
    },
  });
}
