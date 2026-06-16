import { useCallback, useMemo, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { Editor } from '@tiptap/core';
import type { TagPanelActions, TagPanelState } from './TagQuickPanel';

interface UseTagPanelActionsParams {
  editor: Editor | null;
  panel: TagPanelState | null;
  setPanel: Dispatch<SetStateAction<TagPanelState | null>>;
  isPanelActionRef: MutableRefObject<boolean>;
  isWeightUpdateRef: MutableRefObject<boolean>;
}

const stripAllWeights = (rawTag: string): string => {
  let cleaned = rawTag.replace(/^\{+|\}+$|\[+|\]+$/g, '');
  cleaned = cleaned.replace(/^-?\d+(?:\.\d+)?::(.+?)(?:::)?$/, '$1');
  return cleaned;
};

const getDeleteRangeAroundTag = (editor: Editor, from: number, to: number): { from: number; to: number } => {
  const $from = editor.state.doc.resolve(from);
  const fullText = $from.parent.textContent;
  const nodeStart = $from.start();
  const localFrom = from - nodeStart;
  const localTo = to - nodeStart;

  if (localTo < fullText.length && fullText[localTo] === ',') {
    const nextTo = nodeStart + localTo + (localTo + 1 < fullText.length && fullText[localTo + 1] === ' ' ? 2 : 1);
    return { from, to: nextTo };
  }

  if (localFrom > 0 && fullText[localFrom - 1] === ',') {
    const nextFrom = nodeStart + localFrom - (localFrom >= 2 && fullText[localFrom - 2] === ' ' ? 2 : 1);
    return { from: nextFrom, to };
  }

  return { from, to };
};

export function useTagPanelActions({
  editor,
  panel,
  setPanel,
  isPanelActionRef,
  isWeightUpdateRef,
}: UseTagPanelActionsParams) {
  const markPanelAction = useCallback(() => {
    isPanelActionRef.current = true;
  }, [isPanelActionRef]);

  const actions = useMemo<TagPanelActions>(() => ({
    addWeight: () => {
      if (!editor || !panel) return;
      markPanelAction();
      const { from, to, rawTag } = panel;
      editor.chain().focus().command(({ tr }) => {
        tr.delete(from, to);
        tr.insertText(`{${rawTag}}`, from);
        return true;
      }).run();
      setPanel(null);
    },
    reduceWeight: () => {
      if (!editor || !panel) return;
      markPanelAction();
      const { from, to, rawTag } = panel;
      editor.chain().focus().command(({ tr }) => {
        tr.delete(from, to);
        tr.insertText(`[${rawTag}]`, from);
        return true;
      }).run();
      setPanel(null);
    },
    clearWeight: () => {
      if (!editor || !panel) return;
      markPanelAction();
      const { from, to, rawTag } = panel;
      const cleaned = stripAllWeights(rawTag);
      editor.chain().focus().command(({ tr }) => {
        tr.delete(from, to);
        tr.insertText(cleaned, from);
        return true;
      }).run();
      setPanel(null);
    },
    setNumericWeight: (weight: number) => {
      if (!editor || !panel) return;
      isWeightUpdateRef.current = true;
      markPanelAction();
      const { from, to, rawTag } = panel;
      const cleaned = stripAllWeights(rawTag);
      const result = `${weight}::${cleaned}::`;
      editor.chain().focus().command(({ tr }) => {
        tr.delete(from, to);
        tr.insertText(result, from);
        return true;
      }).run();
      setPanel(prev => prev ? { ...prev, rawTag: result, to: from + result.length } : null);
    },
    deleteTag: () => {
      if (!editor || !panel) return;
      markPanelAction();
      const range = getDeleteRangeAroundTag(editor, panel.from, panel.to);
      editor.chain().focus().command(({ tr }) => {
        tr.delete(range.from, range.to);
        return true;
      }).run();
      setPanel(null);
    },
    copyTag: () => {
      if (!panel) return;
      const tagValue = panel.tag.replace(/ /g, '_');
      navigator.clipboard.writeText(tagValue).catch(() => { });
      setPanel(null);
    },
    openDanbooru: () => {
      if (!panel) return;
      const tagValue = panel.tag.replace(/ /g, '_');
      window.open(`https://danbooru.donmai.us/wiki_pages/${tagValue}`, '_blank');
      setPanel(null);
    },
    moveToFront: () => {
      if (!editor || !panel) return;
      markPanelAction();
      const { rawTag } = panel;
      const range = getDeleteRangeAroundTag(editor, panel.from, panel.to);
      editor.chain().focus().command(({ tr }) => {
        tr.delete(range.from, range.to);
        tr.insertText(`${rawTag}, `, 1);
        return true;
      }).run();
      setPanel(null);
    },
    toggleHide: () => {
      if (!editor || !panel) return;
      markPanelAction();
      const { from, to, rawTag } = panel;
      const isHidden = rawTag.trim().startsWith('~');
      const newTag = isHidden ? rawTag.replace(/^(\s*)~/, '$1') : `~${rawTag}`;
      editor.chain().focus().command(({ tr }) => {
        tr.delete(from, to);
        tr.insertText(newTag, from);
        return true;
      }).run();
      setPanel(null);
    },
  }), [editor, isWeightUpdateRef, markPanelAction, panel, setPanel]);

  const existingTagSet = useMemo(() => {
    const set = new Set<string>();
    if (!editor || !panel) return set;
    editor.state.doc.descendants(node => {
      if (node.isText) {
        const text = node.text || '';
        text.split(/[,，]/).forEach(t => {
          const cleaned = t.trim()
            .replace(/^~/, '')
            .replace(/^\{+|\}+$|\[+|\]+$/g, '')
            .replace(/^-?\d+(?:\.\d+)?::(.+?)(?:::)?$/, '$1')
            .toLowerCase()
            .replace(/\s+/g, '_');
          if (cleaned) set.add(cleaned);
        });
      }
    });
    return set;
  }, [editor, panel]);

  const addRelatedTag = useCallback((addedTag: string, addToEnd: boolean) => {
    if (!editor || !panel) return;
    markPanelAction();
    const { to } = panel;
    editor.chain().focus().command(({ tr }) => {
      if (addToEnd) {
        tr.insertText(`, ${addedTag}`, tr.doc.content.size);
      } else {
        tr.insertText(`, ${addedTag}`, to);
      }
      return true;
    }).run();
  }, [editor, markPanelAction, panel]);

  return {
    actions,
    existingTagSet,
    addRelatedTag,
    markPanelAction,
  };
}
