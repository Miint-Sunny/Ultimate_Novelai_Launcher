import { useMemo } from 'react';
import { analyzeTagGroups, getTagWeightInfo } from '../../../utils/promptTags';
import {
  applyBrace,
  applyBracket,
  applyNumericWeight,
  clearWeights,
  convertSDWeights,
  resolveTargetIndices,
  toggleHidden,
} from '../../../utils/promptWeightOps';

type TagGroups = ReturnType<typeof analyzeTagGroups>;

interface UseFullscreenTagActionsArgs {
  parsedTags: string[];
  selectedTags: Set<number>;
  tagGroups: TagGroups;
  rebuildValue: (tags: string[]) => void;
  setSelectedTags: (tags: Set<number>) => void;
}

export const useFullscreenTagActions = ({
  parsedTags,
  selectedTags,
  tagGroups,
  rebuildValue,
  setSelectedTags,
}: UseFullscreenTagActionsArgs) => {
  const tagActions = useMemo(() => {
    const getIndices = (): number[] => resolveTargetIndices(selectedTags, tagGroups);

    return {
      addBrace: () => {
        const indices = getIndices();
        if (indices.length === 0) return;
        rebuildValue(applyBrace(parsedTags, indices));
      },
      addBracket: () => {
        const indices = getIndices();
        if (indices.length === 0) return;
        rebuildValue(applyBracket(parsedTags, indices));
      },
      setNumeric: (w: number) => {
        const indices = getIndices();
        if (indices.length === 0) return;
        rebuildValue(applyNumericWeight(parsedTags, indices, w));
      },
      clearWeight: () => {
        const indices = getIndices();
        if (indices.length === 0) return;
        rebuildValue(clearWeights(parsedTags, indices, tagGroups));
      },
      convertSDToNAI: () => {
        const indices = getIndices();
        if (indices.length === 0) return;
        rebuildValue(convertSDWeights(parsedTags, indices));
      },
      deleteTag: () => {
        const indices = getIndices();
        if (indices.length === 0) return;
        const t = parsedTags.filter((_, i) => !indices.includes(i));
        rebuildValue(t);
        setSelectedTags(new Set());
      },
      toggleHide: () => {
        const indices = getIndices();
        if (indices.length === 0) return;
        rebuildValue(toggleHidden(parsedTags, indices));
        setSelectedTags(new Set());
      },
    };
  }, [parsedTags, selectedTags, tagGroups, rebuildValue, setSelectedTags]);

  const currentNumericWeight = useMemo(() => {
    if (selectedTags.size === 0) return null;
    const firstIdx = Array.from(selectedTags).sort((a, b) => a - b)[0];
    const tag = parsedTags[firstIdx];
    if (!tag) return null;
    const info = getTagWeightInfo(tag.trim());
    if (info.type === 'numeric' && info.numericValue !== undefined) return info.numericValue;
    return null;
  }, [selectedTags, parsedTags]);

  return { tagActions, currentNumericWeight };
};
