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

export function applyImportedModel(
  metadata: MetadataImportPayload,
  setSelectedModel: React.Dispatch<React.SetStateAction<ModelOption>>,
) {
  if (!metadata.source || metadata.sourceType !== 'novelai') return;
  const source = metadata.source.toLowerCase();
  // 按「越具体越靠前」排,命中即停。
  // V5 的 Source 串形如 `NovelAI Diffusion V5 0ADF9AB7`——注意它不像 V4 系那样
  // 在串里写 Full/Curated,只有版本号加权重哈希,所以只能靠哈希区分两版。
  // 0adf9ab7 是实测到的 V5 Full;Curated 的哈希还没采到,故留一条兜底行落到
  // Full(采到 Curated 哈希后在兜底行之前补一条即可)。
  const modelMatchMap: Array<{ keywords: string[]; modelName: string }> = [
    { keywords: ['v5 0adf9ab7'], modelName: 'NovelAI V5 Full' },
    { keywords: ['v5 full'], modelName: 'NovelAI V5 Full' },
    { keywords: ['v5 curated'], modelName: 'NovelAI V5 Curated' },
    { keywords: ['diffusion v5'], modelName: 'NovelAI V5 Full' },
    { keywords: ['v4.5 full', 'v4.5 4bde'], modelName: 'NovelAI V4.5 Full' },
    { keywords: ['v4.5 curated', 'v4.5 c02d'], modelName: 'NovelAI V4.5 Curated' },
    { keywords: ['v4 full', 'v4 44fd'], modelName: 'NovelAI V4 Full' },
    { keywords: ['v4 curated', 'v4 c5e5'], modelName: 'NovelAI V4 Curated Preview' },
    // 这行此前把 V3 的哈希写成了 modelName: 'NovelAI V5',是笔误。改回 V3 后它
    // 仍然不会命中任何东西——下拉里本来就不提供 V3——但至少这张表现在是诚实的,
    // 不会在真的 V5 出现后被误读成「已经支持 V5 导入」。
    { keywords: ['v3', 'f4d5'], modelName: 'NovelAI V3' },
  ];

  for (const entry of modelMatchMap) {
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
