import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 把横向翻页容器的宽度钉成**整数 CSS 像素**。
 *
 * 为什么要这一层:分页轨道是「轨道宽 = 页数 × 100%,每页 = 100 / 页数 %」那套百分比算法。
 * 容器宽度只要带小数(窗格随手拖出来的宽度、缩放、某些 DPR 组合都会),每页宽度跟着带小数,
 * 相邻页的边缘就会被舍入到可见 —— 屏幕左边缘露出上一张图的一条竖缝、缩略图条的第一张被切半
 * (用户 2026-09-21 截图)。整除的宽度(比如 375)上又看不见,所以它时有时无,很难查。
 *
 * 做法是把容器自己钉成 floor(实测宽度):右边最多剩不到 1px 的背景色,肉眼看不出来,
 * 而所有页从此都是整数宽,缝没有了。用 ResizeObserver 跟随窗口 / 窗格变化。
 *
 * 只钉宽度,不碰高度与 transform —— 翻页逻辑一行不用改。
 */
export function useIntegerTrackWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState<number | null>(null);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // 量的是内容盒子:自己已经被钉过宽度时,要拿它实际占的宽来判断有没有变化。
    const next = Math.floor(el.getBoundingClientRect().width);
    setWidth((prev) => (prev === next ? prev : next));
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 先用父级的宽度起步:自己还没被钉宽度时,两者相同。
    const parent = el.parentElement;
    const read = () => {
      const box = parent ?? el;
      const next = Math.floor(box.getBoundingClientRect().width);
      setWidth((prev) => (prev === next ? prev : next));
    };
    read();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', read);
      return () => window.removeEventListener('resize', read);
    }
    const ro = new ResizeObserver(read);
    ro.observe(parent ?? el);
    return () => ro.disconnect();
  }, [measure]);

  return { ref, width } as const;
}
