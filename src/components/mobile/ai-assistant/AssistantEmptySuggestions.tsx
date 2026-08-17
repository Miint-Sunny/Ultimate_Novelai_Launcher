import React from 'react';
import { Sparkles } from 'lucide-react';

interface AssistantEmptySuggestionsProps {
  suggestions: string[];
  onSelect: (suggestion: string) => void;
}

export const AssistantEmptySuggestions: React.FC<AssistantEmptySuggestionsProps> = ({
  suggestions,
  onSelect,
}) => (
  <div className="flex-1 flex flex-col items-start justify-end animate-fade-in select-none px-2 pb-2">
    <div className="w-full flex flex-col items-start gap-2">
      <div className="flex items-center gap-1.5 px-1 mb-1 opacity-70">
        <Sparkles className="w-3.5 h-3.5 text-nai-accent" />
        <span className="text-xs font-bold text-gray-400">你可以试试这样问我：</span>
      </div>
      {suggestions.map((suggestion, index) => (
        <button
          key={index}
          onClick={() => onSelect(suggestion)}
          className="text-left px-3.5 py-2.5 rounded-xl bg-nai-surface/60 border border-nai-border/50 hover:bg-nai-surface-hover/80 hover:border-nai-accent/40 hover:text-white transition-all text-[13px] text-gray-300 shadow-sm leading-snug break-words group/btn"
        >
          <span className="group-hover/btn:text-nai-accent transition-colors mr-1.5 opacity-60">"</span>
          {suggestion}
          <span className="group-hover/btn:text-nai-accent transition-colors ml-1.5 opacity-60">"</span>
        </button>
      ))}
    </div>
  </div>
);
