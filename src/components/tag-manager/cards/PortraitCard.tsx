// 竖图卡 (character 专用) - aspect 832/1216 单图 + 底部姓名 + 选中序号
// 参照设计稿 .pcard, 但按项目硬规则将顶部 linear-gradient shade 改为
// 纯色 bg-black/80 单色底栏 + 全幅 hover 半透明遮罩
//
// 与旧 OCCard 区别:
//   - 选中态显示**序号** (非 ✓), 与 HorizontalCard / CompactCard 视觉一致
//   - tags 行紧贴姓名上方
//   - 操作按钮全部 hover 出现 (避免遮挡预览)
import React, { useState } from 'react';
import { Copy as CopyIcon, Check, Edit2, Heart, Trash2 } from 'lucide-react';
import type { TagFile } from '../types';

interface Props {
  item: TagFile;
  isSelected: boolean;
  isPublic?: boolean;
  isSavedToLocal?: boolean;
  onToggle: (id: string) => void;
  onCopy?: (id: string, text: string) => void;
  onEdit?: (id: string) => void;
  onSaveToLocal?: (id: string) => void;
  onDelete?: (id: string) => void;
}

export const PortraitCard: React.FC<Props> = ({
  item, isSelected,
  isPublic, isSavedToLocal,
  onToggle, onCopy, onEdit, onSaveToLocal, onDelete,
}) => {
  const text = item.positive || '';
  const imgUrl = item.preview || item.legacyPreviews?.[0] || '';
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
    onCopy?.(item.id, text);
  };

  return (
    <button
      onClick={() => onToggle(item.id)}
      className={`group relative w-full aspect-[832/1216] rounded-lg overflow-hidden cursor-pointer transition-all duration-200 ease-out p-0 bg-gray-800 ${
        isSelected
          ? 'ring-2 ring-nai-accent'
          : 'ring-1 ring-gray-700 hover:ring-gray-500/80'
      }`}
    >
      {/* 预览图: 贴满 + clip-path 强制裁切 (避免浏览器 sub-pixel 渲染漏底色) */}
      {imgUrl ? (
        <div
          className="absolute inset-0 bg-cover bg-center bg-gray-800"
          style={{ backgroundImage: `url("${imgUrl}")` }}
        />
      ) : (
        <div className="absolute inset-0 bg-gray-800 flex items-center justify-center text-gray-500 text-[10px]">
          暂无预览图
        </div>
      )}

      {/* 顶部右上操作按钮组 (hover 显示) */}
      <div className="absolute top-2 right-2 z-20 flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <span
          onClick={handleCopy}
          title={copied ? '已复制' : '复制提示词'}
          className={`w-8 h-8 grid place-items-center rounded-md border shadow-sm transition-colors cursor-pointer ${
            copied
              ? 'bg-green-500/85 border-green-600 text-white'
              : 'bg-gray-800/90 border-gray-600 text-white hover:bg-gray-700'
          }`}
        >
          {copied ? <Check className="w-[18px] h-[18px]" /> : <CopyIcon className="w-[18px] h-[18px]" />}
        </span>
        {isPublic && onSaveToLocal && (
          <span
            onClick={(e) => { e.stopPropagation(); onSaveToLocal(item.id); }}
            title={isSavedToLocal ? '已收藏' : '收藏到本地'}
            className={`w-8 h-8 grid place-items-center rounded-md border shadow-sm transition-colors cursor-pointer ${
              isSavedToLocal
                ? 'bg-gray-800/90 border-gray-600 text-red-400 hover:bg-gray-700'
                : 'bg-gray-800/90 border-gray-600 text-white hover:text-pink-400 hover:bg-gray-700'
            }`}
          >
            <Heart className={`w-[18px] h-[18px] ${isSavedToLocal ? 'fill-current' : ''}`} />
          </span>
        )}
        {!isPublic && onEdit && (
          <span
            onClick={(e) => { e.stopPropagation(); onEdit(item.id); }}
            title="编辑"
            className="w-8 h-8 grid place-items-center rounded-md bg-nai-accent border border-black/20 shadow-sm text-[#1a1410] hover:bg-nai-accent-hover transition-colors cursor-pointer"
          >
            <Edit2 className="w-[18px] h-[18px]" />
          </span>
        )}
        {!isPublic && onDelete && (
          <span
            onClick={(e) => { e.stopPropagation(); onDelete(item.id); }}
            title="删除"
            className="w-8 h-8 grid place-items-center rounded-md bg-red-600/95 border border-red-700 shadow-sm text-white hover:bg-red-500 transition-colors cursor-pointer"
          >
            <Trash2 className="w-[18px] h-[18px]" />
          </span>
        )}
      </div>

      {/* 底部姓名 - hover 滑入 (只显示姓名) */}
      <div
        className={`absolute inset-x-0 bottom-0 z-10 bg-black/45 backdrop-blur-md rounded-b-lg px-2 py-1.5 transition-all duration-300 ${
          isSelected
            ? 'translate-y-0 opacity-100'
            : 'translate-y-full opacity-0 group-hover:translate-y-0 group-hover:opacity-100'
        }`}
      >
        <div className={`text-xs font-bold truncate drop-shadow ${isSelected ? 'text-nai-accent' : 'text-white'}`}>
          {item.name}
        </div>
      </div>

      {/* 选中标记 (旧版 OCCard 风格 ✓) */}
      {isSelected && (
        <span className="absolute top-1.5 left-1.5 bg-nai-accent text-black rounded-full p-1 shadow-[0_2px_8px_rgba(0,0,0,0.5)] z-30">
          <Check className="w-3.5 h-3.5" />
        </span>
      )}
    </button>
  );
};

