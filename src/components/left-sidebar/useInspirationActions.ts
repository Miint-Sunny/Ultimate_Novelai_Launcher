import { useCallback } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { CollapsibleTagInfo } from '../InspirationModal';
import type { CollapsibleTagType, PromptEditorRef } from '../PromptEditor';
import { parseCharacterPromptContent } from '../../utils/promptParser';
import type { CharacterPrompt } from './types';

const MAX_CHARACTER_PROMPTS = 6;

interface UseInspirationActionsParams {
  chipMode: boolean;
  positiveEditorRef: RefObject<PromptEditorRef | null>;
  characterPrompts: CharacterPrompt[];
  setPositivePrompt: Dispatch<SetStateAction<string>>;
  setCharacterPrompts: Dispatch<SetStateAction<CharacterPrompt[]>>;
  setIsCharacterSectionOpen: Dispatch<SetStateAction<boolean>>;
}

export function useInspirationActions({
  chipMode,
  positiveEditorRef,
  characterPrompts,
  setPositivePrompt,
  setCharacterPrompts,
  setIsCharacterSectionOpen,
}: UseInspirationActionsParams) {
  const handleSelectPrompt = useCallback((prompt: string) => {
    const parsed = parseCharacterPromptContent(prompt);
    if (parsed.characters.length > 0) {
      const basePrompt = parsed.basePrompt.replace(/,\s*$/, '').trim();
      if (basePrompt) {
        setPositivePrompt((prev) => (prev ? `${prev}, ${basePrompt}` : basePrompt));
      }

      const newCharacters = parsed.characters
        .slice(0, MAX_CHARACTER_PROMPTS - characterPrompts.length)
        .map((character, index) => ({
          id: `${Date.now()}-codex-${index}`,
          positive: character.content.replace(/,\s*$/, '').trim(),
          negative: (character.negative || '').replace(/,\s*$/, '').trim(),
          activeTab: 'prompt' as const,
          enabled: true,
          position: '',
          name: character.label,
        }));

      if (newCharacters.length > 0) {
        setCharacterPrompts((prev) => [...prev, ...newCharacters].slice(0, MAX_CHARACTER_PROMPTS));
        setIsCharacterSectionOpen(true);
      }
      return;
    }

    setPositivePrompt((prev) => (prev ? `${prev}, ${prompt}` : prompt));
  }, [characterPrompts.length, setCharacterPrompts, setIsCharacterSectionOpen, setPositivePrompt]);

  const handleAddCollapsibleTag = useCallback((tag: CollapsibleTagInfo) => {
    if (chipMode) {
      if (tag.type === 'artist') {
        const artistMarker = `<<artist:${tag.label}:${tag.content}>>`;
        setPositivePrompt((prev) => (prev ? `${prev}, ${artistMarker}` : artistMarker));
      } else {
        setPositivePrompt((prev) => (prev ? `${prev}, ${tag.content}` : tag.content));
      }
      return;
    }

    positiveEditorRef.current?.addCollapsibleTag({
      type: tag.type as CollapsibleTagType,
      label: tag.label,
      content: tag.content,
      collapsed: true,
    });
  }, [chipMode, positiveEditorRef, setPositivePrompt]);

  const handleAddToCharacter = useCallback((tag: CollapsibleTagInfo) => {
    if (characterPrompts.length >= MAX_CHARACTER_PROMPTS) return;

    const newCharacter: CharacterPrompt = {
      id: `${Date.now()}-oc`,
      positive: tag.content.replace(/,\s*$/, '').trim(),
      negative: '',
      activeTab: 'prompt',
      enabled: true,
      position: '',
      name: tag.label,
    };

    setCharacterPrompts((prev) => [...prev, newCharacter].slice(0, MAX_CHARACTER_PROMPTS));
    setIsCharacterSectionOpen(true);
  }, [characterPrompts.length, setCharacterPrompts, setIsCharacterSectionOpen]);

  return {
    handleSelectPrompt,
    handleAddCollapsibleTag,
    handleAddToCharacter,
  };
}
