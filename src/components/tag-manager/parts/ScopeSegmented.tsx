// 工具栏内紧凑 segmented [我的 / 公共] - 替代旧的 "公共/本地 Tab"
// 参照设计稿 .seg-pl, h-8 内部 padding 2px, 圆角 6
import React from 'react';
import { Bookmark, Globe } from 'lucide-react';

export type Scope = 'mine' | 'pub';

interface Props {
  scope: Scope;
  onChange: (s: Scope) => void;
  mineLabel?: string;
  pubLabel?: string;
  mineCount?: number;
  pubCount?: number;
}

export const ScopeSegmented: React.FC<Props> = ({
  scope, onChange,
  mineLabel = '我的', pubLabel = '公共',
  mineCount, pubCount,
}) => {
  return (
    <div className="inline-flex shrink-0 h-9 rounded-md bg-gray-800/50 border border-gray-700 p-0.5">
      <Tab
        active={scope === 'mine'}
        onClick={() => onChange('mine')}
        icon={<Bookmark className="w-3.5 h-3.5" />}
        label={mineLabel}
        count={mineCount}
      />
      <Tab
        active={scope === 'pub'}
        onClick={() => onChange('pub')}
        icon={<Globe className="w-3.5 h-3.5" />}
        label={pubLabel}
        count={pubCount}
      />
    </div>
  );
};

const Tab: React.FC<{
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count?: number;
}> = ({ active, onClick, icon, label, count }) => (
  <button
    onClick={onClick}
    className={`inline-flex items-center gap-1.5 px-3 rounded text-[12.5px] font-bold transition-colors cursor-pointer ${
      active
        ? 'bg-nai-accent/20 text-nai-accent shadow-[inset_0_1px_0_rgba(252,237,164,0.10)]'
        : 'text-nai-text-dim hover:text-white'
    }`}
  >
    {icon}
    <span>{label}</span>
    {typeof count === 'number' && (
      <span
        className={`ml-0.5 px-1.5 py-0.5 rounded-full text-[10.5px] font-extrabold tabular-nums leading-none ${
          active ? 'bg-nai-accent/30 text-nai-accent' : 'bg-white/10 text-nai-text-dim'
        }`}
      >
        {count}
      </span>
    )}
  </button>
);
