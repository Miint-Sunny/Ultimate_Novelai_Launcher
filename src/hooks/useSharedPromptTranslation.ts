import { useCallback, useMemo, useState } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { containsChinese, translateChineseInPrompt, translatePrompts } from '../services/translate';
import type { PromptEditorRef } from '../components/PromptEditor';

type TranslationType = 'positive' | 'negative';

type TranslationCache = {
  positive: Map<string, string>;
  negative: Map<string, string>;
  cachedPositive: string;
  cachedNegative: string;
};

interface UseSharedPromptTranslationOptions {
  positivePrompt: string;
  negativePrompt: string;
  setPositivePrompt: Dispatch<SetStateAction<string>>;
  setNegativePrompt: Dispatch<SetStateAction<string>>;
  /** 桌面编辑器引用(点击译文标签回跳选区);移动端无,缺省即可 */
  positiveEditorRef?: RefObject<PromptEditorRef | null>;
  negativeEditorRef?: RefObject<PromptEditorRef | null>;
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

// 提示词翻译的双端共享核心(桌面 usePromptTranslation 语义):
// 中译英(translateChinesePrompts)、英译中预览面板(showTranslation/缓存/
// handleTranslationToggle/handleTagClick)。移动端只消费中译英子集,
// 不引入预览面板 UI。
export function useSharedPromptTranslation({
  positivePrompt,
  negativePrompt,
  setPositivePrompt,
  setNegativePrompt,
  positiveEditorRef,
  negativeEditorRef,
}: UseSharedPromptTranslationOptions) {
  const [showTranslation, setShowTranslation] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);
  const [translationCache, setTranslationCache] = useState<TranslationCache>({
    positive: new Map(),
    negative: new Map(),
    cachedPositive: '',
    cachedNegative: '',
  });

  const hasChinesePrompt = useMemo(
    () => containsChinese(positivePrompt) || containsChinese(negativePrompt),
    [negativePrompt, positivePrompt],
  );

  // 中译英:仅在实际变化时写回(桌面语义)
  const translateChinesePrompts = useCallback(async () => {
    const hasChineseInPositive = containsChinese(positivePrompt);
    const hasChineseInNegative = containsChinese(negativePrompt);
    if (!hasChineseInPositive && !hasChineseInNegative) return;

    setIsTranslating(true);
    try {
      let newPositive = positivePrompt;
      let newNegative = negativePrompt;

      if (hasChineseInPositive) {
        newPositive = await translateChineseInPrompt(positivePrompt);
      }
      if (hasChineseInNegative) {
        newNegative = await translateChineseInPrompt(negativePrompt);
      }

      if (newPositive !== positivePrompt) {
        setPositivePrompt(newPositive);
      }
      if (newNegative !== negativePrompt) {
        setNegativePrompt(newNegative);
      }
    } catch (error) {
      console.error('[Translation] 中译英失败:', error);
    } finally {
      setIsTranslating(false);
    }
  }, [negativePrompt, positivePrompt, setNegativePrompt, setPositivePrompt]);

  // 桌面双模式开关:有中文 → 中译英;否则 → 英译中预览面板
  const handleTranslationToggle = useCallback(async () => {
    if (containsChinese(positivePrompt) || containsChinese(negativePrompt)) {
      await translateChinesePrompts();
      return;
    }

    if (showTranslation) {
      setShowTranslation(false);
      return;
    }

    const positiveValid = isTranslationCacheValid(positivePrompt, translationCache.positive);
    const negativeValid = isTranslationCacheValid(negativePrompt, translationCache.negative);
    const cacheHit = (
      (translationCache.cachedPositive === positivePrompt &&
        translationCache.cachedNegative === negativePrompt) ||
      (positiveValid && negativeValid)
    );

    if (cacheHit) {
      setShowTranslation(true);
      return;
    }

    setIsTranslating(true);
    try {
      const result = await translatePrompts(positivePrompt, negativePrompt);
      setTranslationCache({
        ...result,
        cachedPositive: positivePrompt,
        cachedNegative: negativePrompt,
      });
      setShowTranslation(true);
    } catch (error) {
      console.error('[Translation] 翻译失败:', error);
    } finally {
      setIsTranslating(false);
    }
  }, [negativePrompt, positivePrompt, showTranslation, translateChinesePrompts, translationCache]);

  const handleTagClick = useCallback((
    startIndex: number,
    length: number,
    type: TranslationType,
  ) => {
    setShowTranslation(false);

    setTimeout(() => {
      const editorRef = type === 'positive'
        ? positiveEditorRef
        : negativeEditorRef;

      if (editorRef?.current) {
        editorRef.current.focus();
        editorRef.current.setSelection(startIndex, startIndex + length);
      }
    }, 0);
  }, [negativeEditorRef, positiveEditorRef]);

  return {
    showTranslation,
    setShowTranslation,
    translationCache,
    isTranslating,
    hasChinesePrompt,
    translateChinesePrompts,
    handleTranslationToggle,
    handleTagClick,
  };
}
