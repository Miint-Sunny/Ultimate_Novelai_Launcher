import React from 'react';
import { Bot, X } from 'lucide-react';
import { AI_MODEL_CHOICES } from '../../../services/agentService';

interface AssistantHeaderProps {
  aiModel: string;
  onAiModelChange: (model: string) => void;
  onClose: () => void;
}

export const AssistantHeader: React.FC<AssistantHeaderProps> = ({
  aiModel,
  onAiModelChange,
  onClose,
}) => (
  <div className="flex items-center justify-between px-4 py-3 border-b border-nai-border bg-nai-panel-2 flex-shrink-0 rounded-t-2xl">
    <div className="flex items-center gap-2">
      <Bot className="w-5 h-5 text-nai-accent" />
      <span className="text-base font-bold text-nai-accent">Plana Art Web</span>
    </div>
    <div className="flex items-center gap-2">
<select
        value={aiModel}
        onChange={(e) => onAiModelChange(e.target.value)}
        className="h-8 px-2 text-sm font-bold rounded-lg bg-nai-surface border border-nai-border text-white max-w-[160px]"
      >
        {AI_MODEL_CHOICES.map((choice) => (
          <option key={choice.key} value={choice.key}>{choice.label}</option>
        ))}
      </select>

      <button
        onClick={onClose}
        className="p-2 hover:bg-nai-surface-hover rounded-lg text-gray-400 hover:text-white transition-colors"
      >
        <X className="w-5 h-5" />
      </button>
    </div>
  </div>
);
