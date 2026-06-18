import React from 'react';
import { Check } from 'lucide-react';
import { THEME_OPTIONS, type AppSettings } from '../../../services/localLibrary';

interface MobileThemeSettingsSectionProps {
  settings: AppSettings;
  updateSettingsImmediate: (updates: Partial<AppSettings>) => void;
}

export const MobileThemeSettingsSection: React.FC<MobileThemeSettingsSectionProps> = ({
  settings,
  updateSettingsImmediate,
}) => (
  <div className="p-4 space-y-4">
    <div className="text-xs text-gray-500 uppercase tracking-wider mb-3">选择主题</div>
    <div className="grid grid-cols-2 gap-3">
      {THEME_OPTIONS.map((theme) => (
        <button
          key={theme.id}
          onClick={() => updateSettingsImmediate({ theme: theme.id })}
          className={`flex items-center gap-3 p-4 rounded-xl border-2 transition-all ${settings.theme === theme.id
            ? 'bg-nai-accent/20 border-nai-accent'
            : 'bg-gray-800 border-gray-700 active:bg-gray-700'
            }`}
        >
          <div
            className="w-6 h-6 rounded-full border-2 border-gray-500 shadow-lg"
            style={{ backgroundColor: theme.color }}
          />
          <span className={`text-sm font-medium ${settings.theme === theme.id ? 'text-nai-accent' : 'text-gray-300'}`}>
            {theme.name}
          </span>
          {settings.theme === theme.id && <Check className="w-4 h-4 text-nai-accent ml-auto" />}
        </button>
      ))}
    </div>
    <p className="text-xs text-gray-500 mt-4">更多主题即将推出...</p>
  </div>
);
