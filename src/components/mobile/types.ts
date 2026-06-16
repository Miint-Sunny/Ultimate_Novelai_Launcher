import type { VibeData } from '../../services/localLibrary';

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
  position?: string;
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
