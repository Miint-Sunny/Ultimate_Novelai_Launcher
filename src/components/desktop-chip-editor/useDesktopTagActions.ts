import { useMemo, type Dispatch, type SetStateAction } from 'react';
import {
  cleanTagName,
  convertSDToNAI,
  extractTagsFromList,
  isSDWeightFormat,
  type TagGroupInfo,
} from '../../utils/promptTags';

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
    const getIndices = (): number[] => {
      const arr = Array.from(selectedTags).sort((a, b) => a - b);
      if (arr.length === 0) return [];
      if (arr.length === 1) {
        const group = tagGroups[arr[0]];
        if (group && group.groupId !== -1) {
          return tagGroups.map((tagGroup, idx) => tagGroup.groupId === group.groupId ? idx : -1).filter(x => x >= 0);
        }
      }
      return arr;
    };

    return {
      addBrace: () => {
        const indices = getIndices();
        if (indices.length === 0) return;
        const tags = [...parsedTags];
        const groups: number[][] = [];
        let cur = [indices[0]];
        for (let i = 1; i < indices.length; i++) {
          if (indices[i] === indices[i - 1] + 1) cur.push(indices[i]);
          else {
            groups.push(cur);
            cur = [indices[i]];
          }
        }
        groups.push(cur);
        for (const group of groups) {
          tags[group[0]] = `{${tags[group[0]]}`;
          tags[group[group.length - 1]] = `${tags[group[group.length - 1]]}}`;
        }
        rebuildValue(tags);
      },
      addBracket: () => {
        const indices = getIndices();
        if (indices.length === 0) return;
        const tags = [...parsedTags];
        const groups: number[][] = [];
        let cur = [indices[0]];
        for (let i = 1; i < indices.length; i++) {
          if (indices[i] === indices[i - 1] + 1) cur.push(indices[i]);
          else {
            groups.push(cur);
            cur = [indices[i]];
          }
        }
        groups.push(cur);
        for (const group of groups) {
          tags[group[0]] = `[${tags[group[0]]}`;
          tags[group[group.length - 1]] = `${tags[group[group.length - 1]]}]`;
        }
        rebuildValue(tags);
      },
      setNumeric: (weight: number) => {
        const indices = getIndices();
        if (indices.length === 0) return;
        const tags = [...parsedTags];
        const groups: number[][] = [];
        let cur = [indices[0]];
        for (let i = 1; i < indices.length; i++) {
          if (indices[i] === indices[i - 1] + 1) cur.push(indices[i]);
          else {
            groups.push(cur);
            cur = [indices[i]];
          }
        }
        groups.push(cur);
        for (const group of groups) {
          if (group.length === 1) {
            tags[group[0]] = `${weight}::${cleanTagName(tags[group[0]]).replace(/ /g, '_')}::`;
          } else {
            for (const i of group) tags[i] = cleanTagName(tags[i]);
            tags[group[0]] = `${weight}::${tags[group[0]]}`;
            tags[group[group.length - 1]] = `${tags[group[group.length - 1]]}::`;
          }
        }
        rebuildValue(tags);
      },
      clearWeight: () => {
        const indices = getIndices();
        if (indices.length === 0) return;
        const tags = [...parsedTags];
        const toClear = new Set<number>(indices);
        for (const i of indices) {
          const group = tagGroups[i];
          if (group && group.groupId !== -1) {
            tagGroups.forEach((tagGroup, idx) => {
              if (tagGroup.groupId === group.groupId) toClear.add(idx);
            });
          }
        }
        for (const i of toClear) tags[i] = cleanTagName(tags[i]);
        rebuildValue(tags);
      },
      convertSDToNAI: () => {
        const indices = getIndices();
        if (indices.length === 0) return;
        const tags = [...parsedTags];
        for (const i of indices) {
          if (isSDWeightFormat(tags[i])) tags[i] = convertSDToNAI(tags[i]);
        }
        rebuildValue(tags);
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
        const tags = [...parsedTags];
        const isHidden = tags[indices[0]]?.trim().startsWith('~');
        for (const i of indices) {
          if (isHidden) tags[i] = tags[i].replace(/^(\s*)~/, '$1');
          else tags[i] = tags[i].replace(/^(\s*)/, '$1~');
        }
        rebuildValue(tags);
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
      const group = tagGroups[tagPanel.index];
      if (group && group.groupId !== -1) {
        return tagGroups.map((tagGroup, idx) => tagGroup.groupId === group.groupId ? idx : -1).filter(x => x >= 0);
      }
      return [tagPanel.index];
    };

    return {
      addWeight: () => {
        if (!tagPanel) return;
        const tags = [...parsedTags];
        const indices = getGroupIndices();
        const groups: number[][] = [];
        let cur = [indices[0]];
        for (let i = 1; i < indices.length; i++) {
          if (indices[i] === indices[i - 1] + 1) cur.push(indices[i]);
          else {
            groups.push(cur);
            cur = [indices[i]];
          }
        }
        groups.push(cur);
        for (const group of groups) {
          tags[group[0]] = `{${tags[group[0]]}`;
          tags[group[group.length - 1]] = `${tags[group[group.length - 1]]}}`;
        }
        rebuildValue(tags);
        setTagPanel(null);
      },
      reduceWeight: () => {
        if (!tagPanel) return;
        const tags = [...parsedTags];
        const indices = getGroupIndices();
        const groups: number[][] = [];
        let cur = [indices[0]];
        for (let i = 1; i < indices.length; i++) {
          if (indices[i] === indices[i - 1] + 1) cur.push(indices[i]);
          else {
            groups.push(cur);
            cur = [indices[i]];
          }
        }
        groups.push(cur);
        for (const group of groups) {
          tags[group[0]] = `[${tags[group[0]]}`;
          tags[group[group.length - 1]] = `${tags[group[group.length - 1]]}]`;
        }
        rebuildValue(tags);
        setTagPanel(null);
      },
      clearWeight: () => {
        if (!tagPanel) return;
        const tags = [...parsedTags];
        const toClear = new Set<number>(getGroupIndices());
        for (const i of toClear) tags[i] = cleanTagName(tags[i]);
        rebuildValue(tags);
        setTagPanel(null);
      },
      setNumericWeight: (weight: number) => {
        if (!tagPanel) return;
        const tags = [...parsedTags];
        const indices = getGroupIndices();
        if (indices.length === 1) {
          tags[indices[0]] = `${weight}::${cleanTagName(tags[indices[0]]).replace(/ /g, '_')}::`;
        } else {
          for (const i of indices) tags[i] = cleanTagName(tags[i]);
          tags[indices[0]] = `${weight}::${tags[indices[0]]}`;
          tags[indices[indices.length - 1]] = `${tags[indices[indices.length - 1]]}::`;
        }
        rebuildValue(tags);
        setTagPanel(prev => prev ? { ...prev, rawTag: tags[tagPanel.index] } : null);
      },
      convertSDToNAI: () => {
        if (!tagPanel) return;
        const tags = [...parsedTags];
        tags[tagPanel.index] = convertSDToNAI(tags[tagPanel.index]);
        rebuildValue(tags);
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
        const tags = [...parsedTags];
        const indices = getGroupIndices();
        const isHidden = tags[tagPanel.index]?.trim().startsWith('~');
        for (const i of indices) {
          if (isHidden) tags[i] = tags[i].replace(/^(\s*)~/, '$1');
          else tags[i] = tags[i].replace(/^(\s*)/, '$1~');
        }
        rebuildValue(tags);
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
