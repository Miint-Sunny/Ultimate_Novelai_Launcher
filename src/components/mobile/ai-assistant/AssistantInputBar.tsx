import React from 'react';
import { Loader2, Send, Trash2 } from 'lucide-react';

interface AssistantInputBarProps {
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  aiInput: string;
  onInputChange: (value: string) => void;
  isGeneratingPrompt: boolean;
  hasLogs: boolean;
  onSend: () => void;
  onClearLogs: () => void;
}

export const AssistantInputBar: React.FC<AssistantInputBarProps> = ({
  inputRef,
  aiInput,
  onInputChange,
  isGeneratingPrompt,
  hasLogs,
  onSend,
  onClearLogs,
}) => (
  <div className="flex-shrink-0 px-4 py-3 border-t border-nai-border/80 bg-nai-panel-2">
    <div className="flex items-end bg-nai-panel border border-nai-border rounded-2xl shadow-lg focus-within:border-nai-accent/60 focus-within:shadow-[0_0_15px_rgba(252,237,164,0.1)] transition-all">
      <textarea
        ref={inputRef}
        value={aiInput}
        onChange={(e) => {
          onInputChange(e.target.value);
          e.target.style.height = 'auto';
          e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onSend();
          }
        }}
        placeholder="在此输入画面描述..."
        className="flex-1 bg-transparent text-gray-100 px-4 py-3.5 resize-none focus:outline-none text-[13px] placeholder:text-gray-500 custom-scrollbar font-medium"
        style={{ minHeight: '48px', maxHeight: '120px' }}
        rows={1}
      />
      {hasLogs && (
        <button
          onClick={onClearLogs}
          disabled={isGeneratingPrompt}
          className="w-10 h-10 mb-1 flex items-center justify-center text-gray-400 hover:text-red-400 hover:bg-red-500/10 rounded-lg active:scale-95 transition-all disabled:opacity-50"
          title="清空对话"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      )}
      <button
        onClick={onSend}
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
);
