import React from 'react';
import { type AppSettings } from '../../services/localLibrary';

interface AutocompleteSettingsSectionProps {
  settings: AppSettings;
  updateSettingsImmediate: (updates: Partial<AppSettings>) => void;
}

export const AutocompleteSettingsSection: React.FC<AutocompleteSettingsSectionProps> = ({
  settings,
  updateSettingsImmediate,
}) => {
  return (
    <div className="space-y-4">
      {/* 启用补全 */}
      <div className="bg-gray-800/50 rounded-lg border border-gray-700 p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-white">启用标签补全</div>
            <p className="text-xs text-gray-500 mt-1">
              输入时自动显示标签建议
            </p>
          </div>
          <button
            onClick={() => updateSettingsImmediate({ autocompleteEnabled: !settings.autocompleteEnabled })}
            className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${settings.autocompleteEnabled ? 'bg-emerald-500' : 'bg-gray-600'
              }`}
          >
            <div
              className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200 ${settings.autocompleteEnabled ? 'translate-x-5' : 'translate-x-0'
                }`}
            />
          </button>
        </div>
      </div>

      {/* 中文补全 */}
      <div className={`bg-gray-800/50 rounded-lg border border-gray-700 p-4 ${!settings.autocompleteEnabled ? 'opacity-50 pointer-events-none' : ''}`}>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-white">中文输入补全</div>
            <p className="text-xs text-gray-500 mt-1">
              支持输入中文搜索标签（仅角色匹配）
            </p>
          </div>
          <button
            onClick={() => updateSettingsImmediate({ autocompleteChineseEnabled: !settings.autocompleteChineseEnabled })}
            className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${settings.autocompleteChineseEnabled ? 'bg-emerald-500' : 'bg-gray-600'
              }`}
          >
            <div
              className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200 ${settings.autocompleteChineseEnabled ? 'translate-x-5' : 'translate-x-0'
                }`}
            />
          </button>
        </div>
      </div>

      {/* 显示 Wiki 翻译 */}
      <div className={`bg-gray-800/50 rounded-lg border border-gray-700 p-4 ${!settings.autocompleteEnabled ? 'opacity-50 pointer-events-none' : ''}`}>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-white">显示 Wiki 翻译</div>
            <p className="text-xs text-gray-500 mt-1">
              在补全列表中显示标签的中文翻译
            </p>
          </div>
          <button
            onClick={() => updateSettingsImmediate({ autocompleteShowWiki: !settings.autocompleteShowWiki })}
            className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${settings.autocompleteShowWiki ? 'bg-emerald-500' : 'bg-gray-600'
              }`}
          >
            <div
              className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white shadow transition-transform duration-200 ${settings.autocompleteShowWiki ? 'translate-x-5' : 'translate-x-0'
                }`}
            />
          </button>
        </div>
      </div>

      {/* Danbooru 结果排序（仅英文查询生效） */}
      <div className={`bg-gray-800/50 rounded-lg border border-gray-700 p-4 ${!settings.autocompleteEnabled ? 'opacity-50 pointer-events-none' : ''}`}>
        <label className="block text-xs text-gray-400 mb-1 uppercase tracking-wider">
          Danbooru 结果排序
        </label>
        <p className="text-[10px] text-gray-500 mb-3">仅影响英文查询时 Danbooru 标签的内部顺序</p>
        <div className="grid grid-cols-2 gap-2">
          {[
            { id: 'prefix-first', name: '首字母匹配优先' },
            { id: 'count', name: '引用数量排序' },
          ].map((option) => (
            <button
              key={option.id}
              onClick={() => updateSettingsImmediate({ autocompleteSortOrder: option.id as AppSettings['autocompleteSortOrder'] })}
              className={`px-3 py-2 rounded-lg text-sm transition-colors ${settings.autocompleteSortOrder === option.id
                ? 'bg-nai-accent/20 text-nai-accent border border-nai-accent/50'
                : 'bg-gray-900 text-gray-400 border border-gray-700 hover:bg-gray-800'
                }`}
            >
              {option.name}
            </button>
          ))}
        </div>
        <p className="text-xs text-gray-500 mt-2">
          {settings.autocompleteSortOrder === 'prefix-first' && '优先显示以输入内容开头的标签'}
          {settings.autocompleteSortOrder === 'count' && '按标签引用次数从高到低排序'}
        </p>
      </div>

      {/* 数据源自定义入口 Beta24 起暂时关闭，统一使用内置默认配置；保留旧 localStorage，待功能成熟后再开放 */}
    </div>
  );
};
