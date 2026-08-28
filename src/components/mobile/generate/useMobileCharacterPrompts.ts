import { useState, type Dispatch, type SetStateAction } from 'react';
import { useSharedCharacterPrompts, type CharacterPromptField } from '../../../hooks/useSharedCharacterPrompts';
import type { CharacterPrompt } from '../types';

interface UseMobileCharacterPromptsOptions {
  /** 当前模型的同框角色上限。 */
  maxCharacters?: number;
  characterPrompts: CharacterPrompt[];
  setCharacterPrompts: Dispatch<SetStateAction<CharacterPrompt[]>>;
}

// 薄壳:编辑操作在 src/hooks/useSharedCharacterPrompts.ts(受控,持久化仍由
// useMobileGenerationParams 的 mobile_generate_state 统一托管,不动);
// 这里只保留移动端专属的展开/编辑中 UI 状态。
export function useMobileCharacterPrompts({
  characterPrompts,
  setCharacterPrompts,
  maxCharacters,
}: UseMobileCharacterPromptsOptions) {
  const [isCharacterExpanded, setIsCharacterExpanded] = useState(true);
  const [editingCharacterId, setEditingCharacterId] = useState<string | null>(null);

  const {
    editingPositionId,
    setEditingPositionId,
    addCharacterPrompt,
    removeCharacterPrompt,
    updateCharacterPrompt,
    moveCharacterPrompt,
    clearAllCharacterPrompts,
  } = useSharedCharacterPrompts({ characterPrompts, setCharacterPrompts, maxCharacters });

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
    updateCharacterPrompt: updateCharacterPrompt as (
      id: string,
      field: CharacterPromptField,
      value: CharacterPrompt[CharacterPromptField]
    ) => void,
    moveCharacterPrompt,
    clearAllCharacterPrompts,
  };
}
