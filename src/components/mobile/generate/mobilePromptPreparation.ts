// 移动端专属提示词组装(自 mobileGenerationPreparation 原样迁移,行为不变):
// 与桌面端 generationPrompts 的差异均为移动端既有行为,不在 P1 对齐范围内:
//   - 正向提示词先经行级 filterHiddenTags(utils/promptTags)再展开折叠标记
//   - 预设合并带空值分支(空 prompt 时直接使用预设内容)
//   - 中译英翻译(containsChinese / translateChineseInPrompt)
//   - 角色提示词额外按 positive.trim() 过滤
import type { GenerateImageParams } from '../../../services/novelai';
import {
  containsChinese,
  translateChineseInPrompt,
} from '../../../services/translate';
import { filterHiddenTags } from '../../../utils/promptTags';
import type { CharacterPromptContent, PromptPresetContent } from '../../generation/generationPrompts';
import { expandCollapsibleMarkers } from '../FullscreenEditor';

export async function prepareMobilePromptPair({
  positivePrompt,
  negativePrompt,
  activePreset,
}: {
  positivePrompt: string;
  negativePrompt: string;
  activePreset: PromptPresetContent | null | undefined;
}) {
  let finalPrompt = expandCollapsibleMarkers(filterHiddenTags(positivePrompt));
  let finalNegative = filterHiddenTags(negativePrompt);

  if (activePreset) {
    if (activePreset.positive) {
      finalPrompt = finalPrompt ? `${activePreset.positive}, ${finalPrompt}` : activePreset.positive;
    }
    if (activePreset.negative) {
      finalNegative = finalNegative ? `${activePreset.negative}, ${finalNegative}` : activePreset.negative;
    }
  }

  if (containsChinese(finalPrompt)) finalPrompt = await translateChineseInPrompt(finalPrompt);
  if (containsChinese(finalNegative)) finalNegative = await translateChineseInPrompt(finalNegative);

  return {
    positive: finalPrompt,
    negative: finalNegative,
  };
}

export function prepareMobileCharacterPrompts(
  characterPrompts: CharacterPromptContent[]
): GenerateImageParams['characterPrompts'] {
  return characterPrompts
    .filter((characterPrompt) => characterPrompt.enabled && characterPrompt.positive.trim())
    .map((characterPrompt) => ({
      positive: filterHiddenTags(characterPrompt.positive),
      negative: filterHiddenTags(characterPrompt.negative),
      enabled: characterPrompt.enabled,
      position: characterPrompt.position,
    }));
}
