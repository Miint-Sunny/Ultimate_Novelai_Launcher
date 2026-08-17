import { useMemo } from 'react';
import type { PromptPresetData } from '../../../services/localLibrary';
import { countTokens } from '../../../services/tokenizer';
import { filterHiddenTags } from '../../../utils/promptTags';
import { expandCollapsibleMarkers } from '../FullscreenEditor';
import type { CharacterPrompt } from '../types';

interface UseMobilePromptTokenCountsOptions {
  positivePrompt: string;
  negativePrompt: string;
  activePreset?: PromptPresetData;
  characterPrompts: CharacterPrompt[];
  /** P4 注册表:角色模块对当前型号不可见时其内容已被载荷剥离,计数同口径不计。
   *  缺省 true(保持既有调用方行为)。 */
  characterPromptsVisible?: boolean;
}

export function useMobilePromptTokenCounts({
  positivePrompt,
  negativePrompt,
  activePreset,
  characterPrompts,
  characterPromptsVisible = true,
}: UseMobilePromptTokenCountsOptions) {
  const positivePresetTokens = useMemo(
    () => (activePreset?.positive ? countTokens(activePreset.positive) : 0),
    [activePreset?.positive]
  );

  const negativePresetTokens = useMemo(
    () => (activePreset?.negative ? countTokens(activePreset.negative) : 0),
    [activePreset?.negative]
  );

  const positiveTokens = useMemo(() => {
    let total = countTokens(expandCollapsibleMarkers(filterHiddenTags(positivePrompt))) + positivePresetTokens;
    if (!characterPromptsVisible) return total;
    characterPrompts.forEach((characterPrompt) => {
      if (characterPrompt.enabled && characterPrompt.positive) {
        total += countTokens(filterHiddenTags(characterPrompt.positive));
      }
    });
    return total;
  }, [characterPrompts, characterPromptsVisible, positivePresetTokens, positivePrompt]);

  const negativeTokens = useMemo(() => {
    let total = countTokens(filterHiddenTags(negativePrompt)) + negativePresetTokens;
    if (!characterPromptsVisible) return total;
    characterPrompts.forEach((characterPrompt) => {
      if (characterPrompt.enabled && characterPrompt.negative) {
        total += countTokens(filterHiddenTags(characterPrompt.negative));
      }
    });
    return total;
  }, [characterPrompts, characterPromptsVisible, negativePresetTokens, negativePrompt]);

  return {
    positiveTokens,
    negativeTokens,
    positivePresetTokens,
    negativePresetTokens,
  };
}
