import React, { useState, useRef, useEffect, useMemo } from 'react';
import {
  X,
  Bot,
  Send,
  Loader2,
  ChevronDown,
  RotateCcw,
  CornerDownLeft,
  Wrench,
  Maximize2,
  Minimize2,
  Trash2,
  Sparkles,
} from 'lucide-react';
import {
  agentService,
  type AgentState,
  KNOWLEDGE_SOURCES,
  AI_MODEL_CHOICES,
} from '../../services/agentService';

interface MobileAIAssistantSheetProps {
  isOpen: boolean;
  onClose: () => void;
  aiModel: string;
  onAiModelChange: (model: string) => void;
  agentState: AgentState;
  isGeneratingPrompt: boolean;
  onAIGenerate: (request: string) => void;
  onAIRegenerate?: (
    request: string,
    preState: { positive: string; negative: string; characters: { positive: string; negative?: string; name?: string }[] }
  ) => void;
  onRestoreSnapshot?: (snapshot: {
    positive: string;
    negative: string;
    characters: { positive: string; negative?: string; name?: string }[];
    vibes: string[];
  }) => void;
}

const SUGGESTIONS = [
  "帮我画一只白发红瞳的傲娇猫娘",
  "给我抽一个好看的画师串",
  "帮我查一下足交的Tag",
  "随机画一个蔚蓝档案的角色",
  "包含Chen Bin的画师串有哪些呢",
  "优化一下当前的Tag",
];

const TypewriterText: React.FC<{ text: string }> = ({ text }) => {
  const [displayedText, setDisplayedText] = useState('');

  useEffect(() => {
    let index = 0;
    const timer = setInterval(() => {
      setDisplayedText(text.substring(0, index + 1));
      index++;
      if (index > text.length) clearInterval(timer);
    }, 45);
    return () => clearInterval(timer);
  }, [text]);

  return (
    <>
      {displayedText}
      {displayedText.length < text.length && <span className="animate-pulse opacity-70">_</span>}
    </>
  );
};

const TagButton: React.FC<{ tagText: string; isAccentBubble: boolean }> = ({ tagText, isAccentBubble }) => {
  const [copied, setCopied] = useState(false);

  return (
    <span className="relative inline-block">
      <button
        onClick={(e) => {
          e.stopPropagation();
          navigator.clipboard.writeText(tagText);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
        className={`inline-flex items-center gap-1 mx-1 px-1.5 py-0.5 rounded cursor-pointer border font-mono text-xs transition-all ${
          isAccentBubble 
            ? 'bg-black/10 hover:bg-black/20 border-transparent text-black font-bold shadow-sm' 
            : 'bg-[#1a1c23] border-[#2c3144]/80 hover:border-nai-accent/50 hover:bg-[#232736] text-nai-accent shadow-sm'
        }`}
        title="点击复制标签"
      >
        {tagText}
      </button>
      {copied && (
        <span className="absolute -top-7 left-1/2 -translate-x-1/2 px-2 py-1 bg-black/80 text-green-400 text-[10px] rounded shadow-lg whitespace-nowrap animate-fade-in pointer-events-none z-10 border border-green-500/20">
          已复制!
        </span>
      )}
    </span>
  );
};

const renderMessageContent = (content: string, isAccentBubble: boolean = false) => {
  if (!content) return null;
  const parts = content.split(/(TAG\[\[.*?\]\])/g);
  return parts.map((part, i) => {
    if (part.startsWith('TAG[[') && part.endsWith(']]')) {
      const tagText = part.slice(5, -2);
      return <TagButton key={i} tagText={tagText} isAccentBubble={isAccentBubble} />;
    }
    return <span key={i}>{part}</span>;
  });
};

export const MobileAIAssistantSheet: React.FC<MobileAIAssistantSheetProps> = ({
  isOpen,
  onClose,
  aiModel,
  onAiModelChange,
  agentState,
  isGeneratingPrompt,
  onAIGenerate,
  onAIRegenerate,
  onRestoreSnapshot,

}) => {
  const [aiInput, setAiInput] = useState('');

  const [viewportHeight, setViewportHeight] = useState<number | null>(null);
  const aiLogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const [randomSuggestions, setRandomSuggestions] = useState<string[]>([]);
  useEffect(() => {
    if (isOpen) {
      setRandomSuggestions([...SUGGESTIONS].sort(() => 0.5 - Math.random()).slice(0, 3));
    }
  }, [isOpen]);

  const [thinkingIndex, setThinkingIndex] = useState(0);

  useEffect(() => {
    if (!isGeneratingPrompt) {
      setThinkingIndex(0);
      return;
    }
    const timer = setInterval(() => {
      setThinkingIndex(prev => prev + 1);
    }, 4000);
    return () => clearInterval(timer);
  }, [isGeneratingPrompt]);

  const thinkingText = useMemo(() => {
    const list = [
      '努力思考喵...',
      '脑电波链接中喵~',
      '整理魔法词汇喵~',
      '思考中...喵呜？',
      '灵感加载中喵✨'
    ];
    return list[thinkingIndex % list.length];
  }, [thinkingIndex]);

  // 监听 visualViewport 变化
  useEffect(() => {
    if (!isOpen) return;

    const viewport = window.visualViewport;
    if (!viewport) return;

    const handleResize = () => {
      setViewportHeight(viewport.height);
    };

    handleResize();
    viewport.addEventListener('resize', handleResize);

    return () => {
      viewport.removeEventListener('resize', handleResize);
    };
  }, [isOpen]);

  // AI日志自动滚动
  useEffect(() => {
    if (aiLogRef.current) {
      aiLogRef.current.scrollTop = aiLogRef.current.scrollHeight;
    }
  }, [agentState?.logs]);

  // 打开时聚焦输入框
  useEffect(() => {
    if (isOpen && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 300);
    }
  }, [isOpen]);

  const handleAISend = () => {
    if (aiInput.trim() && onAIGenerate && !isGeneratingPrompt) {
      onAIGenerate(aiInput.trim());
      setAiInput('');
    }
  };

  if (!isOpen) return null;

  return (
    <>
      {/* 背景遮罩 */}
      <div
        className="fixed inset-0 z-50 bg-black/60 animate-fade-in"
        onClick={onClose}
      />

      {/* 半弹窗面板 */}
      <div
        className="fixed left-0 right-0 bottom-0 z-50 bg-nai-panel rounded-t-2xl shadow-2xl animate-slide-in-from-bottom flex flex-col transition-all duration-300"
        style={{ maxHeight: viewportHeight ? `${viewportHeight * 0.85}px` : '85vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#2c3144] bg-[#1a1c23] flex-shrink-0 rounded-t-2xl">
          <div className="flex items-center gap-2">
            <Bot className="w-5 h-5 text-nai-accent" />
            <span className="text-base font-bold text-nai-accent">Plana Art Web</span>
          </div>
          <div className="flex items-center gap-2">
            {/* 模型选择 */}
            <select
              value={aiModel}
              onChange={(e) => onAiModelChange(e.target.value)}
              className="h-8 px-2 text-sm font-bold rounded-lg bg-[#232736] border border-[#2c3144] text-white max-w-[160px]"
            >
              {AI_MODEL_CHOICES.map((c) => (
                <option key={c.key} value={c.key}>{c.label}</option>
              ))}
            </select>

            {/* 关闭按钮 */}
            <button
              onClick={onClose}
              className="p-2 hover:bg-[#2c3144] rounded-lg text-gray-400 hover:text-white transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* 日志区域 */}
        <div
          ref={aiLogRef}
          className="flex-1 overflow-y-auto custom-scrollbar p-4 flex flex-col gap-2 min-h-0 bg-black/40"
        >
          {agentState?.logs.length === 0 ? (
            <div className="flex-1 flex flex-col items-start justify-end animate-fade-in select-none px-2 pb-2">
              <div className="w-full flex flex-col items-start gap-2">
                <div className="flex items-center gap-1.5 px-1 mb-1 opacity-70">
                  <Sparkles className="w-3.5 h-3.5 text-nai-accent" />
                  <span className="text-xs font-bold text-gray-400">你可以试试这样问我：</span>
                </div>
                {randomSuggestions.map((suggestion, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      onAIGenerate(suggestion);
                    }}
                    className="text-left px-3.5 py-2.5 rounded-xl bg-[#232736]/60 border border-[#2c3144]/50 hover:bg-[#2c3144]/80 hover:border-nai-accent/40 hover:text-white transition-all text-[13px] text-gray-300 shadow-sm leading-snug break-words group/btn"
                  >
                    <span className="group-hover/btn:text-nai-accent transition-colors mr-1.5 opacity-60">"</span>
                    {suggestion}
                    <span className="group-hover/btn:text-nai-accent transition-colors ml-1.5 opacity-60">"</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            agentState?.logs.map((log, idx) => {
              if (log.collapsed) return null;

              // 计算是否是最后一个成功日志
              const successLogs = agentState.logs.filter(
                (l) => l.type === 'success' && l.snapshot
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
                            // 最后一个成功日志：重新生成
                            const userRequest = agentService.truncateToUserRequest(idx);
                            if (userRequest && onAIRegenerate) {
                              onAIRegenerate(userRequest.request, {
                                positive: snapshot.prePositive,
                                negative: snapshot.preNegative,
                                characters: snapshot.preCharacters,
                              });
                            }
                          } else {
                            // 之前的成功日志：恢复到此版本
                            if (onRestoreSnapshot) {
                              onRestoreSnapshot({
                                positive: snapshot.positive,
                                negative: snapshot.negative,
                                characters: snapshot.characters,
                                vibes: snapshot.vibes,
                              });
                              agentService.truncateLogsTo(idx);
                            }
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
              
              // 错误日志 - 优化展示样式
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
                        // 找到错误日志之前的用户请求并重试
                        const userRequest = agentService.truncateToUserRequest(idx);
                        if (userRequest && onAIGenerate) {
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
                <TypewriterText text={agentState?.progress || thinkingText} />
              </span>
            </div>
          )}
        </div>

        {/* 输入区域 */}
        <div className="flex-shrink-0 px-4 py-3 border-t border-[#2c3144]/80 bg-[#1a1c23]">
          <div className="flex items-end bg-[#131620] border border-[#2c3144] rounded-2xl shadow-lg focus-within:border-nai-accent/60 focus-within:shadow-[0_0_15px_rgba(252,237,164,0.1)] transition-all">
            <textarea
              ref={inputRef}
              value={aiInput}
              onChange={(e) => {
                setAiInput(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleAISend();
                }
              }}
              placeholder="在此输入画面描述..."
              className="flex-1 bg-transparent text-gray-100 px-4 py-3.5 resize-none focus:outline-none text-[13px] placeholder:text-gray-500 custom-scrollbar font-medium"
              style={{ minHeight: '48px', maxHeight: '120px' }}
              rows={1}
            />
            {/* 清空对话按钮 - 有对话时显示 */}
            {agentState?.logs.length > 0 && (
              <button
                onClick={() => agentService.clearLogs()}
                disabled={isGeneratingPrompt}
                className="w-10 h-10 mb-1 flex items-center justify-center text-gray-400 hover:text-red-400 hover:bg-red-500/10 rounded-lg active:scale-95 transition-all disabled:opacity-50"
                title="清空对话"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
            <button
              onClick={handleAISend}
              disabled={!aiInput.trim() || isGeneratingPrompt}
              className={`w-10 h-10 mb-1 mr-1 flex items-center justify-center rounded-xl active:scale-95 transition-all disabled:opacity-50 ${
                aiInput.trim() && !isGeneratingPrompt
                  ? 'bg-nai-accent text-black font-bold shadow-sm'
                  : 'bg-transparent text-gray-500'
              }`}
            >
              {isGeneratingPrompt ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-4 h-4 ml-0.5" />
              )}
            </button>
          </div>
        </div>
      </div>


    </>
  );
};
