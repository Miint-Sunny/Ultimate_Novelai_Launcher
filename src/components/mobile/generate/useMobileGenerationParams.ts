import { useEffect, useMemo, useState } from 'react';
import type { CharacterPrompt } from '../types';

const STORAGE_KEY = 'mobile_generate_state';

interface StoredCharacterPrompt {
  id?: string;
  positive?: string;
  negative?: string;
  enabled?: boolean;
  position?: string;
  name?: string;
}

interface SavedMobileGenerateState {
  localWidth?: number;
  localHeight?: number;
  model?: string;
  positivePrompt?: string;
  negativePrompt?: string;
  steps?: number;
  scale?: number;
  sampler?: string;
  noiseSchedule?: string;
  cfgRescale?: number;
  varietyPlus?: boolean;
  activePresetId?: string;
  characterPrompts?: StoredCharacterPrompt[];
}

interface UseMobileGenerationParamsOptions {
  targetWidth: number;
  targetHeight: number;
}

const readSavedState = (): SavedMobileGenerateState | null => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : null;
  } catch (error) {
    console.error('Failed to load saved state:', error);
    return null;
  }
};

const restoreCharacterPrompts = (savedPrompts?: StoredCharacterPrompt[]): CharacterPrompt[] => {
  if (!savedPrompts) return [];
  return savedPrompts.map((prompt) => ({
    id: prompt.id || Date.now().toString(),
    positive: prompt.positive || '',
    negative: prompt.negative || '',
    activeTab: 'prompt' as const,
    enabled: prompt.enabled ?? true,
    position: prompt.position || '',
    name: prompt.name,
  }));
};

export function useMobileGenerationParams({
  targetWidth,
  targetHeight,
}: UseMobileGenerationParamsOptions) {
  const savedState = useMemo(readSavedState, []);

  const [localWidth, setLocalWidth] = useState(savedState?.localWidth ?? targetWidth);
  const [localHeight, setLocalHeight] = useState(savedState?.localHeight ?? targetHeight);
  const [model, setModel] = useState(savedState?.model ?? 'v4.5-full');
  const [positivePrompt, setPositivePrompt] = useState(savedState?.positivePrompt ?? '');
  const [negativePrompt, setNegativePrompt] = useState(savedState?.negativePrompt ?? '');
  const [steps, setSteps] = useState(savedState?.steps ?? 28);
  const [scale, setScale] = useState(savedState?.scale ?? 5);
  const [sampler, setSampler] = useState(savedState?.sampler ?? 'k_euler_ancestral');
  const [noiseSchedule, setNoiseSchedule] = useState(savedState?.noiseSchedule ?? 'karras');
  const [cfgRescale, setCfgRescale] = useState(savedState?.cfgRescale ?? 0);
  const [varietyPlus, setVarietyPlus] = useState(savedState?.varietyPlus ?? false);
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(false);
  const [isPresetExpanded, setIsPresetExpanded] = useState(false);
  const [characterPrompts, setCharacterPrompts] = useState<CharacterPrompt[]>(
    () => restoreCharacterPrompts(savedState?.characterPrompts)
  );
  const [activePresetId, setActivePresetId] = useState<string>(savedState?.activePresetId ?? 'heavy');

  useEffect(() => {
    const stateToSave = {
      localWidth,
      localHeight,
      model,
      positivePrompt,
      negativePrompt,
      steps,
      scale,
      sampler,
      noiseSchedule,
      cfgRescale,
      varietyPlus,
      activePresetId,
      characterPrompts: characterPrompts.map((prompt) => ({
        id: prompt.id,
        positive: prompt.positive,
        negative: prompt.negative,
        name: prompt.name,
        enabled: prompt.enabled,
        position: prompt.position,
      })),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stateToSave));
  }, [
    localWidth,
    localHeight,
    model,
    positivePrompt,
    negativePrompt,
    steps,
    scale,
    sampler,
    noiseSchedule,
    cfgRescale,
    varietyPlus,
    activePresetId,
    characterPrompts,
  ]);

  return {
    localWidth,
    setLocalWidth,
    localHeight,
    setLocalHeight,
    model,
    setModel,
    positivePrompt,
    setPositivePrompt,
    negativePrompt,
    setNegativePrompt,
    steps,
    setSteps,
    scale,
    setScale,
    sampler,
    setSampler,
    noiseSchedule,
    setNoiseSchedule,
    cfgRescale,
    setCfgRescale,
    varietyPlus,
    setVarietyPlus,
    showAdvancedSettings,
    setShowAdvancedSettings,
    isPresetExpanded,
    setIsPresetExpanded,
    characterPrompts,
    setCharacterPrompts,
    activePresetId,
    setActivePresetId,
  };
}
