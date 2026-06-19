import React from 'react';
import { Bot, ChevronDown, CornerDownLeft, RotateCcw } from 'lucide-react';
import { agentService, type AgentState } from '../../../services/agentService';
import { AssistantEmptySuggestions } from './AssistantEmptySuggestions';
import { TypewriterText, renderMessageContent } from './AssistantMessageParts';

type PromptSnapshot = {
  positive: string;
  negative: string;
  characters: { positive: string; negative?: string; name?: string }[];
};

interface AssistantLogListProps {
  logRef: React.RefObject<HTMLDivElement | null>;
  agentState: AgentState;
  suggestions: string[];
  isGeneratingPrompt: boolean;
  thinkingText: string;
  onAIGenerate: (request: string) => void;
  onAIRegenerate?: (request: string, preState: PromptSnapshot) => void;
  onRestoreSnapshot?: (snapshot: PromptSnapshot & { vibes: string[] }) => void;
}

export const AssistantLogList: React.FC<AssistantLogListProps> = ({
  logRef,
  agentState,
  suggestions,
  isGeneratingPrompt,
  thinkingText,
  onAIGenerate,
  onAIRegenerate,
  onRestoreSnapshot,
}) => (
  <div
    ref={logRef}
    className="flex-1 overflow-y-auto custom-scrollbar p-4 flex flex-col gap-2 min-h-0 bg-black/40"
  >
    {agentState.logs.length === 0 ? (
      <AssistantEmptySuggestions
        suggestions={suggestions}
        onSelect={onAIGenerate}
      />
    ) : (
      agentState.logs.map((log, idx) => {
        if (log.collapsed) return null;

        const successLogs = agentState.logs.filter(
          (entry) => entry.type === 'success' && entry.snapshot
        );
        const isLastSuccess =
          log.type === 'success' &&
          log.snapshot &&
          successLogs.indexOf(log) === successLogs.length - 1;

        if (log.type === 'success' && log.snapshot) {
          const snapshot = log.snapshot;

          return (
            <div key={idx} className="animate-slide-in-from-bottom shrink-0 w-full">
              <div
                className={`text-sm px-3 py-2.5 bg-[#232736] text-gray-200 border border-[#2c3144]/50 shadow-sm flex items-start justify-between gap-2 cursor-pointer ${
                  log.expanded && log.thinking ? 'rounded-t-xl' : 'rounded-xl'
                }`}
                onClick={() => agentService.toggleLogExpanded(idx)}
              >
                <div className="flex flex-col gap-1.5 flex-1 min-w-0 mt-0.5">
                  <span className="whitespace-pre-wrap break-words">{renderMessageContent(log.content, false)}</span>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (isLastSuccess) {
                      const userRequest = agentService.truncateToUserRequest(idx);
                      if (userRequest && onAIRegenerate) {
                        onAIRegenerate(userRequest.request, {
                          positive: snapshot.prePositive,
                          negative: snapshot.preNegative,
                          characters: snapshot.preCharacters,
                        });
                      }
                    } else if (onRestoreSnapshot) {
                      onRestoreSnapshot({
                        positive: snapshot.positive,
                        negative: snapshot.negative,
                        characters: snapshot.characters,
                        vibes: snapshot.vibes,
                      });
                      agentService.truncateLogsTo(idx);
                    }
                  }}
                  className="p-1 text-nai-accent/60 hover:text-nai-accent hover:bg-nai-accent/30 rounded transition-colors shrink-0 mt-0.5"
                  title={isLastSuccess ? '重新生成' : '回退到此版本'}
                >
                  {isLastSuccess ? (
                    <RotateCcw className="w-4 h-4" />
                  ) : (
                    <CornerDownLeft className="w-4 h-4" />
                  )}
                </button>
              </div>
              {log.expanded && log.thinking && (
                <div className="text-[10px] px-3 py-2 rounded-b-xl bg-[#1a1c23] text-nai-accent/60 tracking-wider flex items-center border-t border-[#2c3144]">
                  <ChevronDown className="w-3.5 h-3.5 shrink-0 mr-1" />
                  <span className="truncate">{log.thinking}</span>
                </div>
              )}
            </div>
          );
        }

        if (log.type === 'error') {
          return (
            <div
              key={idx}
              className="px-3 py-2.5 rounded-xl animate-slide-in-from-bottom bg-[#232736] border border-red-500/30 flex flex-col gap-2 shrink-0 w-full"
            >
              <div className="text-[13px] font-mono whitespace-pre-wrap break-words text-red-400 overflow-x-auto custom-scrollbar opacity-90 pb-1">
                {log.content}
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  const userRequest = agentService.truncateToUserRequest(idx);
                  if (userRequest) {
                    onAIGenerate(userRequest.request);
                  }
                }}
                className="px-3 py-1.5 flex items-center justify-center gap-1.5 text-xs font-bold text-red-300 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 rounded-lg transition-colors w-full"
              >
                <RotateCcw className="w-3 h-3" />
                重新生成
              </button>
            </div>
          );
        }

        return (
          <div
            key={idx}
            className={`text-sm px-3 py-2 rounded-xl animate-slide-in-from-bottom shrink-0 ${
              log.type === 'user'
                ? 'bg-nai-accent text-black font-medium self-end max-w-[90%]'
                : 'bg-[#232736] text-gray-300 border border-[#2c3144] self-start max-w-[90%]'
            }`}
          >
            <span className="whitespace-pre-wrap break-words">{renderMessageContent(log.content, log.type === 'user')}</span>
          </div>
        );
      })
    )}
    {isGeneratingPrompt && (
      <div className="text-sm px-3 py-2.5 rounded-xl bg-[#232736] border border-[#2c3144] text-gray-300 animate-fade-in self-start max-w-[85%] shrink-0 flex items-center gap-2">
        <Bot className="w-4 h-4 text-nai-accent animate-pulse shrink-0" />
        <span className="text-[14px] text-gray-300 font-medium leading-relaxed tracking-wide min-h-[22px] flex items-center animate-pulse">
          <TypewriterText text={agentState.progress || thinkingText} />
        </span>
      </div>
    )}
  </div>
);
