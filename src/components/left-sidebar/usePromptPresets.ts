import { useState } from 'react';
import { useSharedPromptPresets } from '../../hooks/useSharedPromptPresets';
import type { PromptPreset } from './types';

// 薄壳:状态与存储同步在 src/hooks/useSharedPromptPresets.ts;
// 这里保留桌面专属的弹窗状态与预设 CRUD,行为与原实现一致。
export function usePromptPresets() {
  const {
    promptPresets,
    setPromptPresets,
    activePreset,
    activePresetId,
    setActivePresetId,
  } = useSharedPromptPresets({
    persistPresetsList: true,
    persistActivePresetId: true,
    syncExternalUpdates: false,
    resetActivePresetIdOnSync: false,
  });
  const [isPresetModalOpen, setIsPresetModalOpen] = useState(false);
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);

  const handleUpdatePreset = (id: string, field: 'positive' | 'negative' | 'name', value: string) => {
    setPromptPresets(prev => prev.map(p => p.id === id ? { ...p, [field]: value } : p));
  };

  const handleAddPreset = () => {
    const newPreset: PromptPreset = {
      id: Date.now().toString(),
      name: '自定义预设',
      positive: '',
      negative: '',
      isDefault: false,
    };
    setPromptPresets(prev => [...prev, newPreset]);
    setEditingPresetId(newPreset.id);
  };

  const handleDeletePreset = (id: string) => {
    const preset = promptPresets.find(p => p.id === id);
    if (preset?.isDefault) return;
    if (activePresetId === id) setActivePresetId('none');
    setPromptPresets(prev => prev.filter(p => p.id !== id));
  };

  return {
    promptPresets,
    activePreset,
    activePresetId,
    setActivePresetId,
    isPresetModalOpen,
    setIsPresetModalOpen,
    editingPresetId,
    setEditingPresetId,
    handleUpdatePreset,
    handleAddPreset,
    handleDeletePreset,
  };
}
