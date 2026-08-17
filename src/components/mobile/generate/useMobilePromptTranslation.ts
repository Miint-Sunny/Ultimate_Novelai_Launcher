import { useCallback, type Dispatch, type SetStateAction } from 'react';
import { useSharedPromptTranslation } from '../../../hooks/useSharedPromptTranslation';

interface UseMobilePromptTranslationOptions {
  positivePrompt: string;
  setPositivePrompt: Dispatch<SetStateAction<string>>;
  negativePrompt: string;
  setNegativePrompt: Dispatch<SetStateAction<string>>;
}

// 薄壳:只消费共享层(src/hooks/useSharedPromptTranslation.ts)的中译英子集,
// 不引入桌面的英译中预览面板。对齐点:仅在内容变化时写回、异常捕获并记日志
// (此前异常会直接逃逸),hasChinesePrompt 门不变。
export function useMobilePromptTranslation({
  positivePrompt,
  setPositivePrompt,
  negativePrompt,
  setNegativePrompt,
}: UseMobilePromptTranslationOptions) {
  const {
    hasChinesePrompt,
    isTranslating,
    translateChinesePrompts,
  } = useSharedPromptTranslation({
    positivePrompt,
    negativePrompt,
    setPositivePrompt,
    setNegativePrompt,
  });

  const handleTranslate = useCallback(async () => {
    if (!hasChinesePrompt) return;
    await translateChinesePrompts();
  }, [hasChinesePrompt, translateChinesePrompts]);

  return {
    hasChinesePrompt,
    isTranslating,
    handleTranslate,
  };
}
