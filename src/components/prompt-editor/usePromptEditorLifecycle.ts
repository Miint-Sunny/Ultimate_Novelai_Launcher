import { useEffect, useImperativeHandle, type ForwardedRef, type MutableRefObject, type RefObject } from 'react';
import type { Editor } from '@tiptap/core';
import { parseValueToDocContent } from './documentMapping';
import {
  extractEditorContent,
  getEditorSelection,
  insertCollapsibleTag,
  removeCollapsibleTagsByType,
  replaceEditorSelection,
  setPlainTextSelection,
} from './promptEditorCommands';
import type { PromptEditorRef } from './types';

interface UsePromptEditorLifecycleParams {
  ref: ForwardedRef<PromptEditorRef>;
  editor: Editor | null;
  value: string;
  containerRef: RefObject<HTMLDivElement | null>;
  isProgrammaticUpdateRef: MutableRefObject<boolean>;
  translationCacheRef: MutableRefObject<Map<string, string>>;
  onContentHeightChange?: (height: number) => void;
}

export function usePromptEditorLifecycle({
  ref,
  editor,
  value,
  containerRef,
  isProgrammaticUpdateRef,
  translationCacheRef,
  onContentHeightChange,
}: UsePromptEditorLifecycleParams) {
  useEffect(() => {
    if (!editor) return;

    const { text: currentText } = extractEditorContent(editor);
    if (currentText === value) return;

    isProgrammaticUpdateRef.current = true;
    const docContent = parseValueToDocContent(value || '');
    editor.commands.setContent(docContent);
  }, [editor, isProgrammaticUpdateRef, value]);

  useImperativeHandle(ref, () => ({
    addCollapsibleTag: (tag) => {
      insertCollapsibleTag(editor, tag);
    },

    getPlainText: () => {
      const { text } = extractEditorContent(editor);
      return text;
    },

    getTags: () => {
      const { tags } = extractEditorContent(editor);
      return tags;
    },

    removeTagsByType: (type) => {
      removeCollapsibleTagsByType(editor, type);
    },

    focus: () => {
      editor?.commands.focus();
    },

    insertText: (text) => {
      editor?.commands.insertContent(text);
    },

    setSelection: (from, to) => {
      setPlainTextSelection(editor, from, to);
    },

    getSelection: () => {
      return getEditorSelection(editor);
    },

    replaceSelection: (text) => {
      replaceEditorSelection(editor, text);
    },

    getTranslationCache: () => {
      return translationCacheRef.current;
    },

    setTranslationCache: (key, value) => {
      translationCacheRef.current.set(key, value);
    },
  }), [editor, ref, translationCacheRef]);

  useEffect(() => {
    if (!editor || !onContentHeightChange) return;
    const measureContent = () => {
      const el = editor.view.dom;
      const children = el.children;
      if (children.length === 0) return;
      const last = children[children.length - 1] as HTMLElement;
      onContentHeightChange(last.offsetTop + last.offsetHeight + 16);
    };
    editor.on('update', measureContent);
    requestAnimationFrame(measureContent);
    return () => { editor.off('update', measureContent); };
  }, [editor, onContentHeightChange]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (event: WheelEvent) => {
      const scrollable = (event.target as HTMLElement).closest('.ProseMirror') as HTMLElement;
      if (!scrollable) return;

      if (scrollable.scrollHeight <= scrollable.clientHeight) {
        return;
      }

      const isAtTop = scrollable.scrollTop <= 0;
      const isAtBottom = Math.ceil(scrollable.scrollTop + scrollable.clientHeight) >= scrollable.scrollHeight - 1;

      if ((isAtTop && event.deltaY < 0) || (isAtBottom && event.deltaY > 0)) {
        const outerScroll = scrollable.parentElement?.closest('.overflow-y-auto, .custom-scrollbar') as HTMLElement;
        if (outerScroll) {
          event.preventDefault();
          let delta = event.deltaY;
          if (event.deltaMode === 1) delta *= 40;
          else if (event.deltaMode === 2) delta *= outerScroll.clientHeight || 800;

          const isTouchpad = event.deltaMode === 0 && (Math.abs(event.deltaY) < 50 || event.deltaY % 1 !== 0);
          outerScroll.scrollBy({ top: delta, behavior: isTouchpad ? 'auto' : 'smooth' });
        }
      }
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, [containerRef]);
}
