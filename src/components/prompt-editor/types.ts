import type { TagWikiPreview } from '../../services/tagAutocomplete';

export type CollapsibleTagType = string;

export interface CollapsibleTag {
  id: string;
  type: CollapsibleTagType;
  label: string;
  content: string;
  collapsed: boolean;
}

export interface PromptEditorRef {
  addCollapsibleTag: (tag: Omit<CollapsibleTag, 'id'>) => void;
  getPlainText: () => string;
  getTags: () => CollapsibleTag[];
  removeTagsByType: (type: CollapsibleTagType) => void;
  focus: () => void;
  insertText: (text: string) => void;
  setSelection: (from: number, to: number) => void;
  getSelection: () => { text: string; from: number; to: number } | null;
  replaceSelection: (text: string) => void;
  getTranslationCache: () => Map<string, string>;
  setTranslationCache: (key: string, value: string) => void;
}

export interface SuggestionWikiPreviewState {
  tag: string;
  data: TagWikiPreview | null;
  loading: boolean;
  summaryZhLoading?: boolean;
  anchor: DOMRect;
  closing?: boolean;
}
