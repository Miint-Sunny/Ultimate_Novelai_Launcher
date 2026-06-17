import { useCallback, type Dispatch, type SetStateAction } from 'react';
import { parseCharacterPromptContent } from '../../../utils/promptParser';
import type { CharacterPrompt } from '../types';

interface UseMobileInspirationApplyOptions {
  characterPrompts: CharacterPrompt[];
  setCharacterPrompts: Dispatch<SetStateAction<CharacterPrompt[]>>;
  setPositivePrompt: Dispatch<SetStateAction<string>>;
  closeInspirationSheet: () => void;
}

export function useMobileInspirationApply({
  characterPrompts,
  setCharacterPrompts,
  setPositivePrompt,
  closeInspirationSheet,
}: UseMobileInspirationApplyOptions) {
  const handleInspirationSelect = useCallback((prompt: string) => {
    const parsed = parseCharacterPromptContent(prompt);
    if (parsed.characters.length > 0) {
      const basePrompt = parsed.basePrompt.replace(/,\s*$/, '').trim();
      if (basePrompt) {
        setPositivePrompt((prev) => (prev ? `${prev}, ${basePrompt}` : basePrompt));
      }

      const newChars = parsed.characters.slice(0, 6 - characterPrompts.length).map((character, index) => ({
        id: `${Date.now()}-codex-${index}`,
        positive: character.content.replace(/,\s*$/, '').trim(),
        negative: (character.negative || '').replace(/,\s*$/, '').trim(),
        activeTab: 'prompt' as const,
        enabled: true,
        name: character.label,
      }));
      if (newChars.length > 0) {
        setCharacterPrompts((prev) => [...prev, ...newChars].slice(0, 6));
      }
    } else {
      setPositivePrompt((prev) => (prev ? `${prev}, ${prompt}` : prompt));
    }

    closeInspirationSheet();
  }, [characterPrompts.length, closeInspirationSheet, setCharacterPrompts, setPositivePrompt]);

  return {
    handleInspirationSelect,
  };
}
