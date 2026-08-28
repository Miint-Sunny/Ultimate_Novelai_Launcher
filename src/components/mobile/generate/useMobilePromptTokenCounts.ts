import { useMemo } from 'react';
import { promptTokenizerForModel } from '../../generation/modelResolutionOptions';
import { useQwenTokenizerReady } from '../../../hooks/useQwenTokenizerReady';
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
  /** 当前型号:分词口径(V5=Qwen / V4系=T5)由能力表决定,不在调用点写家族判断。 */
  model: string;
}

export function useMobilePromptTokenCounts({
  positivePrompt,
  negativePrompt,
  activePreset,
  characterPrompts,
  characterPromptsVisible = true,
  model,
}: UseMobilePromptTokenCountsOptions) {
  const tokenizer = promptTokenizerForModel(model);
  // Qwen 资产懒加载就绪后读数从 T5 近似升级为精确口径,依赖它触发重算。
  const qwenReady = useQwenTokenizerReady();
  const countWithKind = useMemo(
    () => (text: string) => countTokens(text, tokenizer),
    [tokenizer, qwenReady]
  );

  const positivePresetTokens = useMemo(
    () => (activePreset?.positive ? countWithKind(activePreset.positive) : 0),
    [activePreset?.positive, countWithKind]
  );

  const negativePresetTokens = useMemo(
    () => (activePreset?.negative ? countWithKind(activePreset.negative) : 0),
    [activePreset?.negative, countWithKind]
  );

  const positiveTokens = useMemo(() => {
    let total = countWithKind(expandCollapsibleMarkers(filterHiddenTags(positivePrompt))) + positivePresetTokens;
    if (!characterPromptsVisible) return total;
    characterPrompts.forEach((characterPrompt) => {
      if (characterPrompt.enabled && characterPrompt.positive) {
        total += countWithKind(filterHiddenTags(characterPrompt.positive));
      }
    });
    return total;
  }, [characterPrompts, characterPromptsVisible, countWithKind, positivePresetTokens, positivePrompt]);

  const negativeTokens = useMemo(() => {
    let total = countWithKind(filterHiddenTags(negativePrompt)) + negativePresetTokens;
    if (!characterPromptsVisible) return total;
    characterPrompts.forEach((characterPrompt) => {
      if (characterPrompt.enabled && characterPrompt.negative) {
        total += countWithKind(filterHiddenTags(characterPrompt.negative));
      }
    });
    return total;
  }, [characterPrompts, characterPromptsVisible, countWithKind, negativePresetTokens, negativePrompt]);

  return {
    positiveTokens,
    negativeTokens,
    positivePresetTokens,
    negativePresetTokens,
  };
}
