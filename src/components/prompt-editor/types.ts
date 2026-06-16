export type CollapsibleTagType = string;

export interface CollapsibleTag {
  id: string;
  type: CollapsibleTagType;
  label: string;
  content: string;
  collapsed: boolean;
}
