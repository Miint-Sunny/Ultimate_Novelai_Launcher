import type { RefObject } from 'react';
import { AlignLeft, Ban, Bot, Grid, Loader2, Puzzle, Settings, Sparkles, Tags, X } from 'lucide-react';
import PromptEditor from '../PromptEditor';
import type { CollapsibleTag, PromptEditorRef } from '../PromptEditor';
import { DesktopChipEditor } from '../DesktopChipEditor';
import { AI_MODEL_CHOICES } from '../../services/agentService';
import { TranslationOverlay } from './TranslationOverlay';

export type ActiveTab = 'prompt' | 'undesired' | 'ai';
export type TranslationType = 'positive' | 'negative';

export type TranslationCache = {
  positive: Map<string, string>;
  negative: Map<string, string>;
  cachedPositive: string;
  cachedNegative: string;
};

export function PromptToolbar({
  activeTab,
  onActiveTabChange,
  aiModel,
  localPrimaryModel,
  onAiModelChange,
  onOpenInspiration,
  onOpenTagManager,
  onOpenPromptChunks,
  onOpenPresetModal,
  furry,
}: {
  activeTab: ActiveTab;
  onActiveTabChange: (tab: ActiveTab) => void;
  /** Anime⇄Furry 开关。null = 当前模型没这一位,整个控件不出现。 */
  furry: { on: boolean; onToggle: () => void } | null;
  aiModel: string;
  localPrimaryModel: string | null;
  onAiModelChange: (model: string) => void;
  onOpenInspiration: () => void;
  onOpenTagManager: () => void;
  onOpenPromptChunks: () => void;
  onOpenPresetModal: () => void;
}) {
  return (
    <div className="flex items-center justify-between px-2 pt-1 pb-2 border-b border-gray-700/50 gap-3 relative overflow-hidden">
      <div className="flex-1 relative h-10 overflow-hidden">
        <div className="absolute inset-0 flex items-center justify-between gap-3 transition-all duration-300 ease-out translate-x-0 opacity-100">
          <div className="flex items-center gap-2 h-full min-w-0 flex-1">
          {/* 胶囊可压缩:侧栏最窄 400px 时,挤不下要让它变窄,而不是整行重叠。
              里面的滑块是百分比定位,跟着宽度走没问题。 */}
          <div className="relative flex items-center bg-black/40 rounded-full p-1 border border-gray-700/50 w-full max-w-[200px] min-w-[132px] h-full select-none">
            <div className={`absolute top-1 bottom-1 rounded-full transition-all duration-300 ease-out shadow-sm ${activeTab === 'prompt' ? 'left-1 w-[calc(50%-6px)] bg-nai-accent shadow-[0_0_8px_rgba(235,213,118,0.4)]' : 'left-[calc(50%+2px)] w-[calc(50%-6px)] bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.4)]'}`} />
            <div
              className={`relative z-10 w-1/2 flex items-center justify-center gap-1.5 text-sm font-bold transition-colors duration-200 cursor-pointer ${activeTab === 'prompt' ? 'text-black' : 'text-gray-500 hover:text-gray-400'}`}
              onClick={() => onActiveTabChange('prompt')}
            >
              <Sparkles className="w-4 h-4" />
              提示
            </div>
            <div
              className={`relative z-10 w-1/2 flex items-center justify-center gap-1.5 text-sm font-bold transition-colors duration-200 cursor-pointer ${activeTab === 'undesired' ? 'text-white' : 'text-gray-500 hover:text-gray-400'}`}
              onClick={() => onActiveTabChange('undesired')}
            >
              <Ban className="w-4 h-4" />
              排除
            </div>
          </div>

          {/* Anime⇄Furry。V5 取消了独立的 furry 模型,改成往提示词最前面加
              `fur dataset` —— 所以它挨着提示词/排除放,而不是塞进模型选择器。
              显示的是**当前**数据集,点一下切换;做成单按钮而不是双段,是因为
              侧栏最窄 400px,双段会和右边那组图标撞上。 */}
          {furry && (
            <button
              type="button"
              aria-pressed={furry.on}
              aria-label={`数据集:${furry.on ? 'Furry' : 'Anime'}`}
              onClick={furry.onToggle}
              title={
                furry.on
                  ? 'Furry 数据集(提示词最前面有 fur dataset)。点击切回 Anime'
                  : 'Anime 数据集。点击切到 Furry —— 会把 fur dataset 加到提示词最前面'
              }
              className={`px-2.5 h-8 rounded-full text-[11px] font-bold border transition-colors shrink-0 ${
                furry.on
                  ? 'bg-nai-accent text-black border-nai-accent'
                  : 'bg-black/40 text-gray-400 border-gray-700/50 hover:text-white hover:border-gray-600'
              }`}
            >
              {furry.on ? 'Furry' : 'Anime'}
            </button>
          )}
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            <button className="relative group p-1.5" title="魔法" onClick={onOpenInspiration}>
              <div className="bg-gradient-to-r from-nai-accent to-amber-300 rounded-lg p-1 text-black shadow-sm ring-1 ring-white/20 group-hover:ring-white/50 group-hover:scale-110 transition-transform">
                <Sparkles className="w-4 h-4" />
              </div>
            </button>
            <button className="text-gray-400 hover:text-white transition-colors" onClick={onOpenTagManager} title="Tag 管理器 (统一: 角色 / 画风 / 场景)">
              <Tags className="w-5 h-5" />
            </button>
            <button className="text-gray-400 hover:text-white transition-colors" onClick={onOpenPromptChunks} title="提示词片段 (提示词里打 @ 插入)">
              <Puzzle className="w-5 h-5" />
            </button>
            <button className="text-gray-400 hover:text-white transition-colors" onClick={onOpenPresetModal} title="预设设置">
              <Settings className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="absolute inset-0 hidden items-center justify-between gap-2 transition-all duration-300 ease-out">
          <div className="flex items-center justify-between bg-nai-accent rounded-full p-1 border border-nai-accent shrink-0">
            <div className="flex items-center gap-2 pl-3">
              <Bot className="w-5 h-5 text-black" />
              <span className="text-sm font-bold text-black">NovelAI Agent</span>
            </div>
            <button
              onClick={() => onActiveTabChange('prompt')}
              className="p-1.5 ml-4 mr-1 text-black/60 hover:text-black bg-black/10 hover:bg-black/20 rounded-full transition-colors"
              title="退出"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex items-center gap-2">
            {localPrimaryModel !== null ? (
              <span
                role="status"
                title={`本地 sidecar 主模型：${localPrimaryModel || '未配置'}`}
                className="h-8 max-w-[190px] px-3 inline-flex items-center gap-1.5 text-xs font-bold rounded bg-black/40 border border-gray-700/50 text-white"
              >
                <span className="shrink-0">本地主模型</span>
                <span className="text-gray-400 truncate">· {localPrimaryModel || '未配置'}</span>
              </span>
            ) : (
              <select
                value={aiModel}
                onChange={(event) => onAiModelChange(event.target.value)}
                className="h-8 pl-3 pr-6 text-xs font-bold rounded bg-black/40 border border-gray-700/50 text-white cursor-pointer outline-none hover:border-gray-600 transition-colors appearance-none bg-[url('data:image/svg+xml;charset=UTF-8,%3csvg%20xmlns%3d%22http%3a%2f%2fwww.w3.org%2f2000%2fsvg%22%20width%3d%2212%22%20height%3d%2212%22%20viewBox%3d%220%200%2012%2012%22%3e%3cpath%20fill%3d%22%239ca3af%22%20d%3d%22M2%204l4%204%204-4%22%2f%3e%3c%2fsvg%3e')] bg-no-repeat bg-[right_8px_center]"
              >
                {AI_MODEL_CHOICES.map((choice) => (
                  <option key={choice.key} value={choice.key}>{choice.label}</option>
                ))}
              </select>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function PromptPane({
  visible,
  direction,
  promptType,
  value,
  onChange,
  chipMode,
  showTranslation,
  translationCache,
  onCloseTranslation,
  onTranslationTagClick,
  editorRef,
  onTagsChange,
  disableCollapsibleTags,
  onContentHeightChange,
  suppressAutocompleteInQuotes = false,
}: {
  visible: boolean;
  direction: 'left' | 'right';
  promptType: TranslationType;
  value: string;
  onChange: (value: string) => void;
  chipMode: boolean;
  showTranslation: boolean;
  translationCache: TranslationCache;
  onCloseTranslation: () => void;
  onTranslationTagClick: (startIndex: number, length: number, type: TranslationType) => void;
  editorRef: RefObject<PromptEditorRef | null>;
  onTagsChange?: (tags: CollapsibleTag[]) => void;
  disableCollapsibleTags?: boolean;
  onContentHeightChange?: (height: number) => void;
  /**
   * V5 文字渲染:光标落在未闭合引号内时不弹 Danbooru 补全
   * (引号在 V5 是「画进图里的文字」,弹 tag 补全是错误引导)。
   */
  suppressAutocompleteInQuotes?: boolean;
}) {
  const hiddenClass = direction === 'left' ? '-translate-x-full' : 'translate-x-full';
  const editorType = promptType === 'positive' ? 'prompt' : 'undesired';
  const placeholder = promptType === 'positive' ? '在此输入提示词...' : '在此输入排除内容...';

  return (
    <div className={`transition-all duration-300 ease-in-out absolute inset-0 ${visible ? 'translate-x-0 opacity-100' : `${hiddenClass} opacity-0 pointer-events-none`}`}>
      {showTranslation && (
        <TranslationOverlay
          text={value}
          type={promptType}
          translationCache={translationCache}
          onClose={onCloseTranslation}
          onTagClick={onTranslationTagClick}
        />
      )}
      {chipMode ? (
        <DesktopChipEditor
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          className={`w-full h-full ${showTranslation ? 'opacity-0' : ''}`}
          type={editorType}
          onContentHeightChange={onContentHeightChange}
          suppressAutocompleteInQuotes={suppressAutocompleteInQuotes}
        />
      ) : (
        <PromptEditor
          ref={editorRef}
          disableCollapsibleTags={disableCollapsibleTags}
          containerClassName={`w-full h-full ${showTranslation ? 'opacity-0' : ''}`}
          className={`bg-transparent text-white p-2 outline-none resize-none text-sm font-tag ${promptType === 'positive' ? 'pr-6' : ''}`}
          value={value}
          onChange={onChange}
          onTagsChange={onTagsChange}
          placeholder={placeholder}
          onContentHeightChange={onContentHeightChange}
          suppressAutocompleteInQuotes={suppressAutocompleteInQuotes}
        />
      )}
    </div>
  );
}

export function TokenMeter({
  totalTokenCount,
  maxTokens,
}: {
  totalTokenCount: number;
  /** 当前模型的 token 软阈值(V4 系 512 / V5 Full 1471 / V5 Curated 703)。 */
  maxTokens: number;
}) {
  return (
    <div className="flex-1 relative cursor-help h-[24px] bg-gray-800/80 rounded-full shadow-inner border border-gray-700/50 flex items-center justify-end px-3 overflow-hidden">
      <div
        className={`absolute left-0 top-0 bottom-0 transition-all duration-500 ease-out ${totalTokenCount > maxTokens ? 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.8)] animate-pulse' : 'bg-nai-accent shadow-[0_0_8px_rgba(252,237,164,0.4)]'}`}
        style={{ width: `${Math.min((totalTokenCount / maxTokens) * 100, 100)}%` }}
      />
      <div className={`relative z-10 text-xs font-mono tracking-wide drop-shadow-sm ${totalTokenCount > maxTokens ? 'text-white font-bold drop-shadow' : 'text-gray-500 font-semibold'}`}>
        {totalTokenCount} <span className={`text-[10px] ${totalTokenCount > maxTokens ? 'text-gray-300' : 'text-gray-500'}`}>/ {maxTokens}</span>
      </div>
    </div>
  );
}

export function ChipModeToggle({ chipMode, onChange }: { chipMode: boolean; onChange: (enabled: boolean) => void }) {
  return (
    <button
      className="p-1.5 -ml-1.5 rounded-lg transition-colors hover:bg-white/10 text-gray-400 hover:text-white flex items-center justify-center shrink-0"
      onClick={() => onChange(!chipMode)}
      title={chipMode ? '切换到文本编辑器' : '切换到芯片布局'}
    >
      {chipMode ? <AlignLeft className="w-[22px] h-[22px]" /> : <Grid className="w-[22px] h-[22px]" />}
    </button>
  );
}

export function FloatingAgentButton({
  isOpen,
  isGenerating,
  disabled = false,
  disabledReason,
  onClick,
}: {
  isOpen: boolean;
  isGenerating: boolean;
  disabled?: boolean;
  disabledReason?: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={disabled ? `AI 助手不可用：${disabledReason || '当前后端不支持'}` : 'AI 助手'}
      className={`relative p-1.5 -mr-1.5 rounded-lg transition-colors shrink-0 flex items-center justify-center ${disabled ? 'text-gray-600 cursor-not-allowed' : isOpen ? 'bg-nai-accent/20 text-nai-accent' : isGenerating ? 'text-nai-accent bg-nai-accent/10 shadow-[0_0_0_1px_rgba(252,237,164,0.18)]' : 'text-gray-400 hover:text-white hover:bg-white/10'}`}
      disabled={disabled}
      onClick={onClick}
      title={disabled ? disabledReason : isOpen ? '关闭AI助手' : isGenerating ? 'AI 正在思考，点击查看' : '唤起AI助手'}
    >
      <Bot className="w-[22px] h-[22px]" />
      {isGenerating && !isOpen && (
        <span className="absolute -right-1 -top-1 w-4 h-4 rounded-full bg-nai-panel border border-nai-accent/50 flex items-center justify-center shadow-[0_0_10px_rgba(252,237,164,0.35)]">
          <Loader2 className="w-2.5 h-2.5 text-nai-accent animate-spin" />
        </span>
      )}
    </button>
  );
}
