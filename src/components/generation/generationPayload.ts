// 生成载荷装配层(纯模块:无 React、无 Tauri、无重服务导入)
// 逻辑自 left-sidebar/useGenerationRunner 原样抽取,桌面端行为必须逐字节不变;
// 桌面与移动两端各自以薄壳注入平台差异(提示词组装、回写回调、vibe 缓存策略),
// 共享以下同一份装配逻辑:
//   - 预设采样推导:ucPreset = activePresetId,qualityToggle = activePresetId === 'heavy'
//   - seed 策略:空字符串 = undefined(由后端摇种子)
//   - 生成前 clampToMaxPixels 分辨率兜底与 resolutionSource 追踪
//   - img2img / CR / 角色提示词 / vibe 引用的载荷组装
//   - inpaint 载荷组装(局部重绘 resolutionSource、skipHistory)
//
// vibe/CR/img2img 的图像处理函数(preparePreciseReferences / prepareVibeReferences /
// prepareImg2ImgParams,位于 ./generationReferences,牵连服务门面)以依赖注入方式传入,
// 使本模块保持纯数据组装、可直接被 node --experimental-strip-types 加载做对等校验。
// 本文件与 ./generationPrompts、./modelResolutionOptions 之间的相对导入显式使用 .ts
// 扩展名,正是为了让 Node 的 type stripping 无需额外 loader 即可解析(tsconfig 已开启
// allowImportingTsExtensions + erasableSyntaxOnly,Vite 同样兼容)。

import type { GenerateImageParams, Img2ImgParams, PreciseReferenceItem, VibeReference } from '../../services/novelai';
import type { VibeData } from '../../services/localLibrary';
import type { ActivePreciseRef } from '../cr';
import type { ActiveVibe } from '../vibe';
import { clampToMaxPixels, type ClampedSize } from './modelResolutionOptions.ts';
import {
  buildCharacterPromptParams,
  buildPromptPair,
  type CharacterPromptContent,
  type PromptPresetContent,
} from './generationPrompts.ts';

export interface SavedInpaintParams {
  imageBase64: string;
  maskBase64: string;
  strength: number;
  width: number;
  height: number;
}

export interface PromptPair {
  positive: string;
  negative: string;
}

export type PreparePromptPair = (prompts: {
  positivePrompt: string;
  negativePrompt: string;
  activePreset: PromptPresetContent | null | undefined;
}) => PromptPair | Promise<PromptPair>;

export type PrepareCharacterPrompts = (
  characterPrompts: CharacterPromptContent[]
) => GenerateImageParams['characterPrompts'];

export type FetchPublicVibeEncoding = (
  fileName: string,
  model: string,
  informationExtracted: number
) => Promise<string | null>;

export type RefreshActiveVibeEncodings = (vibeId: string, encodings: VibeData['encodings']) => void;

export type PreparePreciseReferences = (
  activePreciseRefs: ActivePreciseRef[]
) => Promise<PreciseReferenceItem[] | undefined>;

export type PrepareVibeReferences = (options: {
  activeVibes: ActiveVibe[];
  selectedModelId: string;
  vibeEncodingCache: Map<string, string>;
  fetchPublicVibeEncoding?: FetchPublicVibeEncoding;
  refreshActiveVibeEncodings?: RefreshActiveVibeEncodings;
  savePendingVibes?: boolean;
}) => Promise<VibeReference[] | undefined>;

export type PrepareImg2ImgParams = (options: {
  img2imgImage: string | null;
  width: number;
  height: number;
  strength: number;
  noise: number;
}) => Promise<Img2ImgParams | undefined>;

export interface BaseGenerationParamsInput {
  positivePrompt: string;
  negativePrompt: string;
  activePreset: PromptPresetContent | null | undefined;
  model: string;
  width: number;
  height: number;
  steps: number;
  scale: number;
  seed: string;
  sampler: string;
  cfgRescale: number;
  noiseSchedule: string;
  activePresetId: string;
  varietyPlus: boolean;
  normalizeVibeStrength: boolean;
  resolutionSource: string;
  characterPrompts: CharacterPromptContent[];
  activePreciseRefs: ActivePreciseRef[];
  activeVibes: ActiveVibe[];
  vibeEncodingCache: Map<string, string>;
  fetchPublicVibeEncoding?: FetchPublicVibeEncoding;
  refreshActiveVibeEncodings?: RefreshActiveVibeEncodings;
  savePendingVibes?: boolean;
  preparePromptPair?: PreparePromptPair;
  prepareCharacterPrompts?: PrepareCharacterPrompts;
  preparePreciseReferences: PreparePreciseReferences;
  prepareVibeReferences: PrepareVibeReferences;
}

// 对应桌面 useGenerationRunner 的 buildBaseGenerationParams:字段与取值逐一保持一致
// (ucPreset/qualityToggle 由 activePresetId 推导,seed 空串 → undefined)。
export async function buildBaseGenerationParams(input: BaseGenerationParamsInput): Promise<GenerateImageParams> {
  const preparePromptPair = input.preparePromptPair ?? buildPromptPair;
  const prepareCharacterPrompts = input.prepareCharacterPrompts ?? buildCharacterPromptParams;
  const { positive: finalPositive, negative: finalNegative } = await preparePromptPair({
    positivePrompt: input.positivePrompt,
    negativePrompt: input.negativePrompt,
    activePreset: input.activePreset,
  });
  const preciseReferences = await input.preparePreciseReferences(input.activePreciseRefs);
  const vibeReferences = await input.prepareVibeReferences({
    activeVibes: input.activeVibes,
    selectedModelId: input.model,
    vibeEncodingCache: input.vibeEncodingCache,
    fetchPublicVibeEncoding: input.fetchPublicVibeEncoding,
    refreshActiveVibeEncodings: input.refreshActiveVibeEncodings,
    savePendingVibes: input.savePendingVibes,
  });

  return {
    positivePrompt: finalPositive,
    negativePrompt: finalNegative,
    model: input.model,
    width: input.width,
    height: input.height,
    steps: input.steps,
    scale: input.scale,
    seed: input.seed ? parseInt(input.seed, 10) : undefined,
    sampler: input.sampler,
    cfgRescale: input.cfgRescale,
    noiseSchedule: input.noiseSchedule,
    ucPreset: input.activePresetId,
    qualityToggle: input.activePresetId === 'heavy',
    varietyPlus: input.varietyPlus,
    normalizeVibeStrength: input.normalizeVibeStrength,
    resolutionSource: input.resolutionSource,
    characterPrompts: prepareCharacterPrompts(input.characterPrompts),
    preciseReferences,
    vibeReferences,
  };
}

export interface AssembleGenerateParamsInput extends Omit<BaseGenerationParamsInput, 'resolutionSource'> {
  img2imgImage: string | null;
  img2imgStrength: number;
  img2imgNoise: number;
  prepareImg2ImgParams: PrepareImg2ImgParams;
  // 以下访问器复刻桌面壳里的 ref 读取/回写时点,保证副作用顺序与桌面原实现一致:
  // base 构建前读一次 resolutionSource,clamp 后如触发兜底则先回写再拼载荷,
  // 拼载荷前再次读取 resolutionSource 与 savedInpaint。
  readResolutionSource: () => string;
  applyClampedResolution?: (generationSize: ClampedSize, resolutionSource: string) => void;
  readSavedInpaint: () => SavedInpaintParams | null;
}

export interface AssembledGenerateParams {
  generateParams: GenerateImageParams;
  generationSize: ClampedSize;
  resolutionSource: string;
}

// 对应桌面 handleGenerate 的载荷装配段:base → clamp 兜底(含回写)→ img2img →
// savedInpaint 覆盖。平台专属的 UI 回写经 applyClampedResolution 注入。
export async function assembleGenerateParams(input: AssembleGenerateParamsInput): Promise<AssembledGenerateParams> {
  const base = await buildBaseGenerationParams({
    ...input,
    resolutionSource: input.readResolutionSource(),
  });
  const generationSize = clampToMaxPixels(input.width, input.height);
  if (generationSize.width !== input.width || generationSize.height !== input.height) {
    const resolutionSource = `${input.readResolutionSource()}；生成前兜底 ${input.width}×${input.height}`;
    input.applyClampedResolution?.(generationSize, resolutionSource);
  }

  const img2img = await input.prepareImg2ImgParams({
    img2imgImage: input.img2imgImage,
    width: generationSize.width,
    height: generationSize.height,
    strength: input.img2imgStrength,
    noise: input.img2imgNoise,
  });

  const savedInpaint = input.readSavedInpaint();
  const generateParams: GenerateImageParams = {
    ...base,
    width: generationSize.width,
    height: generationSize.height,
    resolutionSource: input.readResolutionSource(),
    img2img: savedInpaint ? undefined : img2img,
  };

  if (savedInpaint) {
    generateParams.width = savedInpaint.width;
    generateParams.height = savedInpaint.height;
    generateParams.inpaint = {
      imageBase64: savedInpaint.imageBase64,
      maskBase64: savedInpaint.maskBase64,
      strength: savedInpaint.strength,
    };
  }

  return {
    generateParams,
    generationSize,
    resolutionSource: generateParams.resolutionSource ?? input.readResolutionSource(),
  };
}

export interface AssembleInpaintParamsInput extends Omit<BaseGenerationParamsInput, 'resolutionSource'> {
  inpaint: {
    imageBase64: string;
    maskBase64: string;
    strength: number;
  };
  skipHistory: boolean;
}

// 对应桌面 handleInpaintGenerate 的载荷装配段:resolutionSource 固定为
// `局部重绘 ${width}×${height}`,载荷附带 inpaint 与 skipHistory。
export async function assembleInpaintParams(input: AssembleInpaintParamsInput): Promise<GenerateImageParams> {
  return {
    ...(await buildBaseGenerationParams({
      ...input,
      resolutionSource: `局部重绘 ${input.width}×${input.height}`,
    })),
    inpaint: {
      imageBase64: input.inpaint.imageBase64,
      maskBase64: input.inpaint.maskBase64,
      strength: input.inpaint.strength,
    },
    skipHistory: input.skipHistory,
  };
}
