import { useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import {
  containsChinese,
  translateChineseInPrompt,
} from '../../../services/translate';

interface UseMobilePromptTranslationOptions {
  positivePrompt: string;
  setPositivePrompt: Dispatch<SetStateAction<string>>;
  negativePrompt: string;
  setNegativePrompt: Dispatch<SetStateAction<string>>;
}

export function useMobilePromptTranslation({
  positivePrompt,
  setPositivePrompt,
  negativePrompt,
  setNegativePrompt,
}: UseMobilePromptTranslationOptions) {
  const [isTranslating, setIsTranslating] = useState(false);
  const hasChinesePrompt = useMemo(
    () => containsChinese(positivePrompt) || containsChinese(negativePrompt),
    [negativePrompt, positivePrompt]
  );

  const handleTranslate = async () => {
    if (!hasChinesePrompt) return;
    setIsTranslating(true);
    try {
      if (containsChinese(positivePrompt)) {
        setPositivePrompt(await translateChineseInPrompt(positivePrompt));
      }
      if (containsChinese(negativePrompt)) {
        setNegativePrompt(await translateChineseInPrompt(negativePrompt));
      }
    } finally {
      setIsTranslating(false);
    }
  };

  return {
    hasChinesePrompt,
    isTranslating,
    handleTranslate,
  };
}
