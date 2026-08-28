export interface ModelOption {
  id: string;
  name: string;
  desc: string;
  /** 下拉分组:NAI 官方自 V5 起把 4.5 及以下整体标为 Legacy。 */
  group?: 'new' | 'legacy';
}

export const NAI_MODELS: ModelOption[] = [
  { id: 'v5-full', name: 'NovelAI V5 Full', desc: '最新旗舰模型，数据集最全，NSFW', group: 'new' },
  { id: 'v5-curated', name: 'NovelAI V5 Curated', desc: '最新精选版，风格更稳，SFW', group: 'new' },
  { id: 'v4.5-full', name: 'NovelAI V4.5 Full', desc: 'V4.5 模型，NSFW', group: 'legacy' },
  { id: 'v4.5-curated', name: 'NovelAI V4.5 Curated', desc: 'V4.5 精选版，SFW', group: 'legacy' },
  { id: 'v4-full', name: 'NovelAI V4 Full', desc: 'V4旧模型，NSFW', group: 'legacy' },
  { id: 'v4-curated-preview', name: 'NovelAI V4 Curated', desc: 'V4旧模型精选版，SFW', group: 'legacy' },
];

// 默认模型与列表顺序解耦:列表按官方 NEW → LEGACY 排,但默认仍是 V4.5 Full。
// V5 是当下旗舰,却有两点让它不适合无声地成为默认:单张 1.5 倍 Anlas,以及它
// 是唯一会消耗 Opus「体力条」的模型族(4.5 及以下对 Opus 仍是无限)。把默认换成
// V5 等于替用户动钱和额度,该是一次明确的产品决定,不是加模型的副作用。
export const DEFAULT_MODEL_ID = 'v4.5-full';

export function defaultModelOption(): ModelOption {
  return NAI_MODELS.find((m) => m.id === DEFAULT_MODEL_ID) ?? NAI_MODELS[0];
}

export const SD_MODELS: ModelOption[] = [
  { id: 'sd-xl', name: 'Stable Diffusion XL', desc: '高质量通用模型' },
  { id: 'sd-3', name: 'Stable Diffusion 3', desc: '最新架构' },
  { id: 'sd-1.5', name: 'Stable Diffusion 1.5', desc: '经典轻量模型' },
];

export const MODELS = NAI_MODELS;

export type ModelProvider = 'nai' | 'sd';

export const MODEL_PROVIDERS: { id: ModelProvider; label: string; models: ModelOption[] }[] = [
  { id: 'nai', label: 'NovelAI', models: NAI_MODELS },
  { id: 'sd', label: 'Stable Diffusion', models: SD_MODELS },
];

export const MODEL_MAP: Record<string, string> = {
  'v5-full': 'nai-diffusion-5-full',
  'v5-curated': 'nai-diffusion-5-curated',
  'v4.5-full': 'nai-diffusion-4-5-full',
  'v4.5-curated': 'nai-diffusion-4-5-curated',
  'v4-full': 'nai-diffusion-4-full',
  'v4-curated-preview': 'nai-diffusion-4-curated-preview',
  'v3': 'nai-diffusion-3',
  'sd-xl': 'stable-diffusion-xl',
  'sd-3': 'stable-diffusion-3',
  'sd-1.5': 'stable-diffusion-1-5',
};

/**
 * 是否 V5 家族。接受 UI id 与后端模型名,兼容 -inpainting 变体。
 *
 * `custom` 是 V5 公测期的暂存 id,官方 bundle 里与 V5 走同一分支,旧图元数据里
 * 还能见到,所以一并认成 V5——否则它会掉进 V4 形状的载荷里。
 */
export function isV5Model(model: string): boolean {
  const backendId = MODEL_MAP[model] ?? model;
  return backendId.startsWith('nai-diffusion-5') || backendId === 'custom';
}

export const MODEL_TO_ENCODING_KEY: Record<string, string> = {
  'nai-diffusion-4-full': 'v4full',
  'nai-diffusion-4-curated': 'v4curated',
  'nai-diffusion-4-curated-preview': 'v4curated',
  'nai-diffusion-4-5-full': 'v4-5full',
  'nai-diffusion-4-5-curated': 'v4-5curated',
  'nai-diffusion-3': 'v3',
};

export interface ResolutionPreset {
  label: string;
  width: number;
  height: number;
}

export const RESOLUTIONS: ResolutionPreset[] = [
  { label: '竖图', width: 832, height: 1216 },
  { label: '横图', width: 1216, height: 832 },
  { label: '方形', width: 1024, height: 1024 },
];

export const LARGE_RESOLUTIONS: ResolutionPreset[] = [
  { label: '竖图', width: 1024, height: 1536 },
  { label: '横图', width: 1536, height: 1024 },
  { label: '方形', width: 1472, height: 1472 },
];

export const WALLPAPER_RESOLUTIONS: ResolutionPreset[] = [
  { label: '竖图', width: 1088, height: 1920 },
  { label: '横图', width: 1920, height: 1088 },
  { label: '手机', width: 960, height: 2176 },
];

export const MOBILE_LARGE_RESOLUTIONS: ResolutionPreset[] = [
  { label: '大竖图', width: 1024, height: 1536 },
  { label: '大横图', width: 1536, height: 1024 },
  { label: '大方图', width: 1472, height: 1472 },
];

export const MOBILE_WALLPAPER_RESOLUTIONS: ResolutionPreset[] = [
  { label: '竖屏', width: 1088, height: 1920 },
  { label: '横屏', width: 1920, height: 1088 },
];

// 合法 steps 范围:当前各模型一致为 1–50(桌面 AISettingsPanel 与移动端高级设置
// 原本各自硬编码,此处收口为唯一来源);NAI 未按型号区分上限,若后续出现型号差异
// 在 stepsRangeForModel 内分档。
export const STEPS_RANGE = { min: 1, max: 50 } as const;

export const stepsRangeForModel = (_model: string): { min: number; max: number } => STEPS_RANGE;

export const getPixelCount = (width: number, height: number) => width * height;

export const MAX_TOTAL_PIXELS = 1024 * 3072;

export interface ClampedSize {
  width: number;
  height: number;
  changed: boolean;
  originalWidth: number;
  originalHeight: number;
}

export const clampToMaxPixels = (width: number, height: number): ClampedSize => {
  const originalWidth = width;
  const originalHeight = height;
  let normalizedWidth = Math.max(64, Math.round(width / 64) * 64);
  let normalizedHeight = Math.max(64, Math.round(height / 64) * 64);
  const pixels = getPixelCount(normalizedWidth, normalizedHeight);
  if (pixels <= MAX_TOTAL_PIXELS) {
    return {
      width: normalizedWidth,
      height: normalizedHeight,
      changed: normalizedWidth !== originalWidth || normalizedHeight !== originalHeight,
      originalWidth,
      originalHeight,
    };
  }

  const scale = Math.sqrt(MAX_TOTAL_PIXELS / pixels);
  normalizedWidth = Math.floor((normalizedWidth * scale) / 64) * 64;
  normalizedHeight = Math.floor((normalizedHeight * scale) / 64) * 64;
  if (normalizedWidth * normalizedHeight > MAX_TOTAL_PIXELS) {
    if (normalizedWidth >= normalizedHeight) {
      normalizedWidth = Math.floor((MAX_TOTAL_PIXELS / normalizedHeight) / 64) * 64;
    } else {
      normalizedHeight = Math.floor((MAX_TOTAL_PIXELS / normalizedWidth) / 64) * 64;
    }
  }
  normalizedWidth = Math.max(64, normalizedWidth);
  normalizedHeight = Math.max(64, normalizedHeight);
  return {
    width: normalizedWidth,
    height: normalizedHeight,
    changed: normalizedWidth !== originalWidth || normalizedHeight !== originalHeight,
    originalWidth,
    originalHeight,
  };
};
