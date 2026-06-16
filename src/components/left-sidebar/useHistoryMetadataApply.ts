import { useCallback, useEffect } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { HistoryItemMetadata } from '../../contexts/GenerationContext';
import { normalizeNoiseSchedule } from '../../utils/generationOptions';
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
import type { CharacterPrompt } from './types';

type ApplyMetadataHandler = (metadata: HistoryItemMetadata, seed: number, width?: number, height?: number) => void;

interface UseHistoryMetadataApplyParams {
  onRegisterApplyMetadata?: (handler: ApplyMetadataHandler) => void;
  resolutionSourceRef: MutableRefObject<string>;
  reportResolutionNormalization: (source: string, result: ClampedSize) => void;
  setPositivePrompt: Dispatch<SetStateAction<string>>;
  setNegativePrompt: Dispatch<SetStateAction<string>>;
  setSelectedModel: Dispatch<SetStateAction<ModelOption>>;
  setSteps: Dispatch<SetStateAction<number>>;
  setScale: Dispatch<SetStateAction<number>>;
  setSampler: Dispatch<SetStateAction<string>>;
  setScaleRescale: Dispatch<SetStateAction<number>>;
  setNoiseSchedule: Dispatch<SetStateAction<string>>;
  setVarietyPlus: Dispatch<SetStateAction<boolean>>;
  setSeed: (seed: string) => void;
  setResolution: Dispatch<SetStateAction<ResolutionPreset>>;
  setCustomWidth: Dispatch<SetStateAction<number>>;
  setCustomHeight: Dispatch<SetStateAction<number>>;
  setCustomWidthInput: Dispatch<SetStateAction<string>>;
  setCustomHeightInput: Dispatch<SetStateAction<string>>;
  setIsCustomRes: Dispatch<SetStateAction<boolean>>;
  setCharacterPrompts: Dispatch<SetStateAction<CharacterPrompt[]>>;
  setIsCharacterSectionOpen: Dispatch<SetStateAction<boolean>>;
}

function applyResolution(
  width: number | undefined,
  height: number | undefined,
  params: Pick<
    UseHistoryMetadataApplyParams,
    | 'resolutionSourceRef'
    | 'reportResolutionNormalization'
    | 'setResolution'
    | 'setCustomWidth'
    | 'setCustomHeight'
    | 'setCustomWidthInput'
    | 'setCustomHeightInput'
    | 'setIsCustomRes'
  >,
) {
  if (!width || !height || width <= 0 || height <= 0) return;

  const safeSize = clampToMaxPixels(width, height);
  params.resolutionSourceRef.current = `应用历史记录 ${width}×${height}`;
  params.reportResolutionNormalization('应用历史记录', safeSize);

  const allPresets = [...RESOLUTIONS, ...LARGE_RESOLUTIONS, ...WALLPAPER_RESOLUTIONS];
  const matchedResolution = allPresets.find((preset) => preset.width === safeSize.width && preset.height === safeSize.height);
  if (matchedResolution) {
    params.setResolution(matchedResolution);
    params.setCustomWidth(matchedResolution.width);
    params.setCustomHeight(matchedResolution.height);
    params.setCustomWidthInput(String(matchedResolution.width));
    params.setCustomHeightInput(String(matchedResolution.height));
    params.setIsCustomRes(false);
    return;
  }

  params.setCustomWidth(safeSize.width);
  params.setCustomHeight(safeSize.height);
  params.setCustomWidthInput(String(safeSize.width));
  params.setCustomHeightInput(String(safeSize.height));
  params.setResolution({ label: '自定义', width: safeSize.width, height: safeSize.height });
  params.setIsCustomRes(true);
}

function buildCharacterPrompts(metadata: HistoryItemMetadata): CharacterPrompt[] {
  if (!metadata.characterPrompts || metadata.characterPrompts.length === 0) return [];

  return metadata.characterPrompts.slice(0, 6).map((character, index) => ({
    id: `${Date.now()}-${index}`,
    positive: character.positive || '',
    negative: character.negative || '',
    activeTab: 'prompt',
    enabled: character.enabled,
    position: character.position || '',
    name: `角色 ${index + 1}`,
  }));
}

export function useHistoryMetadataApply({
  onRegisterApplyMetadata,
  resolutionSourceRef,
  reportResolutionNormalization,
  setPositivePrompt,
  setNegativePrompt,
  setSelectedModel,
  setSteps,
  setScale,
  setSampler,
  setScaleRescale,
  setNoiseSchedule,
  setVarietyPlus,
  setSeed,
  setResolution,
  setCustomWidth,
  setCustomHeight,
  setCustomWidthInput,
  setCustomHeightInput,
  setIsCustomRes,
  setCharacterPrompts,
  setIsCharacterSectionOpen,
}: UseHistoryMetadataApplyParams) {
  const handleApplyHistoryMetadata = useCallback<ApplyMetadataHandler>((metadata, seed, width, height) => {
    setPositivePrompt(metadata.positivePrompt);
    setNegativePrompt(metadata.negativePrompt);

    const model = MODELS.find((option) => option.id === metadata.model);
    if (model) {
      setSelectedModel(model);
    }

    setSteps(metadata.steps);
    setScale(metadata.scale);
    setSampler(metadata.sampler);
    setScaleRescale(metadata.cfgRescale);
    setNoiseSchedule(normalizeNoiseSchedule(metadata.noiseSchedule));
    setVarietyPlus(metadata.varietyPlus);
    setSeed(String(seed));

    applyResolution(width, height, {
      resolutionSourceRef,
      reportResolutionNormalization,
      setResolution,
      setCustomWidth,
      setCustomHeight,
      setCustomWidthInput,
      setCustomHeightInput,
      setIsCustomRes,
    });

    const characterPrompts = buildCharacterPrompts(metadata);
    setCharacterPrompts(characterPrompts);
    if (characterPrompts.length > 0) {
      setIsCharacterSectionOpen(true);
    }
  }, [
    reportResolutionNormalization,
    resolutionSourceRef,
    setCharacterPrompts,
    setCustomHeight,
    setCustomHeightInput,
    setCustomWidth,
    setCustomWidthInput,
    setIsCharacterSectionOpen,
    setIsCustomRes,
    setNegativePrompt,
    setNoiseSchedule,
    setPositivePrompt,
    setResolution,
    setSampler,
    setScale,
    setScaleRescale,
    setSeed,
    setSelectedModel,
    setSteps,
    setVarietyPlus,
  ]);

  useEffect(() => {
    onRegisterApplyMetadata?.(handleApplyHistoryMetadata);
  }, [handleApplyHistoryMetadata, onRegisterApplyMetadata]);

  return handleApplyHistoryMetadata;
}
