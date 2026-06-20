// lucide icon → 静态 SVG 字符串缓存
// 用于 PromptEditor 的 tiptap nodeView (非 React 渲染上下文,需要 innerHTML 注入)
//
// 性能策略: 同 (iconName, size, strokeWidth) 三元组只渲染一次,
// 之后从 Map 读取。 模块加载时不预热,首次使用时按需缓存。

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getLucideIcon } from './registry';

const cache = new Map<string, string>();

export function getIconSvg(iconName: string, size = 13, strokeWidth = 2): string {
  const key = `${iconName}:${size}:${strokeWidth}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const Icon = getLucideIcon(iconName);
  if (!Icon) {
    cache.set(key, '');
    return '';
  }

  try {
    const svg = renderToStaticMarkup(createElement(Icon, { size, strokeWidth }));
    cache.set(key, svg);
    return svg;
  } catch (err) {
    console.warn('[iconSvgCache] failed to render', iconName, err);
    cache.set(key, '');
    return '';
  }
}

// 用于子分类新建/编辑时主动预热,避免首次插入折叠标签时的闪烁
export function warmUpIconCache(iconNames: Iterable<string>): void {
  for (const name of iconNames) {
    getIconSvg(name);
  }
}
