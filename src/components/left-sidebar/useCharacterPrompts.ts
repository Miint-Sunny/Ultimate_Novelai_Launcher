import { useEffect, useState } from 'react';
import { useSharedCharacterPrompts } from '../../hooks/useSharedCharacterPrompts';
import type { CharacterPrompt } from './types';

const STORAGE_KEY = 'desktop_character_prompts';

function loadCharacterPrompts(): CharacterPrompt[] {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return [];
    const parsed = JSON.parse(saved);
    return parsed.map((c: Partial<CharacterPrompt>) => ({
      id: c.id || Date.now().toString(),
      positive: c.positive || '',
      negative: c.negative || '',
      activeTab: c.activeTab || 'prompt',
      enabled: c.enabled !== false,
      position: c.position,
      name: c.name,
    }));
  } catch {
    return [];
  }
}

function saveCharacterPrompts(characterPrompts: CharacterPrompt[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(characterPrompts.map(c => ({
      id: c.id,
      positive: c.positive,
      negative: c.negative,
      activeTab: c.activeTab,
      enabled: c.enabled,
      position: c.position,
      name: c.name,
    }))));
  } catch {
    // localStorage can be unavailable in private or embedded contexts.
  }
}

// 薄壳:编辑操作在 src/hooks/useSharedCharacterPrompts.ts;
// 这里保留桌面专属的持久化(desktop_character_prompts 键不动)、
// 区块展开状态与清空二次确认(UI 决策,移动端不引入),行为与原实现一致。
export function useCharacterPrompts() {
  const [characterPrompts, setCharacterPrompts] = useState<CharacterPrompt[]>(loadCharacterPrompts);
  const [isCharacterSectionOpen, setIsCharacterSectionOpen] = useState(true);
  const [isClearConfirming, setIsClearConfirming] = useState(false);

  useEffect(() => {
    saveCharacterPrompts(characterPrompts);
  }, [characterPrompts]);

  const {
    editingPositionId,
    setEditingPositionId,
    addCharacterPrompt,
    removeCharacterPrompt,
    updateCharacterPrompt,
    moveCharacterPrompt,
    clearAllCharacterPrompts: clearAll,
  } = useSharedCharacterPrompts({ characterPrompts, setCharacterPrompts });

  const clearAllCharacterPrompts = () => {
    if (isClearConfirming) {
      clearAll();
      setIsClearConfirming(false);
    } else {
      setIsClearConfirming(true);
      setTimeout(() => setIsClearConfirming(false), 3000);
    }
  };

  return {
    characterPrompts,
    setCharacterPrompts,
    isCharacterSectionOpen,
    setIsCharacterSectionOpen,
    isClearConfirming,
    editingPositionId,
    setEditingPositionId,
    addCharacterPrompt,
    clearAllCharacterPrompts,
    removeCharacterPrompt,
    updateCharacterPrompt,
    moveCharacterPrompt,
  };
}
