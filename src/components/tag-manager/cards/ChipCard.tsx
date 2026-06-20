// Pill 形 chip 卡 - 用于 cardLayout: 'chip' 的 subtype (场景 / 其他)
// 不显示预览图,信息密度高:中文名(主) + 浅灰小字 prompt 预览(辅)
// 选中态用 nai-accent 填充,跟整体 chip 风格一致
import React from 'react';
import { Check, Pencil, X } from 'lucide-react';
import type { TagFile } from '../types';

interface Props {
  tag: TagFile;
  isSelected: boolean;
  onToggleSelection: (id: string) => void;
  onEdit?: (id: string) => void;
  onDelete?: (id: string) => void;
}

export const ChipCard: React.FC<Props> = ({ tag, isSelected, onToggleSelection, onEdit, onDelete }) => {
  const text = tag.positive || '';
  return (
    <div
      onClick={() => onToggleSelection(tag.id)}
      title={text}
      className={`group inline-flex items-center gap-2 pl-3 pr-2 py-2 rounded-full border transition-colors cursor-pointer max-w-full ${
        isSelected
          ? 'bg-nai-accent text-[#1a1410] border-nai-accent shadow-sm'
          : 'bg-gray-800/60 text-gray-200 border-gray-700 hover:bg-gray-700/80 hover:border-gray-500'
      }`}
    >
      {isSelected && <Check className="w-3.5 h-3.5 shrink-0" />}
      <span className="font-bold text-[13px] truncate max-w-[14ch] leading-none">{tag.name}</span>
      {text && (
        <span
          className={`text-[11px] truncate max-w-[22ch] leading-none ${
            isSelected ? 'text-[#1a1410]/65' : 'text-nai-text-dim'
          }`}
        >
          · {text}
        </span>
      )}
      {onEdit && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onEdit(tag.id); }}
          title="编辑"
          className={`shrink-0 w-5 h-5 grid place-items-center rounded-full transition-colors opacity-0 group-hover:opacity-100 cursor-pointer ${
            isSelected
              ? 'hover:bg-black/15 text-[#1a1410]/70 hover:text-[#1a1410]'
              : 'hover:bg-white/10 text-nai-text-dim hover:text-white'
          }`}
        >
          <Pencil className="w-3 h-3" />
        </button>
      )}
      {onDelete && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onDelete(tag.id); }}
          title="删除"
          className={`shrink-0 w-5 h-5 grid place-items-center rounded-full transition-colors opacity-0 group-hover:opacity-100 cursor-pointer ${
            isSelected
              ? 'hover:bg-black/15 text-[#1a1410]/70 hover:text-[#1a1410]'
              : 'hover:bg-red-500/20 text-nai-text-dim hover:text-red-400'
          }`}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
};
