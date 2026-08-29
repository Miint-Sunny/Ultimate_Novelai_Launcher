import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getActivePresetId,
  getPromptPresets,
  PROMPT_PRESETS_KEY,
  saveActivePresetId,
  savePromptPresets,
  type PromptPresetData,
} from '../services/localLibrary';
import { isV5Model } from '../components/generation/modelResolutionOptions';
import { promptPresetsForModel, remapPromptPresetId } from '../services/promptPresetCatalog';

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
  /**
   * 当前模型 id。给了就按模型系列过滤内置档,并把激活档映射到该系列的可见档。
   * 不给则原样返回全部档(旧行为)。
   */
  modelId?: string;
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
  modelId,
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
      // P4 修死键:此前监听 'prompt_presets'(不存在),跨标签页同步从未生效;
      // 实际键为 PROMPT_PRESETS_KEY('novelai_prompt_presets')
      if (event.key === PROMPT_PRESETS_KEY) {
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

  // 按模型系列过滤/映射是**推导**,不写回存储:存的始终是用户真正点过的那一档,
  // 所以 V5 →4.5→ V5 来回切能拿回原来那一档,而不是被沿途改写掉。
  // 注意持久化用的仍是上面那个未过滤的 promptPresets 与未映射的 activePresetId。
  const visiblePresets = useMemo(
    () => (modelId === undefined ? promptPresets : promptPresetsForModel(promptPresets, isV5Model(modelId))),
    [modelId, promptPresets],
  );
  const effectiveActivePresetId = useMemo(
    () => (modelId === undefined
      ? activePresetId
      : remapPromptPresetId(activePresetId, promptPresets, isV5Model(modelId))),
    [activePresetId, modelId, promptPresets],
  );
  const activePreset = useMemo(
    () => promptPresets.find((preset) => preset.id === effectiveActivePresetId),
    [effectiveActivePresetId, promptPresets],
  );

  return {
    promptPresets: visiblePresets,
    setPromptPresets,
    activePresetId: effectiveActivePresetId,
    setActivePresetId,
    activePreset,
    reloadPresets,
  };
}
