import { V5_QUALITY_SUFFIX, V5_UC_PREFIX } from '../naiV5Presets';

export const PROMPT_PRESETS_KEY = 'novelai_prompt_presets';
const ACTIVE_PRESET_KEY = 'novelai_active_preset';

/**
 * 内置档的适用模型系列。自定义预设不带 scope = 两个系列下都能选。
 *
 * 分组的理由:V5 的官方质量词与负面档和 V4.5 完全是两套文本(V5 的 light 负面
 * 甚至用上了 `0::ai-generated::` 这种零权重写法),混在一个列表里选会串味。
 */
export type PromptPresetScope = 'legacy' | 'v5';

export interface PromptPresetData {
  id: string;
  name: string;
  positive: string;
  negative: string;
  isDefault?: boolean;
  createdAt?: number;
  /** 只在该系列的模型下出现;缺省(自定义预设)= 不限系列。 */
  scope?: PromptPresetScope;
  /**
   * 正面预设拼在提示词**末尾**而不是开头。
   *
   * 官方从 V4 起就把质量词放末尾(负面一律前缀)。新增的 V5 档照官方来;
   * legacy 两档保持前缀不动 —— 存量用户的出图风格挂在上面,挪位置会变图。
   */
  suffixPositive?: boolean;
}

export const DEFAULT_PROMPT_PRESETS: PromptPresetData[] = [
  // ===== V4.5 及更早 =====
  // ⚠ 这两档的文本**勿动**(包括 heavy 里重复的 `very aesthetic`、少一个空格的
  // `absurdres,very aesthetic`、以及负面末尾那个孤零零的 `1`)。它们从初始导入
  // 就是这样,存量用户的出图风格挂在上面;要"修正"得当成一次会变图的改动单独走。
  {
    id: 'heavy',
    name: '重度 (质量标签)',
    scope: 'legacy',
    positive: 'best quality, amazing quality, very aesthetic, absurdres,very aesthetic, masterpiece, no text',
    negative: 'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, 1',
    isDefault: true,
  },
  {
    id: 'light',
    name: '轻度',
    scope: 'legacy',
    positive: 'very aesthetic, masterpiece, no text',
    negative: 'lowres, artistic error, scan artifacts, worst quality, bad quality, jpeg artifacts, multiple views, very displeasing, too many watermarks, negative space, blank page, 1',
    isDefault: true,
  },
  // ===== V5 =====
  // 文本一律引用 naiV5Presets 的官方表,不在这里再抄一份 —— 抄一份就会有一份走样。
  // 官方把「正面质量档」和「负面档」做成两个独立下拉,我们这套预设是一行一档,
  // 因此按官方的默认配对并成四条:质量档 standard/light 各一条,另外两个只改
  // 负面的侧重档配官方默认的 standard 质量尾。
  {
    id: 'v5-standard',
    name: '标准',
    scope: 'v5',
    suffixPositive: true,
    positive: V5_QUALITY_SUFFIX.standard,
    negative: V5_UC_PREFIX.heavy,
    isDefault: true,
  },
  {
    id: 'v5-light',
    name: '轻度',
    scope: 'v5',
    suffixPositive: true,
    positive: V5_QUALITY_SUFFIX.light,
    negative: V5_UC_PREFIX.light,
    isDefault: true,
  },
  {
    id: 'v5-human-focus',
    name: '人物侧重',
    scope: 'v5',
    suffixPositive: true,
    positive: V5_QUALITY_SUFFIX.standard,
    negative: V5_UC_PREFIX.humanFocus,
    isDefault: true,
  },
  {
    id: 'v5-furry-focus',
    name: '兽人侧重',
    scope: 'v5',
    suffixPositive: true,
    positive: V5_QUALITY_SUFFIX.standard,
    negative: V5_UC_PREFIX.furryFocus,
    isDefault: true,
  },
  // 两个系列共用:不加任何预设文本。
  {
    id: 'none',
    name: '无',
    positive: '',
    negative: '',
    isDefault: true,
  },
];

export const savePromptPresets = (presets: PromptPresetData[]): void => {
  localStorage.setItem(PROMPT_PRESETS_KEY, JSON.stringify(presets));
};

export const getPromptPresets = (): PromptPresetData[] => {
  const stored = localStorage.getItem(PROMPT_PRESETS_KEY);
  if (!stored) return DEFAULT_PROMPT_PRESETS;

  try {
    const parsed = JSON.parse(stored);
    const defaultIds = DEFAULT_PROMPT_PRESETS.map(p => p.id);
    const customPresets = parsed.filter((p: PromptPresetData) => !defaultIds.includes(p.id));
    return [...DEFAULT_PROMPT_PRESETS, ...customPresets];
  } catch {
    return DEFAULT_PROMPT_PRESETS;
  }
};

export const saveActivePresetId = (id: string): void => {
  localStorage.setItem(ACTIVE_PRESET_KEY, id);
};

export const getActivePresetId = (): string => {
  return localStorage.getItem(ACTIVE_PRESET_KEY) || 'heavy';
};

export const addPromptPreset = (preset: Omit<PromptPresetData, 'id' | 'createdAt'>): PromptPresetData => {
  const presets = getPromptPresets();
  const newPreset: PromptPresetData = {
    ...preset,
    id: `custom_${Date.now()}`,
    createdAt: Date.now(),
  };
  savePromptPresets([...presets, newPreset]);
  return newPreset;
};

export const updatePromptPreset = (id: string, updates: Partial<PromptPresetData>): void => {
  const presets = getPromptPresets();
  savePromptPresets(presets.map(p => (p.id === id ? { ...p, ...updates } : p)));
};

export const deletePromptPreset = (id: string): void => {
  const presets = getPromptPresets();
  const preset = presets.find(p => p.id === id);
  if (preset?.isDefault) return;

  savePromptPresets(presets.filter(p => p.id !== id));
};
