// 最近使用横条 - 角色 + 画风共享, 参照设计稿 .recent
import React, { useMemo } from 'react';
import { Check, Clock, Trash2 } from 'lucide-react';
import type { TagFile } from '../types';

interface Props {
  ids: string[];                          // localStorage 里的 usage order
  pools: TagFile[][];                      // 在多个数据源里查找(我的/收藏/公共)
  selectedSet: Set<string>;
  onToggle: (id: string) => void;
  onClear?: () => void;
  maxItems?: number;
}

export const RecentStrip: React.FC<Props> = ({
  ids, pools, selectedSet,
  onToggle, onClear, maxItems = 8,
}) => {
  const items = useMemo(() => {
    return ids
      .map(id => {
        for (const pool of pools) {
          const found = pool.find(t => t.id === id);
          if (found) return found;
        }
        return null;
      })
      .filter((x): x is TagFile => !!x)
      .slice(0, maxItems);
  }, [ids, pools, maxItems]);

  const isEmpty = items.length === 0;

  return (
    <div className="rounded-lg border border-white/[0.06] bg-nai-dark/40 px-3 py-2.5 mb-3">
      <div className="flex items-center gap-1.5 text-[11px] font-bold text-nai-text-dim mb-2">
        <Clock className="w-3 h-3" />
        <span>最近使用</span>
        {!isEmpty && onClear && (
          <button
            onClick={(e) => { e.stopPropagation(); onClear(); }}
            className="ml-auto inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-nai-text-dim hover:text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer"
          >
            <Trash2 className="w-2.5 h-2.5" />
            清空
          </button>
        )}
      </div>
      <div className="flex items-center gap-2 overflow-x-auto overflow-y-hidden py-0.5 scrollbar-hide">
        {isEmpty ? (
          <span className="text-[11.5px] text-nai-text-dim/60 italic">暂无最近使用</span>
        ) : items.map(it => {
          const isSel = selectedSet.has(it.id);
          const thumb = it.preview || it.legacyPreviews?.[0] || '';
          return (
            <button
              key={it.id}
              onClick={() => onToggle(it.id)}
              title={it.positive}
              className={`shrink-0 inline-flex items-center gap-1.5 pl-1 pr-2.5 py-1 rounded-full border text-[11.5px] font-semibold cursor-pointer transition-colors ${
                isSel
                  ? 'bg-nai-accent/15 text-nai-accent border-nai-accent'
                  : 'bg-gray-800/70 text-white border-gray-700 hover:bg-gray-700/85 hover:border-white/20'
              }`}
            >
              <span
                className="w-5 h-5 rounded-full bg-cover bg-center bg-white/[0.04] shrink-0"
                style={{ backgroundImage: thumb ? `url("${thumb}")` : undefined }}
              />
              <span className="max-w-[120px] truncate">{it.name}</span>
              {isSel && (
                <span className="ml-0.5 w-3.5 h-3.5 rounded-full bg-nai-accent text-[#1a1410] inline-flex items-center justify-center">
                  <Check className="w-2 h-2" strokeWidth={3} />
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
};
