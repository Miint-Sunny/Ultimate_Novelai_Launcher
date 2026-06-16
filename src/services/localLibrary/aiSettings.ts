import { normalizeNoiseSchedule, SAMPLER_LABELS, samplerIdToLabel } from '../../utils/generationOptions';

export interface AISettings {
  steps: number;
  scale: number;
  sampler: string;
  scaleRescale: number;
  noiseSchedule: string;
  varietyPlus: boolean;
  normalizeVibeStrength: boolean;
}

const AI_SETTINGS_KEY = 'novelai_ai_settings';

export const DEFAULT_AI_SETTINGS: AISettings = {
  steps: 28,
  scale: 5,
  sampler: 'Euler Ancestral',
  scaleRescale: 0,
  noiseSchedule: 'karras',
  varietyPlus: false,
  normalizeVibeStrength: true,
};

export const saveAISettings = (settings: AISettings): void => {
  localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(settings));
};

export const getAISettings = (): AISettings => {
  const stored = localStorage.getItem(AI_SETTINGS_KEY);
  if (!stored) return DEFAULT_AI_SETTINGS;

  try {
    const merged = { ...DEFAULT_AI_SETTINGS, ...JSON.parse(stored) };
    merged.noiseSchedule = normalizeNoiseSchedule(merged.noiseSchedule);
    if (!SAMPLER_LABELS.includes(merged.sampler)) {
      merged.sampler = samplerIdToLabel(merged.sampler) ?? DEFAULT_AI_SETTINGS.sampler;
    }
    return merged;
  } catch {
    return DEFAULT_AI_SETTINGS;
  }
};
