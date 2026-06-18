import React, { useCallback, useEffect, useState } from 'react';
import { Edit3, Plus, Trash2 } from 'lucide-react';
import {
  getPromptPresets,
  savePromptPresets,
  type PromptPresetData,
} from '../../../services/localLibrary';

interface MobilePresetSettingsSectionProps {
  onSaved: () => void;
}

const PresetEditor: React.FC<{
  preset?: PromptPresetData;
  onSave: (preset: PromptPresetData) => void;
  onCancel: () => void;
}> = ({ preset, onSave, onCancel }) => {
  const [name, setName] = useState(preset?.name || '');
  const [positive, setPositive] = useState(preset?.positive || '');
  const [negative, setNegative] = useState(preset?.negative || '');

  const handleSave = () => {
    if (!name.trim()) {
      alert('请输入预设名称');
      return;
    }
    onSave({
      id: preset?.id || `custom-${Date.now()}`,
      name: name.trim(),
      positive: positive.trim(),
      negative: negative.trim(),
      isDefault: preset?.isDefault || false,
      createdAt: preset?.createdAt || Date.now(),
    });
  };

  return (
    <div className="p-4 space-y-4">
      <div>
        <label className="text-xs text-gray-500 uppercase tracking-wider block mb-2">预设名称</label>
        <input
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="例如: 高质量动漫"
          className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-500 focus:border-nai-accent/50 focus:outline-none"
        />
      </div>
      <div>
        <label className="text-xs text-gray-500 uppercase tracking-wider block mb-2">正向提示词</label>
        <textarea
          value={positive}
          onChange={(event) => setPositive(event.target.value)}
          placeholder="会附加到正向提示词后面..."
          rows={4}
          className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-500 focus:border-nai-accent/50 focus:outline-none resize-none"
        />
      </div>
      <div>
        <label className="text-xs text-gray-500 uppercase tracking-wider block mb-2">反向提示词</label>
        <textarea
          value={negative}
          onChange={(event) => setNegative(event.target.value)}
          placeholder="会附加到反向提示词后面..."
          rows={4}
          className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-500 focus:border-nai-accent/50 focus:outline-none resize-none"
        />
      </div>
      <div className="flex gap-3 pt-2">
        <button
          onClick={onCancel}
          className="flex-1 py-3 bg-gray-700 text-gray-300 font-medium rounded-xl active:bg-gray-600"
        >
          取消
        </button>
        <button
          onClick={handleSave}
          className="flex-1 py-3 bg-nai-accent text-black font-bold rounded-xl active:bg-nai-accent/80"
        >
          保存
        </button>
      </div>
    </div>
  );
};

export const MobilePresetSettingsSection: React.FC<MobilePresetSettingsSectionProps> = ({ onSaved }) => {
  const [promptPresets, setPromptPresets] = useState<PromptPresetData[]>([]);
  const [editingPreset, setEditingPreset] = useState<PromptPresetData | null>(null);
  const [isCreatingPreset, setIsCreatingPreset] = useState(false);

  useEffect(() => {
    setPromptPresets(getPromptPresets());
  }, []);

  const notifyPresetsUpdated = useCallback(() => {
    onSaved();
    window.dispatchEvent(new Event('presets-updated'));
  }, [onSaved]);

  const handleSavePreset = useCallback((preset: PromptPresetData) => {
    const updatedPresets = promptPresets.map((item) => (item.id === preset.id ? preset : item));
    savePromptPresets(updatedPresets);
    setPromptPresets(updatedPresets);
    setEditingPreset(null);
    notifyPresetsUpdated();
  }, [notifyPresetsUpdated, promptPresets]);

  const handleCreatePreset = useCallback((preset: PromptPresetData) => {
    const newPreset: PromptPresetData = {
      id: `custom-${Date.now()}`,
      name: preset.name,
      positive: preset.positive,
      negative: preset.negative,
      isDefault: false,
      createdAt: Date.now(),
    };
    const updatedPresets = [...promptPresets, newPreset];
    savePromptPresets(updatedPresets);
    setPromptPresets(updatedPresets);
    setIsCreatingPreset(false);
    notifyPresetsUpdated();
  }, [notifyPresetsUpdated, promptPresets]);

  const handleDeletePreset = useCallback((presetId: string) => {
    const preset = promptPresets.find((item) => item.id === presetId);
    if (preset?.isDefault) return;
    if (!confirm(`确定删除预设 "${preset?.name}" 吗？`)) return;
    const updatedPresets = promptPresets.filter((item) => item.id !== presetId);
    savePromptPresets(updatedPresets);
    setPromptPresets(updatedPresets);
    window.dispatchEvent(new Event('presets-updated'));
  }, [promptPresets]);

  if (editingPreset) {
    return (
      <PresetEditor
        preset={editingPreset}
        onSave={handleSavePreset}
        onCancel={() => setEditingPreset(null)}
      />
    );
  }

  if (isCreatingPreset) {
    return (
      <PresetEditor
        onSave={handleCreatePreset}
        onCancel={() => setIsCreatingPreset(false)}
      />
    );
  }

  return (
    <div className="p-4 space-y-3">
      <p className="text-xs text-gray-500 mb-4">
        预设会自动附加到你的提示词后面，用于统一画风和质量标签
      </p>
      {promptPresets.map((preset) => (
        <div
          key={preset.id}
          className="p-4 bg-gray-800 rounded-xl space-y-2"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="font-medium text-white">{preset.name}</span>
              {preset.isDefault && (
                <span className="text-xs px-2 py-0.5 bg-gray-700 text-gray-400 rounded">默认</span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setEditingPreset(preset)}
                className="p-2 text-gray-400 hover:text-white rounded-lg hover:bg-gray-700"
              >
                <Edit3 className="w-4 h-4" />
              </button>
              {!preset.isDefault && (
                <button
                  onClick={() => handleDeletePreset(preset.id)}
                  className="p-2 text-gray-400 hover:text-red-400 rounded-lg hover:bg-gray-700"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
          </div>
          {preset.positive && (
            <div className="text-xs text-gray-500">
              <span className="text-green-400">正向:</span> {preset.positive.slice(0, 50)}
              {preset.positive.length > 50 && '...'}
            </div>
          )}
          {preset.negative && (
            <div className="text-xs text-gray-500">
              <span className="text-red-400">反向:</span> {preset.negative.slice(0, 50)}
              {preset.negative.length > 50 && '...'}
            </div>
          )}
        </div>
      ))}
      <button
        onClick={() => setIsCreatingPreset(true)}
        className="w-full p-4 bg-gray-800 rounded-xl border-2 border-dashed border-gray-700 text-gray-400 flex items-center justify-center gap-2 active:bg-gray-700"
      >
        <Plus className="w-5 h-5" />
        <span>新建预设</span>
      </button>
    </div>
  );
};
