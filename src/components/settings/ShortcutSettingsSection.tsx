import React from 'react';
import { X, Plus } from 'lucide-react';
import { type AppSettings } from '../../services/localLibrary';

interface ShortcutSettingsSectionProps {
  settings: AppSettings;
  updateSettingsImmediate: (updates: Partial<AppSettings>) => void;
}

export const ShortcutSettingsSection: React.FC<ShortcutSettingsSectionProps> = ({
  settings,
  updateSettingsImmediate,
}) => {
  return (
    <div className="space-y-4">
      {/* 回车键行为 */}
      <div className="bg-gray-800/50 rounded-lg border border-gray-700 p-4">
        <label className="block text-xs text-gray-400 mb-3 uppercase tracking-wider">
          回车键行为
        </label>
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => updateSettingsImmediate({ enterBehavior: 'default' })}
            className={`px-3 py-2 rounded-lg text-sm transition-colors ${settings.enterBehavior === 'default'
              ? 'bg-nai-accent/20 text-nai-accent border border-nai-accent/50'
              : 'bg-gray-900 text-gray-400 border border-gray-700 hover:bg-gray-800'
              }`}
          >
            确认 / 换行
          </button>
          <button
            onClick={() => updateSettingsImmediate({ enterBehavior: 'generate' })}
            className={`px-3 py-2 rounded-lg text-sm transition-colors ${settings.enterBehavior === 'generate'
              ? 'bg-nai-accent/20 text-nai-accent border border-nai-accent/50'
              : 'bg-gray-900 text-gray-400 border border-gray-700 hover:bg-gray-800'
              }`}
          >
            生成图片
          </button>
        </div>
        <p className="text-xs text-gray-500 mt-2">
          {settings.enterBehavior === 'generate' && '按回车直接生成图片，换行按 Shift+回车。此模式全局有效，可防止误触焦点组件。'}
          {settings.enterBehavior === 'default' && '当焦点在按钮时，按回车会点击它，在文本框内则为换行。这是默认的浏览器行为。'}
        </p>
      </div>

      {/* 标签权重预设 */}
      <div className="bg-gray-800/50 rounded-lg border border-gray-700 p-4">
        <div className="flex items-center justify-between mb-3">
          <label className="text-xs text-gray-400 uppercase tracking-wider">
            标签权重预设
          </label>
          <button
            onClick={() => updateSettingsImmediate({ weightPresets: [-1, 0.5, 0.8, 1.5, 2.0] })}
            className="text-[11px] text-gray-500 hover:text-gray-300 transition-colors"
          >恢复默认</button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {(settings.weightPresets || [-1, 0.5, 0.8, 1.5, 2.0]).map((w, i) => {
            const color = w > 1 ? 'orange' : w < 1 ? 'blue' : 'gray';
            const colorMap = {
              orange: { bg: 'bg-orange-500/15', border: 'border-orange-400/30', text: 'text-orange-200', hover: 'hover:border-orange-400/50', xHover: 'hover:text-orange-100 hover:bg-orange-500/30' },
              blue: { bg: 'bg-blue-500/15', border: 'border-blue-400/30', text: 'text-blue-200', hover: 'hover:border-blue-400/50', xHover: 'hover:text-blue-100 hover:bg-blue-500/30' },
              gray: { bg: 'bg-gray-700/40', border: 'border-gray-600/50', text: 'text-gray-300', hover: 'hover:border-gray-500', xHover: 'hover:text-gray-100 hover:bg-gray-600/50' },
            };
            const c = colorMap[color];
            return (
              <div key={i} className={`group inline-flex items-center gap-0.5 rounded-md border ${c.bg} ${c.border} ${c.hover} transition-colors`}>
                <input
                  type="number"
                  step="0.1"
                  min="-10"
                  max="10"
                  value={w}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    if (isNaN(val)) return;
                    const p = [...(settings.weightPresets || [-1, 0.5, 0.8, 1.5, 2.0])];
                    p[i] = Math.round(val * 100) / 100;
                    updateSettingsImmediate({ weightPresets: p });
                  }}
                  className={`w-12 bg-transparent text-center text-xs font-mono py-1 pl-1.5 pr-0 outline-none ${c.text} [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none`}
                />
                <button
                  onClick={() => updateSettingsImmediate({ weightPresets: (settings.weightPresets || [-1, 0.5, 0.8, 1.5, 2.0]).filter((_, idx) => idx !== i) })}
                  className={`w-5 h-full flex items-center justify-center rounded-r-[5px] text-gray-500 ${c.xHover} transition-colors`}
                ><X className="w-2.5 h-2.5" /></button>
              </div>
            );
          })}
          {(settings.weightPresets || [-1, 0.5, 0.8, 1.5, 2.0]).length < 6 && (
            <button
              onClick={() => updateSettingsImmediate({ weightPresets: [...(settings.weightPresets || [-1, 0.5, 0.8, 1.5, 2.0]), 1.0] })}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-dashed border-gray-600 text-[11px] text-gray-500 hover:border-gray-400 hover:text-gray-300 transition-colors"
            ><Plus className="w-3 h-3" />添加</button>
          )}
        </div>
        <p className="text-[11px] text-gray-600 mt-2.5">点击芯片面板中的预设按钮可快速设置标签权重</p>
      </div>
    </div>
  );
};
