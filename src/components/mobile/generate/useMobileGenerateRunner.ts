import { useCallback, useEffect, useState, type MutableRefObject } from 'react';
import type { PromptPresetData } from '../../../services/localLibrary';
import type { GenerateImageParams, GenerateResult } from '../../../services/novelai';
import type { ActivePreciseRef, ActiveVibe, CharacterPrompt } from '../types';
import type { SavedMobileInpaint } from './useMobileImg2Img';
import {
  prepareMobileCharacterPrompts,
  prepareMobileImg2Img,
  prepareMobilePreciseReferences,
  prepareMobilePrompts,
  prepareMobileVibeReferences,
} from './mobileGenerationPreparation';

interface UseMobileGenerateRunnerOptions {
  isGenerating: boolean;
  isQueuing: boolean;
  isAuthenticated: boolean;
  requireAuth: (callback: () => void) => void;
  positivePrompt: string;
  negativePrompt: string;
  promptPresets: PromptPresetData[];
  activePresetId: string;
  activeVibes: ActiveVibe[];
  activePreciseRefs: ActivePreciseRef[];
  characterPrompts: CharacterPrompt[];
  savedInpaintRef: MutableRefObject<SavedMobileInpaint | null>;
  img2imgImage: string | null;
  img2imgStrength: number;
  img2imgNoise: number;
  localWidth: number;
  localHeight: number;
  model: string;
  seed: string;
  steps: number;
  scale: number;
  sampler: string;
  cfgRescale: number;
  noiseSchedule: string;
  varietyPlus: boolean;
  generate: (params: GenerateImageParams) => Promise<GenerateResult>;
}

export function useMobileGenerateRunner({
  isGenerating,
  isQueuing,
  isAuthenticated,
  requireAuth,
  positivePrompt,
  negativePrompt,
  promptPresets,
  activePresetId,
  activeVibes,
  activePreciseRefs,
  characterPrompts,
  savedInpaintRef,
  img2imgImage,
  img2imgStrength,
  img2imgNoise,
  localWidth,
  localHeight,
  model,
  seed,
  steps,
  scale,
  sampler,
  cfgRescale,
  noiseSchedule,
  varietyPlus,
  generate,
}: UseMobileGenerateRunnerOptions) {
  const [isPreparing, setIsPreparing] = useState(false);

  const handleGenerate = useCallback(async () => {
    if (isGenerating || isQueuing || isPreparing) return;

    if (!isAuthenticated) {
      requireAuth(() => {
        void handleGenerate();
      });
      return;
    }

    setIsPreparing(true);
    try {
      const { finalPrompt, finalNegative } = await prepareMobilePrompts({
        positivePrompt,
        negativePrompt,
        promptPresets,
        activePresetId,
      });
      const vibeReferences = await prepareMobileVibeReferences({ activeVibes, model });
      const preciseReferences = await prepareMobilePreciseReferences(activePreciseRefs);

      const savedInpaint = savedInpaintRef.current;
      const img2img = savedInpaint ? undefined : await prepareMobileImg2Img({
        img2imgImage,
        localWidth,
        localHeight,
        img2imgStrength,
        img2imgNoise,
      });
      const inpaintParams = savedInpaint ? {
        inpaint: {
          imageBase64: savedInpaint.imageBase64,
          maskBase64: savedInpaint.maskBase64,
          strength: savedInpaint.strength,
        },
      } : {};

      await generate({
        model,
        positivePrompt: finalPrompt,
        negativePrompt: finalNegative,
        width: savedInpaint ? savedInpaint.width : localWidth,
        height: savedInpaint ? savedInpaint.height : localHeight,
        seed: seed ? parseInt(seed) : Math.floor(Math.random() * 4294967295),
        steps,
        scale,
        sampler,
        cfgRescale,
        noiseSchedule,
        ucPreset: 'heavy',
        qualityToggle: true,
        varietyPlus,
        vibeReferences,
        characterPrompts: prepareMobileCharacterPrompts(characterPrompts),
        preciseReferences,
        img2img,
        ...inpaintParams,
      });
    } finally {
      setIsPreparing(false);
    }
  }, [
    activePreciseRefs,
    activePresetId,
    activeVibes,
    cfgRescale,
    characterPrompts,
    generate,
    img2imgImage,
    img2imgNoise,
    img2imgStrength,
    isAuthenticated,
    isGenerating,
    isPreparing,
    isQueuing,
    localHeight,
    localWidth,
    model,
    negativePrompt,
    noiseSchedule,
    positivePrompt,
    promptPresets,
    requireAuth,
    sampler,
    savedInpaintRef,
    scale,
    seed,
    steps,
    varietyPlus,
  ]);

  useEffect(() => {
    const handleRegenerate = () => {
      if (!isGenerating && !isQueuing && !isPreparing) {
        void handleGenerate();
      }
    };
    window.addEventListener('regenerate-image', handleRegenerate);
    return () => window.removeEventListener('regenerate-image', handleRegenerate);
  }, [handleGenerate, isGenerating, isPreparing, isQueuing]);

  return {
    isPreparing,
    handleGenerate,
  };
}
