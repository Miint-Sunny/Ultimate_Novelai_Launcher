/**
 * 水印引擎(移植自 Novelai-harness,MIT):可见水印 + 智能选位 + 自动对比度 + DCT 盲水印。
 *
 * 核心全是裸 RGBA 上的纯函数,不碰 DOM,`scripts/check-watermark.mjs` 在 Node 里直接校验;
 * 浏览器解码 / 编码在 `browser.ts`,导出管道的接法见 `processImageForSave`。
 */

export type { RawRgbaImage, RgbaBytes, WatermarkConfig } from './types.ts';
export {
  DEFAULT_WATERMARK_CONFIG,
  WATERMARK_LIMITS,
  hasBlindWatermark,
  hasVisibleWatermark,
  isWatermarkActive,
  normalizeWatermarkConfig,
} from './types.ts';
export {
  blendWatermarkRect,
  premultiplyInPlace,
  resizeRgbaCubic,
  resizeRgbaCubicAlphaAware,
  unpremultiplyInPlace,
} from './rgba.ts';
export type { WatermarkPlacement } from './visible.ts';
export {
  applyAutoContrast,
  applyVisibleWatermark,
  findLowInformationPosition,
  resolveWatermarkPlacement,
  resolveWatermarkSize,
} from './visible.ts';
export {
  BLIND_PAIRS,
  BlindRng,
  FLAT_STEP_SCALE,
  TEXTURED_BLOCK_ENERGY,
  blindCapacityBlocks,
  blindStep,
  buildBlindPayload,
  crc16,
  dct8x8,
  decodeBlindPayload,
  embedBlindWatermark,
  extractBlindWatermark,
  idct8x8,
} from './blind.ts';
