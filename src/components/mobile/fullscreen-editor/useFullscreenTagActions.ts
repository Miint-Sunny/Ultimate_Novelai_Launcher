import { useMemo } from 'react';
import {
  analyzeTagGroups,
  cleanTagName,
  convertSDToNAI,
  getTagWeightInfo,
  isSDWeightFormat,
} from '../../../utils/promptTags';

type TagGroups = ReturnType<typeof analyzeTagGroups>;

interface UseFullscreenTagActionsArgs {
  parsedTags: string[];
  selectedTags: Set<number>;
  tagGroups: TagGroups;
  rebuildValue: (tags: string[]) => void;
  setSelectedTags: (tags: Set<number>) => void;
}

const groupContinuousIndices = (indices: number[]): number[][] => {
  const groups: number[][] = [];
  let currentGroup = [indices[0]];
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] === indices[i - 1] + 1) {
      currentGroup.push(indices[i]);
    } else {
      groups.push(currentGroup);
      currentGroup = [indices[i]];
    }
  }
  groups.push(currentGroup);
  return groups;
};

export const useFullscreenTagActions = ({
  parsedTags,
  selectedTags,
  tagGroups,
  rebuildValue,
  setSelectedTags,
}: UseFullscreenTagActionsArgs) => {
  const tagActions = useMemo(() => {
    const getIndices = (): number[] => {
      const arr = Array.from(selectedTags).sort((a, b) => a - b);
      if (arr.length === 0) return [];
      if (arr.length === 1) {
        const g = tagGroups[arr[0]];
        if (g && g.groupId !== -1) {
          return tagGroups.map((tg, idx) => tg.groupId === g.groupId ? idx : -1).filter(x => x >= 0);
        }
      }
      return arr;
    };

    return {
      addBrace: () => {
        const indices = getIndices();
        if (indices.length === 0) return;
        const t = [...parsedTags];
        for (const group of groupContinuousIndices(indices)) {
          const first = group[0], last = group[group.length - 1];
          t[first] = `{${t[first]}`;
          t[last] = `${t[last]}}`;
        }
        rebuildValue(t);
      },
      addBracket: () => {
        const indices = getIndices();
        if (indices.length === 0) return;
        const t = [...parsedTags];
        for (const group of groupContinuousIndices(indices)) {
          const first = group[0], last = group[group.length - 1];
          t[first] = `[${t[first]}`;
          t[last] = `${t[last]}]`;
        }
        rebuildValue(t);
      },
      setNumeric: (w: number) => {
        const indices = getIndices();
        if (indices.length === 0) return;
        const t = [...parsedTags];
        if (indices.length === 1) {
          const cleaned = cleanTagName(t[indices[0]]).replace(/ /g, '_');
          t[indices[0]] = `${w}::${cleaned}::`;
        } else {
          for (const group of groupContinuousIndices(indices)) {
            if (group.length === 1) {
              const cleaned = cleanTagName(t[group[0]]).replace(/ /g, '_');
              t[group[0]] = `${w}::${cleaned}::`;
            } else {
              const first = group[0], last = group[group.length - 1];
              for (const i of group) {
                t[i] = cleanTagName(t[i]);
              }
              t[first] = `${w}::${t[first]}`;
              t[last] = `${t[last]}::`;
            }
          }
        }
        rebuildValue(t);
      },
      clearWeight: () => {
        const indices = getIndices();
        if (indices.length === 0) return;
        const t = [...parsedTags];
        const toClear = new Set<number>(indices);
        for (const i of indices) {
          const g = tagGroups[i];
          if (g && g.groupId !== -1) {
            tagGroups.forEach((tg, idx) => {
              if (tg.groupId === g.groupId) toClear.add(idx);
            });
          }
        }
        for (const i of toClear) {
          t[i] = cleanTagName(t[i]);
        }
        rebuildValue(t);
      },
      convertSDToNAI: () => {
        const indices = getIndices();
        if (indices.length === 0) return;
        const t = [...parsedTags];
        for (const i of indices) {
          if (isSDWeightFormat(t[i])) {
            t[i] = convertSDToNAI(t[i]);
          }
        }
        rebuildValue(t);
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
        const t = [...parsedTags];
        const isHidden = t[indices[0]]?.trim().startsWith('~');
        for (const i of indices) {
          if (isHidden) t[i] = t[i].replace(/^(\s*)~/, '$1');
          else t[i] = t[i].replace(/^(\s*)/, '$1~');
        }
        rebuildValue(t);
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
