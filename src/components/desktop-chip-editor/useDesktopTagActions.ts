import { useMemo, type Dispatch, type SetStateAction } from 'react';
import {
  cleanTagName,
  extractTagsFromList,
  type TagGroupInfo,
} from '../../utils/promptTags';
import {
  applyBrace,
  applyBracket,
  applyNumericWeight,
  clearWeights,
  convertSDWeights,
  resolveTargetIndices,
  toggleHidden,
} from '../../utils/promptWeightOps';

interface TagPanelState {
  index: number;
  rawTag: string;
  tag: string;
  translation: string;
  screenX: number;
  screenY: number;
}

interface UseDesktopTagActionsParams {
  selectedTags: Set<number>;
  tagGroups: TagGroupInfo[];
  parsedTags: string[];
  rebuildValue: (tags: string[]) => void;
  setSelectedTags: Dispatch<SetStateAction<Set<number>>>;
  setTagPanel: Dispatch<SetStateAction<TagPanelState | null>>;
}

interface UseDesktopPanelActionsParams {
  tagPanel: TagPanelState | null;
  tagGroups: TagGroupInfo[];
  parsedTags: string[];
  rebuildValue: (tags: string[]) => void;
  setSelectedTags: Dispatch<SetStateAction<Set<number>>>;
  setTagPanel: Dispatch<SetStateAction<TagPanelState | null>>;
}

export function useDesktopTagActions({
  selectedTags,
  tagGroups,
  parsedTags,
  rebuildValue,
  setSelectedTags,
  setTagPanel,
}: UseDesktopTagActionsParams) {
  return useMemo(() => {
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
      setNumeric: (weight: number) => {
        const indices = getIndices();
        if (indices.length === 0) return;
        rebuildValue(applyNumericWeight(parsedTags, indices, weight));
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
        if (selectedTags.size === 0) return;
        rebuildValue(parsedTags.filter((_, i) => !selectedTags.has(i)));
        setSelectedTags(new Set());
        setTagPanel(null);
      },
      toggleHide: () => {
        if (selectedTags.size === 0) return;
        const indices = Array.from(selectedTags).sort((a, b) => a - b);
        rebuildValue(toggleHidden(parsedTags, indices));
        setSelectedTags(new Set());
        setTagPanel(null);
      },
      moveToFront: () => {
        const { extracted, remaining } = extractTagsFromList(parsedTags, selectedTags, tagGroups);
        rebuildValue([...extracted, ...remaining]);
        setSelectedTags(new Set(extracted.map((_, i) => i)));
        setTagPanel(null);
      },
      openDanbooru: () => {
        const indices = Array.from(selectedTags);
        if (indices.length !== 1) return;
        window.open(`https://danbooru.donmai.us/wiki_pages/${encodeURIComponent(cleanTagName(parsedTags[indices[0]]).replace(/ /g, '_'))}`, '_blank');
        setTagPanel(null);
      },
    };
  }, [parsedTags, rebuildValue, selectedTags, setSelectedTags, setTagPanel, tagGroups]);
}

export function useDesktopPanelActions({
  tagPanel,
  parsedTags,
  tagGroups,
  rebuildValue,
  setSelectedTags,
  setTagPanel,
}: UseDesktopPanelActionsParams) {
  return useMemo(() => {
    const getGroupIndices = (): number[] => {
      if (!tagPanel) return [];
      return resolveTargetIndices([tagPanel.index], tagGroups);
    };

    return {
      addWeight: () => {
        if (!tagPanel) return;
        rebuildValue(applyBrace(parsedTags, getGroupIndices()));
        setTagPanel(null);
      },
      reduceWeight: () => {
        if (!tagPanel) return;
        rebuildValue(applyBracket(parsedTags, getGroupIndices()));
        setTagPanel(null);
      },
      clearWeight: () => {
        if (!tagPanel) return;
        // 下标已经 getGroupIndices 组展开,无需再连带展开(与原实现一致)
        rebuildValue(clearWeights(parsedTags, getGroupIndices()));
        setTagPanel(null);
      },
      setNumericWeight: (weight: number) => {
        if (!tagPanel) return;
        const tags = applyNumericWeight(parsedTags, getGroupIndices(), weight);
        rebuildValue(tags);
        setTagPanel(prev => prev ? { ...prev, rawTag: tags[tagPanel.index] } : null);
      },
      convertSDToNAI: () => {
        if (!tagPanel) return;
        rebuildValue(convertSDWeights(parsedTags, [tagPanel.index]));
        setTagPanel(null);
      },
      deleteTag: () => {
        if (!tagPanel) return;
        rebuildValue(parsedTags.filter((_, i) => i !== tagPanel.index));
        setSelectedTags(new Set());
        setTagPanel(null);
      },
      copyTag: () => {
        if (!tagPanel) return;
        navigator.clipboard.writeText(tagPanel.tag.replace(/ /g, '_')).catch(() => { });
        setTagPanel(null);
      },
      openDanbooru: () => {
        if (!tagPanel) return;
        window.open(`https://danbooru.donmai.us/wiki_pages/${encodeURIComponent(tagPanel.tag.replace(/ /g, '_'))}`, '_blank');
        setTagPanel(null);
      },
      toggleHide: () => {
        if (!tagPanel) return;
        const indices = getGroupIndices();
        // 隐藏状态锚定在面板标签本身(与原实现一致,不取组首)
        rebuildValue(toggleHidden(parsedTags, indices, tagPanel.index));
        setTagPanel(null);
        setSelectedTags(new Set());
      },
      moveToFront: () => {
        if (!tagPanel) return;
        const { extracted, remaining } = extractTagsFromList(parsedTags, new Set([tagPanel.index]), tagGroups);
        rebuildValue([...extracted, ...remaining]);
        setSelectedTags(new Set([0]));
        setTagPanel(null);
      },
    };
  }, [parsedTags, rebuildValue, setSelectedTags, setTagPanel, tagGroups, tagPanel]);
}
