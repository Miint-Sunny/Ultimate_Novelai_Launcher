import { useCallback, useEffect, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { getAISettings, getAppSettings, type PromptPresetData } from '../../../services/localLibrary';
import type { GenerateImageParams, GenerateResult } from '../../../services/novelai';
import { fetchPublicVibeEncoding } from '../../../services/publicLibrary';
import { assembleGenerateParams } from '../../generation/generationPayload';
import { isGenModuleVisible, stripInvisibleModuleData, type GenModuleContext } from '../../generation/genModules';
import { prepareImg2ImgParams, preparePreciseReferences, prepareVibeReferences } from '../../generation/generationReferences';
import type { ActivePreciseRef, ActiveVibe, CharacterPrompt } from '../types';
import type { SavedMobileInpaint } from './useMobileImg2Img';
import { prepareMobileCharacterPrompts, prepareMobilePromptPair } from './mobilePromptPreparation';

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
  setActiveVibes: Dispatch<SetStateAction<ActiveVibe[]>>;
  activePreciseRefs: ActivePreciseRef[];
  characterPrompts: CharacterPrompt[];
  savedInpaintRef: MutableRefObject<SavedMobileInpaint | null>;
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
  vibeEncodingCache: Map<string, string>;
  generate: (params: GenerateImageParams) => Promise<GenerateResult>;
}

// 薄适配:载荷装配全部走共享装配层(src/components/generation/generationPayload),
// 与桌面端同一条链路;此处只保留移动端既有差异——提示词组装(折叠标记展开/中译英,
// 见 mobilePromptPreparation)、isQueuing 门、regenerate-image 事件。
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
  vibeEncodingCache,
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
      let resolutionSource = `移动端 ${localWidth}×${localHeight}`;
      // P4 注册表剥离(唯一可见性谓词的载荷消费):清掉当前型号不支持模块的数据,
      // 只影响本次快照,不动工作区状态(条件恢复卡回来数据还在);入库快照即剥离后
      // 状态,「重生成」复跑经 regenerate-image 走同一装配,剥离幂等不二次损失。
      // serverMode 在点按当时读新值(与 getAISettings 同一时点约定)。
      const moduleContext: GenModuleContext = {
        model,
        serverMode: getAppSettings().serverMode,
        isAuthenticated,
      };
      const stripped = stripInvisibleModuleData(
        { characterPrompts, activePreciseRefs, activeVibes, img2imgImage },
        moduleContext,
      );
      // inpaint 是图生图卡内子模式:模块不可见时连同 savedInpaint 一起剥
      const img2imgVisible = isGenModuleVisible('img2img', moduleContext);
      const { generateParams } = await assembleGenerateParams({
        positivePrompt,
        negativePrompt,
        activePreset: promptPresets.find((preset) => preset.id === activePresetId),
        model,
        width: localWidth,
        height: localHeight,
        steps,
        scale,
        seed,
        sampler,
        cfgRescale,
        noiseSchedule,
        activePresetId,
        varietyPlus,
        // 移动端无该开关的 UI:读取共享设置存储(novelai_ai_settings,桌面侧维护),
        // 默认 true 与此前省略该字段的后端默认行为一致
        normalizeVibeStrength: getAISettings().normalizeVibeStrength,
        characterPrompts: stripped.characterPrompts,
        activePreciseRefs: stripped.activePreciseRefs,
        activeVibes: stripped.activeVibes,
        vibeEncodingCache,
        fetchPublicVibeEncoding,
        refreshActiveVibeEncodings: (vibeId, encodings) => {
          setActiveVibes((prev) => prev.map((vibe) =>
            vibe.id === vibeId ? { ...vibe, encodings } : vibe
          ));
        },
        savePendingVibes: true,
        preparePromptPair: prepareMobilePromptPair,
        prepareCharacterPrompts: prepareMobileCharacterPrompts,
        preparePreciseReferences,
        prepareVibeReferences,
        img2imgImage: stripped.img2imgImage,
        img2imgStrength,
        img2imgNoise,
        prepareImg2ImgParams,
        readResolutionSource: () => resolutionSource,
        applyClampedResolution: (generationSize, nextSource) => {
          resolutionSource = nextSource;
          console.warn('[Resolution] 生成前兜底,尺寸已调整:', {
            from: `${generationSize.originalWidth}x${generationSize.originalHeight}`,
            to: `${generationSize.width}x${generationSize.height}`,
          });
          setLocalWidth(generationSize.width);
          setLocalHeight(generationSize.height);
        },
        readSavedInpaint: () => (img2imgVisible ? savedInpaintRef.current : null),
      });

      await generate(generateParams);
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
    setActiveVibes,
    setLocalHeight,
    setLocalWidth,
    steps,
    varietyPlus,
    vibeEncodingCache,
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
