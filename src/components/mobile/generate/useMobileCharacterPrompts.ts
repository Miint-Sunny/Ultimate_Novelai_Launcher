import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import type { CharacterPrompt } from '../types';

type CharacterPromptField = 'positive' | 'negative' | 'activeTab' | 'enabled' | 'name' | 'position';

interface UseMobileCharacterPromptsOptions {
  characterPrompts: CharacterPrompt[];
  setCharacterPrompts: Dispatch<SetStateAction<CharacterPrompt[]>>;
}

export function useMobileCharacterPrompts({
  characterPrompts,
  setCharacterPrompts,
}: UseMobileCharacterPromptsOptions) {
  const [isCharacterExpanded, setIsCharacterExpanded] = useState(true);
  const [editingCharacterId, setEditingCharacterId] = useState<string | null>(null);
  const [editingPositionId, setEditingPositionId] = useState<string | null>(null);

  const addCharacterPrompt = useCallback(() => {
    if (characterPrompts.length >= 6) return;
    setCharacterPrompts((prev) => [
      ...prev,
      {
        id: Date.now().toString(),
        positive: '',
        negative: '',
        activeTab: 'prompt',
        enabled: true,
      },
    ]);
  }, [characterPrompts.length, setCharacterPrompts]);

  const removeCharacterPrompt = useCallback((id: string) => {
    setCharacterPrompts((prev) => prev.filter((prompt) => prompt.id !== id));
  }, [setCharacterPrompts]);

  const updateCharacterPrompt = useCallback((
    id: string,
    field: CharacterPromptField,
    value: CharacterPrompt[CharacterPromptField]
  ) => {
    setCharacterPrompts((prev) =>
      prev.map((prompt) => (prompt.id === id ? { ...prompt, [field]: value } : prompt))
    );
  }, [setCharacterPrompts]);

  const moveCharacterPrompt = useCallback((index: number, direction: -1 | 1) => {
    setCharacterPrompts((prev) => {
      const newPrompts = [...prev];
      if (index + direction >= 0 && index + direction < newPrompts.length) {
        [newPrompts[index], newPrompts[index + direction]] = [
          newPrompts[index + direction],
          newPrompts[index],
        ];
      }
      return newPrompts;
    });
  }, [setCharacterPrompts]);

  const clearAllCharacterPrompts = useCallback(() => {
    setCharacterPrompts([]);
  }, [setCharacterPrompts]);

  return {
    characterPrompts,
    isCharacterExpanded,
    setIsCharacterExpanded,
    editingCharacterId,
    setEditingCharacterId,
    editingPositionId,
    setEditingPositionId,
    addCharacterPrompt,
    removeCharacterPrompt,
    updateCharacterPrompt,
    moveCharacterPrompt,
    clearAllCharacterPrompts,
  };
}
