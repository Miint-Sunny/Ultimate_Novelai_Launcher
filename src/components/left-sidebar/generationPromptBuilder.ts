import type { CharacterPrompt, PromptPreset } from './types';

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
}: {
  positivePrompt: string;
  negativePrompt: string;
  activePreset: PromptPreset | null | undefined;
}) {
  let positive = filterHiddenTags(positivePrompt);
  let negative = filterHiddenTags(negativePrompt);

  if (activePreset?.positive) {
    positive = `${activePreset.positive}, ${positive}`;
  }
  if (activePreset?.negative) {
    negative = `${activePreset.negative}, ${negative}`;
  }

  return { positive, negative };
}

export function buildCharacterPromptParams(characterPrompts: CharacterPrompt[]) {
  return characterPrompts
    .filter(character => character.enabled)
    .map(character => ({
      positive: filterHiddenTags(character.positive),
      negative: filterHiddenTags(character.negative),
      enabled: character.enabled,
      position: character.position,
    }));
}
