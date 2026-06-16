import { useCallback } from 'react';
import type React from 'react';
import type { ClampedSize, ModelOption, ResolutionPreset } from '../generation/modelResolutionOptions';
import type { ActiveVibe, VibeFile } from '../vibe';
import {
  applyImportedModel,
  applyImportedResolution,
  applyImportedSettings,
  type MetadataImportOptions,
  type MetadataImportPayload,
} from './metadataImportActions';
import type { CharacterPrompt } from './types';
import { importVibesFromMetadata } from './metadataVibeImport';

interface UseMetadataImportHandlerParams {
  resolutionSourceRef: React.MutableRefObject<string>;
  reportResolutionNormalization: (source: string, result: ClampedSize) => void;
  setSelectedModel: React.Dispatch<React.SetStateAction<ModelOption>>;
  setResolution: React.Dispatch<React.SetStateAction<ResolutionPreset>>;
  setCustomWidth: React.Dispatch<React.SetStateAction<number>>;
  setCustomHeight: React.Dispatch<React.SetStateAction<number>>;
  setCustomWidthInput: React.Dispatch<React.SetStateAction<string>>;
  setCustomHeightInput: React.Dispatch<React.SetStateAction<string>>;
  setIsCustomRes: React.Dispatch<React.SetStateAction<boolean>>;
  setPositivePrompt: React.Dispatch<React.SetStateAction<string>>;
  setNegativePrompt: React.Dispatch<React.SetStateAction<string>>;
  setCharacterPrompts: React.Dispatch<React.SetStateAction<CharacterPrompt[]>>;
  setIsCharacterSectionOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setLocalFiles: React.Dispatch<React.SetStateAction<VibeFile[]>>;
  setActiveVibes: React.Dispatch<React.SetStateAction<ActiveVibe[]>>;
  setSeed: (seed: string) => void;
  setSteps: React.Dispatch<React.SetStateAction<number>>;
  setScale: React.Dispatch<React.SetStateAction<number>>;
  setSampler: React.Dispatch<React.SetStateAction<string>>;
  setScaleRescale: React.Dispatch<React.SetStateAction<number>>;
  setNoiseSchedule: React.Dispatch<React.SetStateAction<string>>;
}

export function useMetadataImportHandler({
  resolutionSourceRef,
  reportResolutionNormalization,
  setSelectedModel,
  setResolution,
  setCustomWidth,
  setCustomHeight,
  setCustomWidthInput,
  setCustomHeightInput,
  setIsCustomRes,
  setPositivePrompt,
  setNegativePrompt,
  setCharacterPrompts,
  setIsCharacterSectionOpen,
  setLocalFiles,
  setActiveVibes,
  setSeed,
  setSteps,
  setScale,
  setSampler,
  setScaleRescale,
  setNoiseSchedule,
}: UseMetadataImportHandlerParams) {
  return useCallback((metadata: MetadataImportPayload, options: MetadataImportOptions, fileName?: string) => {
    if (options.settings) {
      applyImportedModel(metadata, setSelectedModel);
      applyImportedResolution({
        metadata,
        resolutionSourceRef,
        reportResolutionNormalization,
        setResolution,
        setCustomWidth,
        setCustomHeight,
        setCustomWidthInput,
        setCustomHeightInput,
        setIsCustomRes,
      });
      applyImportedSettings({
        metadata,
        setSteps,
        setScale,
        setSampler,
        setScaleRescale,
        setNoiseSchedule,
      });
    }

    if (options.prompt && metadata.prompt) {
      setPositivePrompt(prev => options.cleanImports ? metadata.prompt : appendPrompt(prev, metadata.prompt));
    }

    if (options.negativePrompt && metadata.negativePrompt) {
      setNegativePrompt(prev => options.cleanImports ? metadata.negativePrompt : appendPrompt(prev, metadata.negativePrompt));
    }

    if (options.characters && metadata.characterPrompts && metadata.characterPrompts.length > 0) {
      const newChars = metadata.characterPrompts.map((char, index) => ({
        id: `${Date.now()}-${index}`,
        positive: char.prompt || '',
        negative: char.uc || '',
        activeTab: 'prompt' as const,
        enabled: true,
        position: char.center ? `${char.center.x},${char.center.y}` : '',
        name: `角色 ${index + 1}`,
      }));

      if (options.cleanImports) {
        setCharacterPrompts(newChars.slice(0, 6));
      } else {
        setCharacterPrompts(prev => {
          const availableSlots = 6 - prev.length;
          if (availableSlots <= 0) return prev;
          return [...prev, ...newChars.slice(0, availableSlots)];
        });
      }
      setIsCharacterSectionOpen(true);
    }

    if (options.vibes && metadata.vibes && metadata.vibes.length > 0) {
      void importVibesFromMetadata({
        vibes: metadata.vibes,
        seed: metadata.seed,
        source: metadata.source,
        fileName,
      }).then(({ activeVibes: newVibes, localFilesToPrepend }) => {
        if (localFilesToPrepend.length > 0) {
          setLocalFiles(prev => [...localFilesToPrepend, ...prev]);
        }

        if (newVibes.length > 0) {
          setActiveVibes(prev => options.cleanImports ? newVibes : [...prev, ...newVibes]);
        }
      }).catch(error => {
        console.error('[Vibe导入] 处理失败:', error);
      });
    }

    if (options.seed && metadata.seed) {
      setSeed(String(metadata.seed));
    }
  }, [
    reportResolutionNormalization,
    resolutionSourceRef,
    setActiveVibes,
    setCharacterPrompts,
    setCustomHeight,
    setCustomHeightInput,
    setCustomWidth,
    setCustomWidthInput,
    setIsCharacterSectionOpen,
    setIsCustomRes,
    setLocalFiles,
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
  ]);
}

function appendPrompt(current: string, incoming: string) {
  return current ? `${current}, ${incoming}` : incoming;
}
