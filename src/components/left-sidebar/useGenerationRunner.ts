import { useCallback } from 'react';
import type React from 'react';
import type { GenerateImageParams, GenerateResult } from '../../services/novelai';
import { fetchPublicVibeEncoding } from '../../services/publicLibrary';
import { clampToMaxPixels, type ClampedSize, type ModelOption, type ResolutionPreset } from '../generation/modelResolutionOptions';
import type { ActivePreciseRef } from '../cr';
import type { ActiveVibe } from '../vibe';
import type { CharacterPrompt, PromptPreset } from './types';
import { buildCharacterPromptParams, buildPromptPair } from './generationPromptBuilder';
import { prepareImg2ImgParams, preparePreciseReferences, prepareVibeReferences } from './generationReferences';
import { pasteBackInpaintResult, type InpaintCropInfo } from './inpaintPasteback';

interface SavedInpaintParams {
  imageBase64: string;
  maskBase64: string;
  strength: number;
  width: number;
  height: number;
}

interface UseGenerationRunnerParams {
  isGenerating: boolean;
  isPreparing: boolean;
  setIsPreparing: React.Dispatch<React.SetStateAction<boolean>>;
  isAuthenticated: boolean;
  requireAuth: (callback: () => void) => void;
  generate: (params: GenerateImageParams) => Promise<GenerateResult>;
  addInpaintedImage: (imageUrl: string, width: number, height: number, seed: number) => void;
  positivePrompt: string;
  negativePrompt: string;
  activePreset: PromptPreset | null | undefined;
  activePresetId: string;
  selectedModel: ModelOption;
  steps: number;
  scale: number;
  seed: string;
  sampler: string;
  scaleRescale: number;
  noiseSchedule: string;
  varietyPlus: boolean;
  normalizeVibeStrength: boolean;
  characterPrompts: CharacterPrompt[];
  activePreciseRefs: ActivePreciseRef[];
  activeVibes: ActiveVibe[];
  setActiveVibes: React.Dispatch<React.SetStateAction<ActiveVibe[]>>;
  customWidth: number;
  customHeight: number;
  setCustomWidth: React.Dispatch<React.SetStateAction<number>>;
  setCustomHeight: React.Dispatch<React.SetStateAction<number>>;
  setCustomWidthInput: React.Dispatch<React.SetStateAction<string>>;
  setCustomHeightInput: React.Dispatch<React.SetStateAction<string>>;
  setResolution: React.Dispatch<React.SetStateAction<ResolutionPreset>>;
  setIsCustomRes: React.Dispatch<React.SetStateAction<boolean>>;
  resolutionSourceRef: React.MutableRefObject<string>;
  reportResolutionNormalization: (source: string, result: ClampedSize) => void;
  img2imgImage: string | null;
  img2imgStrength: number;
  img2imgNoise: number;
  savedInpaintRef: React.MutableRefObject<SavedInpaintParams | null>;
  cropInfoRef: React.MutableRefObject<InpaintCropInfo | null>;
  vibeEncodingCache: Map<string, string>;
}

export function useGenerationRunner(params: UseGenerationRunnerParams) {
  const handleGenerate = useCallback(async () => {
    if (params.isGenerating || params.isPreparing) return;

    if (!params.isAuthenticated) {
      params.requireAuth(() => {
        void handleGenerate();
      });
      return;
    }

    params.setIsPreparing(true);

    try {
      const base = await buildBaseGenerationParams(params, params.customWidth, params.customHeight, params.resolutionSourceRef.current, true);
      const generationSize = clampToMaxPixels(params.customWidth, params.customHeight);
      if (generationSize.width !== params.customWidth || generationSize.height !== params.customHeight) {
        const previousSource = params.resolutionSourceRef.current;
        params.resolutionSourceRef.current = `${previousSource}；生成前兜底 ${params.customWidth}×${params.customHeight}`;
        params.reportResolutionNormalization('生成前兜底', generationSize);
        params.setCustomWidth(generationSize.width);
        params.setCustomHeight(generationSize.height);
        params.setCustomWidthInput(String(generationSize.width));
        params.setCustomHeightInput(String(generationSize.height));
        params.setResolution({ label: '自定义', width: generationSize.width, height: generationSize.height });
        params.setIsCustomRes(true);
      }

      const img2img = await prepareImg2ImgParams({
        img2imgImage: params.img2imgImage,
        width: generationSize.width,
        height: generationSize.height,
        strength: params.img2imgStrength,
        noise: params.img2imgNoise,
      });

      const generateParams: GenerateImageParams = {
        ...base,
        width: generationSize.width,
        height: generationSize.height,
        resolutionSource: params.resolutionSourceRef.current,
        img2img: params.savedInpaintRef.current ? undefined : img2img,
      };

      if (params.savedInpaintRef.current) {
        const saved = params.savedInpaintRef.current;
        generateParams.width = saved.width;
        generateParams.height = saved.height;
        generateParams.inpaint = {
          imageBase64: saved.imageBase64,
          maskBase64: saved.maskBase64,
          strength: saved.strength,
        };
      }

      params.setIsPreparing(false);
      await params.generate(generateParams);
    } catch (error) {
      console.error('handleGenerate error:', error);
      params.setIsPreparing(false);
      alert('生成准备失败: ' + (error as Error).message);
    }
  }, [params]);

  const handleInpaintGenerate = useCallback(async (event: CustomEvent) => {
    if (params.isGenerating || params.isPreparing) return;

    const { imageBase64, maskBase64, strength, width, height, cropInfo } = event.detail;
    params.cropInfoRef.current = cropInfo || null;
    params.setIsPreparing(true);

    try {
      const generateParams: GenerateImageParams = {
        ...(await buildBaseGenerationParams(params, width, height, `局部重绘 ${width}×${height}`, false)),
        inpaint: {
          imageBase64,
          maskBase64,
          strength,
        },
        skipHistory: !!params.cropInfoRef.current,
      };

      params.setIsPreparing(false);
      const result = await params.generate(generateParams);

      const savedCropInfo = params.cropInfoRef.current;
      if (savedCropInfo && result.success && result.imageData) {
        await pasteBackInpaintResult({
          cropInfo: savedCropInfo,
          imageData: result.imageData,
          seed: result.seed || 0,
          addInpaintedImage: params.addInpaintedImage,
        });
        params.cropInfoRef.current = null;
      }
    } catch (error) {
      console.error('局部重绘准备失败:', error);
      params.setIsPreparing(false);
      params.cropInfoRef.current = null;
    }
  }, [params]);

  return { handleGenerate, handleInpaintGenerate };
}

async function buildBaseGenerationParams(
  params: UseGenerationRunnerParams,
  width: number,
  height: number,
  resolutionSource: string,
  includePublicVibeCache: boolean,
): Promise<GenerateImageParams> {
  const { positive: finalPositive, negative: finalNegative } = buildPromptPair({
    positivePrompt: params.positivePrompt,
    negativePrompt: params.negativePrompt,
    activePreset: params.activePreset,
  });
  const preciseReferences = await preparePreciseReferences(params.activePreciseRefs);
  const vibeReferences = await prepareVibeReferences({
    activeVibes: params.activeVibes,
    selectedModelId: params.selectedModel.id,
    vibeEncodingCache: params.vibeEncodingCache,
    fetchPublicVibeEncoding: includePublicVibeCache ? fetchPublicVibeEncoding : undefined,
    refreshActiveVibeEncodings: includePublicVibeCache
      ? (vibeId, encodings) => {
        params.setActiveVibes(prev => prev.map(vibe =>
          vibe.id === vibeId ? { ...vibe, encodings } : vibe
        ));
      }
      : undefined,
    savePendingVibes: includePublicVibeCache,
  });

  return {
    positivePrompt: finalPositive,
    negativePrompt: finalNegative,
    model: params.selectedModel.id,
    width,
    height,
    steps: params.steps,
    scale: params.scale,
    seed: params.seed ? parseInt(params.seed, 10) : undefined,
    sampler: params.sampler,
    cfgRescale: params.scaleRescale,
    noiseSchedule: params.noiseSchedule,
    ucPreset: params.activePresetId,
    qualityToggle: params.activePresetId === 'heavy',
    varietyPlus: params.varietyPlus,
    normalizeVibeStrength: params.normalizeVibeStrength,
    resolutionSource,
    characterPrompts: buildCharacterPromptParams(params.characterPrompts),
    preciseReferences,
    vibeReferences,
  };
}
