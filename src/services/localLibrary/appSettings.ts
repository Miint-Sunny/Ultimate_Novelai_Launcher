const APP_SETTINGS_KEY = 'novelai_app_settings';
export const APP_SETTINGS_CHANGED_EVENT = 'app-settings-changed';

export const THEME_OPTIONS = [
  { id: 'default', name: '默认主题', color: '#ebd576' },
];

export type AutocompleteSourceId = 'artists' | 'ocs' | 'characters' | 'origins' | 'danbooru' | 'aiRecommend' | 'nl';

export interface AutocompleteSourceConfig {
  id: AutocompleteSourceId;
  enabled: boolean;
  maxCount?: number;
  scope?: 'mine' | 'all';
}

export const DEFAULT_AUTOCOMPLETE_SOURCES: AutocompleteSourceConfig[] = [
  { id: 'nl', enabled: true },
  { id: 'artists', enabled: true, maxCount: 20, scope: 'all' },
  { id: 'ocs', enabled: true, maxCount: 20, scope: 'all' },
  { id: 'characters', enabled: true, maxCount: 20 },
  { id: 'origins', enabled: false, maxCount: 20 },
  { id: 'danbooru', enabled: true, maxCount: 20 },
  { id: 'aiRecommend', enabled: true, maxCount: 20 },
];

export interface AppSettings {
  theme: string;
  aiMode: 'public' | 'custom';
  aiBaseUrl: string;
  aiApiKey: string;
  translateModel: string;
  autocompleteModel: string;
  backendUrl: string;
  serverMode: 'public' | 'custom';
  queueEnabled: boolean;
  queueServerUrl: string;
  loginMode: 'token' | 'bot';
  autocompleteEnabled: boolean;
  autocompleteChineseEnabled: boolean;
  autocompleteShowWiki: boolean;
  autocompleteSortOrder: 'count' | 'prefix-first';
  autocompleteSources: AutocompleteSourceConfig[];
  upscaleModelPrecision: 'fp16' | 'fp32';
  aiMaxContextLength: number;
  aiPrisonBreakEnabled: boolean;
  kktServerMode: 'public' | 'custom';
  kktServerUrl: string;
  enterBehavior: 'default' | 'generate';
  weightPresets: number[];
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  theme: 'default',
  aiMode: 'public',
  aiBaseUrl: '',
  aiApiKey: '',
  translateModel: 'gemini-2.5-flash-lite',
  autocompleteModel: 'gemini-2.5-flash-lite',
  backendUrl: '',
  serverMode: 'public',
  queueEnabled: false,
  queueServerUrl: '',
  loginMode: 'token',
  autocompleteEnabled: true,
  autocompleteChineseEnabled: true,
  autocompleteShowWiki: true,
  autocompleteSortOrder: 'prefix-first',
  autocompleteSources: DEFAULT_AUTOCOMPLETE_SOURCES,
  upscaleModelPrecision: 'fp16',
  aiMaxContextLength: 30,
  aiPrisonBreakEnabled: true,
  kktServerMode: 'public',
  kktServerUrl: 'https://nai.sora214.top',
  enterBehavior: 'default',
  weightPresets: [-1, 0.5, 0.8, 1.5, 2.0],
};

const sanitizeAppSettings = (settings: AppSettings): AppSettings => ({
  ...settings,
  aiApiKey: '',
});

export const saveAppSettings = (settings: AppSettings): void => {
  localStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(sanitizeAppSettings(settings)));
  window.dispatchEvent(new Event(APP_SETTINGS_CHANGED_EVENT));
};

export const getAppSettings = (): AppSettings => {
  const stored = localStorage.getItem(APP_SETTINGS_KEY);
  let settings: AppSettings;
  let shouldRewriteSettings = false;

  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      shouldRewriteSettings = Boolean(parsed.aiApiKey);
      settings = sanitizeAppSettings({ ...DEFAULT_APP_SETTINGS, ...parsed });
    } catch {
      settings = sanitizeAppSettings(DEFAULT_APP_SETTINGS);
      shouldRewriteSettings = true;
    }
  } else {
    settings = sanitizeAppSettings(DEFAULT_APP_SETTINGS);
  }

  if (stored && shouldRewriteSettings) {
    localStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(settings));
  }

  const oldDefaultWeightPresets = [0.5, 0.8, 1.2, 1.5, 2.0];
  if (JSON.stringify(settings.weightPresets) === JSON.stringify(oldDefaultWeightPresets)) {
    settings = { ...settings, weightPresets: DEFAULT_APP_SETTINGS.weightPresets };
    localStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(settings));
  }

  settings.autocompleteSources = DEFAULT_AUTOCOMPLETE_SOURCES;
  return settings;
};
