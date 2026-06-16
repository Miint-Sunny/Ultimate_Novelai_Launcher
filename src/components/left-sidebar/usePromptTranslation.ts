import { useCallback, useState } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { containsChinese, translateChineseInPrompt, translatePrompts } from '../../services/translate';
import type { PromptEditorRef } from '../PromptEditor';

type TranslationType = 'positive' | 'negative';

type TranslationCache = {
  positive: Map<string, string>;
  negative: Map<string, string>;
  cachedPositive: string;
  cachedNegative: string;
};

interface UsePromptTranslationParams {
  positivePrompt: string;
  negativePrompt: string;
  setPositivePrompt: Dispatch<SetStateAction<string>>;
  setNegativePrompt: Dispatch<SetStateAction<string>>;
  positiveEditorRef: RefObject<PromptEditorRef | null>;
  negativeEditorRef: RefObject<PromptEditorRef | null>;
}

function isTranslationCacheValid(prompt: string, cache: Map<string, string>) {
  if (!prompt.trim()) return true;
  if (cache.size === 0) return false;

  const tags = prompt
    .split(/[,，]/)
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);

  if (tags.length === 0) return true;
  return tags.every((tag) => cache.has(tag));
}

export function usePromptTranslation(params: UsePromptTranslationParams) {
  const [showTranslation, setShowTranslation] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);
  const [translationCache, setTranslationCache] = useState<TranslationCache>({
    positive: new Map(),
    negative: new Map(),
    cachedPositive: '',
    cachedNegative: '',
  });

  const handleTranslationToggle = useCallback(async () => {
    const hasChineseInPositive = containsChinese(params.positivePrompt);
    const hasChineseInNegative = containsChinese(params.negativePrompt);

    if (hasChineseInPositive || hasChineseInNegative) {
      setIsTranslating(true);
      try {
        let newPositive = params.positivePrompt;
        let newNegative = params.negativePrompt;

        if (hasChineseInPositive) {
          newPositive = await translateChineseInPrompt(params.positivePrompt);
        }
        if (hasChineseInNegative) {
          newNegative = await translateChineseInPrompt(params.negativePrompt);
        }

        if (newPositive !== params.positivePrompt) {
          params.setPositivePrompt(newPositive);
        }
        if (newNegative !== params.negativePrompt) {
          params.setNegativePrompt(newNegative);
        }
      } catch (error) {
        console.error('[Translation] 中译英失败:', error);
      } finally {
        setIsTranslating(false);
      }
      return;
    }

    if (showTranslation) {
      setShowTranslation(false);
      return;
    }

    const positiveValid = isTranslationCacheValid(params.positivePrompt, translationCache.positive);
    const negativeValid = isTranslationCacheValid(params.negativePrompt, translationCache.negative);
    const cacheHit = (
      (translationCache.cachedPositive === params.positivePrompt &&
        translationCache.cachedNegative === params.negativePrompt) ||
      (positiveValid && negativeValid)
    );

    if (cacheHit) {
      setShowTranslation(true);
      return;
    }

    setIsTranslating(true);
    try {
      const result = await translatePrompts(params.positivePrompt, params.negativePrompt);
      setTranslationCache({
        ...result,
        cachedPositive: params.positivePrompt,
        cachedNegative: params.negativePrompt,
      });
      setShowTranslation(true);
    } catch (error) {
      console.error('[Translation] 翻译失败:', error);
    } finally {
      setIsTranslating(false);
    }
  }, [params, showTranslation, translationCache]);

  const handleTagClick = useCallback((
    startIndex: number,
    length: number,
    type: TranslationType,
  ) => {
    setShowTranslation(false);

    setTimeout(() => {
      const editorRef = type === 'positive'
        ? params.positiveEditorRef
        : params.negativeEditorRef;

      if (editorRef.current) {
        editorRef.current.focus();
        editorRef.current.setSelection(startIndex, startIndex + length);
      }
    }, 0);
  }, [params.negativeEditorRef, params.positiveEditorRef]);

  return {
    showTranslation,
    setShowTranslation,
    translationCache,
    isTranslating,
    handleTranslationToggle,
    handleTagClick,
  };
}
