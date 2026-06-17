import { useEffect } from 'react';
import type { MutableRefObject } from 'react';
import type { PromptPresetData } from '../../../services/localLibrary';
import type { GenerateImageParams, GenerateResult } from '../../../services/novelai';
import type { ActivePreciseRef, ActiveVibe, CharacterPrompt } from '../types';
import type { MobileCropInfo } from './useMobileImg2Img';
import { pasteBackInpaintResult } from './mobileInpaintPasteback';
import {
  prepareMobileCharacterPrompts,
  prepareMobilePreciseReferences,
  prepareMobilePrompts,
  prepareMobileVibeReferences,
} from './mobileGenerationPreparation';

interface UseMobileInpaintGenerateOptions {
  isGenerating: boolean;
  isQueuing: boolean;
  isPreparing: boolean;
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
  generate: (params: GenerateImageParams) => Promise<GenerateResult>;
  addInpaintedImage: (imageUrl: string, width: number, height: number, seed: number) => void;
  clearInpaintParams: () => void;
}

export function useMobileInpaintGenerate({
  isGenerating,
  isQueuing,
  isPreparing,
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
        const { finalPrompt, finalNegative } = await prepareMobilePrompts({
          positivePrompt,
          negativePrompt,
          promptPresets,
          activePresetId,
        });
        const preciseReferences = await prepareMobilePreciseReferences(activePreciseRefs);
        const vibeReferences = await prepareMobileVibeReferences({
          activeVibes,
          model,
          includePublicRemoteCache: true,
        });

        const result = await generate({
          model,
          positivePrompt: finalPrompt,
          negativePrompt: finalNegative,
          width,
          height,
          seed: seed ? parseInt(seed) : undefined,
          steps,
          scale,
          sampler,
          cfgRescale,
          noiseSchedule,
          ucPreset: 'heavy',
          qualityToggle: true,
          varietyPlus,
          characterPrompts: prepareMobileCharacterPrompts(characterPrompts),
          preciseReferences,
          vibeReferences,
          inpaint: {
            imageBase64,
            maskBase64,
            strength,
          },
          skipHistory: !!cropInfoRef.current,
        });

        const savedCropInfo = cropInfoRef.current;
        if (savedCropInfo && result.success && result.imageData) {
          await pasteBackInpaintResult(result, savedCropInfo, addInpaintedImage);
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
  ]);
}
