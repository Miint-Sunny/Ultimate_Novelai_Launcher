import React from 'react';
import { Bot, X } from 'lucide-react';
import { AI_MODEL_CHOICES } from '../../../services/agentService';

interface AssistantHeaderProps {
  aiModel: string;
  localPrimaryModel: string | null;
  onAiModelChange: (model: string) => void;
  onClose: () => void;
}

export const AssistantHeader: React.FC<AssistantHeaderProps> = ({
  aiModel,
  localPrimaryModel,
  onAiModelChange,
  onClose,
}) => (
  <div className="flex items-center justify-between px-4 py-3 border-b border-[#303235] bg-[#1c1d1f] flex-shrink-0 rounded-t-2xl">
    <div className="flex items-center gap-2">
      <Bot className="w-5 h-5 text-nai-accent" />
      <span className="text-base font-bold text-nai-accent">Plana Art Web</span>
    </div>
    <div className="flex items-center gap-2">
      {localPrimaryModel !== null ? (
        <div
          role="status"
          title={`本地 sidecar 主模型：${localPrimaryModel || '未配置'}`}
          className="h-8 max-w-[180px] px-2.5 inline-flex items-center gap-1.5 text-xs font-bold rounded-lg bg-[#26282a] border border-[#303235] text-white"
        >
          <span className="shrink-0">本地主模型</span>
          <span className="text-gray-400 truncate">· {localPrimaryModel || '未配置'}</span>
        </div>
      ) : (
        <select
          value={aiModel}
          onChange={(e) => onAiModelChange(e.target.value)}
          className="h-8 px-2 text-sm font-bold rounded-lg bg-[#26282a] border border-[#303235] text-white max-w-[160px]"
        >
          {AI_MODEL_CHOICES.map((choice) => (
            <option key={choice.key} value={choice.key}>{choice.label}</option>
          ))}
        </select>
      )}

      <button
        onClick={onClose}
        className="p-2 hover:bg-[#303235] rounded-lg text-gray-400 hover:text-white transition-colors"
      >
        <X className="w-5 h-5" />
      </button>
    </div>
  </div>
);
