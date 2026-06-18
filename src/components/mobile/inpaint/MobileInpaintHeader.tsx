import React from 'react';
import { Play, X } from 'lucide-react';

interface MobileInpaintHeaderProps {
  onClose: () => void;
  onGenerate: () => void;
  isGenerating: boolean;
  isExpandMode: boolean;
  hasExpand: boolean;
  cost: number;
}

export const MobileInpaintHeader: React.FC<MobileInpaintHeaderProps> = ({
  onClose,
  onGenerate,
  isGenerating,
  isExpandMode,
  hasExpand,
  cost,
}) => (
  <div className="flex-shrink-0 bg-gray-900/95 border-b border-white/10 px-3 py-2 safe-area-top">
    <div className="flex items-center justify-between">
      <button
        onClick={onClose}
        className="p-2 text-gray-400 hover:text-white rounded-lg"
      >
        <X className="w-5 h-5" />
      </button>
      <span className="text-sm text-white font-medium">重绘</span>
      <button
        onClick={onGenerate}
        disabled={isGenerating || (isExpandMode && !hasExpand)}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-nai-accent text-black rounded-lg text-sm font-medium disabled:opacity-50"
      >
        <Play className="w-4 h-4" />
        {isGenerating ? '生成中' : isExpandMode ? '扩图' : '重绘'}
        {!isGenerating && (
          <span className="flex items-center gap-0.5 bg-black/15 px-1.5 py-0.5 rounded text-[10px] font-mono font-bold">
            {cost}<span>💎</span>
          </span>
        )}
      </button>
    </div>
  </div>
);
