/**
 * 提示词预设的目录层:把「用户看到的一行预设」翻译成「官方的两个档位」。
 *
 * 存储层(localLibrary/promptPresets)只管一行预设的文本与增删改;
 * 官方那边其实是两个互相独立的下拉——正面的质量档(quality preset)与负面的
 * 负面档(undesired content preset)。我们这套 UI 一行一档,所以需要这张表
 * 把两者对上。分成两个文件是因为存储层要保持可被任何端直接读写,不该知道
 * 官方档位这回事。
 *
 * ⚠ 这里的档位名是**官方枚举名**,不是线上那个数字 `ucPreset`(后者是可见档位
 * 数组的下标,由 naiUcPresets.resolveUcPreset 负责)。两张表都有 heavy/light。
 */

import type { PromptPresetData, PromptPresetScope } from './localLibrary/promptPresets';
import type { NaiV5QualityPresetId, NaiV5UcPresetId } from './naiV5Presets';

export interface PresetOfficialSource {
  /** 该档的正面文本取自官方哪个质量档;对不上任何单一档就是 null。 */
  quality: NaiV5QualityPresetId | null;
  /** 该档的负面文本取自官方哪个负面档;对不上就是 null。 */
  uc: NaiV5UcPresetId | null;
}

const NO_OFFICIAL_SOURCE: PresetOfficialSource = { quality: null, uc: null };

/**
 * 每条内置预设的文本实际取自哪个官方档。
 *
 * 官方导入图片时靠这个提示决定「先拿哪个档去试着把预设文本剥掉」,剥不掉会自己
 * 暴力扫描兜底 —— 所以对不上就留 null,别硬凑一个看着像的。
 *
 * `heavy` / `light` 的正面自 2026-09-04 起按模型取官方质量尾(naiQualityTails),
 * 旧模型族只有 standard 一档,所以两条都报 standard;之前那个 V3+V4.5 拼接串只剩
 * 认不出模型时的兜底用途,不再决定来源。
 *
 * 同一份表在 Plana-App 的 `_presetOfficialSource` 里有一份独立实现,
 * 两边的结论一致。
 */
const PRESET_OFFICIAL_SOURCE: Readonly<Record<string, PresetOfficialSource>> = {
  heavy: { quality: 'standard', uc: 'heavy' },
  light: { quality: 'standard', uc: 'light' },
  'v5-standard': { quality: 'standard', uc: 'heavy' },
  'v5-light': { quality: 'light', uc: 'light' },
  'v5-human-focus': { quality: 'standard', uc: 'humanFocus' },
  'v5-furry-focus': { quality: 'standard', uc: 'furryFocus' },
  none: { quality: null, uc: null },
};

/** 自定义预设与未知 id 一律「没有官方来源」——它们的文本是用户自己写的。 */
export function presetOfficialSource(presetId: string): PresetOfficialSource {
  return PRESET_OFFICIAL_SOURCE[presetId] ?? NO_OFFICIAL_SOURCE;
}

export function presetScopeForModel(isV5: boolean): PromptPresetScope {
  return isV5 ? 'v5' : 'legacy';
}

/**
 * 当前模型能看到哪些档:内置档按 scope 过滤,自定义预设(无 scope)两边都留。
 */
export function promptPresetsForModel<T extends { scope?: PromptPresetScope }>(
  presets: readonly T[],
  isV5: boolean,
): T[] {
  const want = presetScopeForModel(isV5);
  return presets.filter((preset) => preset.scope === undefined || preset.scope === want);
}

/** 同强度档在两个系列之间的对应;没列出的(自定义预设)不参与映射。 */
const PRESET_EQUIVALENTS: Readonly<Record<string, string>> = {
  heavy: 'v5-standard',
  light: 'v5-light',
  'v5-standard': 'heavy',
  'v5-light': 'light',
  // V5 才有的两个侧重档在 legacy 侧没有同强度对应,回落到列表首项。
};

/**
 * 把当前档映射到目标模型可用的档(同官方:切模型会重算档位)。
 * 仍然可选 → 原样保留;能对上同强度档 → 换过去;都不行 → 落到列表首项。
 *
 * 注意这是**推导**而不是改写存储:切回原系列还能拿回原来那一档。
 */
export function remapPromptPresetId(
  activeId: string,
  presets: readonly PromptPresetData[],
  isV5: boolean,
): string {
  const visible = promptPresetsForModel(presets, isV5);
  if (visible.some((preset) => preset.id === activeId)) return activeId;
  const equivalent = PRESET_EQUIVALENTS[activeId];
  if (equivalent !== undefined && visible.some((preset) => preset.id === equivalent)) {
    return equivalent;
  }
  return visible.length > 0 ? visible[0].id : 'none';
}
