import { useEffect } from 'react';
import type { MutableRefObject } from 'react';
import { getAISettings, getAppSettings, type PromptPresetData } from '../../../services/localLibrary';
import type { GenerateImageParams, GenerateResult } from '../../../services/novelai';
import { fetchPublicVibeEncoding } from '../../../services/publicLibrary';
import { assembleInpaintParams } from '../../generation/generationPayload';
import { stripInvisibleModuleData, type GenModuleContext } from '../../generation/genModules';
import { preparePreciseReferences, prepareVibeReferences } from '../../generation/generationReferences';
import { pasteBackInpaintResult } from '../../generation/inpaintPasteback';
import type { ActivePreciseRef, ActiveVibe, CharacterPrompt } from '../types';
import type { MobileCropInfo } from './useMobileImg2Img';
import { prepareMobileCharacterPrompts, prepareMobilePromptPair } from './mobilePromptPreparation';

interface UseMobileInpaintGenerateOptions {
  isGenerating: boolean;
  isQueuing: boolean;
  isPreparing: boolean;
  isAuthenticated: boolean;
  positivePrompt: string;
  negativePrompt: string;
  promptPresets: PromptPresetData[];
  activePresetId: string;
  model: string;
  seed: string;
  steps: number;
  scale: number;
  sampler: string;
  cfgRescale: number;
  noiseSchedule: string;
  varietyPlus: boolean;
  characterPrompts: CharacterPrompt[];
  activePreciseRefs: ActivePreciseRef[];
  activeVibes: ActiveVibe[];
  cropInfoRef: MutableRefObject<MobileCropInfo | null>;
  vibeEncodingCache: Map<string, string>;
  generate: (params: GenerateImageParams) => Promise<GenerateResult>;
  addInpaintedImage: (imageUrl: string, width: number, height: number, seed: number) => void;
  clearInpaintParams: () => void;
}

// 薄适配:inpaint 载荷装配与回贴走共享装配层(generationPayload + inpaintPasteback)。
// 保留移动端既有差异:失败时 clearInpaintParams、公共 vibe 远端编码缓存查询
// (fetchPublicVibeEncoding,不带刷新激活 vibe / 保存 pending vibes——与移动端原行为一致)。
export function useMobileInpaintGenerate({
  isGenerating,
  isQueuing,
  isPreparing,
  isAuthenticated,
  positivePrompt,
  negativePrompt,
  promptPresets,
  activePresetId,
  model,
  seed,
  steps,
  scale,
  sampler,
  cfgRescale,
  noiseSchedule,
  varietyPlus,
  characterPrompts,
  activePreciseRefs,
  activeVibes,
  cropInfoRef,
  vibeEncodingCache,
  generate,
  addInpaintedImage,
  clearInpaintParams,
}: UseMobileInpaintGenerateOptions) {
  useEffect(() => {
    const handleInpaintGenerate = async (event: Event) => {
      if (isGenerating || isQueuing || isPreparing) return;

      const customEvent = event as CustomEvent;
      const { imageBase64, maskBase64, strength, width, height, cropInfo } = customEvent.detail;
      cropInfoRef.current = cropInfo || null;

      try {
        // P4 注册表剥离(与 useMobileGenerateRunner 同口径):只清本次快照,不动工作区
        const moduleContext: GenModuleContext = {
          model,
          serverMode: getAppSettings().serverMode,
          isAuthenticated,
        };
        const stripped = stripInvisibleModuleData(
          { characterPrompts, activePreciseRefs, activeVibes, img2imgImage: null },
          moduleContext,
        );
        const generateParams = await assembleInpaintParams({
          positivePrompt,
          negativePrompt,
          activePreset: promptPresets.find((preset) => preset.id === activePresetId),
          model,
          width,
          height,
          seed,
          steps,
          scale,
          sampler,
          cfgRescale,
          noiseSchedule,
          activePresetId,
          varietyPlus,
          // 与 useMobileGenerateRunner 一致:读取共享设置存储,默认 true
          normalizeVibeStrength: getAISettings().normalizeVibeStrength,
          characterPrompts: stripped.characterPrompts,
          activePreciseRefs: stripped.activePreciseRefs,
          activeVibes: stripped.activeVibes,
          vibeEncodingCache,
          fetchPublicVibeEncoding,
          preparePromptPair: prepareMobilePromptPair,
          prepareCharacterPrompts: prepareMobileCharacterPrompts,
          preparePreciseReferences,
          prepareVibeReferences,
          inpaint: {
            imageBase64,
            maskBase64,
            strength,
          },
          skipHistory: !!cropInfoRef.current,
        });

        const result = await generate(generateParams);

        const savedCropInfo = cropInfoRef.current;
        if (savedCropInfo && result.success && result.imageData) {
          await pasteBackInpaintResult({
            cropInfo: savedCropInfo,
            imageData: result.imageData,
            seed: result.seed || 0,
            addInpaintedImage,
          });
          cropInfoRef.current = null;
        }
      } catch (error) {
        console.error('局部重绘失败:', error);
        clearInpaintParams();
        cropInfoRef.current = null;
      }
    };

    window.addEventListener('inpaint-generate', handleInpaintGenerate);
    return () => window.removeEventListener('inpaint-generate', handleInpaintGenerate);
  }, [
    activePreciseRefs,
    activePresetId,
    activeVibes,
    addInpaintedImage,
    cfgRescale,
    characterPrompts,
    clearInpaintParams,
    cropInfoRef,
    generate,
    isGenerating,
    isPreparing,
    isQueuing,
    isAuthenticated,
    model,
    negativePrompt,
    noiseSchedule,
    positivePrompt,
    promptPresets,
    sampler,
    scale,
    seed,
    steps,
    varietyPlus,
    vibeEncodingCache,
  ]);
}
