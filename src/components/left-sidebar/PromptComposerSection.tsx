import { useMemo, type MouseEvent, type MutableRefObject, type RefObject } from 'react';
import { Ban } from 'lucide-react';
import type { PromptLayout } from '../../utils/sidebarTabs';
import type { CollapsibleTag, PromptEditorRef } from '../PromptEditor';
import { useAgentDock } from '../../contexts/AgentDockContext';
import { useAgentModelPresentation } from '../../hooks/useAgentModelPresentation';
import { modelCapabilities } from '../generation/modelResolutionOptions';
import { V5TogglePanel } from './V5TogglePanel';
import {
  ChipModeToggle,
  FloatingAgentButton,
  PromptLayoutToggle,
  PromptPane,
  PromptToolbar,
  TokenMeter,
  type ActiveTab,
  type TranslationCache,
  type TranslationType,
} from './PromptComposerParts';
import { isFurryDatasetOn, toggleFurryDataset } from '../../services/naiV5Toggles';
import { detectTextRenderHints } from '../../utils/textRenderHints';
import { TextRenderHintBar } from '../prompt-editor/TextRenderHintBar';

interface PromptComposerSectionProps {
  /** 当前模型 id。开关词条面板、文字渲染提示与补全让路都按它的能力位决定。 */
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
  /** 分页 / 堆叠。堆叠时两栏同时可见,提示 / 排除胶囊藏起来,token 表按「提示」算。 */
  layout: PromptLayout;
  onLayoutChange: (layout: PromptLayout) => void;
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
  onOpenPromptChunks: () => void;
  onOpenPresetModal: () => void;
}

/** 堆叠排法里排除那栏的固定高度(含标签行),整框自动撑高时加上它。 */
const STACKED_NEGATIVE_HEIGHT = 150;
const STACKED_NEGATIVE_LABEL_HEIGHT = 26;

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
  layout,
  onLayoutChange,
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
  onOpenPromptChunks,
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

  const caps = modelCapabilities(model);
  const stacked = layout === 'stacked';
  const showPositive = stacked || activeTab === 'prompt';

  // Anime⇄Furry:V5 取消了独立的 furry 模型,改成往提示词最前面加 `fur dataset`。
  // 能力位关着就整个不出现(V4 系有独立的 furry 模型,不走这条路)。
  const furry = useMemo(
    () =>
      caps.furryMode
        ? {
          on: isFurryDatasetOn(positivePrompt),
          onToggle: () => onPositivePromptChange(toggleFurryDataset(positivePrompt)),
        }
        : null,
    [caps.furryMode, positivePrompt, onPositivePromptChange],
  );

  // V5 文字渲染体检:只在能力位打开的家族下跑,只提示不改写输入。
  const textRenderEnabled = caps.textRendering;
  const textRenderHints = useMemo(
    () => (textRenderEnabled && showPositive ? detectTextRenderHints(positivePrompt) : []),
    [textRenderEnabled, showPositive, positivePrompt],
  );

  return (
    <div className="bg-nai-input rounded-lg border border-gray-800 p-1 relative group/prompt-container" ref={promptAreaRef}>
      <PromptToolbar
        activeTab={activeTab}
        onActiveTabChange={onActiveTabChange}
        showTabs={!stacked}
        furry={furry}
        aiModel={aiModel}
        localPrimaryModel={agentModel.isLocal ? (agentModel.primaryModel ?? '') : null}
        onAiModelChange={setAiModel}
        onOpenInspiration={onOpenInspiration}
        onOpenTagManager={onOpenTagManager}
        onOpenPromptChunks={onOpenPromptChunks}
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
          {stacked ? (
            /* 堆叠:提示在上占剩余高度,排除固定一段在下;整框高度仍由底部把手拖。
               自动撑高只看提示那栏,加上排除那段的固定高度。 */
            <div className="absolute inset-0 flex flex-col" data-testid="prompt-stacked">
              <div className="relative flex-1 min-h-0">
                <PromptPane
                  visible
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
                  suppressAutocompleteInQuotes={textRenderEnabled}
                  onContentHeightChange={(height) => onPromptContentHeightChange(height + STACKED_NEGATIVE_HEIGHT)}
                />
              </div>
              <div className="shrink-0 flex items-center gap-1.5 px-2 py-1 border-t border-gray-700/50 text-[11px] font-bold text-red-400/80 select-none">
                <Ban className="w-3.5 h-3.5" />
                排除
              </div>
              <div className="relative shrink-0" style={{ height: `${STACKED_NEGATIVE_HEIGHT - STACKED_NEGATIVE_LABEL_HEIGHT}px` }}>
                <PromptPane
                  visible
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
                />
              </div>
            </div>
          ) : (
            <>
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
                suppressAutocompleteInQuotes={textRenderEnabled}
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
            </>
          )}
        </div>
      </div>

      {showPositive && (
        <V5TogglePanel model={model} prompt={positivePrompt} onPromptChange={onPositivePromptChange} />
      )}

      <TextRenderHintBar hints={textRenderHints} />

      <div className="px-2 pt-2 pb-1.5 flex items-center justify-between gap-2 border-t border-transparent">
        <ChipModeToggle chipMode={chipMode} onChange={onChipModeChange} />
        <PromptLayoutToggle layout={layout} onChange={onLayoutChange} />
        <TokenMeter maxTokens={maxTokens} totalTokenCount={totalTokenCount} />
        {/* 不再挂「Agent 未启用」的灰字:右边那颗按钮本来就是禁用态,
            原因写在它的 tooltip 里,重复一遍只是占地方(用户 2026-09-21)。 */}
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
