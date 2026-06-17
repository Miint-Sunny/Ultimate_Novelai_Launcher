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
}

export function useMobilePromptTokenCounts({
  positivePrompt,
  negativePrompt,
  activePreset,
  characterPrompts,
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
    characterPrompts.forEach((characterPrompt) => {
      if (characterPrompt.enabled && characterPrompt.positive) {
        total += countTokens(filterHiddenTags(characterPrompt.positive));
      }
    });
    return total;
  }, [characterPrompts, positivePresetTokens, positivePrompt]);

  const negativeTokens = useMemo(() => {
    let total = countTokens(filterHiddenTags(negativePrompt)) + negativePresetTokens;
    characterPrompts.forEach((characterPrompt) => {
      if (characterPrompt.enabled && characterPrompt.negative) {
        total += countTokens(filterHiddenTags(characterPrompt.negative));
      }
    });
    return total;
  }, [characterPrompts, negativePresetTokens, negativePrompt]);

  return {
    positiveTokens,
    negativeTokens,
    positivePresetTokens,
    negativePresetTokens,
  };
}
