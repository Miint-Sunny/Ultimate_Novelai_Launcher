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

// 默认模型与列表顺序解耦:即便列表顺序变了,默认也只跟着这个常量走。
//
// 默认为 V5 Full 是一次明确的产品决定(2026-08-28),不是「排在第一位所以成了默认」
// 的副作用——两者的区别在这里很重要,因为 V5 比 4.5 贵 1.5 倍,而且是唯一会消耗
// Opus「体力条」的模型族(4.5 及以下对 Opus 仍是无限)。这个代价由体力条 UI 与
// 成本徽章如实呈现给用户,而不是靠把默认压在旧模型上来回避。
export const DEFAULT_MODEL_ID = 'v5-full';

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

/**
 * 按模型族的能力位。结构照搬 NAI 官方前端 bundle 里那张 capability record——
 * 它把「这个模型能不能用某功能」集中成一张表,而不是散落的 `if (isV5)`。
 *
 * 这样组织的实际好处:V5 缺的 vibe / 精确参考是**暂时**缺的(官方说仍在训练),
 * 上线那天只要把对应位改成 true,所有消费方一起跟着亮,不必回头找散落的判断。
 */
export interface ModelCapabilities {
  /** 噪声调度可选:V5 隐藏选择器并强制 karras。 */
  noiseSchedule: boolean;
  /** Variety+(skip_cfg_above_sigma):V5 没有。 */
  varietyPlus: boolean;
  /** 同框角色上限:V4 系 6,V5 提到 32。 */
  maxCharacters: number;
  /** 角色位置是否自由浮点(V5)还是 5×5 网格(V4 系)。 */
  freeformCharacterPosition: boolean;
  /** 透明背景输出(straight_alpha + 三个透明词条)。 */
  transparency: boolean;
  /** Anime⇄Furry 数据集开关(V5 用它取代独立的 furry 模型)。 */
  furryMode: boolean;
  /** 氛围转移。V5 暂缺——官方后续会上,不是永久没有。 */
  vibeTransfer: boolean;
  /** 精确参考。V5 暂缺,同上。 */
  preciseReference: boolean;
  /** 是否消耗 Opus「体力条」:目前只有 V5。 */
  opusUsageLimit: boolean;
  /**
   * 文字渲染(引号内容翻译成 teXt: 块画进图里):V5 新增,V4 系没有。
   * 编辑器里的引号提示、载体检查与补全让路都问这一位,不写 if (isV5)。
   */
  textRendering: boolean;
  /**
   * 提示词 token 上限。V4 系 512;V5 Full 1471、V5 Curated 703——同一家族两个值,
   * 所以这一项按型号分,不按家族。
   *
   * 注意这是**软阈值**不是硬上限:超了照样出图,只是更费额度。所以 UI 用它做
   * 进度与提示,不拦截生成。
   *
   * 另注:V5 换成了 Qwen 分词器,而本地计数器仍是 T5/CLIP 口径,所以 V5 下的
   * 计数是近似值(见 docs_and_plan/v5-upgrade-plan.md 的 P7 backlog)。
   */
  maxPromptTokens: number;
}

const V5_CAPABILITIES: ModelCapabilities = {
  noiseSchedule: false,
  varietyPlus: false,
  maxCharacters: 32,
  freeformCharacterPosition: true,
  transparency: true,
  furryMode: true,
  vibeTransfer: false,
  preciseReference: false,
  opusUsageLimit: true,
  textRendering: true,
  maxPromptTokens: 1471,
};

// V5 Curated 的训练母体更小,token 上限也更低——除此之外能力位与 Full 相同。
const V5_CURATED_CAPABILITIES: ModelCapabilities = {
  ...V5_CAPABILITIES,
  maxPromptTokens: 703,
};

const LEGACY_CAPABILITIES: ModelCapabilities = {
  noiseSchedule: true,
  varietyPlus: true,
  maxCharacters: 6,
  freeformCharacterPosition: false,
  transparency: false,
  furryMode: false,
  vibeTransfer: true,
  preciseReference: true,
  opusUsageLimit: false,
  textRendering: false,
  maxPromptTokens: 512,
};

export function modelCapabilities(model: string): ModelCapabilities {
  if (!isV5Model(model)) return LEGACY_CAPABILITIES;
  const backendId = MODEL_MAP[model] ?? model;
  return backendId.includes('curated') ? V5_CURATED_CAPABILITIES : V5_CAPABILITIES;
}

/** 提示词 token 上限(软阈值)。UI 各处的 `/512` 都应问这里。 */
export function maxPromptTokensForModel(model: string): number {
  return modelCapabilities(model).maxPromptTokens;
}

/** 同框角色上限。UI 各处的「已满」判断都应问这里,不要再写死 6。 */
export function maxCharactersForModel(model: string): number {
  return modelCapabilities(model).maxCharacters;
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
