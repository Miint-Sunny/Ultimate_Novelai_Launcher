/**
 * 助手 `inpaint_region` 的取景几何:归一化的框 → 源图像素 → 真正发出去的尺寸。
 *
 * 单独抽成纯模块(无 React、无 canvas、无 DOM)有两个理由:
 *
 * 1. **口径只有一处**。框是 0–1、相对**这张图本身**的像素,不是屏幕上显示的尺寸 ——
 *    画布摆位那条踩的就是这个坑(官方那个「没搞清楚分辨率」)。三条二期工具共用这一份。
 * 2. **估价能被钉住**。局部重绘按**实际发送的尺寸**计费:框先 64 对齐(API 硬要求),
 *    再按焦点重绘放大到约 100 万像素。照画布尺寸估价会把价报错,而这是一条计费路径,
 *    所以它必须能在 node 里被 `check:agent-tools` 直接加载断言,不能埋在组件里。
 */

import { alignSendRect, focusSendSize, type CropRect } from '../../utils/maskCrop.ts';
import type { InpaintRegionQuote, NormalizedBox } from '../../services/agentHarness/workbench.ts';

/** 框在源图上至少要有这么大:再小的框 64 对齐之后会被撑开,框本身就不作数了。 */
export const REGION_MIN_EDGE = 64;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** 归一化的框 → 源图像素矩形。越界贴边;贴完还是太小就返回 null(由调用方给理由)。 */
export function regionBoxToRect(box: NormalizedBox, width: number, height: number): CropRect | null {
  const left = Math.round(clamp01(box.x) * width);
  const top = Math.round(clamp01(box.y) * height);
  const right = Math.round(clamp01(box.x + box.w) * width);
  const bottom = Math.round(clamp01(box.y + box.h) * height);
  const w = right - left;
  const h = bottom - top;
  if (w < REGION_MIN_EDGE || h < REGION_MIN_EDGE) return null;
  return { x: left, y: top, width: w, height: h };
}

/**
 * 一次重绘的预估:框落在哪、实际会发多大。不碰图、不花钱。
 * 发送尺寸与重绘面板上显示价钱用的是同一个算法(InpaintOverlay 的 genDimensions)。
 */
export function quoteInpaintRegion(
  box: NormalizedBox,
  source: { width: number; height: number },
): InpaintRegionQuote {
  const rect = regionBoxToRect(box, source.width, source.height);
  if (!rect) {
    return {
      ok: false,
      reason: `框太小:换算到这张图(${source.width}×${source.height})上不足 ${REGION_MIN_EDGE}px,把 w / h 放大一些。`,
    };
  }
  const sent = focusSendSize(alignSendRect(rect, source.width, source.height));
  return {
    ok: true,
    source: { width: source.width, height: source.height },
    box: rect,
    send: { width: sent.width, height: sent.height },
  };
}
