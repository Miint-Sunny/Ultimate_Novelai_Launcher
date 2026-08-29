import { useCallback } from 'react';
import { saveActivePresetId, type PromptPresetData } from '../../../services/localLibrary';
import { useSharedPromptPresets } from '../../../hooks/useSharedPromptPresets';

interface UseMobilePromptPresetsOptions {
  activePresetId: string;
  setActivePresetId: (presetId: string) => void;
  /** 当前模型 id:内置档按系列过滤,激活档映射到该系列的可见档。 */
  modelId: string;
}

// 薄壳:状态与存储同步在 src/hooks/useSharedPromptPresets.ts(受控模式,
// activePresetId 仍由 useMobileGenerationParams 的 mobile_generate_state 托管);
// 这里只保留移动端既有的 handleApplyPreset 语义(显式写共享存储)。
export function useMobilePromptPresets({
  activePresetId,
  setActivePresetId,
  modelId,
}: UseMobilePromptPresetsOptions) {
  // effectiveActivePresetId 是按当前模型系列映射过的那一档;下游(生成载荷、
  // 设置面板的选中态)一律用它,别再用 mobile_generate_state 里那个原始 id,
  // 否则会出现「选中的是 A、发出去的预设文本是 B」的错位。
  const {
    promptPresets,
    activePreset,
    activePresetId: effectiveActivePresetId,
  } = useSharedPromptPresets({
    activePresetId,
    setActivePresetId,
    persistPresetsList: false,
    persistActivePresetId: false,
    syncExternalUpdates: true,
    resetActivePresetIdOnSync: true,
    modelId,
  });

  const handleApplyPreset = useCallback((preset: PromptPresetData) => {
    setActivePresetId(preset.id);
    saveActivePresetId(preset.id);
  }, [setActivePresetId]);

  return {
    promptPresets,
    activePreset,
    activePresetId: effectiveActivePresetId,
    handleApplyPreset,
  };
}
