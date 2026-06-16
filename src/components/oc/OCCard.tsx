// OC卡片组件 - 公共/本地共用
import React from 'react';
import { Check, Edit2, Save, Trash2 } from 'lucide-react';
import { Clipboard as ClipboardIcon } from 'lucide-react';
import type { OCFile } from './types';

interface OCCardProps {
  file: OCFile;
  isSelected: boolean;
  isJustSelected: boolean;
  isPublic: boolean;
  copiedOCId: string | null;
  savedToLocalOCId: string | null;
  onToggleSelection: (id: string) => void;
  onCopy: (id: string, prompt: string) => void;
  onEdit?: (file: OCFile) => void;
  onSaveToLocal?: (file: OCFile, e: React.MouseEvent) => void;
  onDelete?: (id: string, e: React.MouseEvent) => void;
}

export const OCCard: React.FC<OCCardProps> = ({
  file, isSelected, isJustSelected, isPublic,
  copiedOCId, savedToLocalOCId,
  onToggleSelection, onCopy, onEdit,
  onSaveToLocal, onDelete,
}) => {
  return (
    <div
      key={file.id}
      id={`oc-card-${file.id}`}
      className={`group relative aspect-[832/1216] rounded-lg border-2 cursor-pointer overflow-hidden transition-[transform,box-shadow] duration-200 ease-out bg-gray-800 ${
        isJustSelected
          ? 'border-yellow-400 ring-2 ring-yellow-400/50 scale-105 shadow-[0_0_20px_rgba(250,204,21,0.5)] z-20'
          : isSelected
            ? 'border-nai-accent ring-1 ring-nai-accent/20'
            : 'border-gray-700 hover:border-gray-500'
      }`}
      onClick={() => onToggleSelection(file.id)}
    >
      {isJustSelected && (
        <div className="absolute inset-0 bg-yellow-400/20 animate-pulse z-30 pointer-events-none" />
      )}
      <img
        src={file.preview} alt={file.name} loading="lazy" decoding="async"
        className="w-full h-full object-cover opacity-0 transition-opacity duration-300"
        onLoad={(e) => e.currentTarget.classList.remove('opacity-0')}
      />
      {isSelected && (
        <div className="absolute top-1.5 left-1.5 bg-nai-accent text-black rounded-full p-1 shadow-lg z-10">
          <Check className="w-3.5 h-3.5" />
        </div>
      )}
      {/* Action Buttons */}
      <div className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 transition-opacity z-10 flex gap-1">
        <button
          className={`${copiedOCId === file.id ? 'bg-green-600' : 'bg-gray-800/90 hover:bg-gray-700'} text-white rounded p-1.5 shadow-lg border border-gray-600`}
          onClick={(e) => { e.stopPropagation(); onCopy(file.id, file.positive); }}
          title="复制提示词"
        >
          {copiedOCId === file.id ? <Check className="w-4 h-4" /> : <ClipboardIcon className="w-4 h-4" />}
        </button>
        {isPublic && onSaveToLocal && (
          <button
            className={`${savedToLocalOCId === file.id ? 'bg-green-600' : 'bg-gray-800/90 hover:bg-gray-700'} text-white rounded p-1.5 shadow-lg border border-gray-600`}
            onClick={(e) => onSaveToLocal(file, e)}
            title="保存到本地"
          >
            {savedToLocalOCId === file.id ? <Check className="w-4 h-4" /> : <Save className="w-4 h-4" />}
          </button>
        )}
        {!isPublic && onDelete && (
          <button
            className="bg-red-600 hover:bg-red-500 text-white rounded p-1.5 shadow-lg border border-red-700"
            onClick={(e) => onDelete(file.id, e)}
            title="删除"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        )}
        {onEdit && (
          <button
            className="bg-nai-accent hover:bg-[#ebd576] text-black rounded p-1.5 shadow-lg border border-black/20"
            onClick={(e) => { e.stopPropagation(); onEdit(file); }}
            title="查看详情 / 编辑"
          >
            <Edit2 className="w-4 h-4" />
          </button>
        )}
      </div>

      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/60 to-transparent p-2 pt-5">
        <div className={`text-sm font-bold truncate ${isSelected ? 'text-nai-accent' : 'text-white'}`}>
          {file.name}
        </div>
      </div>
    </div>
  );
};
