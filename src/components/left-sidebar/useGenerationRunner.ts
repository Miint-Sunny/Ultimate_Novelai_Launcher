import { useCallback } from 'react';
import type React from 'react';
import type { GenerateImageParams, GenerateResult } from '../../services/novelai';
import type { VibeData } from '../../services/localLibrary';
import { fetchPublicVibeEncoding } from '../../services/publicLibrary';
import { type ClampedSize, type ModelOption, type ResolutionPreset } from '../generation/modelResolutionOptions';
import {
  assembleGenerateParams,
  assembleInpaintParams,
  type BaseGenerationParamsInput,
  type SavedInpaintParams,
} from '../generation/generationPayload';
import { prepareImg2ImgParams, preparePreciseReferences, prepareVibeReferences } from '../generation/generationReferences';
import { pasteBackInpaintResult, type InpaintCropInfo } from '../generation/inpaintPasteback';
import type { ActivePreciseRef } from '../cr';
import type { ActiveVibe } from '../vibe';
import type { CharacterPrompt, PromptPreset } from './types';

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
  transparentBackground?: boolean;
  normalizeVibeStrength: boolean;
  characterPrompts: CharacterPrompt[];
  useCoords?: boolean;
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

// 薄壳:读取 UI 状态 → 调共享装配层(src/components/generation/generationPayload)→
// GenerationContext.generate()。装配逻辑全部在共享层,这里只保留 React 生命周期、
// 鉴权门、isPreparing 状态与分辨率兜底后的 UI 回写,行为与原实现逐字节一致。
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
      const { generateParams } = await assembleGenerateParams({
        ...sharedBaseInput(params, true),
        width: params.customWidth,
        height: params.customHeight,
        img2imgImage: params.img2imgImage,
        img2imgStrength: params.img2imgStrength,
        img2imgNoise: params.img2imgNoise,
        prepareImg2ImgParams,
        readResolutionSource: () => params.resolutionSourceRef.current,
        applyClampedResolution: (generationSize, resolutionSource) => {
          params.resolutionSourceRef.current = resolutionSource;
          params.reportResolutionNormalization('生成前兜底', generationSize);
          params.setCustomWidth(generationSize.width);
          params.setCustomHeight(generationSize.height);
          params.setCustomWidthInput(String(generationSize.width));
          params.setCustomHeightInput(String(generationSize.height));
          params.setResolution({ label: '自定义', width: generationSize.width, height: generationSize.height });
          params.setIsCustomRes(true);
        },
        readSavedInpaint: () => params.savedInpaintRef.current,
      });

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
      const generateParams = await assembleInpaintParams({
        ...sharedBaseInput(params, false),
        width,
        height,
        inpaint: {
          imageBase64,
          maskBase64,
          strength,
        },
        skipHistory: !!params.cropInfoRef.current,
      });

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

function sharedBaseInput(
  params: UseGenerationRunnerParams,
  includePublicVibeCache: boolean,
): Omit<BaseGenerationParamsInput, 'width' | 'height' | 'resolutionSource'> {
  return {
    positivePrompt: params.positivePrompt,
    negativePrompt: params.negativePrompt,
    activePreset: params.activePreset,
    model: params.selectedModel.id,
    steps: params.steps,
    scale: params.scale,
    seed: params.seed,
    sampler: params.sampler,
    cfgRescale: params.scaleRescale,
    noiseSchedule: params.noiseSchedule,
    activePresetId: params.activePresetId,
    varietyPlus: params.varietyPlus,
    transparentBackground: params.transparentBackground,
    normalizeVibeStrength: params.normalizeVibeStrength,
    characterPrompts: params.characterPrompts,
    useCoords: params.useCoords,
    activePreciseRefs: params.activePreciseRefs,
    activeVibes: params.activeVibes,
    vibeEncodingCache: params.vibeEncodingCache,
    fetchPublicVibeEncoding: includePublicVibeCache ? fetchPublicVibeEncoding : undefined,
    refreshActiveVibeEncodings: includePublicVibeCache
      ? (vibeId: string, encodings: VibeData['encodings']) => {
        params.setActiveVibes(prev => prev.map(vibe =>
          vibe.id === vibeId ? { ...vibe, encodings } : vibe
        ));
      }
      : undefined,
    savePendingVibes: includePublicVibeCache,
    preparePreciseReferences,
    prepareVibeReferences,
  };
}
