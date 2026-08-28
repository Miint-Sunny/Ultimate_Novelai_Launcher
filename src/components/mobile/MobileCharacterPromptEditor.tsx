import { FullscreenEditor } from './FullscreenEditor';
import type { useMobileCharacterPrompts } from './generate/useMobileCharacterPrompts';

type MobileCharacterPrompts = ReturnType<typeof useMobileCharacterPrompts>;

interface MobileCharacterPromptEditorProps {
  /** 当前模型的 token 软阈值。 */
  maxTokens: number;
  manager: MobileCharacterPrompts;
  positiveTokens: number;
  negativeTokens: number;
}

export function MobileCharacterPromptEditor({
  maxTokens,
  manager,
  positiveTokens,
  negativeTokens,
}: MobileCharacterPromptEditorProps) {
  const {
    characterPrompts,
    editingCharacterId,
    setEditingCharacterId,
    updateCharacterPrompt,
  } = manager;

  if (!editingCharacterId) return null;

  const characterPrompt = characterPrompts.find((prompt) => prompt.id === editingCharacterId);
  if (!characterPrompt) return null;

  return (
    <FullscreenEditor
      maxTokens={maxTokens}
      isOpen={true}
      onClose={() => setEditingCharacterId(null)}
      type={characterPrompt.activeTab === 'prompt' ? 'prompt' : 'undesired'}
      value={characterPrompt.activeTab === 'prompt' ? characterPrompt.positive : characterPrompt.negative}
      onChange={(value) =>
        updateCharacterPrompt(
          characterPrompt.id,
          characterPrompt.activeTab === 'prompt' ? 'positive' : 'negative',
          value
        )
      }
      totalTokens={characterPrompt.activeTab === 'prompt' ? positiveTokens : negativeTokens}
    />
  );
}
