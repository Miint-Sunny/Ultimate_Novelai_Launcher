/**
 * 水印引擎的配置与像素类型。
 *
 * 移植自 Novelai-harness(MIT)的 `WatermarkConfig` / `WatermarkService`:字段名、默认值
 * 与 JSON 键和他保持一致,这样他导出的配置能直接读进来,盲水印也能互相提取。
 * 与他唯一不同的是 logo 的存放:他存文件路径 + 字节,浏览器没有文件路径,我们存 data URL。
 */

/** 裸 RGBA 像素缓冲,像素下标 `(y * width + x) * 4`,没有隐式 alpha 语义。 */
export type RgbaBytes = Uint8Array | Uint8ClampedArray;

export interface RawRgbaImage {
  rgba: RgbaBytes;
  width: number;
  height: number;
}

export interface WatermarkConfig {
  /** 可见水印开关。 */
  enabled: boolean;
  /** 水印图(logo)的 data: URL;null = 还没选。 */
  imageDataUrl: string | null;
  /** 水印相对位置 X(0 = 左,1 = 右;默认 1 右下)。 */
  posX: number;
  /** 水印相对位置 Y(0 = 顶,1 = 底;默认 1 右下)。 */
  posY: number;
  /** 水印宽度占底图短边的百分比(1–100,默认 15)。 */
  scalePercent: number;
  /** 不透明度(0–1,默认 0.8)。 */
  opacity: number;
  /** 边距占短边的百分比(0–50,默认 2)。 */
  marginPercent: number;
  /** 自动对比度:按水印下方背景亮度把水印压暗或提亮。 */
  autoContrast: boolean;
  /** 智能选位:每次合成时找信息量最低的位置放水印(覆盖 posX / posY)。 */
  autoPosition: boolean;
  /** 盲水印开关(DCT 频域隐形水印,肉眼不可见)。 */
  blindEnabled: boolean;
  /** 盲水印载荷文本(签名 / 版权信息)。 */
  blindText: string;
  /** 盲水印强度 1–5,越高越抗压缩,画质扰动略增(默认 3)。 */
  blindStrength: number;
}

export const DEFAULT_WATERMARK_CONFIG: WatermarkConfig = {
  enabled: false,
  imageDataUrl: null,
  posX: 1,
  posY: 1,
  scalePercent: 15,
  opacity: 0.8,
  marginPercent: 2,
  autoContrast: false,
  autoPosition: false,
  blindEnabled: false,
  blindText: '',
  blindStrength: 3,
};

export const WATERMARK_LIMITS = {
  scalePercent: { min: 1, max: 100 },
  opacity: { min: 0, max: 1 },
  marginPercent: { min: 0, max: 50 },
  blindStrength: { min: 1, max: 5 },
  /** 盲水印载荷上限:两字节长度域。 */
  blindTextBytes: 0xffff,
  /** logo data URL 的字符上限(约 1.5 MB 的 PNG),设置存 localStorage,不能无限大。 */
  imageDataUrlChars: 2_000_000,
} as const;

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * 把任意来源的 JSON(旧设置、他的导出)整理成合法配置:缺键补默认,数值钳到范围,
 * 非法类型回默认。`imagePath`(他的字段)不认识就丢掉,只读 `imageDataUrl`。
 */
export function normalizeWatermarkConfig(input: unknown): WatermarkConfig {
  const d = DEFAULT_WATERMARK_CONFIG;
  if (!input || typeof input !== 'object') return { ...d };
  const raw = input as Record<string, unknown>;
  const imageDataUrl = typeof raw.imageDataUrl === 'string'
    && raw.imageDataUrl.startsWith('data:image/')
    && raw.imageDataUrl.length <= WATERMARK_LIMITS.imageDataUrlChars
    ? raw.imageDataUrl
    : null;
  const blindStrength = Math.round(
    clampNumber(raw.blindStrength, d.blindStrength, WATERMARK_LIMITS.blindStrength.min, WATERMARK_LIMITS.blindStrength.max),
  );
  return {
    enabled: readBoolean(raw.enabled, d.enabled),
    imageDataUrl,
    posX: clampNumber(raw.posX, d.posX, 0, 1),
    posY: clampNumber(raw.posY, d.posY, 0, 1),
    scalePercent: clampNumber(raw.scalePercent, d.scalePercent, WATERMARK_LIMITS.scalePercent.min, WATERMARK_LIMITS.scalePercent.max),
    opacity: clampNumber(raw.opacity, d.opacity, WATERMARK_LIMITS.opacity.min, WATERMARK_LIMITS.opacity.max),
    marginPercent: clampNumber(raw.marginPercent, d.marginPercent, WATERMARK_LIMITS.marginPercent.min, WATERMARK_LIMITS.marginPercent.max),
    autoContrast: readBoolean(raw.autoContrast, d.autoContrast),
    autoPosition: readBoolean(raw.autoPosition, d.autoPosition),
    blindEnabled: readBoolean(raw.blindEnabled, d.blindEnabled),
    blindText: typeof raw.blindText === 'string' ? raw.blindText : d.blindText,
    blindStrength,
  };
}

/** 可见水印真的会画上去:开关开着并且选了 logo。 */
export function hasVisibleWatermark(config: WatermarkConfig): boolean {
  return config.enabled && Boolean(config.imageDataUrl);
}

/** 盲水印真的会嵌:开关开着并且载荷非空。 */
export function hasBlindWatermark(config: WatermarkConfig): boolean {
  return config.blindEnabled && config.blindText.trim().length > 0;
}

/** 导出时是否需要走水印管道(任一种水印生效)。 */
export function isWatermarkActive(config: WatermarkConfig): boolean {
  return hasVisibleWatermark(config) || hasBlindWatermark(config);
}
