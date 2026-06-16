// 统一 Tag 管理器 - 类型定义

export type ColorTone =
  | 'amber'
  | 'sky'
  | 'emerald'
  | 'rose'
  | 'slate'
  | 'cyan'
  | 'lime'
  | 'orange'
  | 'teal';

export type InsertStrategy =
  | { kind: 'character-prompt' }
  | { kind: 'collapsible-tag'; tagType: string };

export type CardLayout = 'portrait' | 'compact' | 'chip';

export interface SubtypeDef {
  id: string;
  label: string;
  iconName: string;
  colorTone: ColorTone;
  insertStrategy: InsertStrategy;
  cardLayout: CardLayout;
  maxSelectable: number;
  isBuiltin?: boolean;
  enableAlphabetRail?: boolean;
  enablePublicTab?: boolean;
  enableCloudBackup?: boolean;
  enablePublicUploadManager?: boolean;
  enableRandomPick?: boolean;
  previewPromptTemplate?: string;
}

export interface TagFile {
  id: string;
  subtypeId: string;
  name: string;
  preview?: string;
  legacyPreviews?: string[];
  positive: string;
  negative?: string;
  aliases?: string[];
  tags?: string[];
  origin?: 'local' | 'favorited' | 'created' | 'public';
  publicId?: string;
  usageCount?: number;
  createdAt?: number;
  createdBy?: string;
  _isLocal?: boolean;
}
