// 单图通用卡 (artist-style 与所有 compact 子分类共用)
// 无预览图时显示子分类色调的 lucide icon 占位
import React from 'react';
import { Check, Edit2, ImageOff, Trash2 } from 'lucide-react';
import type { SubtypeDef, TagFile } from '../types';
import { getLucideIcon } from '../registry';

interface Props {
  tag: TagFile;
  subtype: SubtypeDef;
  isSelected: boolean;
  onToggleSelection: (id: string) => void;
  onEdit?: (id: string) => void;
  onDelete?: (id: string) => void;
}

// 统一色: 所有 subtype 共用 nai-accent (不再按 colorTone 区分)
export const CompactCard: React.FC<Props> = ({ tag, subtype, isSelected, onToggleSelection, onEdit, onDelete }) => {
  const Icon = getLucideIcon(subtype.iconName);

  return (
    <div
      className={`group relative aspect-square rounded-lg border-2 cursor-pointer overflow-hidden transition-[transform,box-shadow] duration-200 ease-out bg-nai-input ${
        isSelected
          ? 'border-nai-accent ring-1 ring-nai-accent/40'
          : 'border-gray-700 hover:border-gray-500'
      }`}
      onClick={() => onToggleSelection(tag.id)}
      title={tag.positive}
    >
      {tag.preview ? (
        <img
          src={tag.preview}
          alt={tag.name}
          loading="lazy"
          decoding="async"
          className="w-full h-full object-cover"
          onError={(e) => { e.currentTarget.style.display = 'none'; }}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center bg-nai-accent/10">
          {Icon ? (
            <Icon className="w-10 h-10 text-nai-accent" strokeWidth={1.5} />
          ) : (
            <ImageOff className="w-10 h-10 text-gray-600" />
          )}
        </div>
      )}

      {isSelected && (
        <div className="absolute top-1.5 left-1.5 bg-nai-accent text-black rounded-full p-1 shadow-[0_2px_8px_rgba(0,0,0,0.4)] z-10">
          <Check className="w-3.5 h-3.5" />
        </div>
      )}

      {(onEdit || onDelete) && (
        <div className="absolute top-1.5 right-1.5 flex gap-1 z-10 opacity-0 group-hover:opacity-100 transition-opacity">
          {onEdit && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onEdit(tag.id); }}
              title="编辑"
              className="w-7 h-7 grid place-items-center rounded-md bg-nai-accent border border-black/20 text-[#1a1410] shadow-sm hover:bg-nai-accent-hover transition-colors cursor-pointer"
            >
              <Edit2 className="w-3.5 h-3.5" />
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onDelete(tag.id); }}
              title="删除"
              className="w-7 h-7 grid place-items-center rounded-md bg-red-600/95 border border-red-700 text-white shadow-sm hover:bg-red-500 transition-colors cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      )}

      <div className="absolute inset-x-0 bottom-0 bg-black/70 backdrop-blur-sm px-2 py-1.5">
        <div className={`text-xs font-bold truncate ${isSelected ? 'text-nai-accent' : 'text-white'}`}>
          {tag.name}
        </div>
        {tag.tags && tag.tags.length > 0 && (
          <div className="mt-0.5 flex gap-1 truncate text-[10px] text-white/55">
            {tag.tags.slice(0, 3).map(t => <span key={t}>#{t}</span>)}
            {tag.tags.length > 3 && <span>+{tag.tags.length - 3}</span>}
          </div>
        )}
      </div>
    </div>
  );
};
