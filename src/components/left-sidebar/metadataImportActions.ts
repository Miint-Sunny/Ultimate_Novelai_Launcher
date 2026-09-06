import type React from 'react';
import { normalizeNoiseSchedule, samplerIdToLabel } from '../../utils/generationOptions';
import {
  LARGE_RESOLUTIONS,
  MODELS,
  RESOLUTIONS,
  WALLPAPER_RESOLUTIONS,
  clampToMaxPixels,
  type ClampedSize,
  type ModelOption,
  type ResolutionPreset,
} from '../generation/modelResolutionOptions';
import { stripAutoText } from '../../utils/autoText';
import { collapsePromptChunks } from '../../services/promptChunkMacros';
import { getCachedPromptChunks } from '../../services/promptChunkCache';
import type { MetadataVibeInput } from './metadataVibeImport';

export interface MetadataImportPayload {
  prompt: string;
  negativePrompt: string;
  source?: string;
  sourceType?: string;
  width?: number;
  height?: number;
  seed?: string | number;
  steps?: string | number;
  scale?: string | number;
  sampler?: string;
  noiseSchedule?: string;
  cfgRescale?: string | number;
  characterPrompts?: Array<{ prompt: string; uc?: string; center?: { x: number; y: number } }>;
  /** 原图的 v4_prompt.use_coords;老元数据没有。 */
  useCoords?: boolean;
  vibes?: MetadataVibeInput[];
}

export interface MetadataImportOptions {
  prompt: boolean;
  negativePrompt: boolean;
  characters: boolean;
  appendCharacters: boolean;
  settings: boolean;
  seed: boolean;
  vibes: boolean;
  cleanImports: boolean;
}

// 按「越具体越靠前」排,命中即停。
//
// ⚠ 匹配的是 **imageMetadata 归一化之后的显示名**,不是 PNG 里的原始 Source 串。
// 原始串形如 `NovelAI Diffusion V5 0ADF9AB7`,但只要它在 imageMetadata 的
// modelNameMap 里命中,到这里就已经变成 `NovelAI V5 Full` 了;没命中则被正则
// 压成 `NovelAI V5`,哈希整个丢掉。所以这里写哈希关键词是没用的 ——
// 曾经就是这样:V5 只有一条哈希关键词,结果导入 V5 图片一条都不中、
// 不切模型也不报错。要认新哈希,补的是 imageMetadata 那张表。
//
// V5 的 Source 串不像 V4 系那样写 Full/Curated,只有版本号加权重哈希,
// 所以未知哈希只能落到最后那条兜底,按 Full 处理。
export const MODEL_MATCH_MAP: Array<{ keywords: string[]; modelName: string }> = [
  { keywords: ['v5 full'], modelName: 'NovelAI V5 Full' },
  { keywords: ['v5 curated'], modelName: 'NovelAI V5 Curated' },
  // 兜底:未知哈希被压成 `NovelAI V5`,归到 Full。
  { keywords: ['v5'], modelName: 'NovelAI V5 Full' },
  { keywords: ['v4.5 full', 'v4.5 4bde'], modelName: 'NovelAI V4.5 Full' },
  { keywords: ['v4.5 curated', 'v4.5 c02d'], modelName: 'NovelAI V4.5 Curated' },
  { keywords: ['v4 full', 'v4 44fd'], modelName: 'NovelAI V4 Full' },
  { keywords: ['v4 curated', 'v4 c5e5'], modelName: 'NovelAI V4 Curated Preview' },
  // 这行此前把 V3 的哈希写成了 modelName: 'NovelAI V5',是笔误。改回 V3 后它
  // 仍然不会命中任何东西——下拉里本来就不提供 V3——但至少这张表现在是诚实的,
  // 不会在真的 V5 出现后被误读成「已经支持 V5 导入」。
  { keywords: ['v3', 'f4d5'], modelName: 'NovelAI V3' },
];

/**
 * 导入时要往输入框里放的正向提示词。
 *
 * 图片元数据记的是**发出去那一份**,里面可能带着 autoText 自动加的 `teXt:` 块。
 * 直接塞进输入框,用户看到的就不是自己写的东西了;再生成一次还会在旧块上再叠一个。
 * 所以这里剥掉自动块 —— 但只剥**算得出来**的那一个:stripAutoText 会拿同一批角色
 * 重算一遍,对不上就原样保留,所以别人家客户端写的块、或用户手改过的块都不会被吃掉。
 *
 * 然后把与片段正文相同的子串折回 `!macro:名字!` 引用(官方导入也这么做:片段不进
 * 元数据,导入时按正文认回来)。片段库读的是同步快照,还没加载到就不折叠,不会等。
 *
 * 元数据详情那边**不做**这一步:那个视图要如实显示发出去的原文。
 */
export function importedPositivePrompt(metadata: {
  // 结构最小集:移动端那条链路带的是一份更窄的本地类型(prompt 可选),
  // 两端都能喂进来才不用为此再造一个转换层。
  prompt?: string;
  characterPrompts?: Array<{ prompt: string; center?: { x: number; y: number } }>;
  useCoords?: boolean;
}): string {
  const characters = metadata.characterPrompts ?? [];
  const stripped = stripAutoText(metadata.prompt ?? '', {
    characters: characters.map((character) => ({ prompt: character.prompt, center: character.center })),
    // 用原图记下来的 use_coords。老元数据没这个字段时才退回「有角色就按坐标排」,
    // 那正是我们 2026-08 之前一直发的取值,所以旧图剥离结果不变。
    useCoords: metadata.useCoords ?? characters.length > 0,
  });
  return collapsePromptChunks(stripped, getCachedPromptChunks());
}

export function applyImportedModel(
  metadata: MetadataImportPayload,
  setSelectedModel: React.Dispatch<React.SetStateAction<ModelOption>>,
) {
  if (!metadata.source || metadata.sourceType !== 'novelai') return;
  const source = metadata.source.toLowerCase();

  for (const entry of MODEL_MATCH_MAP) {
    if (entry.keywords.some(keyword => source.includes(keyword))) {
      const matched = MODELS.find(model => model.name === entry.modelName);
      if (matched) setSelectedModel(matched);
      break;
    }
  }
}

export function applyImportedResolution({
  metadata,
  resolutionSourceRef,
  reportResolutionNormalization,
  setResolution,
  setCustomWidth,
  setCustomHeight,
  setCustomWidthInput,
  setCustomHeightInput,
  setIsCustomRes,
}: {
  metadata: MetadataImportPayload;
  resolutionSourceRef: React.MutableRefObject<string>;
  reportResolutionNormalization: (source: string, result: ClampedSize) => void;
  setResolution: React.Dispatch<React.SetStateAction<ResolutionPreset>>;
  setCustomWidth: React.Dispatch<React.SetStateAction<number>>;
  setCustomHeight: React.Dispatch<React.SetStateAction<number>>;
  setCustomWidthInput: React.Dispatch<React.SetStateAction<string>>;
  setCustomHeightInput: React.Dispatch<React.SetStateAction<string>>;
  setIsCustomRes: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  if (!metadata.width || !metadata.height || metadata.width <= 0 || metadata.height <= 0) return;
  const safeSize = clampToMaxPixels(metadata.width, metadata.height);
  resolutionSourceRef.current = `导入PNG元数据 ${metadata.width}×${metadata.height}`;
  reportResolutionNormalization('导入PNG元数据', safeSize);

  const allPresets = [...RESOLUTIONS, ...LARGE_RESOLUTIONS, ...WALLPAPER_RESOLUTIONS];
  const matchedRes = allPresets.find(res => res.width === safeSize.width && res.height === safeSize.height);
  if (matchedRes) {
    setResolution(matchedRes);
    setCustomWidth(matchedRes.width);
    setCustomHeight(matchedRes.height);
    setCustomWidthInput(String(matchedRes.width));
    setCustomHeightInput(String(matchedRes.height));
    setIsCustomRes(false);
    return;
  }

  setCustomWidth(safeSize.width);
  setCustomHeight(safeSize.height);
  setCustomWidthInput(String(safeSize.width));
  setCustomHeightInput(String(safeSize.height));
  setResolution({ label: '自定义', width: safeSize.width, height: safeSize.height });
  setIsCustomRes(true);
}

export function applyImportedSettings({
  metadata,
  setSteps,
  setScale,
  setSampler,
  setScaleRescale,
  setNoiseSchedule,
}: {
  metadata: MetadataImportPayload;
  setSteps: React.Dispatch<React.SetStateAction<number>>;
  setScale: React.Dispatch<React.SetStateAction<number>>;
  setSampler: React.Dispatch<React.SetStateAction<string>>;
  setScaleRescale: React.Dispatch<React.SetStateAction<number>>;
  setNoiseSchedule: React.Dispatch<React.SetStateAction<string>>;
}) {
  const stepsNum = parsePositiveNumber(metadata.steps);
  if (stepsNum !== null) setSteps(stepsNum);

  const scaleNum = parsePositiveNumber(metadata.scale);
  if (scaleNum !== null) setScale(scaleNum);

  if (metadata.sampler) {
    const samplerLabel = samplerIdToLabel(metadata.sampler);
    if (samplerLabel) setSampler(samplerLabel);
  }

  if (metadata.noiseSchedule) {
    setNoiseSchedule(normalizeNoiseSchedule(metadata.noiseSchedule));
  }

  if (metadata.cfgRescale !== undefined) {
    const rescaleNum = typeof metadata.cfgRescale === 'string'
      ? parseFloat(metadata.cfgRescale)
      : metadata.cfgRescale;
    if (!Number.isNaN(rescaleNum)) setScaleRescale(rescaleNum);
  }
}

function parsePositiveNumber(value?: string | number) {
  if (value === undefined) return null;
  const num = typeof value === 'string' ? parseFloat(value) : value;
  return !Number.isNaN(num) && num > 0 ? num : null;
}
