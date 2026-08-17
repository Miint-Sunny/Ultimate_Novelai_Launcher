import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getActivePresetId,
  getPromptPresets,
  saveActivePresetId,
  savePromptPresets,
  type PromptPresetData,
} from '../services/localLibrary';

interface UseSharedPromptPresetsOptions {
  /** 受控:activePresetId 由外部托管(移动端 mobile_generate_state);
   *  缺省则内部 state(桌面,初值取共享存储 novelai_active_preset) */
  activePresetId?: string;
  setActivePresetId?: (id: string) => void;
  /** 预设列表变化时写回存储(桌面是预设管理端:true;移动端只读:false) */
  persistPresetsList: boolean;
  /** activePresetId 变化时写回共享存储(仅非受控,桌面:true) */
  persistActivePresetId: boolean;
  /** 监听 storage / presets-updated 事件并重新加载(移动端:true) */
  syncExternalUpdates: boolean;
  /** 重新加载时从共享存储重置 activePresetId(移动端既有行为:true) */
  resetActivePresetIdOnSync: boolean;
}

// 提示词预设的双端共享核心。桌面壳保留弹窗状态与 CRUD;移动壳保留
// handleApplyPreset(显式 saveActivePresetId)。两个存储键
// (novelai_prompt_presets / novelai_active_preset)的读写语义不变。
export function useSharedPromptPresets({
  activePresetId: controlledActivePresetId,
  setActivePresetId: controlledSetActivePresetId,
  persistPresetsList,
  persistActivePresetId,
  syncExternalUpdates,
  resetActivePresetIdOnSync,
}: UseSharedPromptPresetsOptions) {
  const isControlled = controlledActivePresetId !== undefined && controlledSetActivePresetId !== undefined;
  const [promptPresets, setPromptPresets] = useState<PromptPresetData[]>(() =>
    isControlled ? [] : getPromptPresets()
  );
  const [internalActivePresetId, setInternalActivePresetId] = useState<string>(() => getActivePresetId());

  const activePresetId = isControlled ? controlledActivePresetId : internalActivePresetId;
  const setActivePresetId = useCallback((id: string) => {
    if (isControlled) {
      controlledSetActivePresetId(id);
    } else {
      setInternalActivePresetId(id);
    }
  }, [controlledSetActivePresetId, isControlled]);

  useEffect(() => {
    if (persistPresetsList) savePromptPresets(promptPresets);
  }, [persistPresetsList, promptPresets]);

  useEffect(() => {
    if (persistActivePresetId && !isControlled) saveActivePresetId(activePresetId);
  }, [persistActivePresetId, isControlled, activePresetId]);

  const reloadPresets = useCallback(() => {
    setPromptPresets(getPromptPresets());
    if (resetActivePresetIdOnSync) {
      setActivePresetId(getActivePresetId());
    }
  }, [resetActivePresetIdOnSync, setActivePresetId]);

  useEffect(() => {
    if (!syncExternalUpdates) return;
    reloadPresets();
    const handleStorageChange = (event: StorageEvent) => {
      if (event.key === 'prompt_presets') {
        reloadPresets();
      }
    };
    const handlePresetsUpdate = () => {
      reloadPresets();
    };

    window.addEventListener('storage', handleStorageChange);
    window.addEventListener('presets-updated', handlePresetsUpdate);
    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('presets-updated', handlePresetsUpdate);
    };
  }, [reloadPresets, syncExternalUpdates]);

  const activePreset = useMemo(
    () => promptPresets.find((preset) => preset.id === activePresetId),
    [activePresetId, promptPresets],
  );

  return {
    promptPresets,
    setPromptPresets,
    activePresetId,
    setActivePresetId,
    activePreset,
    reloadPresets,
  };
}
