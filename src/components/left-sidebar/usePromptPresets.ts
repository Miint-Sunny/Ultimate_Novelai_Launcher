import { useEffect, useMemo, useState } from 'react';
import {
  getActivePresetId,
  getPromptPresets,
  saveActivePresetId,
  savePromptPresets,
} from '../../services/localLibrary';
import type { PromptPreset } from './types';

export function usePromptPresets() {
  const [promptPresets, setPromptPresets] = useState<PromptPreset[]>(() => getPromptPresets());
  const [activePresetId, setActivePresetId] = useState<string>(() => getActivePresetId());
  const [isPresetModalOpen, setIsPresetModalOpen] = useState(false);
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);

  useEffect(() => {
    savePromptPresets(promptPresets);
  }, [promptPresets]);

  useEffect(() => {
    saveActivePresetId(activePresetId);
  }, [activePresetId]);

  const activePreset = useMemo(
    () => promptPresets.find(p => p.id === activePresetId),
    [activePresetId, promptPresets],
  );

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
