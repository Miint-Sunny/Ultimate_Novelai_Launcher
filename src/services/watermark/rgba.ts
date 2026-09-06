/**
 * 裸 RGBA 像素运算:预乘、Catmull-Rom 双三次缩放、水印矩形合成。
 *
 * 移植自 Novelai-harness(MIT)的 `rgba_pixel_ops.dart`。不依赖 DOM,Node 里能直接跑校验。
 */

import type { RgbaBytes } from './types.ts';

/** 原地预乘 alpha(仅 a < 255 的像素变动):RGB = RGB × A / 255。 */
export function premultiplyInPlace(rgba: RgbaBytes): void {
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3];
    if (a === 255) continue;
    if (a === 0) {
      rgba[i] = 0;
      rgba[i + 1] = 0;
      rgba[i + 2] = 0;
      continue;
    }
    rgba[i] = Math.floor((rgba[i] * a + 127) / 255);
    rgba[i + 1] = Math.floor((rgba[i + 1] * a + 127) / 255);
    rgba[i + 2] = Math.floor((rgba[i + 2] * a + 127) / 255);
  }
}

/** 原地反预乘 alpha(仅 0 < A < 255 的像素变动):RGB = RGB × 255 / A。 */
export function unpremultiplyInPlace(rgba: RgbaBytes): void {
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3];
    if (a === 0 || a === 255) continue;
    const half = Math.floor(a / 2);
    rgba[i] = Math.min(255, Math.floor((rgba[i] * 255 + half) / a));
    rgba[i + 1] = Math.min(255, Math.floor((rgba[i + 1] * 255 + half) / a));
    rgba[i + 2] = Math.min(255, Math.floor((rgba[i + 2] * 255 + half) / a));
  }
}

/** Catmull-Rom 插值核(|d| <= 2)。 */
function catmullRom(d: number): number {
  const a = Math.abs(d);
  if (a <= 1) return 1.5 * a * a * a - 2.5 * a * a + 1;
  if (a < 2) return -0.5 * a * a * a + 2.5 * a * a - 4 * a + 2;
  return 0;
}

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

function resampleAxis(
  src: RgbaBytes,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
  horizontal: boolean,
): Uint8Array {
  const out = new Uint8Array(dw * dh * 4);
  const srcLen = horizontal ? sw : sh;
  const dstLen = horizontal ? dw : dh;
  const rowLen = horizontal ? sh : dw;
  const taps = [0, 0, 0, 0];
  const weights = [0, 0, 0, 0];
  for (let d0 = 0; d0 < dstLen; d0 += 1) {
    // 目标像素中心映射回源坐标
    const center = ((d0 + 0.5) * srcLen) / dstLen - 0.5;
    const base = Math.floor(center);
    let wsum = 0;
    for (let k = 0; k < 4; k += 1) {
      const tap = base - 1 + k;
      weights[k] = catmullRom(center - tap);
      taps[k] = tap < 0 ? 0 : tap > srcLen - 1 ? srcLen - 1 : tap;
      wsum += weights[k];
    }
    for (let d1 = 0; d1 < rowLen; d1 += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let k = 0; k < 4; k += 1) {
        const w = weights[k] / wsum;
        if (w === 0) continue;
        const i = horizontal ? (d1 * sw + taps[k]) * 4 : (taps[k] * sw + d1) * 4;
        r += src[i] * w;
        g += src[i + 1] * w;
        b += src[i + 2] * w;
        a += src[i + 3] * w;
      }
      const o = horizontal ? (d1 * dw + d0) * 4 : (d0 * dw + d1) * 4;
      out[o] = clampByte(r);
      out[o + 1] = clampByte(g);
      out[o + 2] = clampByte(b);
      out[o + 3] = clampByte(a);
    }
  }
  return out;
}

/** 分离式 Catmull-Rom 双三次缩放(四通道同核,边缘钳制)。尺寸不变时原样返回。 */
export function resizeRgbaCubic(src: RgbaBytes, sw: number, sh: number, dw: number, dh: number): RgbaBytes {
  if (sw === dw && sh === dh) return src;
  const mid = resampleAxis(src, sw, sh, dw, sh, true);
  return resampleAxis(mid, dw, sh, dw, dh, false);
}

/**
 * 带 alpha 的缩放:预乘 → Catmull-Rom → 反预乘。
 * 直接对非预乘 RGBA 插值会让透明区携带的 RGB 垃圾值渗进半透明边缘形成光晕。
 */
export function resizeRgbaCubicAlphaAware(src: RgbaBytes, sw: number, sh: number, dw: number, dh: number): Uint8Array {
  const premul = new Uint8Array(src);
  if (sw === dw && sh === dh) return premul;
  premultiplyInPlace(premul);
  const resized = new Uint8Array(resizeRgbaCubic(premul, sw, sh, dw, dh));
  unpremultiplyInPlace(resized);
  return resized;
}

/**
 * 把水印矩形以 src-over 合成进底图,越界裁剪。
 *
 * 与 harness 的差别只在 alpha 通道:他四通道同式混合,不透明底图上会留下半透明的洞;
 * 这里 RGB 按 src-over,alpha 在底图像素 ≥ 254 时保持原值(NAI 的隐写元数据放在
 * alpha 的最低位,原图模式导出时得留住),其余按 src-over 合成。
 */
export function blendWatermarkRect(
  dst: RgbaBytes,
  dstWidth: number,
  dstHeight: number,
  src: RgbaBytes,
  srcWidth: number,
  srcHeight: number,
  dstX: number,
  dstY: number,
): void {
  for (let y = 0; y < srcHeight; y += 1) {
    const dy = dstY + y;
    if (dy < 0 || dy >= dstHeight) continue;
    for (let x = 0; x < srcWidth; x += 1) {
      const dx = dstX + x;
      if (dx < 0 || dx >= dstWidth) continue;
      const s = (y * srcWidth + x) * 4;
      const d = (dy * dstWidth + dx) * 4;
      const sa = src[s + 3] / 255;
      if (sa <= 0) continue;
      const da = dst[d + 3] / 255;
      const outA = sa + da * (1 - sa);
      if (outA <= 0) continue;
      for (let c = 0; c < 3; c += 1) {
        const value = (src[s + c] * sa + dst[d + c] * da * (1 - sa)) / outA;
        dst[d + c] = clampByte(value);
      }
      if (dst[d + 3] < 254) dst[d + 3] = clampByte(outA * 255);
    }
  }
}
