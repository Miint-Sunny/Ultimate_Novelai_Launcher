const PROMPT_PRESETS_KEY = 'novelai_prompt_presets';
const ACTIVE_PRESET_KEY = 'novelai_active_preset';

export interface PromptPresetData {
  id: string;
  name: string;
  positive: string;
  negative: string;
  isDefault?: boolean;
  createdAt?: number;
}

export const DEFAULT_PROMPT_PRESETS: PromptPresetData[] = [
  {
    id: 'heavy',
    name: '重度 (质量标签)',
    positive: 'best quality, amazing quality, very aesthetic, absurdres,very aesthetic, masterpiece, no text',
    negative: 'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, 1',
    isDefault: true,
  },
  {
    id: 'light',
    name: '轻度',
    positive: 'very aesthetic, masterpiece, no text',
    negative: 'lowres, artistic error, scan artifacts, worst quality, bad quality, jpeg artifacts, multiple views, very displeasing, too many watermarks, negative space, blank page, 1',
    isDefault: true,
  },
  {
    id: 'none',
    name: '无',
    positive: '',
    negative: '',
    isDefault: true,
  },
];

export const savePromptPresets = (presets: PromptPresetData[]): void => {
  localStorage.setItem(PROMPT_PRESETS_KEY, JSON.stringify(presets));
};

export const getPromptPresets = (): PromptPresetData[] => {
  const stored = localStorage.getItem(PROMPT_PRESETS_KEY);
  if (!stored) return DEFAULT_PROMPT_PRESETS;

  try {
    const parsed = JSON.parse(stored);
    const defaultIds = DEFAULT_PROMPT_PRESETS.map(p => p.id);
    const customPresets = parsed.filter((p: PromptPresetData) => !defaultIds.includes(p.id));
    return [...DEFAULT_PROMPT_PRESETS, ...customPresets];
  } catch {
    return DEFAULT_PROMPT_PRESETS;
  }
};

export const saveActivePresetId = (id: string): void => {
  localStorage.setItem(ACTIVE_PRESET_KEY, id);
};

export const getActivePresetId = (): string => {
  return localStorage.getItem(ACTIVE_PRESET_KEY) || 'heavy';
};

export const addPromptPreset = (preset: Omit<PromptPresetData, 'id' | 'createdAt'>): PromptPresetData => {
  const presets = getPromptPresets();
  const newPreset: PromptPresetData = {
    ...preset,
    id: `custom_${Date.now()}`,
    createdAt: Date.now(),
  };
  savePromptPresets([...presets, newPreset]);
  return newPreset;
};

export const updatePromptPreset = (id: string, updates: Partial<PromptPresetData>): void => {
  const presets = getPromptPresets();
  savePromptPresets(presets.map(p => (p.id === id ? { ...p, ...updates } : p)));
};

export const deletePromptPreset = (id: string): void => {
  const presets = getPromptPresets();
  const preset = presets.find(p => p.id === id);
  if (preset?.isDefault) return;

  savePromptPresets(presets.filter(p => p.id !== id));
};
