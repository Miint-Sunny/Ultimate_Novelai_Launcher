import { useCallback } from 'react';
import { saveActivePresetId, type PromptPresetData } from '../../../services/localLibrary';
import { useSharedPromptPresets } from '../../../hooks/useSharedPromptPresets';

interface UseMobilePromptPresetsOptions {
  activePresetId: string;
  setActivePresetId: (presetId: string) => void;
}

// 薄壳:状态与存储同步在 src/hooks/useSharedPromptPresets.ts(受控模式,
// activePresetId 仍由 useMobileGenerationParams 的 mobile_generate_state 托管);
// 这里只保留移动端既有的 handleApplyPreset 语义(显式写共享存储)。
export function useMobilePromptPresets({
  activePresetId,
  setActivePresetId,
}: UseMobilePromptPresetsOptions) {
  const { promptPresets, activePreset } = useSharedPromptPresets({
    activePresetId,
    setActivePresetId,
    persistPresetsList: false,
    persistActivePresetId: false,
    syncExternalUpdates: true,
    resetActivePresetIdOnSync: true,
  });

  const handleApplyPreset = useCallback((preset: PromptPresetData) => {
    setActivePresetId(preset.id);
    saveActivePresetId(preset.id);
  }, [setActivePresetId]);

  return {
    promptPresets,
    activePreset,
    handleApplyPreset,
  };
}
