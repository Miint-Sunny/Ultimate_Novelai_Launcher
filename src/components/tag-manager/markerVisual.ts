// collapsible 标记芯片视觉: lucide 图标 + 中文名 (配色统一 nai-accent 暖黄)
// builtin 类型固定图标/名; 自定义 subtype 从 registry 取图标与中文 label
// 双端共享（DesktopChipEditor / mobile FullscreenEditor）
import { Palette, BookOpen, User, Mountain, Tag, type LucideIcon } from 'lucide-react';
import { getRegistrySnapshot, findSubtypeByTagType, getLucideIcon } from './registry';

export interface MarkerVisual {
  Icon: LucideIcon;
  label: string;
}

const MARKER_VISUALS: Record<string, MarkerVisual> = {
  artist: { Icon: Palette,  label: '画师串' },
  codex:  { Icon: BookOpen, label: '法典' },
  oc:     { Icon: User,     label: '角色' },
  scene:  { Icon: Mountain, label: '场景' },
  other:  { Icon: Tag,      label: '其他' },
};

export const getMarkerVisual = (type: string): MarkerVisual => {
  const preset = MARKER_VISUALS[type];
  if (preset) return preset;
  // 自定义 subtype: 取 registry 的图标与中文名,图标兜底 Tag
  const subtype = findSubtypeByTagType(getRegistrySnapshot(), type);
  return { Icon: (subtype && getLucideIcon(subtype.iconName)) || Tag, label: subtype?.label || type };
};
