import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getActivePresetId,
  getPromptPresets,
  saveActivePresetId,
  type PromptPresetData,
} from '../../../services/localLibrary';

interface UseMobilePromptPresetsOptions {
  activePresetId: string;
  setActivePresetId: (presetId: string) => void;
}

export function useMobilePromptPresets({
  activePresetId,
  setActivePresetId,
}: UseMobilePromptPresetsOptions) {
  const [promptPresets, setPromptPresets] = useState<PromptPresetData[]>([]);

  const activePreset = useMemo(
    () => promptPresets.find((preset) => preset.id === activePresetId),
    [activePresetId, promptPresets]
  );

  const loadPresets = useCallback(() => {
    const presets = getPromptPresets();
    setPromptPresets(presets);
    setActivePresetId(getActivePresetId());
  }, [setActivePresetId]);

  const handleApplyPreset = useCallback((preset: PromptPresetData) => {
    setActivePresetId(preset.id);
    saveActivePresetId(preset.id);
  }, [setActivePresetId]);

  useEffect(() => {
    loadPresets();
  }, [loadPresets]);

  useEffect(() => {
    const handleStorageChange = (event: StorageEvent) => {
      if (event.key === 'prompt_presets') {
        loadPresets();
      }
    };
    const handlePresetsUpdate = () => {
      loadPresets();
    };

    window.addEventListener('storage', handleStorageChange);
    window.addEventListener('presets-updated', handlePresetsUpdate);
    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('presets-updated', handlePresetsUpdate);
    };
  }, [loadPresets]);

  return {
    promptPresets,
    activePreset,
    handleApplyPreset,
  };
}
