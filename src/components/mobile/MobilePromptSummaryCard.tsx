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
import type { ReactNode } from 'react';
import {
  NEWLINE_SENTINEL,
  parseCollapsibleMarker,
  splitPromptToTags,
} from '../../utils/promptTags';
import { getMarkerVisual } from '../tag-manager/markerVisual';

interface MobilePromptSummaryCardProps {
  positivePrompt: string;
  setPositivePrompt: (prompt: string) => void;
  negativePrompt: string;
  setNegativePrompt: (prompt: string) => void;
  positiveTokens: number;
  negativeTokens: number;
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
  positivePrompt,
  setPositivePrompt,
  negativePrompt,
  setNegativePrompt,
  positiveTokens,
  negativeTokens,
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
              <span className={`text-xs font-mono ${positiveTokens > 512 ? 'text-red-400' : 'text-gray-500'}`}>
                {positiveTokens}/512
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
        </div>

        <div className="w-full text-left p-3 border-b border-gray-700/30">
          <div className="flex items-center justify-between mb-2">
            <div
              className="flex items-center gap-2 flex-1 cursor-pointer"
              onClick={openNegativeEditor}
            >
              <div className="w-2 h-2 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)]" />
              <span className="text-sm font-bold text-red-400">排除内容</span>
              <span className={`text-xs font-mono ${negativeTokens > 512 ? 'text-red-400' : 'text-gray-500'}`}>
                {negativeTokens}/512
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
          <PromptToolButton label="AI助手" tone="purple" onClick={openAIAssistant} icon={<Bot className="w-3.5 h-3.5" />} />
          <PromptToolButton label="画师串" tone="amber" onClick={openArtistModal} icon={<Brush className="w-3.5 h-3.5" />} />
          <PromptToolButton label="灵感" tone="pink" onClick={openInspirationModal} icon={<Lightbulb className="w-3.5 h-3.5" />} />
          <PromptToolButton label="OC" tone="cyan" onClick={openOCModal} icon={<User className="w-3.5 h-3.5" />} />
        </div>
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

function renderPromptSummary(prompt: string) {
  return splitPromptToTags(prompt)
    .filter((tag) => tag !== NEWLINE_SENTINEL)
    .map((tag) => {
      const marker = parseCollapsibleMarker(tag);
      return marker ? `[${getMarkerVisual(marker.type).label}·${marker.name}]` : tag;
    })
    .join(', ');
}

interface PromptToolButtonProps {
  label: string;
  tone: 'purple' | 'amber' | 'pink' | 'cyan';
  icon: ReactNode;
  onClick: () => void;
}

function PromptToolButton({ label, tone, icon, onClick }: PromptToolButtonProps) {
  const toneClass = {
    purple: 'bg-purple-500/15 text-purple-400 active:bg-purple-500/25',
    amber: 'bg-amber-500/15 text-amber-400 active:bg-amber-500/25',
    pink: 'bg-pink-500/15 text-pink-400 active:bg-pink-500/25',
    cyan: 'bg-cyan-500/15 text-cyan-400 active:bg-cyan-500/25',
  }[tone];

  return (
    <button
      onClick={onClick}
      className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg transition-colors ${toneClass}`}
    >
      {icon}
      <span className="text-xs font-medium">{label}</span>
    </button>
  );
}
