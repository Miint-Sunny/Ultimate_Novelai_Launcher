import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Dispatch, MouseEvent, MutableRefObject, RefObject, SetStateAction } from 'react';
import {
  cleanTagName,
  getTagWeightInfo,
  isCollapsibleMarker,
} from '../../utils/promptTags';

interface EditingTagState {
  index: number;
  text: string;
  width: number;
  height: number;
}

interface TagPanelState {
  index: number;
  rawTag: string;
  tag: string;
  translation: string;
  screenX: number;
  screenY: number;
}

interface UseDesktopChipSelectionParams {
  parsedTags: string[];
  tagTranslations: Map<string, string>;
  editingTag: EditingTagState | null;
  tagPanel: TagPanelState | null;
  chipRefsMap: MutableRefObject<Map<number, HTMLElement>>;
  chipClickTimeRef: MutableRefObject<number>;
  inputRef: RefObject<HTMLInputElement | null>;
  editInputRef: RefObject<HTMLInputElement | null>;
  setEditingTag: Dispatch<SetStateAction<EditingTagState | null>>;
  setTagPanel: Dispatch<SetStateAction<TagPanelState | null>>;
}

export function useDesktopChipSelection({
  parsedTags,
  tagTranslations,
  editingTag,
  tagPanel,
  chipRefsMap,
  chipClickTimeRef,
  inputRef,
  editInputRef,
  setEditingTag,
  setTagPanel,
}: UseDesktopChipSelectionParams) {
  const [selectedTags, setSelectedTags] = useState<Set<number>>(new Set());
  const [multiNumWeight, setMultiNumWeight] = useState(1.0);

  useEffect(() => {
    if (selectedTags.size === 0) return;
    const valid = new Set<number>();
    selectedTags.forEach(index => { if (index < parsedTags.length) valid.add(index); });
    if (valid.size !== selectedTags.size) setSelectedTags(valid);
  }, [parsedTags.length, selectedTags]);

  const currentNumericWeight = useMemo(() => {
    if (selectedTags.size === 0) return null;
    const index = Array.from(selectedTags).sort((a, b) => a - b)[0];
    const weight = getTagWeightInfo(parsedTags[index]?.trim() || '');
    return weight.type === 'numeric' ? weight.numericValue ?? null : null;
  }, [selectedTags, parsedTags]);

  useEffect(() => { setMultiNumWeight(currentNumericWeight ?? 1.0); }, [currentNumericWeight]);

  const hasSelection = selectedTags.size > 0 && !tagPanel;

  const handleChipClick = useCallback((event: MouseEvent, index: number) => {
    event.stopPropagation();
    chipClickTimeRef.current = Date.now();
    if (editingTag !== null) return;
    if (event.ctrlKey || event.metaKey) {
      setTagPanel(null);
      setSelectedTags(prev => {
        const next = new Set(prev);
        if (next.has(index)) next.delete(index);
        else next.add(index);
        return next;
      });
    } else if (event.shiftKey && selectedTags.size > 0) {
      setTagPanel(null);
      const existing = Array.from(selectedTags).sort((a, b) => a - b);
      const from = Math.min(existing[0], index);
      const to = Math.max(existing[0], index);
      const next = new Set<number>();
      for (let i = from; i <= to; i++) next.add(i);
      setSelectedTags(next);
    } else {
      const rawTag = parsedTags[index];
      if (!rawTag) return;
      if (tagPanel && tagPanel.index === index) {
        setTagPanel(null);
        setSelectedTags(new Set());
        return;
      }
      setSelectedTags(new Set([index]));
      const chipEl = event.currentTarget as HTMLElement;
      const rect = chipEl.getBoundingClientRect();
      const clean = cleanTagName(rawTag);
      setTagPanel({
        index,
        rawTag: rawTag.trim(),
        tag: clean,
        translation: tagTranslations.get(clean) || '',
        screenX: rect.left,
        screenY: rect.bottom + 4,
      });
    }
  }, [chipClickTimeRef, editingTag, parsedTags, selectedTags, setTagPanel, tagPanel, tagTranslations]);

  const handleChipDoubleClick = useCallback((event: MouseEvent, index: number) => {
    event.stopPropagation();
    const rawTag = parsedTags[index];
    if (!rawTag || isCollapsibleMarker(rawTag)) return;
    setTagPanel(null);
    setSelectedTags(new Set());
    const chipEl = chipRefsMap.current.get(index);
    const chipWidth = chipEl ? chipEl.getBoundingClientRect().width : 80;
    const chipHeight = chipEl ? chipEl.getBoundingClientRect().height : 32;
    setEditingTag({ index, text: rawTag.trim(), width: Math.max(80, chipWidth), height: chipHeight });
  }, [chipRefsMap, parsedTags, setEditingTag, setTagPanel]);

  const handleContainerClick = useCallback(() => {
    setSelectedTags(new Set());
    setTagPanel(null);
    setEditingTag(null);
    inputRef.current?.focus();
  }, [inputRef, setEditingTag, setTagPanel]);

  const editingIndex = editingTag?.index ?? null;
  useEffect(() => {
    if (editingIndex !== null && editInputRef.current) {
      editInputRef.current.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingIndex]);

  return {
    selectedTags,
    setSelectedTags,
    multiNumWeight,
    setMultiNumWeight,
    hasSelection,
    handleChipClick,
    handleChipDoubleClick,
    handleContainerClick,
  };
}
