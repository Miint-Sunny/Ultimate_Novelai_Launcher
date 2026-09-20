// 生成载荷的提示词组装(桌面端语义,自 left-sidebar/generationPromptBuilder 原样迁移,双端共享)
// 注意:这里的 filterHiddenTags 与 utils/promptTags 版本语义不同(仅按逗号切分、保留空 tag、
// 不按行处理),桌面生成链路必须保持该行为逐字节不变;移动端自带的提示词组装(折叠标记展开、
// 中文翻译、行级过滤)不在本模块,见 mobile/generate/mobilePromptPreparation。

import { appendBeforeTextBlock } from '../../utils/textRenderHints.ts';
import type { CharacterCenter } from '../../services/characterPosition';
import { qualityTailForModel, type QualityTier } from '../../services/naiQualityTails';

// 结构类型:桌面 PromptPreset(left-sidebar/types)与移动端 PromptPresetData(localLibrary)
// 均结构兼容,避免装配层反向依赖某一端的组件类型。
export interface PromptPresetContent {
  positive?: string;
  negative?: string;
  /** 正面预设拼在末尾(官方位置)而不是开头;缺省 = 开头,与历史行为一致。 */
  suffixPositive?: boolean;
  /** 质量档;见 localLibrary/promptPresets。 */
  qualityTier?: QualityTier;
}

// 结构类型:桌面与移动端的 CharacterPrompt 均结构兼容。
export interface CharacterPromptContent {
  positive: string;
  negative: string;
  enabled: boolean;
  /** 旧的 A1–E5 网格,只为读旧存档保留。 */
  position?: string;
  /** 画布上的连续坐标(0–1);`null`/缺省 = 自动。见 services/characterPosition。 */
  center?: CharacterCenter | null;
}

export function filterHiddenTags(prompt: string) {
  return prompt
    .split(/[,，]/)
    .map(tag => tag.trim())
    .filter(tag => !tag.startsWith('~'))
    .join(', ');
}

export function buildPromptPair({
  positivePrompt,
  negativePrompt,
  activePreset,
  model,
}: {
  positivePrompt: string;
  negativePrompt: string;
  activePreset: PromptPresetContent | null | undefined;
  /** 当前模型。给了才会按模型取质量尾;不给(移动端旧调用)用预设行的字面文本。 */
  model?: string;
}) {
  let positive = filterHiddenTags(positivePrompt);
  let negative = filterHiddenTags(negativePrompt);

  // 质量尾随模型走:官方每个模型一段,预设行里的字面串只是认不出模型时的兜底。
  const presetPositive =
    activePreset?.qualityTier && model
      ? (qualityTailForModel(model, activePreset.qualityTier) ?? activePreset.positive)
      : activePreset?.positive;

  if (presetPositive) {
    // 前缀分支保持原样(含 positive 为空时那个尾随的 `, `)——桌面生成链路的
    // 逐字节基线就是照它比的。后缀分支是新加的,可以顺手把空串处理干净。
    positive = activePreset?.suffixPositive
      ? appendBeforeTextBlock(positive, presetPositive)
      : `${presetPositive}, ${positive}`;
  }
  if (activePreset?.negative) {
    negative = `${activePreset.negative}, ${negative}`;
  }

  return { positive, negative };
}

export function buildCharacterPromptParams(characterPrompts: CharacterPromptContent[]) {
  return characterPrompts
    .filter(character => character.enabled)
    .map(character => ({
      positive: filterHiddenTags(character.positive),
      negative: filterHiddenTags(character.negative),
      enabled: character.enabled,
      position: character.position,
      // 这里漏掉 center 的话画布摆的位置根本到不了发包层。
      center: character.center ?? null,
    }));
}
