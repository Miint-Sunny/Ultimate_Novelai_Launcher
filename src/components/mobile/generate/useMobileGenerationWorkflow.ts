import { useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
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
  setActiveVibes: Dispatch<SetStateAction<ActiveVibe[]>>;
  activePreciseRefs: ActivePreciseRef[];
  characterPrompts: CharacterPrompt[];
  savedInpaintRef: MutableRefObject<SavedMobileInpaint | null>;
  cropInfoRef: MutableRefObject<MobileCropInfo | null>;
  img2imgImage: string | null;
  img2imgStrength: number;
  img2imgNoise: number;
  localWidth: number;
  localHeight: number;
  setLocalWidth: (width: number) => void;
  setLocalHeight: (height: number) => void;
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
  setActiveVibes,
  activePreciseRefs,
  characterPrompts,
  savedInpaintRef,
  cropInfoRef,
  img2imgImage,
  img2imgStrength,
  img2imgNoise,
  localWidth,
  localHeight,
  setLocalWidth,
  setLocalHeight,
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
  // 生成与 inpaint 两条链路共享同一份 vibe 编码缓存(对齐桌面 LeftSidebar 的模块级 Map;
  // 这里用 ref 挂在工作流上,页面卸载后重建,仅影响缓存命中、不影响载荷内容)
  const vibeEncodingCacheRef = useRef(new Map<string, string>());

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
    setActiveVibes,
    activePreciseRefs,
    characterPrompts,
    savedInpaintRef,
    img2imgImage,
    img2imgStrength,
    img2imgNoise,
    localWidth,
    localHeight,
    setLocalWidth,
    setLocalHeight,
    model,
    seed,
    steps,
    scale,
    sampler,
    cfgRescale,
    noiseSchedule,
    varietyPlus,
    vibeEncodingCache: vibeEncodingCacheRef.current,
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
    vibeEncodingCache: vibeEncodingCacheRef.current,
    generate,
    addInpaintedImage,
    clearInpaintParams,
  });

  return {
    isPreparing,
    handleGenerate,
  };
}
