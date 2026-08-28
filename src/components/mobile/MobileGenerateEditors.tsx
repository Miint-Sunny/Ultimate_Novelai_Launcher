import type { ComponentProps, Dispatch, SetStateAction } from 'react';
import { MobileAIAssistantSheet } from './MobileAIAssistantSheet';
import { MobileCharacterPromptEditor } from './MobileCharacterPromptEditor';
import { MobileCharacterPositionSheet } from './MobileCharacterPositionSheet';
import { FullscreenEditor } from './FullscreenEditor';
import type { MobileEditorOpenState } from './generate/useMobileGenerateSheetState';
import type { useMobileCharacterPrompts } from './generate/useMobileCharacterPrompts';

type MobileCharacterPrompts = ReturnType<typeof useMobileCharacterPrompts>;
type AssistantProps = ComponentProps<typeof MobileAIAssistantSheet>;

interface MobileGenerateEditorsProps {
  /** 当前模型 id(文字渲染提示与补全让路按能力位开关)。 */
  model: string;
  /** 当前模型的 token 软阈值。 */
  maxTokens: number;
  editorOpen: MobileEditorOpenState;
  setEditorOpen: Dispatch<SetStateAction<MobileEditorOpenState>>;
  positivePrompt: string;
  setPositivePrompt: Dispatch<SetStateAction<string>>;
  negativePrompt: string;
  setNegativePrompt: Dispatch<SetStateAction<string>>;
  positivePresetTokens: number;
  negativePresetTokens: number;
  positiveTokens: number;
  negativeTokens: number;
  showAIAssistant: boolean;
  closeAIAssistant: () => void;
  aiModel: string;
  setAiModel: (model: string) => void;
  agentState: AssistantProps['agentState'];
  isGeneratingPrompt: boolean;
  handleAIGenerate: AssistantProps['onAIGenerate'];
  handleAIRegenerate: AssistantProps['onAIRegenerate'];
  handleRestoreSnapshot: AssistantProps['onRestoreSnapshot'];
  characterPromptManager: MobileCharacterPrompts;
}

export function MobileGenerateEditors({
  model,
  maxTokens,
  editorOpen,
  setEditorOpen,
  positivePrompt,
  setPositivePrompt,
  negativePrompt,
  setNegativePrompt,
  positivePresetTokens,
  negativePresetTokens,
  positiveTokens,
  negativeTokens,
  showAIAssistant,
  closeAIAssistant,
  aiModel,
  setAiModel,
  agentState,
  isGeneratingPrompt,
  handleAIGenerate,
  handleAIRegenerate,
  handleRestoreSnapshot,
  characterPromptManager,
}: MobileGenerateEditorsProps) {
  return (
    <>
      <FullscreenEditor
        model={model}
        maxTokens={maxTokens}
        isOpen={editorOpen === 'prompt'}
        onClose={() => setEditorOpen(null)}
        type="prompt"
        value={positivePrompt}
        onChange={setPositivePrompt}
        presetTokens={positivePresetTokens}
        totalTokens={positiveTokens}
      />
      <FullscreenEditor
        model={model}
        maxTokens={maxTokens}
        isOpen={editorOpen === 'undesired'}
        onClose={() => setEditorOpen(null)}
        type="undesired"
        value={negativePrompt}
        onChange={setNegativePrompt}
        presetTokens={negativePresetTokens}
        totalTokens={negativeTokens}
      />
      <MobileAIAssistantSheet
        isOpen={showAIAssistant}
        onClose={closeAIAssistant}
        aiModel={aiModel}
        onAiModelChange={setAiModel}
        agentState={agentState}
        isGeneratingPrompt={isGeneratingPrompt}
        onAIGenerate={handleAIGenerate}
        onAIRegenerate={handleAIRegenerate}
        onRestoreSnapshot={handleRestoreSnapshot}
      />

      <MobileCharacterPromptEditor
        maxTokens={maxTokens}
        manager={characterPromptManager}
        positiveTokens={positiveTokens}
        negativeTokens={negativeTokens}
      />
      <MobileCharacterPositionSheet manager={characterPromptManager} />
    </>
  );
}
