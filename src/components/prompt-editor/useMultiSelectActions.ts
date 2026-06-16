import { useMemo, type Dispatch, type SetStateAction } from 'react';
import type { Editor } from '@tiptap/core';
import type { MultiSelectActions, MultiSelectPanelState } from './MultiSelectQuickPanel';

interface UseMultiSelectActionsParams {
  editor: Editor | null;
  panel: MultiSelectPanelState | null;
  setPanel: Dispatch<SetStateAction<MultiSelectPanelState | null>>;
  markPanelAction: () => void;
}

const stripMergedWeight = (text: string): string => text.replace(/^-?\d+(?:\.\d+)?::([\s\S]*?)(?:::)?$/, '$1');

const stripOuterWeights = (text: string): string => text
  .replace(/^\{+|\}+$/g, '')
  .replace(/^\[+|\]+$/g, '');

const stripTagWeight = (tag: string): string => {
  let cleaned = tag.replace(/^\s*\{+|\}+\s*$/g, '').replace(/^\s*\[+|\]+\s*$/g, '');
  cleaned = cleaned.replace(/^(\s*)-?\d+(?:\.\d+)?::([\s\S]*?)(?:::)?\s*$/, '$1$2');
  return cleaned;
};

const getDeleteRangeAroundSelection = (editor: Editor, from: number, to: number): { from: number; to: number } => {
  const $from = editor.state.doc.resolve(from);
  const fullText = $from.parent.textContent;
  const nodeStart = $from.start();
  const localFrom = from - nodeStart;
  const localTo = to - nodeStart;

  if (localTo < fullText.length && (fullText[localTo] === ',' || fullText[localTo] === '，')) {
    const nextTo = nodeStart + localTo + (localTo + 1 < fullText.length && fullText[localTo + 1] === ' ' ? 2 : 1);
    return { from, to: nextTo };
  }

  if (localFrom > 0 && (fullText[localFrom - 1] === ',' || fullText[localFrom - 1] === '，')) {
    const nextFrom = nodeStart + localFrom - (localFrom >= 2 && fullText[localFrom - 2] === ' ' ? 2 : 1);
    return { from: nextFrom, to };
  }

  return { from, to };
};

export function useMultiSelectActions({
  editor,
  panel,
  setPanel,
  markPanelAction,
}: UseMultiSelectActionsParams): MultiSelectActions {
  return useMemo<MultiSelectActions>(() => ({
    addWeight: () => {
      if (!editor || !panel) return;
      markPanelAction();
      const { from, to, text } = panel;
      editor.chain().focus().command(({ tr }) => {
        tr.delete(from, to);
        tr.insertText(`{${text}}`, from);
        return true;
      }).run();
      setPanel(null);
    },
    reduceWeight: () => {
      if (!editor || !panel) return;
      markPanelAction();
      const { from, to, text } = panel;
      editor.chain().focus().command(({ tr }) => {
        tr.delete(from, to);
        tr.insertText(`[${text}]`, from);
        return true;
      }).run();
      setPanel(null);
    },
    clearWeight: () => {
      if (!editor || !panel) return;
      markPanelAction();
      const { from, to, text } = panel;
      const stripped = stripOuterWeights(stripMergedWeight(text));
      const cleaned = stripped.split(/[,，]/).map(stripTagWeight).join(', ');
      editor.chain().focus().command(({ tr }) => {
        tr.delete(from, to);
        tr.insertText(cleaned, from);
        return true;
      }).run();
      setPanel(null);
    },
    setNumericWeight: (weight: number) => {
      if (!editor || !panel) return;
      markPanelAction();
      const { from, to, text } = panel;
      const cleaned = text.split(/[,，]/).map(t => {
        let tag = t.trim();
        if (!tag) return '';
        tag = stripOuterWeights(tag);
        tag = tag.replace(/^-?\d+(?:\.\d+)?::(.+?)(?:::)?$/, '$1');
        return tag;
      }).filter(Boolean).join(', ');
      const result = `${weight}::${cleaned}::`;
      editor.chain().focus().command(({ tr }) => {
        tr.delete(from, to);
        tr.insertText(result, from);
        return true;
      }).run();
      setPanel(prev => prev ? { ...prev, text: result, to: from + result.length } : null);
    },
    moveToFront: () => {
      if (!editor || !panel) return;
      markPanelAction();
      const { text } = panel;
      const range = getDeleteRangeAroundSelection(editor, panel.from, panel.to);
      editor.chain().focus().command(({ tr }) => {
        tr.delete(range.from, range.to);
        tr.insertText(`${text.trim()}, `, 1);
        return true;
      }).run();
      setPanel(null);
    },
    toggleHide: () => {
      if (!editor || !panel) return;
      markPanelAction();
      const { from, to, text } = panel;
      const tags = text.split(/[,，]/);
      const isHidden = tags[0]?.trim().startsWith('~');
      const result = tags.map(t => {
        const trimmed = t.trim();
        if (!trimmed) return t;
        const leading = t.match(/^\s*/)?.[0] || '';
        if (isHidden) return leading + trimmed.replace(/^~/, '');
        return leading + '~' + trimmed;
      }).join(',');
      editor.chain().focus().command(({ tr }) => {
        tr.delete(from, to);
        tr.insertText(result, from);
        return true;
      }).run();
      setPanel(null);
    },
    deleteTag: () => {
      if (!editor || !panel) return;
      markPanelAction();
      const range = getDeleteRangeAroundSelection(editor, panel.from, panel.to);
      editor.chain().focus().command(({ tr }) => {
        tr.delete(range.from, range.to);
        return true;
      }).run();
      setPanel(null);
    },
  }), [editor, markPanelAction, panel, setPanel]);
}
