import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * scroll edge(P7-1,方案 §4.2/§4.3):监听页滚动容器,scrollTop > 0 → scrolled = true,
 * 供 MobilePageHeader 在「顶部静止透明无边界 ↔ 滚动后均匀玻璃材质」两态间切换。
 *
 * 返回 callback ref 绑定到各页的滚动容器(生图页卡片列/创作室内容列/AI 页日志流等,
 * 容器各不相同):容器条件渲染或重挂载时自动卸下旧监听、挂上新监听。
 * 图库页当前无纵向滚动容器,绑定后 scrolled 恒 false(页头保持大标题态),属预期。
 */
export const useScrollEdge = <T extends HTMLElement = HTMLDivElement>() => {
  const [scrolled, setScrolled] = useState(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  const scrollRef = useCallback((node: T | null) => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    if (!node) {
      setScrolled(false);
      return;
    }
    const onScroll = () => setScrolled(node.scrollTop > 0);
    onScroll(); // 挂载即同步一次:容器带滚动位置重挂载时立即呈 scrolled 态
    node.addEventListener('scroll', onScroll, { passive: true });
    cleanupRef.current = () => node.removeEventListener('scroll', onScroll);
  }, []);

  // 组件卸载时兜底卸下监听
  useEffect(() => () => cleanupRef.current?.(), []);

  return { scrolled, scrollRef };
};
