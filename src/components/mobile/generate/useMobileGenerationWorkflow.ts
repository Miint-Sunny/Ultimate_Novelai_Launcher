import type { MutableRefObject } from 'react';
import type { PromptPresetData } from '../../../services/localLibrary';
import type { GenerateImageParams, GenerateResult } from '../../../services/novelai';
import type { ActivePreciseRef, ActiveVibe, CharacterPrompt } from '../types';
import { useMobileGenerateRunner } from './useMobileGenerateRunner';
import { useMobileInpaintGenerate } from './useMobileInpaintGenerate';
import type { MobileCropInfo, SavedMobileInpaint } from './useMobileImg2Img';

interface UseMobileGenerationWorkflowOptions {
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
  cropInfoRef: MutableRefObject<MobileCropInfo | null>;
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
  addInpaintedImage: (imageUrl: string, width: number, height: number, seed: number) => void;
  clearInpaintParams: () => void;
}

export function useMobileGenerationWorkflow({
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
  cropInfoRef,
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
  addInpaintedImage,
  clearInpaintParams,
}: UseMobileGenerationWorkflowOptions) {
  const { isPreparing, handleGenerate } = useMobileGenerateRunner({
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
  });

  useMobileInpaintGenerate({
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
  });

  return {
    isPreparing,
    handleGenerate,
  };
}
