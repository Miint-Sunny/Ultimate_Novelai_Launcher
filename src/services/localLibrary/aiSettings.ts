import { normalizeNoiseSchedule, SAMPLER_LABELS, samplerIdToLabel } from '../../utils/generationOptions';
import { DEFAULT_MODEL_ID, NAI_MODELS } from '../../components/generation/modelResolutionOptions';

export interface AISettings {
  steps: number;
  scale: number;
  sampler: string;
  scaleRescale: number;
  noiseSchedule: string;
  varietyPlus: boolean;
  normalizeVibeStrength: boolean;
  /** 上次选中的模型;首次启动为 DEFAULT_MODEL_ID。 */
  model: string;
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
  model: DEFAULT_MODEL_ID,
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
    // 记住的模型可能已经不在列表里(改过 id、下架过型号),那样恢复出来的是一个
    // 选不中也显示不出名字的空选择,不如退回默认。
    if (!NAI_MODELS.some((option) => option.id === merged.model)) {
      merged.model = DEFAULT_AI_SETTINGS.model;
    }
    return merged;
  } catch {
    return DEFAULT_AI_SETTINGS;
  }
};
