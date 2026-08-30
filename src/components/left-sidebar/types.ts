import type { PromptPresetScope } from '../../services/localLibrary/promptPresets';
import type { CharacterCenter } from '../../services/characterPosition';

export interface CharacterPrompt {
  id: string;
  positive: string;
  negative: string;
  activeTab: 'prompt' | 'undesired';
  enabled: boolean;
  /** 旧的 A1–E5 网格。只为读旧存档保留,新数据写 `center`。 */
  position?: string;
  /** 画布上的连续坐标(0–1);`null`/缺省 = 自动。见 services/characterPosition。 */
  center?: CharacterCenter | null;
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
