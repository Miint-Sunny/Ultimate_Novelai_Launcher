import {
  User, Palette, PersonStanding, Sun, Mountain,
  Tag, Sparkles, Wand, Flame, Snowflake, Droplet, Leaf,
  Crown, Gem, Music, Coffee, Camera, Map, Compass,
  Heart, Star, Cloud, Moon, Zap, Flower, Brush, Eye,
  Hand, Smile,
  type LucideIcon,
} from 'lucide-react';
import type { SubtypeDef } from './types';

const ICON_MAP: Record<string, LucideIcon> = {
  User, Palette, PersonStanding, Sun, Mountain,
  Tag, Sparkles, Wand, Flame, Snowflake, Droplet, Leaf,
  Crown, Gem, Music, Coffee, Camera, Map, Compass,
  Heart, Star, Cloud, Moon, Zap, Flower, Brush, Eye,
  Hand, Smile,
};

export function getLucideIcon(name: string): LucideIcon | null {
  return ICON_MAP[name] || null;
}

// 用户自定义子分类可选的图标白名单
export const ICON_WHITELIST: string[] = [
  'Tag', 'Sparkles', 'Wand', 'Flame', 'Snowflake', 'Droplet', 'Leaf',
  'Crown', 'Gem', 'Music', 'Coffee', 'Camera', 'Map', 'Compass',
  'Heart', 'Star', 'Cloud', 'Moon', 'Zap', 'Flower', 'Brush', 'Eye',
  'Hand', 'Smile',
];

// 预置 5 个子分类
export const BUILTIN_SUBTYPES: SubtypeDef[] = [
  {
    id: 'character',
    label: '角色',
    iconName: 'User',
    colorTone: 'amber',
    insertStrategy: { kind: 'character-prompt' },
    cardLayout: 'portrait',
    maxSelectable: 6,
    isBuiltin: true,
    enablePublicTab: true,
    enableRandomPick: true,
  },
  {
    id: 'artist-style',
    label: '画风',
    iconName: 'Palette',
    colorTone: 'sky',
    insertStrategy: { kind: 'collapsible-tag', tagType: 'artist' },
    cardLayout: 'compact',
    maxSelectable: 99,
    isBuiltin: true,
    enableAlphabetRail: true,
    enablePublicTab: true,
    enableCloudBackup: true,
    enablePublicUploadManager: true,
  },
  {
    id: 'scene',
    label: '场景',
    iconName: 'Mountain',
    colorTone: 'teal',
    insertStrategy: { kind: 'collapsible-tag', tagType: 'scene' },
    cardLayout: 'compact',
    maxSelectable: 20,
    isBuiltin: true,
  },
  {
    id: 'other',
    label: '其他',
    iconName: 'Tag',
    colorTone: 'slate',
    insertStrategy: { kind: 'collapsible-tag', tagType: 'other' },
    cardLayout: 'compact',
    maxSelectable: 20,
    isBuiltin: true,
  },
];

const BUILTIN_IDS = new Set(BUILTIN_SUBTYPES.map(s => s.id));

export function isBuiltinSubtypeId(id: string): boolean {
  return BUILTIN_IDS.has(id);
}

export function getAllSubtypes(custom: SubtypeDef[]): SubtypeDef[] {
  const validCustom = custom.filter(s => !BUILTIN_IDS.has(s.id));
  return [...BUILTIN_SUBTYPES, ...validCustom];
}

export function findSubtype(all: SubtypeDef[], id: string): SubtypeDef | undefined {
  return all.find(s => s.id === id);
}

// 给定一个 collapsible tag 的 type 字符串, 反查 SubtypeDef
// 优先按 insertStrategy.tagType 匹配, fallback 到 subtypeId 本身
export function findSubtypeByTagType(all: SubtypeDef[], tagType: string): SubtypeDef | undefined {
  return (
    all.find(s => s.insertStrategy.kind === 'collapsible-tag' && s.insertStrategy.tagType === tagType) ||
    all.find(s => s.id === tagType)
  );
}

// 同步读取 localStorage 中的用户自定义子分类
// 供非 React 上下文使用 (tiptap nodeView 等)。 React 组件应优先用 useCustomRegistry hook
export const CUSTOM_SUBTYPE_STORAGE_KEY = 'tag_subtypes_custom_v1';

export function readCustomSubtypesFromStorage(): SubtypeDef[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(CUSTOM_SUBTYPE_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// 一次性获取完整子分类清单 (builtin + 用户自定义)
export function getRegistrySnapshot(): SubtypeDef[] {
  return getAllSubtypes(readCustomSubtypesFromStorage());
}
