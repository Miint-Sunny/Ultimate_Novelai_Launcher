import type { Dispatch, MouseEvent, MutableRefObject, RefObject, SetStateAction } from 'react';
import type { CollapsibleTag, PromptEditorRef } from '../PromptEditor';
import type { AgentState, GenerationSnapshot } from '../../services/agentService';
import { InlineAgentPanel } from './InlineAgentPanel';
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
  aiModel: string;
  onAiModelChange: (model: string) => void;
  agentState: AgentState;
  isGeneratingPrompt: boolean;
  aiLogScrollRef: RefObject<HTMLDivElement | null>;
  aiInputRef: RefObject<HTMLTextAreaElement | null>;
  aiInputPrompt: string;
  setAiInputPrompt: Dispatch<SetStateAction<string>>;
  onAIGenerate: () => void;
  onSuccessLogAction: (index: number, snapshot: GenerationSnapshot, isLastSuccess: boolean) => void;
  onErrorLogRetry: (index: number) => void;
  onToggleLogExpanded: (index: number) => void;
  onClearAgentAll: () => void;
  isFloatingAIOpen: boolean;
  setIsFloatingAIOpen: Dispatch<SetStateAction<boolean>>;
  onAssistantInitialRectChange: (rect: DOMRect) => void;
}

export function PromptComposerSection({
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
  aiModel,
  onAiModelChange,
  agentState,
  isGeneratingPrompt,
  aiLogScrollRef,
  aiInputRef,
  aiInputPrompt,
  setAiInputPrompt,
  onAIGenerate,
  onSuccessLogAction,
  onErrorLogRetry,
  onToggleLogExpanded,
  onClearAgentAll,
  isFloatingAIOpen,
  setIsFloatingAIOpen,
  onAssistantInitialRectChange,
}: PromptComposerSectionProps) {
  return (
    <div className="bg-nai-input rounded-lg border border-gray-800 p-1 relative group/prompt-container" ref={promptAreaRef}>
      <PromptToolbar
        activeTab={activeTab}
        onActiveTabChange={onActiveTabChange}
        aiModel={aiModel}
        onAiModelChange={onAiModelChange}
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

          <InlineAgentPanel
            agentState={agentState}
            isGeneratingPrompt={isGeneratingPrompt}
            aiLogScrollRef={aiLogScrollRef}
            aiInputRef={aiInputRef}
            aiInputPrompt={aiInputPrompt}
            setAiInputPrompt={setAiInputPrompt}
            onAIGenerate={onAIGenerate}
            onSuccessLogAction={onSuccessLogAction}
            onErrorLogRetry={onErrorLogRetry}
            onToggleLogExpanded={onToggleLogExpanded}
            onClearAll={onClearAgentAll}
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

      <div className="px-2 pt-2 pb-1.5 flex items-center justify-between gap-2 border-t border-transparent">
        <ChipModeToggle chipMode={chipMode} onChange={onChipModeChange} />
        <TokenMeter totalTokenCount={totalTokenCount} />
        <FloatingAgentButton
          isOpen={isFloatingAIOpen}
          isGenerating={isGeneratingPrompt}
          onClick={() => {
            if (!isFloatingAIOpen && promptAreaRef.current) {
              onAssistantInitialRectChange(promptAreaRef.current.getBoundingClientRect());
            }
            setIsFloatingAIOpen((prev) => !prev);
          }}
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
