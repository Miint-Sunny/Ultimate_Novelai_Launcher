import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';

// 角色提示词条目的结构类型:桌面(left-sidebar/types)与移动端(mobile/types)
// 的 CharacterPrompt 均结构兼容,字段取并集(name + position)。
export interface SharedCharacterPrompt {
  id: string;
  positive: string;
  negative: string;
  activeTab: 'prompt' | 'undesired';
  enabled: boolean;
  position?: string;
  name?: string;
}

export type CharacterPromptField = 'positive' | 'negative' | 'activeTab' | 'enabled' | 'name' | 'position';

const MAX_CHARACTER_PROMPTS = 6;

interface UseSharedCharacterPromptsOptions<T extends SharedCharacterPrompt> {
  characterPrompts: T[];
  setCharacterPrompts: Dispatch<SetStateAction<T[]>>;
}

// 角色提示词编辑操作的双端共享核心。持久化走各自适配器(桌面壳:
// desktop_character_prompts;移动端:useMobileGenerationParams 的
// mobile_generate_state),本 hook 不碰任何 localStorage 键。
// 清空确认(isClearConfirming)是桌面 UI 决策,留在桌面壳;
// 展开/编辑中等 UI 状态留在各自壳。
export function useSharedCharacterPrompts<T extends SharedCharacterPrompt>({
  characterPrompts,
  setCharacterPrompts,
}: UseSharedCharacterPromptsOptions<T>) {
  const [editingPositionId, setEditingPositionId] = useState<string | null>(null);

  const addCharacterPrompt = useCallback(() => {
    if (characterPrompts.length >= MAX_CHARACTER_PROMPTS) return;
    setCharacterPrompts((prev) => [
      ...prev,
      {
        id: Date.now().toString(),
        positive: '',
        negative: '',
        activeTab: 'prompt',
        enabled: true,
        position: '',
      } as T,
    ]);
  }, [characterPrompts.length, setCharacterPrompts]);

  const removeCharacterPrompt = useCallback((id: string) => {
    setCharacterPrompts((prev) => prev.filter((prompt) => prompt.id !== id));
  }, [setCharacterPrompts]);

  const updateCharacterPrompt = useCallback(<K extends CharacterPromptField>(
    id: string,
    field: K,
    value: SharedCharacterPrompt[K],
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

  // 直接清空;桌面的二次确认在桌面壳里包装
  const clearAllCharacterPrompts = useCallback(() => {
    setCharacterPrompts([]);
  }, [setCharacterPrompts]);

  return {
    editingPositionId,
    setEditingPositionId,
    addCharacterPrompt,
    removeCharacterPrompt,
    updateCharacterPrompt,
    moveCharacterPrompt,
    clearAllCharacterPrompts,
  };
}
