const CODEX_FILTER_SETTINGS_KEY = 'novelai_codex_filter_settings';

export type R18FilterType = 'all' | 'safe' | 'r18';

export interface CodexFilterSettings {
  r18Filter: R18FilterType;
  selectedCategories: string[];
}

export const DEFAULT_CODEX_FILTER_SETTINGS: CodexFilterSettings = {
  r18Filter: 'all',
  selectedCategories: [],
};

export const saveCodexFilterSettings = (settings: CodexFilterSettings): void => {
  localStorage.setItem(CODEX_FILTER_SETTINGS_KEY, JSON.stringify(settings));
};

export const getCodexFilterSettings = (): CodexFilterSettings => {
  const stored = localStorage.getItem(CODEX_FILTER_SETTINGS_KEY);
  if (!stored) return DEFAULT_CODEX_FILTER_SETTINGS;

  try {
    return { ...DEFAULT_CODEX_FILTER_SETTINGS, ...JSON.parse(stored) };
  } catch {
    return DEFAULT_CODEX_FILTER_SETTINGS;
  }
};
