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
}

export type ToastType = 'success' | 'error' | 'warning';
