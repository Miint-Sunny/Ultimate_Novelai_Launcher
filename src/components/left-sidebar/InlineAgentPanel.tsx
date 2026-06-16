import type { Dispatch, RefObject, SetStateAction } from 'react';
import { Bot, ChevronDown, CornerDownLeft, Loader2, RotateCcw, Send, Trash2 } from 'lucide-react';
import type { AgentState, GenerationSnapshot } from '../../services/agentService';

interface InlineAgentPanelProps {
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
  onClearAll: () => void;
}

export function InlineAgentPanel({
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
  onClearAll,
}: InlineAgentPanelProps) {
  return (
    <div className={`transition-all duration-300 ease-in-out absolute inset-0 flex flex-col ${'hidden'}`}>
      <div
        ref={aiLogScrollRef}
        className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-2 space-y-1.5"
      >
        {agentState.logs.length === 0 ? (
          <div className="h-full flex items-center justify-center text-gray-500">
            <div className="text-center">
              <Bot className="w-12 h-12 mx-auto mb-3 opacity-50" />
              <p className="text-sm">描述你想要的画面</p>
              <p className="text-gray-600 text-xs mt-1.5">支持引用画师串/Vibe/OC名称</p>
            </div>
          </div>
        ) : (
          agentState.logs.map((log, index) => {
            if (log.collapsed) return null;

            const successLogs = agentState.logs.filter((candidate) => candidate.type === 'success' && candidate.snapshot);
            const isLastSuccess = log.type === 'success' && log.snapshot &&
              successLogs.indexOf(log) === successLogs.length - 1;

            if (log.type === 'success' && log.snapshot) {
              return (
                <div key={index} className="animate-slide-in-from-bottom">
                  <div
                    className={`text-xs px-2 py-1.5 bg-nai-accent/20 text-nai-accent flex items-start justify-between gap-2 cursor-pointer hover:bg-nai-accent/30 transition-colors ${log.expanded && log.thinking ? 'rounded-t' : 'rounded'}`}
                    onClick={() => onToggleLogExpanded(index)}
                  >
                    <div className="flex flex-col gap-1.5 flex-1 min-w-0 mt-0.5">
                      <span className="whitespace-pre-wrap break-words">{log.content}</span>
                    </div>
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        if (log.snapshot) onSuccessLogAction(index, log.snapshot, !!isLastSuccess);
                      }}
                      className="p-0.5 text-nai-accent/60 hover:text-nai-accent hover:bg-nai-accent/30 rounded transition-colors shrink-0 mt-0.5"
                      title={isLastSuccess ? '重新生成' : '回退到此版本'}
                    >
                      {isLastSuccess ? (
                        <RotateCcw className="w-3 h-3" />
                      ) : (
                        <CornerDownLeft className="w-3 h-3" />
                      )}
                    </button>
                  </div>
                  {log.expanded && log.thinking && (
                    <div className="text-[10px] px-2 py-1 rounded-b bg-black/20 text-nai-accent/60 flex items-center gap-1 border-t border-nai-accent/10">
                      <ChevronDown className="w-3 h-3 shrink-0" />
                      <span className="truncate">{log.thinking}</span>
                    </div>
                  )}
                </div>
              );
            }

            if (log.type === 'error') {
              return (
                <div
                  key={index}
                  className="text-xs px-2 py-1 rounded animate-slide-in-from-bottom bg-red-500/20 text-red-400 flex items-center justify-between gap-2"
                >
                  <span className="break-words flex-1">{log.content}</span>
                  <button
                    onClick={() => onErrorLogRetry(index)}
                    className="p-0.5 text-red-400/60 hover:text-red-400 hover:bg-red-500/30 rounded transition-colors shrink-0"
                    title="重试"
                  >
                    <RotateCcw className="w-3 h-3" />
                  </button>
                </div>
              );
            }

            return (
              <div
                key={index}
                className={`text-xs px-2 py-1 rounded animate-slide-in-from-bottom ${log.type === 'user'
                  ? 'bg-nai-accent/20 text-nai-accent'
                  : 'bg-gray-700/50 text-gray-400'
                }`}
              >
                {log.type === 'user' && <span className="font-bold mr-1">▶</span>}
                {log.type === 'system' && <span className="mr-1">•</span>}
                <span className="break-words">{log.content}</span>
              </div>
            );
          })
        )}

        {isGeneratingPrompt && (
          <div className="text-xs px-2 py-1 rounded bg-gray-700/50 text-gray-400 animate-fade-in">
            <div className="flex items-center gap-2">
              <Loader2 className="w-3 h-3 animate-spin" />
              <span>{agentState.progress || '思考中...'}</span>
            </div>
          </div>
        )}
      </div>

      <div className="shrink-0">
        <div className="flex items-end gap-2 p-1.5">
          <textarea
            ref={aiInputRef}
            value={aiInputPrompt}
            onChange={(event) => {
              setAiInputPrompt(event.target.value);
              const target = event.target;
              target.style.height = 'auto';
              const lineHeight = 24;
              const maxHeight = lineHeight * 3;
              target.style.height = Math.min(target.scrollHeight, maxHeight) + 'px';
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && aiInputPrompt.trim() && !isGeneratingPrompt) {
                event.preventDefault();
                onAIGenerate();
              }
            }}
            rows={1}
            className="flex-1 bg-gray-800 text-white px-3 py-1.5 outline-none resize-none text-sm rounded-md placeholder:text-gray-500 custom-scrollbar"
            style={{ minHeight: '32px', maxHeight: '72px' }}
            placeholder="输入你的需求..."
            disabled={isGeneratingPrompt}
          />
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={onAIGenerate}
              disabled={!aiInputPrompt.trim() || isGeneratingPrompt}
              className="w-8 h-8 flex items-center justify-center bg-nai-accent hover:bg-nai-accent/90 text-black rounded-md transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              title="发送"
            >
              {isGeneratingPrompt ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
            </button>
            <div className={`overflow-hidden transition-all duration-300 ease-out ${agentState.logs.length > 0 ? 'w-8 opacity-100' : 'w-0 opacity-0'}`}>
              <button
                onClick={onClearAll}
                disabled={isGeneratingPrompt}
                className="w-8 h-8 flex items-center justify-center text-red-400 bg-red-500/10 hover:bg-red-500/20 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                title="清空所有提示词"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
