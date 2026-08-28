import {
  Bot,
  Brush,
  ChevronRight,
  Languages,
  Lightbulb,
  Loader2,
  User,
  X,
} from 'lucide-react';
import { appBackendApi } from '../../api/appBackendApi';
import { renderPromptSummary, PromptToolButton } from './prompt-summary/PromptSummaryParts';
import { V5TogglePanel } from '../left-sidebar/V5TogglePanel';

interface MobilePromptSummaryCardProps {
  /** 当前模型 id。开关词条面板按它的能力位决定出不出现。 */
  model: string;
  positivePrompt: string;
  setPositivePrompt: (prompt: string) => void;
  negativePrompt: string;
  setNegativePrompt: (prompt: string) => void;
  positiveTokens: number;
  negativeTokens: number;
  /** 当前模型的 token 软阈值。 */
  maxTokens: number;
  openPromptEditor: () => void;
  openNegativeEditor: () => void;
  openAIAssistant: () => void;
  openArtistModal: () => void;
  openInspirationModal: () => void;
  openOCModal: () => void;
  hasChinesePrompt: boolean;
  isTranslating: boolean;
  onTranslate: () => void;
}

export function MobilePromptSummaryCard({
  model,
  positivePrompt,
  setPositivePrompt,
  negativePrompt,
  setNegativePrompt,
  positiveTokens,
  negativeTokens,
  maxTokens,
  openPromptEditor,
  openNegativeEditor,
  openAIAssistant,
  openArtistModal,
  openInspirationModal,
  openOCModal,
  hasChinesePrompt,
  isTranslating,
  onTranslate,
}: MobilePromptSummaryCardProps) {
  const agentAvailability = appBackendApi.desktopAgentAvailability();

  return (
    <>
      <div className="bg-nai-input rounded-xl border border-gray-700/50 overflow-hidden shadow-lg">
        <div className="w-full text-left p-3 border-b border-gray-700/30">
          <div className="flex items-center justify-between mb-2">
            <div
              className="flex items-center gap-2 flex-1 cursor-pointer"
              onClick={openPromptEditor}
            >
              <div className="w-2 h-2 rounded-full bg-nai-accent shadow-[0_0_8px_rgba(235,213,118,0.5)]" />
              <span className="text-sm font-bold text-nai-accent">提示词</span>
              <span className={`text-xs font-mono ${positiveTokens > maxTokens ? 'text-red-400' : 'text-gray-500'}`}>
                {positiveTokens}/{maxTokens}
              </span>
            </div>
            <div className="flex items-center gap-1">
              {positivePrompt && (
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    setPositivePrompt('');
                  }}
                  className="p-1.5 text-gray-500 hover:text-red-400 active:scale-95 transition-all rounded-lg"
                  title="清空"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
              <ChevronRight
                className="w-5 h-5 text-gray-500 cursor-pointer"
                onClick={openPromptEditor}
              />
            </div>
          </div>
          <div
            className={`text-sm leading-relaxed line-clamp-3 cursor-pointer active:bg-gray-800/50 -mx-3 -mb-3 px-3 pb-3 pt-1 transition-colors ${positivePrompt ? 'text-gray-300' : 'text-gray-600'}`}
            onClick={openPromptEditor}
          >
            {positivePrompt ? renderPromptSummary(positivePrompt) : '点击输入提示词...'}
          </div>
          <div className="-mx-3 -mb-3 mt-2 border-t border-gray-700/30 pt-1">
            <V5TogglePanel model={model} prompt={positivePrompt} onPromptChange={setPositivePrompt} touch />
          </div>
        </div>

        <div className="w-full text-left p-3 border-b border-gray-700/30">
          <div className="flex items-center justify-between mb-2">
            <div
              className="flex items-center gap-2 flex-1 cursor-pointer"
              onClick={openNegativeEditor}
            >
              <div className="w-2 h-2 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)]" />
              <span className="text-sm font-bold text-red-400">排除内容</span>
              <span className={`text-xs font-mono ${negativeTokens > maxTokens ? 'text-red-400' : 'text-gray-500'}`}>
                {negativeTokens}/{maxTokens}
              </span>
            </div>
            <div className="flex items-center gap-1">
              {negativePrompt && (
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    setNegativePrompt('');
                  }}
                  className="p-1.5 text-gray-500 hover:text-red-400 active:scale-95 transition-all rounded-lg"
                  title="清空"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
              <ChevronRight
                className="w-5 h-5 text-gray-500 cursor-pointer"
                onClick={openNegativeEditor}
              />
            </div>
          </div>
          <div
            className={`text-sm leading-relaxed line-clamp-2 cursor-pointer active:bg-gray-800/50 -mx-3 -mb-3 px-3 pb-3 pt-1 transition-colors ${negativePrompt ? 'text-gray-300' : 'text-gray-600'}`}
            onClick={openNegativeEditor}
          >
            {negativePrompt || '点击输入排除内容...'}
          </div>
        </div>

        <div className="flex items-center gap-2 px-3 py-2">
          <PromptToolButton
            label="AI助手"
            tone="purple"
            onClick={openAIAssistant}
            icon={<Bot className="w-3.5 h-3.5" />}
            disabled={!agentAvailability.available}
            title={agentAvailability.reason}
          />
          <PromptToolButton label="画师串" tone="amber" onClick={openArtistModal} icon={<Brush className="w-3.5 h-3.5" />} />
          <PromptToolButton label="灵感" tone="pink" onClick={openInspirationModal} icon={<Lightbulb className="w-3.5 h-3.5" />} />
          <PromptToolButton label="OC" tone="cyan" onClick={openOCModal} icon={<User className="w-3.5 h-3.5" />} />
        </div>
        {!agentAvailability.available && (
          <p className="border-t border-gray-700/30 px-3 py-2 text-[11px] leading-4 text-gray-500">
            {agentAvailability.reason}
          </p>
        )}
      </div>

      {hasChinesePrompt && (
        <button
          onClick={onTranslate}
          disabled={isTranslating}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-500/20 text-blue-400 rounded-xl active:scale-[0.98] transition-all disabled:opacity-50"
        >
          {isTranslating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Languages className="w-4 h-4" />}
          <span className="text-sm font-medium">{isTranslating ? '翻译中...' : '翻译中文'}</span>
        </button>
      )}
    </>
  );
}
