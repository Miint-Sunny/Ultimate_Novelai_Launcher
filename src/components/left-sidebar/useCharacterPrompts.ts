import { useEffect, useState } from 'react';
import type { CharacterPrompt } from './types';

const STORAGE_KEY = 'desktop_character_prompts';
const MAX_CHARACTER_PROMPTS = 6;

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

export function useCharacterPrompts() {
  const [characterPrompts, setCharacterPrompts] = useState<CharacterPrompt[]>(loadCharacterPrompts);
  const [isCharacterSectionOpen, setIsCharacterSectionOpen] = useState(true);
  const [isClearConfirming, setIsClearConfirming] = useState(false);
  const [editingPositionId, setEditingPositionId] = useState<string | null>(null);

  useEffect(() => {
    saveCharacterPrompts(characterPrompts);
  }, [characterPrompts]);

  const addCharacterPrompt = () => {
    if (characterPrompts.length >= MAX_CHARACTER_PROMPTS) return;
    setCharacterPrompts(prev => [...prev, {
      id: Date.now().toString(),
      positive: '',
      negative: '',
      activeTab: 'prompt',
      enabled: true,
      position: '',
    }]);
  };

  const clearAllCharacterPrompts = () => {
    if (isClearConfirming) {
      setCharacterPrompts([]);
      setIsClearConfirming(false);
    } else {
      setIsClearConfirming(true);
      setTimeout(() => setIsClearConfirming(false), 3000);
    }
  };

  const removeCharacterPrompt = (id: string) => {
    setCharacterPrompts(prev => prev.filter(p => p.id !== id));
  };

  const updateCharacterPrompt = <K extends 'positive' | 'negative' | 'activeTab' | 'enabled' | 'position'>(
    id: string,
    field: K,
    value: CharacterPrompt[K],
  ) => {
    setCharacterPrompts(prev => prev.map(p =>
      p.id === id ? { ...p, [field]: value } : p
    ));
  };

  const moveCharacterPrompt = (index: number, direction: -1 | 1) => {
    setCharacterPrompts(prev => {
      const newPrompts = [...prev];
      if (index + direction >= 0 && index + direction < newPrompts.length) {
        [newPrompts[index], newPrompts[index + direction]] = [newPrompts[index + direction], newPrompts[index]];
      }
      return newPrompts;
    });
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
