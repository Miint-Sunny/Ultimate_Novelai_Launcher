/**
 * 水印引擎的浏览器适配:图片解码 / 编码走 canvas,像素运算交给纯函数核心。
 *
 * 只有这一层碰 DOM;核心模块在 Node 里也能跑(`scripts/check-watermark.mjs`)。
 */

import { extractBlindWatermark } from './blind.ts';
import type { RawRgbaImage, WatermarkConfig } from './types.ts';
import { findLowInformationPosition, resolveWatermarkSize } from './visible.ts';

function loadImageElement(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  return new Promise<HTMLImageElement>((resolve, reject) => {
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = url;
  });
}

/** 把任意图片 URL(blob: / data: / http)解码成裸 RGBA。 */
export async function decodeImageUrlToRgba(url: string): Promise<RawRgbaImage> {
  const img = await loadImageElement(url);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { rgba: data.data, width: data.width, height: data.height };
}

let cachedLogoKey: string | null = null;
let cachedLogo: RawRgbaImage | null = null;

/** 解码水印 logo(data URL),同一张 logo 只解一次。 */
export async function loadWatermarkImage(dataUrl: string): Promise<RawRgbaImage> {
  if (cachedLogoKey === dataUrl && cachedLogo) return cachedLogo;
  const decoded = await decodeImageUrlToRgba(dataUrl);
  cachedLogoKey = dataUrl;
  cachedLogo = decoded;
  return decoded;
}

/**
 * 把裸 RGBA 编码成 Blob。jpg 没有 alpha,先把透明像素合到白底上,与现有的
 * `reEncodeImage` 保持同一口径。
 */
export async function rgbaToBlob(
  image: RawRgbaImage,
  format: 'png' | 'jpg' = 'png',
  quality = 0.92,
): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  const data = ctx.createImageData(image.width, image.height);
  if (format === 'jpg') {
    const src = image.rgba;
    const dst = data.data;
    for (let i = 0; i < src.length; i += 4) {
      const a = src[i + 3] / 255;
      dst[i] = Math.round(src[i] * a + 255 * (1 - a));
      dst[i + 1] = Math.round(src[i + 1] * a + 255 * (1 - a));
      dst[i + 2] = Math.round(src[i + 2] * a + 255 * (1 - a));
      dst[i + 3] = 255;
    }
  } else {
    data.data.set(image.rgba);
  }
  ctx.putImageData(data, 0, 0);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Failed to encode image'))),
      format === 'jpg' ? 'image/jpeg' : 'image/png',
      format === 'jpg' ? quality : undefined,
    );
  });
}

/** 从一张图里提取盲水印文本;没有水印返回 null。 */
export async function extractBlindWatermarkFromUrl(url: string): Promise<string | null> {
  const image = await decodeImageUrlToRgba(url);
  return extractBlindWatermark(image);
}

/**
 * 给「智能选位」按钮用:按当前 logo 长宽比与缩放 / 边距,在这张图上算出信息量最低的
 * 归一化位置,UI 把结果写回 posX / posY。没有 logo 时按 1:1 处理。
 */
export async function computeSmartWatermarkPosition(
  imageUrl: string,
  config: WatermarkConfig,
): Promise<{ x: number; y: number }> {
  const image = await decodeImageUrlToRgba(imageUrl);
  let aspect = 1;
  if (config.imageDataUrl) {
    try {
      const logo = await loadWatermarkImage(config.imageDataUrl);
      if (logo.width > 0) aspect = logo.height / logo.width;
    } catch {
      // logo 坏了就按方形算,选位仍然有意义
    }
  }
  const shortSide = Math.min(image.width, image.height);
  const marginPx = (shortSide * config.marginPercent) / 100;
  const { width, height } = resolveWatermarkSize(image.width, image.height, 1, aspect, config.scalePercent);
  return findLowInformationPosition(image, width, height, marginPx);
}
