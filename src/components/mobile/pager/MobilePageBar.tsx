import React from 'react';
import { Image as ImageIcon, Paintbrush, Sparkles } from 'lucide-react';

// 悬浮页栏(P3):.glass 胶囊,3 项(生图/创作室/图库),选中项滑动 pill 指示;
// AI 页(页 0,负一屏)从页栏不可达,激活时页栏无选中态。
const PAGE_BAR_ITEMS = [
  { page: 1, label: '生图', icon: Sparkles },
  { page: 2, label: '创作室', icon: Paintbrush },
  { page: 3, label: '图库', icon: ImageIcon },
] as const;

const ITEM_WIDTH = 84;
const BAR_PADDING = 4;

interface MobilePageBarProps {
  activePage: number;
  onNavigate: (page: number) => void;
}

export const MobilePageBar: React.FC<MobilePageBarProps> = ({ activePage, onNavigate }) => {
  const activeIndex = PAGE_BAR_ITEMS.findIndex((item) => item.page === activePage);

  return (
    <div
      className="fixed left-1/2 -translate-x-1/2 z-30 pointer-events-none"
      style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)' }}
    >
      <div className="glass relative flex items-center rounded-full shadow-xl pointer-events-auto" style={{ padding: BAR_PADDING }}>
        <div
          aria-hidden
          className="absolute rounded-full bg-nai-accent/20 border border-nai-accent/50 transition-all duration-300"
          style={{
            top: BAR_PADDING,
            bottom: BAR_PADDING,
            left: BAR_PADDING + (activeIndex >= 0 ? activeIndex * ITEM_WIDTH : 0),
            width: ITEM_WIDTH,
            opacity: activeIndex >= 0 ? 1 : 0,
          }}
        />
        {PAGE_BAR_ITEMS.map((item) => {
          const selected = activePage === item.page;
          return (
            <button
              key={item.page}
              onClick={() => onNavigate(item.page)}
              title={item.label}
              className={`relative z-10 flex flex-col items-center justify-center gap-0.5 py-1.5 rounded-full transition-colors duration-200 ${
                selected ? 'text-nai-accent' : 'text-gray-400 active:text-white'
              }`}
              style={{ width: ITEM_WIDTH }}
            >
              <item.icon className="w-5 h-5" />
              <span className="text-[11px]">{item.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
