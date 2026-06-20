import React from 'react';
import { ChevronDown, Check } from 'lucide-react';
import { type AppSettings, THEME_OPTIONS } from '../../services/localLibrary';

interface ThemeSettingsSectionProps {
  settings: AppSettings;
  isThemeDropdownOpen: boolean;
  setIsThemeDropdownOpen: (open: boolean) => void;
  updateSettingsImmediate: (updates: Partial<AppSettings>) => void;
}

export const ThemeSettingsSection: React.FC<ThemeSettingsSectionProps> = ({
  settings,
  isThemeDropdownOpen,
  setIsThemeDropdownOpen,
  updateSettingsImmediate,
}) => {
  const selectedTheme = THEME_OPTIONS.find((t) => t.id === settings.theme) || THEME_OPTIONS[0];

  return (
    <div className="space-y-4">
      <div className="bg-gray-800/50 rounded-lg border border-gray-700 p-4">
        <label className="block text-xs text-gray-400 mb-3 uppercase tracking-wider">
          当前主题
        </label>
        <div className="relative">
          <button
            className="w-full bg-gray-900 hover:bg-gray-800 px-4 py-3 rounded-lg flex items-center justify-between text-left transition-colors border border-gray-700"
            onClick={() => setIsThemeDropdownOpen(!isThemeDropdownOpen)}
          >
            <div className="flex items-center gap-3">
              <div
                className="w-6 h-6 rounded-full border-2 border-gray-600 shadow-lg"
                style={{ backgroundColor: selectedTheme.color }}
              />
              <span className="text-white">{selectedTheme.name}</span>
            </div>
            <ChevronDown
              className={`w-4 h-4 text-gray-400 transition-transform ${isThemeDropdownOpen ? 'rotate-180' : ''}`}
            />
          </button>

          {isThemeDropdownOpen && (
            <div className="absolute top-full left-0 right-0 mt-2 bg-gray-900 border border-gray-700 rounded-lg shadow-xl overflow-hidden z-50">
              {THEME_OPTIONS.map((theme) => (
                <button
                  key={theme.id}
                  className={`w-full px-4 py-3 text-left hover:bg-gray-800 transition-colors flex items-center justify-between ${settings.theme === theme.id ? 'bg-gray-800' : ''
                    }`}
                  onClick={() => {
                    updateSettingsImmediate({ theme: theme.id });
                    setIsThemeDropdownOpen(false);
                  }}
                >
                  <div className="flex items-center gap-3">
                    <div
                      className="w-6 h-6 rounded-full border-2 border-gray-600"
                      style={{ backgroundColor: theme.color }}
                    />
                    <span className="text-white">{theme.name}</span>
                  </div>
                  {settings.theme === theme.id && (
                    <Check className="w-4 h-4 text-nai-accent" />
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
        <p className="text-xs text-gray-500 mt-3">更多主题即将推出...</p>
      </div>
    </div>
  );
};
