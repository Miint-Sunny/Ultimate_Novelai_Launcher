import type { VibeData } from '../../services/localLibrary';
import type { CharacterCenter } from '../../services/characterPosition';

export interface VibeFile {
  id: string;
  name: string;
  preview?: string;
  image?: string;
  encodings?: VibeData['encodings'];
  defaultStrength?: number;
  defaultInfoExtracted?: number;
  supportedModels?: string[];
  fileName?: string;
}

export interface ActiveVibe extends VibeFile {
  referenceStrength: number;
  informationExtracted: number;
  enabled: boolean;
  fileName?: string;
  isPublic?: boolean;
}

export type PreciseReferenceMode = 'character&style' | 'character' | 'style';

export interface CRFile {
  id: string;
  name: string;
  preview: string;
}

export interface ActivePreciseRef {
  id: string;
  name: string;
  preview: string;
  mode: PreciseReferenceMode;
  informationExtracted: number;
  strength: number;
  enabled: boolean;
}

export interface ActiveCR extends CRFile {
  fidelity: number;
  styleAware: boolean;
}

export interface CharacterPrompt {
  id: string;
  positive: string;
  negative: string;
  activeTab: 'prompt' | 'undesired';
  enabled: boolean;
  /** 旧的 A1–E5 网格。 */
  position?: string;
  /**
   * 画布上的连续坐标(0–1);`null`/缺省 = 自动。
   * 竖屏这边还没有画布控件,这个字段先只保证与桌面/发包层结构兼容
   * (共享 hook 的字段是两端并集),不改移动端现有行为。
   */
  center?: CharacterCenter | null;
  name?: string;
}

export interface ArtistFile {
  id: string;
  name: string;
  previews: string[];
  prompt: string;
}

export interface OCFile {
  id: string;
  name: string;
  preview: string;
  positive: string;
  negative: string;
  aliases?: string[];
  user?: string;
  created_by?: string;
  created_at?: number;
  isLocal?: boolean;
}
