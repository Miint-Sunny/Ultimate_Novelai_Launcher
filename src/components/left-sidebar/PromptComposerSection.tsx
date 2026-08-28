import type { MouseEvent, MutableRefObject, RefObject } from 'react';
import type { CollapsibleTag, PromptEditorRef } from '../PromptEditor';
import { useAgentDock } from '../../contexts/AgentDockContext';
import { useAgentModelPresentation } from '../../hooks/useAgentModelPresentation';
import { modelCapabilities } from '../generation/modelResolutionOptions';
import { V5TogglePanel } from './V5TogglePanel';
import {
  ChipModeToggle,
  FloatingAgentButton,
  PromptPane,
  PromptToolbar,
  TokenMeter,
  type ActiveTab,
  type TranslationCache,
  type TranslationType,
} from './PromptComposerParts';

interface PromptComposerSectionProps {
  /** 当前模型 id。开关词条面板按它的能力位决定出不出现。 */
  model: string;
  /** 当前模型的 token 软阈值。 */
  maxTokens: number;
  promptAreaRef: RefObject<HTMLDivElement | null>;
  promptBoxHeight: number;
  isDraggingPromptBox: MutableRefObject<boolean>;
  onPromptBoxMouseDown: (event: MouseEvent<HTMLDivElement>) => void;
  activeTab: ActiveTab;
  onActiveTabChange: (tab: ActiveTab) => void;
  chipMode: boolean;
  onChipModeChange: (enabled: boolean) => void;
  positivePrompt: string;
  negativePrompt: string;
  onPositivePromptChange: (value: string) => void;
  onNegativePromptChange: (value: string) => void;
  positiveEditorRef: RefObject<PromptEditorRef | null>;
  negativeEditorRef: RefObject<PromptEditorRef | null>;
  onPositiveTagsChange: (tags: CollapsibleTag[]) => void;
  onPromptContentHeightChange: (height: number) => void;
  showTranslation: boolean;
  translationCache: TranslationCache;
  onCloseTranslation: () => void;
  onTranslationTagClick: (startIndex: number, length: number, type: TranslationType) => void;
  totalTokenCount: number;
  onOpenInspiration: () => void;
  onOpenTagManager: () => void;
  onOpenPresetModal: () => void;
}

export function PromptComposerSection({
  model,
  maxTokens,
  promptAreaRef,
  promptBoxHeight,
  isDraggingPromptBox,
  onPromptBoxMouseDown,
  activeTab,
  onActiveTabChange,
  chipMode,
  onChipModeChange,
  positivePrompt,
  negativePrompt,
  onPositivePromptChange,
  onNegativePromptChange,
  positiveEditorRef,
  negativeEditorRef,
  onPositiveTagsChange,
  onPromptContentHeightChange,
  showTranslation,
  translationCache,
  onCloseTranslation,
  onTranslationTagClick,
  totalTokenCount,
  onOpenInspiration,
  onOpenTagManager,
  onOpenPresetModal,
}: PromptComposerSectionProps) {
  // Agent 模型与开合状态来自停靠面板上下文；结果展示已整体迁往右侧 AgentDock。
  const {
    aiModel,
    setAiModel,
    isGeneratingPrompt,
    agentAvailable,
    agentUnavailableReason,
    isDockOpen,
    toggleDock,
  } = useAgentDock();
  const agentModel = useAgentModelPresentation();

  return (
    <div className="bg-nai-input rounded-lg border border-gray-800 p-1 relative group/prompt-container" ref={promptAreaRef}>
      <PromptToolbar
        activeTab={activeTab}
        onActiveTabChange={onActiveTabChange}
        aiModel={aiModel}
        localPrimaryModel={agentModel.isLocal ? (agentModel.primaryModel ?? '') : null}
        onAiModelChange={setAiModel}
        onOpenInspiration={onOpenInspiration}
        onOpenTagManager={onOpenTagManager}
        onOpenPresetModal={onOpenPresetModal}
      />

      <div className="relative group/prompt-box">
        <div
          className="relative min-h-[250px] bg-nai-input rounded-md z-10 overflow-hidden"
          style={{
            height: `${promptBoxHeight}px`,
            transition: isDraggingPromptBox.current ? 'none' : 'height 0.25s ease-out',
          }}
        >
          <PromptPane
            visible={activeTab === 'prompt'}
            direction="left"
            promptType="positive"
            value={positivePrompt}
            onChange={onPositivePromptChange}
            chipMode={chipMode}
            showTranslation={showTranslation}
            translationCache={translationCache}
            onCloseTranslation={onCloseTranslation}
            onTranslationTagClick={onTranslationTagClick}
            editorRef={positiveEditorRef}
            onTagsChange={onPositiveTagsChange}
            onContentHeightChange={activeTab === 'prompt' ? onPromptContentHeightChange : undefined}
          />

          <PromptPane
            visible={activeTab === 'undesired'}
            direction="right"
            promptType="negative"
            value={negativePrompt}
            onChange={onNegativePromptChange}
            chipMode={chipMode}
            showTranslation={showTranslation}
            translationCache={translationCache}
            onCloseTranslation={onCloseTranslation}
            onTranslationTagClick={onTranslationTagClick}
            editorRef={negativeEditorRef}
            disableCollapsibleTags
            onContentHeightChange={activeTab === 'undesired' ? onPromptContentHeightChange : undefined}
          />
        </div>
      </div>

      {modelCapabilities(model).toggleWords && activeTab === 'prompt' && (
        <V5TogglePanel prompt={positivePrompt} onPromptChange={onPositivePromptChange} />
      )}

      <div className="px-2 pt-2 pb-1.5 flex items-center justify-between gap-2 border-t border-transparent">
        <ChipModeToggle chipMode={chipMode} onChange={onChipModeChange} />
        <TokenMeter maxTokens={maxTokens} totalTokenCount={totalTokenCount} />
        {!agentAvailable && (
          <span
            className="shrink-0 text-[10px] text-gray-600"
            title={agentUnavailableReason}
          >
            Agent 未启用
          </span>
        )}
        <FloatingAgentButton
          isOpen={isDockOpen}
          isGenerating={isGeneratingPrompt}
          disabled={!agentAvailable}
          disabledReason={agentUnavailableReason}
          onClick={toggleDock}
        />
      </div>

      <div
        className="absolute bottom-0 left-0 right-0 h-1 cursor-ns-resize z-50 hover:bg-white/10 transition-colors rounded-b-lg"
        onMouseDown={onPromptBoxMouseDown}
        title="拖动调整高度"
      />
    </div>
  );
}
