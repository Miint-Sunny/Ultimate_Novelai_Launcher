// 画师串卡片 - 竖向布局
// 顶部: 预览图 (无图时用画师名生成稳定色调的色块 + letter-spaced 大字水印)
// 底部: 名称 + 操作按钮单行 (复制/编辑/删除/收藏)
import React, { useMemo, useState } from 'react';
import { Check, Copy as CopyIcon, Heart, type LucideIcon } from 'lucide-react';
import type { TagFile } from '../types';

export interface CardMenuItem {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  danger?: boolean;
}

interface Props {
  item: TagFile;
  isSelected: boolean;
  onToggle: (id: string) => void;
  isPublic?: boolean;                // true: 显示收藏 ❤️; false: 显示更多操作
  isSavedToLocal?: boolean;
  onCopy?: (id: string, text: string) => void;
  onSaveToLocal?: (id: string) => void;
  /** 我的 scope 下操作按钮,按 origin 分支由父级提供 */
  menuItems?: CardMenuItem[];
}

// 从字符串生成稳定 hue (0-360)
function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

export const HorizontalCard: React.FC<Props> = ({
  item, isSelected, onToggle,
  isPublic, isSavedToLocal,
  onCopy, onSaveToLocal, menuItems,
}) => {
  const text = item.positive || '';
  const imgUrl = item.preview || item.legacyPreviews?.[0] || '';
  const [copied, setCopied] = useState(false);

  const inlineActions = !isPublic && menuItems ? menuItems : [];

  // 无图时的稳定色调
  const hue = useMemo(() => hashHue(item.name || item.id), [item.name, item.id]);
  const placeholderStyle: React.CSSProperties = {
    background: `linear-gradient(135deg, hsl(${hue} 55% 55%) 0%, hsl(${(hue + 30) % 360} 50% 40%) 100%)`,
  };
  const stripeStyle: React.CSSProperties = {
    backgroundImage:
      'repeating-linear-gradient(135deg, rgba(255,255,255,0.06) 0 12px, rgba(0,0,0,0.04) 12px 24px)',
  };

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
      title={text}
      className={`group relative flex flex-col w-full rounded-xl overflow-hidden cursor-pointer transition-colors text-left p-0 bg-gray-900/70 ${
        isSelected
          ? 'ring-2 ring-nai-accent'
          : 'ring-1 ring-gray-700/60 hover:ring-gray-500/80'
      }`}
    >
      {/* 顶部预览区 */}
      <div className="relative w-full aspect-[1216/832] overflow-hidden bg-gray-800">
        {imgUrl ? (
          <img
            src={imgUrl}
            alt={item.name}
            loading="lazy"
            decoding="async"
            className="absolute inset-0 w-full h-full object-cover"
          />
        ) : (
          <>
            <div className="absolute inset-0" style={placeholderStyle} />
            <div className="absolute inset-0" style={stripeStyle} />
            <div className="absolute inset-0 flex items-center justify-center px-3">
              <span
                className="text-white/55 font-bold uppercase truncate max-w-full text-center"
                style={{ letterSpacing: '0.35em', fontSize: 'clamp(14px, 2.2vw, 22px)' }}
              >
                {item.name}
              </span>
            </div>
          </>
        )}
      </div>

      {/* 底部信息区 - 名称 + 操作按钮一行 */}
      <div className="flex items-center gap-2 px-3 py-2.5 h-[52px]">
        <span
          className={`flex-1 min-w-0 truncate text-[15px] font-extrabold tracking-wide ${
            isSelected ? 'text-nai-accent' : 'text-gray-100'
          }`}
        >
          {item.name}
        </span>
        <div className="flex justify-end gap-1.5 shrink-0">
          <span
            onClick={handleCopy}
            title={copied ? '已复制' : '复制提示词'}
            className={`w-8 h-8 grid place-items-center rounded-md border shadow-sm transition-colors cursor-pointer ${
              copied
                ? 'bg-green-500/85 border-green-600 text-white'
                : 'bg-gray-800/70 border-gray-700 text-gray-300 hover:text-white hover:bg-gray-700'
            }`}
          >
            {copied ? <Check className="w-[17px] h-[17px]" /> : <CopyIcon className="w-[17px] h-[17px]" />}
          </span>
          {isPublic ? (
            <span
              onClick={(e) => { e.stopPropagation(); onSaveToLocal?.(item.id); }}
              title={isSavedToLocal ? '已收藏' : '收藏到本地'}
              className={`w-8 h-8 grid place-items-center rounded-md border shadow-sm transition-colors cursor-pointer ${
                isSavedToLocal
                  ? 'bg-gray-800/70 border-gray-700 text-red-400 hover:bg-gray-700'
                  : 'bg-gray-800/70 border-gray-700 text-gray-300 hover:text-pink-400 hover:bg-gray-700'
              }`}
            >
              <Heart className={`w-[17px] h-[17px] ${isSavedToLocal ? 'fill-current' : ''}`} />
            </span>
          ) : (
            inlineActions.map(mi => {
              const Icon = mi.icon;
              return (
                <span
                  key={mi.label}
                  onClick={(e) => { e.stopPropagation(); mi.onClick(); }}
                  title={mi.label}
                  className={`w-8 h-8 grid place-items-center rounded-md border shadow-sm transition-colors cursor-pointer ${
                    mi.danger
                      ? 'bg-gray-800/70 border-gray-700 text-gray-300 hover:text-red-300 hover:bg-red-500/10 hover:border-red-500/40'
                      : 'bg-gray-800/70 border-gray-700 text-gray-300 hover:text-white hover:bg-gray-700'
                  }`}
                >
                  <Icon className="w-[17px] h-[17px]" />
                </span>
              );
            })
          )}
        </div>
      </div>

      {/* 选中标记 - 左上角 */}
      {isSelected && (
        <span className="absolute left-2.5 top-2.5 bg-nai-accent text-black rounded-full p-1 shadow-[0_2px_8px_rgba(0,0,0,0.5)] z-10">
          <Check className="w-3 h-3" strokeWidth={3} />
        </span>
      )}
    </button>
  );
};
