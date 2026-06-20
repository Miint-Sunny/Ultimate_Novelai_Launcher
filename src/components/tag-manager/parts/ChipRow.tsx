// 标签筛选 chip 行 - 全部 / ⭐ 收藏 / #tag 圆角 999
// 参照设计稿 .chip / .chip-star
import React from 'react';
import { Settings, Star } from 'lucide-react';

interface Props {
  allActive: boolean;                    // 没有 favOnly 也没有 activeTags 时为 true
  onAllClick: () => void;
  showFavChip?: boolean;
  favOn?: boolean;
  onFavToggle?: () => void;
  tagPool: string[];
  activeTags: Set<string>;
  onTagToggle: (tag: string) => void;
  onSettingsClick?: () => void;          // 标签池管理入口 (右侧 Settings icon)
}

export const ChipRow: React.FC<Props> = ({
  allActive, onAllClick,
  showFavChip, favOn, onFavToggle,
  tagPool, activeTags, onTagToggle,
  onSettingsClick,
}) => {
  if (!showFavChip && tagPool.length === 0 && !onSettingsClick) return null;
  return (
    <div className="flex items-center gap-1.5 mb-3 pt-0.5 pb-1">
      <div className="flex-1 flex items-center gap-1.5 flex-wrap">
        <Chip active={allActive} onClick={onAllClick}>全部</Chip>
        {showFavChip && (
          <Chip
            active={!!favOn}
            variant="star"
            onClick={onFavToggle}
          >
            <Star className="w-3 h-3" />
            <span>收藏</span>
          </Chip>
        )}
        {tagPool.map(t => (
          <Chip
            key={t}
            active={activeTags.has(t)}
            onClick={() => onTagToggle(t)}
          >
            #{t}
          </Chip>
        ))}
      </div>
      {onSettingsClick && (
        <button
          onClick={onSettingsClick}
          title="标签管理"
          className="shrink-0 p-2 text-gray-500 hover:text-nai-accent hover:bg-white/[0.04] rounded-md transition-colors cursor-pointer"
        >
          <Settings className="w-4 h-4" />
        </button>
      )}
    </div>
  );
};

interface ChipProps {
  active: boolean;
  variant?: 'default' | 'star';
  onClick?: () => void;
  children: React.ReactNode;
}

const Chip: React.FC<ChipProps> = ({ active, variant = 'default', onClick, children }) => {
  const base = 'shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[13px] font-bold leading-tight border whitespace-nowrap transition-colors cursor-pointer';
  let cls: string;
  if (active) {
    cls = 'bg-nai-accent text-[#1a1410] border-nai-accent';
  } else if (variant === 'star') {
    cls = 'bg-nai-accent/10 text-nai-accent border-nai-accent/35 hover:bg-nai-accent/15';
  } else {
    cls = 'bg-gray-800/60 text-nai-text-dim border-gray-700 hover:text-white hover:bg-gray-700/85';
  }
  return (
    <button onClick={onClick} className={`${base} ${cls}`}>
      {children}
    </button>
  );
};
