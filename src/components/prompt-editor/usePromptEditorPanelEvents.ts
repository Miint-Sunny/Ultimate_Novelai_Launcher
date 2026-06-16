import { useEffect, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from 'react';
import type { Editor } from '@tiptap/core';
import { docOffsetToTextIndex, textIndexToDocOffset } from './documentMapping';
import type { MultiSelectPanelState } from './MultiSelectQuickPanel';
import type { TagPanelState } from './TagQuickPanel';

interface UsePromptEditorPanelEventsParams {
  editor: Editor | null;
  mobileMode: boolean;
  tagPanel: TagPanelState | null;
  setTagPanel: Dispatch<SetStateAction<TagPanelState | null>>;
  tagPanelRef: RefObject<HTMLDivElement | null>;
  multiSelectPanel: MultiSelectPanelState | null;
  setMultiSelectPanel: Dispatch<SetStateAction<MultiSelectPanelState | null>>;
  multiSelectPanelRef: RefObject<HTMLDivElement | null>;
  setMultiNumWeight: Dispatch<SetStateAction<number>>;
  translationCacheRef: MutableRefObject<Map<string, string>>;
  clearHoverTranslation: () => void;
}

export function usePromptEditorPanelEvents({
  editor,
  mobileMode,
  tagPanel,
  setTagPanel,
  tagPanelRef,
  multiSelectPanel,
  setMultiSelectPanel,
  multiSelectPanelRef,
  setMultiNumWeight,
  translationCacheRef,
  clearHoverTranslation,
}: UsePromptEditorPanelEventsParams) {
  useEffect(() => {
    if (!editor || mobileMode) return;

    const editorDom = editor.view.dom;

    const handleClick = (e: MouseEvent) => {
      if (tagPanelRef.current?.contains(e.target as globalThis.Node)) return;
      if (multiSelectPanelRef.current?.contains(e.target as globalThis.Node)) return;

      const { from: selFrom, to: selTo } = editor.state.selection;
      if (selTo - selFrom > 1) return;

      const pos = editor.view.posAtCoords({ left: e.clientX, top: e.clientY });
      if (!pos) {
        setTagPanel(null);
        return;
      }

      const $pos = editor.state.doc.resolve(pos.pos);
      const node = $pos.parent;
      if (!node.isTextblock) {
        setTagPanel(null);
        return;
      }

      const text = node.textContent;
      const offset = docOffsetToTextIndex(node, $pos.parentOffset);
      const nodeStart = $pos.start();
      let start = offset;
      let end = offset;
      while (start > 0 && text[start - 1] !== ',') start--;
      while (end < text.length && text[end] !== ',') end++;

      const rawTag = text.slice(start, end).trim();
      if (!rawTag || rawTag.length < 2 || rawTag.length > 80) {
        setTagPanel(null);
        return;
      }

      const cleanTag = rawTag.replace(/^\{+|\}+$|\[+|\]+$/g, '').replace(/_/g, ' ').trim();
      if (!cleanTag) {
        setTagPanel(null);
        return;
      }

      const tagText = text.slice(start, end);
      const tagStartInText = start + (tagText.length - tagText.trimStart().length);
      const tagEndInText = end - (tagText.length - tagText.trimEnd().length);
      const absoluteFrom = nodeStart + textIndexToDocOffset(node, tagStartInText);
      const absoluteTo = nodeStart + textIndexToDocOffset(node, tagEndInText);

      if (tagPanel && tagPanel.from === absoluteFrom && tagPanel.to === absoluteTo) {
        setTagPanel(null);
        return;
      }

      const cleanForCache = rawTag.replace(/^\{+|\}+$|\[+|\]+$/g, '').replace(/_/g, ' ').trim();
      const translation = translationCacheRef.current.get(cleanForCache) || '';
      const coords = editor.view.coordsAtPos(absoluteFrom);

      clearHoverTranslation();
      setMultiSelectPanel(null);

      setTagPanel({
        tag: cleanTag,
        rawTag,
        translation,
        from: absoluteFrom,
        to: absoluteTo,
        screenX: coords.left,
        screenY: coords.bottom + 4,
      });
    };

    editorDom.addEventListener('click', handleClick);
    return () => { editorDom.removeEventListener('click', handleClick); };
  }, [clearHoverTranslation, editor, mobileMode, multiSelectPanelRef, setMultiSelectPanel, setTagPanel, tagPanel, tagPanelRef, translationCacheRef]);

  useEffect(() => {
    if (!editor || mobileMode) return;
    const editorDom = editor.view.dom;

    const handleMouseUp = () => {
      const { from, to } = editor.state.selection;
      if (to - from < 2) {
        setMultiSelectPanel(null);
        return;
      }

      const selectedText = editor.state.doc.textBetween(from, to, '\n', '');
      if (!selectedText.trim()) {
        setMultiSelectPanel(null);
        return;
      }

      const $from = editor.state.doc.resolve(from);
      const $to = editor.state.doc.resolve(to);
      const fromText = $from.parent.textContent;
      const toText = $to.parent.textContent;
      const fromNodeStart = $from.start();
      const toNodeStart = $to.start();
      const fromLocal = docOffsetToTextIndex($from.parent, $from.parentOffset);
      const toLocal = docOffsetToTextIndex($to.parent, $to.parentOffset);

      let expandedFromLocal = fromLocal;
      while (expandedFromLocal > 0 && fromText[expandedFromLocal - 1] !== ',' && fromText[expandedFromLocal - 1] !== '，') expandedFromLocal--;
      const expandedFrom = fromNodeStart + textIndexToDocOffset($from.parent, expandedFromLocal);

      let expandedToLocal = toLocal;
      while (expandedToLocal < toText.length && toText[expandedToLocal] !== ',' && toText[expandedToLocal] !== '，') expandedToLocal++;
      const expandedTo = toNodeStart + textIndexToDocOffset($to.parent, expandedToLocal);

      const fullText = editor.state.doc.textBetween(expandedFrom, expandedTo, '\n', '');
      const tags = fullText.split(/[,，]/).filter(t => t.trim());
      if (tags.length < 2) {
        setMultiSelectPanel(null);
        return;
      }

      const coords = editor.view.coordsAtPos(from);
      setTagPanel(null);
      setMultiSelectPanel({
        from: expandedFrom,
        to: expandedTo,
        text: fullText,
        tagCount: tags.length,
        screenX: coords.left,
        screenY: coords.bottom + 4,
      });
      setMultiNumWeight(1.0);
    };

    editorDom.addEventListener('mouseup', handleMouseUp);
    return () => { editorDom.removeEventListener('mouseup', handleMouseUp); };
  }, [editor, mobileMode, setMultiNumWeight, setMultiSelectPanel, setTagPanel]);

  useEffect(() => {
    if (!multiSelectPanel || !editor) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (multiSelectPanelRef.current?.contains(e.target as globalThis.Node)) return;
      if (editor.view.dom.contains(e.target as globalThis.Node)) return;
      setMultiSelectPanel(null);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [editor, multiSelectPanel, multiSelectPanelRef, setMultiSelectPanel]);

  useEffect(() => {
    if (!tagPanel || !editor) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (tagPanelRef.current?.contains(e.target as globalThis.Node)) return;
      if (editor.view.dom.contains(e.target as globalThis.Node)) return;
      setTagPanel(null);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [editor, setTagPanel, tagPanel, tagPanelRef]);
}
