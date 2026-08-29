import type { PromptPresetScope } from '../../services/localLibrary/promptPresets';

export interface CharacterPrompt {
  id: string;
  positive: string;
  negative: string;
  activeTab: 'prompt' | 'undesired';
  enabled: boolean;
  position?: string;
  name?: string;
}

export interface PromptPreset {
  id: string;
  name: string;
  positive: string;
  negative: string;
  isDefault?: boolean;
  /** 见 services/localLibrary/promptPresets:内置档只在对应模型系列下出现。 */
  scope?: PromptPresetScope;
  /** 正面预设拼在提示词末尾(官方位置)。 */
  suffixPositive?: boolean;
}

export type ToastType = 'success' | 'error' | 'warning';
