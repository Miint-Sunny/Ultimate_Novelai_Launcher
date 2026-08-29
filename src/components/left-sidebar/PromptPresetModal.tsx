import { Ban, Check, Edit2, Plus, Save, Settings, Sparkles, Trash2, X } from 'lucide-react';
import type React from 'react';
import { countTokens } from '../../services/tokenizer';
import { ResizableTextarea } from './ResizableTextarea';
import type { PromptPreset } from './types';

interface PromptPresetModalProps {
  promptPresets: PromptPreset[];
  activePresetId: string;
  editingPresetId: string | null;
  onClose: () => void;
  onActivePresetChange: (id: string) => void;
  onEditingPresetChange: (id: string | null) => void;
  onUpdatePreset: (id: string, field: 'positive' | 'negative' | 'name', value: string) => void;
  onAddPreset: () => void;
  onDeletePreset: (id: string) => void;
}

export const PromptPresetModal: React.FC<PromptPresetModalProps> = ({
  promptPresets,
  activePresetId,
  editingPresetId,
  onClose,
  onActivePresetChange,
  onEditingPresetChange,
  onUpdatePreset,
  onAddPreset,
  onDeletePreset,
}) => (
  <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
    <div className="w-[500px] bg-nai-panel border border-gray-700 rounded-lg shadow-2xl flex flex-col max-h-[80vh]">
      <div className="flex items-center justify-between p-3 border-b border-gray-700">
        <h3 className="font-bold text-white flex items-center gap-2">
          <Settings className="w-4 h-4" />
          提示词预设
        </h3>
        <button onClick={onClose} className="text-gray-400 hover:text-white">
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3 custom-scrollbar">
        <div className="text-xs text-gray-400 mb-2">
          预设内容不会显示在输入框中，但会随生成一起拼进提示词。选择一个预设以激活。
          <br />
          负向一律拼在开头；正向的位置随预设而定（V5 官方档拼在末尾）。
        </div>

        {promptPresets.map(preset => (
          <div
            key={preset.id}
            className={`border rounded-lg p-2 transition-colors cursor-pointer ${activePresetId === preset.id
              ? 'bg-nai-accent/10 border-nai-accent'
              : 'bg-nai-input/30 border-gray-700 hover:bg-nai-input/50'
            }`}
            onClick={() => onActivePresetChange(preset.id)}
          >
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <div className={`w-4 h-4 rounded-full border flex items-center justify-center ${activePresetId === preset.id
                  ? 'border-nai-accent bg-nai-accent'
                  : 'border-gray-500'
                }`}>
                  {activePresetId === preset.id && <Check className="w-3 h-3 text-black" />}
                </div>

                {editingPresetId === preset.id ? (
                  <input
                    value={preset.name}
                    onChange={(e) => onUpdatePreset(preset.id, 'name', e.target.value)}
                    className="bg-black/30 border border-gray-600 rounded px-1.5 py-0.5 text-sm text-white focus:border-nai-accent outline-none w-32"
                    onClick={(e) => e.stopPropagation()}
                    autoFocus
                  />
                ) : (
                  <span className={`font-bold text-sm ${activePresetId === preset.id ? 'text-white' : 'text-gray-300'}`}>
                    {preset.name}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-1">
                <div className="text-[10px] text-gray-500 font-mono bg-black/20 px-1.5 py-0.5 rounded">
                  {countTokens(preset.positive) + countTokens(preset.negative)} Tokens
                </div>
                <button
                  className={`p-1.5 rounded transition-colors ${editingPresetId === preset.id ? 'bg-green-500/20 text-green-400 border border-green-500/50 hover:bg-green-500/30' : 'text-gray-400 hover:text-white hover:bg-gray-700'}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onEditingPresetChange(editingPresetId === preset.id ? null : preset.id);
                  }}
                  title={editingPresetId === preset.id ? '保存预设' : '编辑预设'}
                >
                  {editingPresetId === preset.id ? (
                    <Save className="w-3.5 h-3.5" />
                  ) : (
                    <Edit2 className="w-3.5 h-3.5" />
                  )}
                </button>
                {!preset.isDefault && (
                  <button
                    className="p-1.5 text-gray-400 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeletePreset(preset.id);
                    }}
                    title="删除预设"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>

            {editingPresetId === preset.id && (
              <div
                className="space-y-2 mt-2 pt-2 border-t border-gray-700/50 animate-in slide-in-from-top-1"
                onClick={(e) => e.stopPropagation()}
              >
                <div>
                  <div className="text-xs text-gray-500 mb-1 flex items-center gap-1">
                    <Sparkles className="w-3 h-3" /> 正向提示词{preset.suffixPositive ? '后缀' : '前缀'}
                  </div>
                  <ResizableTextarea
                    value={preset.positive}
                    onChange={(e) => onUpdatePreset(preset.id, 'positive', e.target.value)}
                    className="w-full min-h-[60px] bg-black/20 border border-gray-700 rounded p-2 text-xs text-gray-300 focus:border-gray-500 outline-none font-mono"
                    placeholder="空..."
                    disableHighlight={true}
                  />
                </div>
                <div>
                  <div className="text-xs text-gray-500 mb-1 flex items-center gap-1">
                    <Ban className="w-3 h-3" /> 负向提示词前缀
                  </div>
                  <ResizableTextarea
                    value={preset.negative}
                    onChange={(e) => onUpdatePreset(preset.id, 'negative', e.target.value)}
                    className="w-full min-h-[60px] bg-black/20 border border-gray-700 rounded p-2 text-xs text-gray-300 focus:border-gray-500 outline-none font-mono"
                    placeholder="空..."
                    disableHighlight={true}
                  />
                </div>
              </div>
            )}
          </div>
        ))}

        <button
          className="w-full py-2 border-2 border-dashed border-gray-700 rounded-lg text-gray-500 hover:text-white hover:border-gray-500 transition-all flex items-center justify-center gap-2 text-sm font-bold"
          onClick={onAddPreset}
        >
          <Plus className="w-4 h-4" />
          添加自定义预设
        </button>
      </div>

      <div className="p-3 border-t border-gray-700 bg-gray-900/30 rounded-b-lg flex justify-end">
        <button
          onClick={onClose}
          className="px-4 py-1.5 bg-nai-accent text-black font-bold rounded hover:bg-[#ebd576] transition-colors text-sm"
        >
          完成
        </button>
      </div>
    </div>
  </div>
);
