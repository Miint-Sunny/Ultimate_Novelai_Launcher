/**
 * 可见水印:缩放 → 选位(固定 / 智能)→ 自动对比度 → 不透明度 → 合成。
 *
 * 移植自 Novelai-harness(MIT)`WatermarkService` 的可见水印部分,几何公式与他的画板
 * 交互层一致(`left = margin + avail × pos`),UI 预览可以直接复用 `resolveWatermarkPlacement`。
 */

import { blendWatermarkRect, resizeRgbaCubicAlphaAware } from './rgba.ts';
import type { RawRgbaImage, RgbaBytes, WatermarkConfig } from './types.ts';

export interface WatermarkPlacement {
  /** 水印落点(像素,左上角)。 */
  x: number;
  y: number;
  /** 水印实际尺寸(像素,已按短边比例与 contain 钳制)。 */
  width: number;
  height: number;
  marginPx: number;
  /** 最终采用的归一化位置(智能选位时是算法算出来的)。 */
  posX: number;
  posY: number;
}

function luma(rgba: RgbaBytes, i: number): number {
  return 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 水印目标尺寸:宽 = 短边 × scale%,高按长宽比,高度超过底图时 contain 钳制。 */
export function resolveWatermarkSize(
  baseWidth: number,
  baseHeight: number,
  wmWidth: number,
  wmHeight: number,
  scalePercent: number,
): { width: number; height: number } {
  const shortSide = Math.min(baseWidth, baseHeight);
  const targetW = Math.min(baseWidth, Math.max(1, Math.round((shortSide * scalePercent) / 100)));
  const aspect = wmHeight / wmWidth;
  let height = Math.max(1, Math.round(targetW * aspect));
  let width = targetW;
  if (height > baseHeight) {
    height = baseHeight;
    width = Math.min(targetW, Math.max(1, Math.round(baseHeight / aspect)));
  }
  return { width, height };
}

/**
 * 在图像里找信息量最低的水印落点(归一化 posX / posY,语义同 WatermarkConfig)。
 *
 * 降采样到最长边 480 后算亮度梯度能量积分图,32×32 网格滑窗评估每个候选矩形
 * (水印尺寸 + 边距约束)的梯度总能量,取最低者:细节最少、对画面干扰最小的平坦区。
 */
export function findLowInformationPosition(
  image: RawRgbaImage,
  wmW: number,
  wmH: number,
  marginPx: number,
): { x: number; y: number } {
  const imgW = image.width;
  const imgH = image.height;
  if (imgW < 8 || imgH < 8) return { x: 1, y: 1 };

  const maxSide = 480;
  const scale = Math.min(1, maxSide / Math.max(imgW, imgH));
  const w = Math.max(8, Math.round(imgW * scale));
  const h = Math.max(8, Math.round(imgH * scale));
  const lumaMap = new Float64Array(w * h);
  const src = image.rgba;
  for (let y = 0; y < h; y += 1) {
    const y0 = Math.floor((y * imgH) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * imgH) / h));
    for (let x = 0; x < w; x += 1) {
      const x0 = Math.floor((x * imgW) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * imgW) / w));
      let sum = 0;
      let count = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          sum += luma(src, (sy * imgW + sx) * 4);
          count += 1;
        }
      }
      lumaMap[y * w + x] = sum / count;
    }
  }

  const stride = w + 1;
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y += 1) {
    let rowSum = 0;
    for (let x = 0; x < w; x += 1) {
      const gx = x + 1 < w ? Math.abs(lumaMap[y * w + x + 1] - lumaMap[y * w + x]) : 0;
      const gy = y + 1 < h ? Math.abs(lumaMap[(y + 1) * w + x] - lumaMap[y * w + x]) : 0;
      rowSum += gx + gy;
      integral[(y + 1) * stride + (x + 1)] = integral[y * stride + (x + 1)] + rowSum;
    }
  }
  const rectSum = (x0: number, y0: number, x1: number, y1: number): number => {
    const cx0 = Math.min(w, Math.max(0, x0));
    const cx1 = Math.min(w, Math.max(0, x1));
    const cy0 = Math.min(h, Math.max(0, y0));
    const cy1 = Math.min(h, Math.max(0, y1));
    if (cx1 <= cx0 || cy1 <= cy0) return 0;
    return integral[cy1 * stride + cx1] - integral[cy0 * stride + cx1] - integral[cy1 * stride + cx0] + integral[cy0 * stride + cx0];
  };

  const sWmW = Math.max(1, Math.round(wmW * scale));
  const sWmH = Math.max(1, Math.round(wmH * scale));
  const sMargin = marginPx * scale;
  const availW = Math.floor(w - 2 * sMargin - sWmW);
  const availH = Math.floor(h - 2 * sMargin - sWmH);
  if (availW < 0 || availH < 0) return { x: 1, y: 1 };

  const steps = 32;
  let bestScore = Number.POSITIVE_INFINITY;
  let bestLeft = sMargin;
  let bestTop = sMargin;
  for (let iy = 0; iy <= steps; iy += 1) {
    const top = sMargin + (availH * iy) / steps;
    for (let ix = 0; ix <= steps; ix += 1) {
      const left = sMargin + (availW * ix) / steps;
      const score = rectSum(Math.round(left), Math.round(top), Math.round(left + sWmW), Math.round(top + sWmH));
      if (score < bestScore) {
        bestScore = score;
        bestLeft = left;
        bestTop = top;
      }
    }
  }
  const posX = availW > 0 ? (bestLeft - sMargin) / availW : 0;
  const posY = availH > 0 ? (bestTop - sMargin) / availH : 0;
  return { x: clamp01(posX), y: clamp01(posY) };
}

/** 计算水印的落点与尺寸;`autoPosition` 时在底图上跑智能选位。 */
export function resolveWatermarkPlacement(
  base: RawRgbaImage,
  wmWidth: number,
  wmHeight: number,
  config: WatermarkConfig,
): WatermarkPlacement {
  const shortSide = Math.min(base.width, base.height);
  const marginPx = (shortSide * config.marginPercent) / 100;
  const { width, height } = resolveWatermarkSize(base.width, base.height, wmWidth, wmHeight, config.scalePercent);
  const availW = Math.max(0, base.width - 2 * marginPx - width);
  const availH = Math.max(0, base.height - 2 * marginPx - height);
  let posX = clamp01(config.posX);
  let posY = clamp01(config.posY);
  if (config.autoPosition) {
    const smart = findLowInformationPosition(base, width, height, marginPx);
    posX = smart.x;
    posY = smart.y;
  }
  return {
    x: Math.round(marginPx + availW * posX),
    y: Math.round(marginPx + availH * posY),
    width,
    height,
    marginPx,
    posX,
    posY,
  };
}

/**
 * 自动对比度:统计水印覆盖区域的背景平均亮度,把水印颜色向反色方向偏移 65%。
 * 背景偏亮(> 0.55)→ 压暗;偏暗 → 提亮。只动不透明像素。
 */
export function applyAutoContrast(
  base: RawRgbaImage,
  wmRgba: RgbaBytes,
  wmW: number,
  wmH: number,
  dstX: number,
  dstY: number,
): void {
  let lumaSum = 0;
  let sampleCount = 0;
  for (let y = dstY; y < dstY + wmH; y += 2) {
    if (y < 0 || y >= base.height) continue;
    for (let x = dstX; x < dstX + wmW; x += 2) {
      if (x < 0 || x >= base.width) continue;
      lumaSum += luma(base.rgba, (y * base.width + x) * 4);
      sampleCount += 1;
    }
  }
  if (sampleCount === 0) return;
  const meanLuma = lumaSum / sampleCount / 255;
  const strength = 0.65;
  const targetChannel = meanLuma > 0.55 ? 0 : 255;
  for (let i = 0; i < wmRgba.length; i += 4) {
    if (wmRgba[i + 3] === 0) continue;
    for (let c = 0; c < 3; c += 1) {
      const v = Math.round(wmRgba[i + c] * (1 - strength) + targetChannel * strength);
      wmRgba[i + c] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
}

/**
 * 合成可见水印,返回新的像素缓冲(底图不动)。
 * 顺序:缩放(预乘插值防光晕)→ 选位 → 自动对比度 → 不透明度 → src-over 合成。
 */
export function applyVisibleWatermark(
  base: RawRgbaImage,
  watermark: RawRgbaImage,
  config: WatermarkConfig,
): { image: RawRgbaImage; placement: WatermarkPlacement } {
  const placement = resolveWatermarkPlacement(base, watermark.width, watermark.height, config);
  const resized = resizeRgbaCubicAlphaAware(
    watermark.rgba,
    watermark.width,
    watermark.height,
    placement.width,
    placement.height,
  );
  if (config.autoContrast) {
    applyAutoContrast(base, resized, placement.width, placement.height, placement.x, placement.y);
  }
  if (config.opacity < 1) {
    const alphaFactor = clamp01(config.opacity);
    for (let i = 3; i < resized.length; i += 4) {
      resized[i] = Math.round(resized[i] * alphaFactor);
    }
  }
  const out = new Uint8Array(base.rgba);
  blendWatermarkRect(out, base.width, base.height, resized, placement.width, placement.height, placement.x, placement.y);
  return { image: { rgba: out, width: base.width, height: base.height }, placement };
}
