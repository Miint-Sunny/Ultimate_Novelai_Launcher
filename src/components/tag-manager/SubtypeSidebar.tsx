// 子分类 左侧 Sidebar - 参照设计稿 .subs
// 替代之前的 SubtypeTabBar (横向 tab),回归更紧凑的纵向列表项
//
// 每个 item:
//   - padding 9 9 9 10, gap 8, rounded-lg, mb-px
//   - hover: bg-white/[0.04] + text-white
//   - active: bg-white/[0.05] + 左侧 3px 圆角竖条 (subtype tone solid)
//   - icon 22×22 圆角 6,默认显示 subtype tone 色,active 时加 tone bg
//   - count badge 16x16 圆角 999 (subtype tone solid)
import React from 'react';
import type { SubtypeDef } from './types';
import { getLucideIcon } from './registry';

interface Props {
  subtypes: SubtypeDef[];
  activeId: string;
  onSelect: (id: string) => void;
  countMap?: Record<string, number>;
}

// 统一色: 所有 subtype 共用 nai-accent (用户反馈: 不希望每类不同色,
// 也不希望用户自定义分类时还要选色)
export const SubtypeSidebar: React.FC<Props> = ({
  subtypes, activeId, onSelect, countMap,
}) => {
  return (
    <aside className="w-[176px] shrink-0 border-r border-white/[0.06] bg-nai-dark/30 flex flex-col min-h-0">
      <div className="flex-1 overflow-y-auto py-2 pl-2.5 pr-2 scrollbar-hide">
        {subtypes.map(s => {
          const Icon = getLucideIcon(s.iconName);
          const isActive = s.id === activeId;
          const count = countMap?.[s.id];
          return (
            <button
              key={s.id}
              onClick={() => onSelect(s.id)}
              title={s.label}
              className={`relative w-full flex items-center gap-2.5 pl-3 pr-3 py-2.5 mb-1 rounded-lg transition-colors cursor-pointer ${
                isActive
                  ? 'bg-white/[0.05] text-white'
                  : 'text-nai-text-dim hover:bg-white/[0.04] hover:text-white'
              }`}
            >
              {isActive && (
                <span className="absolute left-0 top-2.5 bottom-2.5 w-[3px] rounded-r bg-nai-accent" />
              )}
              <span
                className={`w-7 h-7 grid place-items-center rounded-lg shrink-0 ${
                  isActive ? 'text-nai-accent bg-nai-accent/15' : 'text-gray-400'
                }`}
              >
                {Icon && <Icon className="w-[18px] h-[18px]" strokeWidth={1.75} />}
              </span>
              <span className="flex-1 min-w-0 text-[13px] font-semibold truncate text-left">
                {s.label}
              </span>
              {typeof count === 'number' && count > 0 && (
                <span className="min-w-[18px] h-[18px] px-1.5 rounded-full text-[10.5px] font-extrabold tabular-nums inline-flex items-center justify-center bg-nai-accent text-[#1a1410]">
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </aside>
  );
};
