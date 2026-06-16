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
  const modelMatchMap: Array<{ keywords: string[]; modelName: string }> = [
    { keywords: ['v4.5 full', 'v4.5 4bde'], modelName: 'NovelAI V4.5 Full' },
    { keywords: ['v4.5 curated', 'v4.5 c02d'], modelName: 'NovelAI V4.5 Curated' },
    { keywords: ['v4 full', 'v4 44fd'], modelName: 'NovelAI V4 Full' },
    { keywords: ['v4 curated', 'v4 c5e5'], modelName: 'NovelAI V4 Curated Preview' },
    { keywords: ['v3', 'f4d5'], modelName: 'NovelAI V5' },
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
