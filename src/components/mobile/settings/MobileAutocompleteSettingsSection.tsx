import React from 'react';
import type { AppSettings } from '../../../services/localLibrary';
import { MobileSettingsToggle } from './MobileSettingsToggle';

interface MobileAutocompleteSettingsSectionProps {
  settings: AppSettings;
  updateSettingsImmediate: (updates: Partial<AppSettings>) => void;
}

export const MobileAutocompleteSettingsSection: React.FC<MobileAutocompleteSettingsSectionProps> = ({
  settings,
  updateSettingsImmediate,
}) => (
  <div className="p-4 space-y-4">
    <div className="flex items-center justify-between p-4 bg-gray-800 rounded-xl">
      <div>
        <div className="text-sm font-medium text-white">启用标签补全</div>
        <p className="text-xs text-gray-500 mt-1">输入时自动显示标签建议</p>
      </div>
      <MobileSettingsToggle
        enabled={settings.autocompleteEnabled}
        onChange={() => updateSettingsImmediate({ autocompleteEnabled: !settings.autocompleteEnabled })}
      />
    </div>
    <div className={`flex items-center justify-between p-4 bg-gray-800 rounded-xl ${!settings.autocompleteEnabled ? 'opacity-50' : ''}`}>
      <div>
        <div className="text-sm font-medium text-white">中文输入补全</div>
        <p className="text-xs text-gray-500 mt-1">支持输入中文搜索标签</p>
      </div>
      <MobileSettingsToggle
        enabled={settings.autocompleteChineseEnabled}
        onChange={() => updateSettingsImmediate({ autocompleteChineseEnabled: !settings.autocompleteChineseEnabled })}
        disabled={!settings.autocompleteEnabled}
      />
    </div>
    <div className={`flex items-center justify-between p-4 bg-gray-800 rounded-xl ${!settings.autocompleteEnabled ? 'opacity-50' : ''}`}>
      <div>
        <div className="text-sm font-medium text-white">显示 Wiki 翻译</div>
        <p className="text-xs text-gray-500 mt-1">显示标签的中文翻译</p>
      </div>
      <MobileSettingsToggle
        enabled={settings.autocompleteShowWiki}
        onChange={() => updateSettingsImmediate({ autocompleteShowWiki: !settings.autocompleteShowWiki })}
        disabled={!settings.autocompleteEnabled}
      />
    </div>
    <div className={`p-4 bg-gray-800 rounded-xl ${!settings.autocompleteEnabled ? 'opacity-50' : ''}`}>
      <label className="text-xs text-gray-500 uppercase tracking-wider mb-1 block">Danbooru 结果排序</label>
      <p className="text-[10px] text-gray-500 mb-3">仅影响英文查询时 Danbooru 标签的内部顺序</p>
      <div className="grid grid-cols-2 gap-3">
        {[
          { id: 'prefix-first', name: '首字母优先' },
          { id: 'count', name: '引用数排序' },
        ].map((option) => (
          <button
            key={option.id}
            onClick={() => settings.autocompleteEnabled && updateSettingsImmediate({ autocompleteSortOrder: option.id as AppSettings['autocompleteSortOrder'] })}
            className={`px-4 py-3 rounded-xl text-sm font-medium transition-colors ${settings.autocompleteSortOrder === option.id
              ? 'bg-nai-accent/20 text-nai-accent border-2 border-nai-accent'
              : 'bg-gray-700 text-gray-400 border-2 border-gray-600'
              }`}
          >
            {option.name}
          </button>
        ))}
      </div>
    </div>
  </div>
);
