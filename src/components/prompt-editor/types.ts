import type { TagWikiPreview } from '../../services/tagAutocomplete';

export type CollapsibleTagType = string;

export interface CollapsibleTag {
  id: string;
  type: CollapsibleTagType;
  label: string;
  content: string;
  collapsed: boolean;
}

export interface SuggestionWikiPreviewState {
  tag: string;
  data: TagWikiPreview | null;
  loading: boolean;
  summaryZhLoading?: boolean;
  anchor: DOMRect;
  closing?: boolean;
}
