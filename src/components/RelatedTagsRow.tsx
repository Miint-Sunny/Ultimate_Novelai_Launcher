/**
 * 关联推荐悬浮行 - 跟随 tagPanel 显示 Danbooru 共现标签
 *
 * 形态:
 *  - 文字云 (英文 + 中文双行, hover 金色 + 下划线), 横向滚动
 *  - 左右两侧 ‹ › 按钮: 横向滚动可视区
 *  - 失败/无结果时静默不渲染
 *  - 已添加的 tag 灰显划掉不可重复点
 *
 * 数据源: 后端 /api/tags/related → DanbooruSearch /api/related
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { fetchRelatedTags, pickPrimaryChineseName, type RelatedTag } from '../services/tagRelated';

interface Props {
  // 当前 anchor tag 列表 (干净版,不含权重符号); 单选=1项, 多选=多项做共现
  anchorTags: string[];
  // 已经在 prompt 里的 tag 集合 (小写下划线归一,用于灰显)
  existingTagSet: Set<string>;
  // 添加 tag 的回调; addToEnd=true 时插到末尾,否则插到当前 chip 之后
  onAdd: (tag: string, addToEnd: boolean) => void;
  // 隐藏左右滚动箭头 (触摸端直接横滑,箭头无用且挤占列表宽度)
  hideNav?: boolean;
}

const ARROW_SCROLL_RATIO = 0.7;  // 每次箭头点击滚动可视区的 70%

export const RelatedTagsRow: React.FC<Props> = ({ anchorTags, existingTagSet, onAdd, hideNav = false }) => {
  const [results, setResults] = useState<RelatedTag[]>([]);
  const [loading, setLoading] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  // 拉数据 + 过滤自身/排序
  // 切换 anchorTags 立即清空 results, 显示加载骨架 (避免残留上一条目内容).
  const anchorKey = anchorTags.map(t => t.toLowerCase().replace(/\s+/g, '_')).sort().join('|');
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setResults([]);
    const normAnchors = anchorTags
      .map(t => t.toLowerCase().replace(/\s+/g, '_'))
      .filter(Boolean);
    if (normAnchors.length === 0) {
      setResults([]);
      setLoading(false);
      return;
    }
    const anchorSet = new Set(normAnchors);
    fetchRelatedTags(normAnchors, 30, true, ['General'])
      .then(rs => {
        if (cancelled) return;
        // 后端已按 categories=['General'] 过滤; 此处再剔除 anchor 自身 + 排序保险
        const filtered = rs.filter(r => !anchorSet.has(r.tag));
        const sorted = [...filtered].sort((a, b) =>
          (b.npmi ?? b.score ?? 0) - (a.npmi ?? a.score ?? 0)
        );
        setResults(sorted);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setResults([]);
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorKey]);

  const updateScroll = () => {
    const el = scrollRef.current;
    if (!el) {
      setCanLeft(false); setCanRight(false);
      return;
    }
    setCanLeft(el.scrollLeft > 1);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  };

  useLayoutEffect(() => {
    updateScroll();
  }, [results]);

  const scrollByDir = (dir: 'left' | 'right') => {
    const el = scrollRef.current;
    if (!el) return;
    const delta = el.clientWidth * ARROW_SCROLL_RATIO * (dir === 'left' ? -1 : 1);
    el.scrollBy({ left: delta, behavior: 'smooth' });
    setTimeout(updateScroll, 350);
  };

  // 加载完成后无结果 → 用 grid 行高动画平滑折叠（不直接 return null）
  const isEmpty = !loading && results.length === 0;
  // 仅在首次加载（无任何已有结果）时显示骨架；切换 anchorTag 时保留旧结果不显示骨架
  const showSkeleton = loading && results.length === 0;

  const innerContent = showSkeleton ? (
    <div className="px-2 py-1 flex items-center gap-3">
      {[10, 8, 12, 10].map((w, i) => (
        <div key={i} className="shrink-0 flex flex-col gap-0.5 py-0.5">
          <div className="h-[14px] bg-white/[0.06] animate-pulse rounded-sm"
            style={{ width: `${w * 4}px` }} />
          <div className="h-[12px] bg-white/[0.04] animate-pulse rounded-sm"
            style={{ width: `${w * 3}px` }} />
        </div>
      ))}
    </div>
  ) : (
    <RelatedTagsBody
      results={results}
      existingTagSet={existingTagSet}
      onAdd={onAdd}
      scrollRef={scrollRef}
      updateScroll={updateScroll}
      canLeft={canLeft}
      canRight={canRight}
      scrollByDir={scrollByDir}
      hideNav={hideNav}
    />
  );

  return (
    <div
      className="grid transition-all duration-300 ease-out"
      style={{
        gridTemplateRows: isEmpty ? '0fr' : '1fr',
        opacity: isEmpty ? 0 : 1,
      }}
    >
      <div className="overflow-hidden min-h-0">
        {innerContent}
      </div>
    </div>
  );
};

// 实际内容部分: 滚动按钮 + 滚动区
interface BodyProps {
  results: RelatedTag[];
  existingTagSet: Set<string>;
  onAdd: (tag: string, addToEnd: boolean) => void;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  updateScroll: () => void;
  canLeft: boolean;
  canRight: boolean;
  scrollByDir: (dir: 'left' | 'right') => void;
  hideNav: boolean;
}

const RelatedTagsBody: React.FC<BodyProps> = ({ results, existingTagSet, onAdd, scrollRef, updateScroll, canLeft, canRight, scrollByDir, hideNav }) => {
  const showNav = !hideNav && (canLeft || canRight);
  return (
    <div className="px-2 py-1 flex items-center gap-1">
      {showNav && (
        <button
          type="button"
          onClick={() => scrollByDir('left')}
          disabled={!canLeft}
          className={`shrink-0 w-5 h-6 flex items-center justify-center transition-colors
            ${canLeft ? 'text-[#fceda4]/60 hover:text-[#fceda4]' : 'text-white/15 cursor-not-allowed'}`}
          title="向左滚动"
        >
          <ChevronLeft className="w-3.5 h-3.5" strokeWidth={2.5} />
        </button>
      )}

      <div
        ref={scrollRef}
        className="flex-1 w-0 min-w-0 overflow-x-auto"
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' } as React.CSSProperties}
        onScroll={updateScroll}
      >
        <style>{`.related-row-scroll::-webkit-scrollbar { display: none; }`}</style>
        <div className="related-row-scroll flex items-baseline gap-x-3 gap-y-0.5 whitespace-nowrap py-0.5">
          {results.map((r) => {
            const added = existingTagSet.has(r.tag);
            const cn = pickPrimaryChineseName(r);
            return (
              <button
                key={r.tag}
                type="button"
                disabled={added}
                onClick={(e) => { if (!added) onAdd(r.tag, e.shiftKey); }}
                className={`group shrink-0 inline-flex flex-col items-start text-left bg-transparent border-0 p-0
                  ${added ? 'cursor-default' : 'cursor-pointer'}`}
                title={r.wiki ? `${r.tag}\n${r.wiki}` : r.tag}
              >
                <span className={`font-tag text-[12px] leading-tight transition-colors
                  ${added
                    ? 'text-white/25 line-through'
                    : 'text-white/80 group-hover:text-[#fceda4] group-hover:underline underline-offset-2 decoration-[#fceda4]/60'}`}>
                  {r.tag}
                </span>
                {cn && (
                  <span className={`text-[10px] leading-tight transition-colors
                    ${added ? 'text-white/15' : 'text-white/40 group-hover:text-[#fceda4]/55'}`}>
                    {cn}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {showNav && (
        <button
          type="button"
          onClick={() => scrollByDir('right')}
          disabled={!canRight}
          className={`shrink-0 w-5 h-6 flex items-center justify-center transition-colors
            ${canRight ? 'text-[#fceda4]/60 hover:text-[#fceda4]' : 'text-white/15 cursor-not-allowed'}`}
          title="向右滚动"
        >
          <ChevronRight className="w-3.5 h-3.5" strokeWidth={2.5} />
        </button>
      )}
    </div>
  );
};
