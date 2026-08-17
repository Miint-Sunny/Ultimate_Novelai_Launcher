import type { Dispatch, RefObject, SetStateAction } from 'react';
import { useSharedPromptTranslation } from '../../hooks/useSharedPromptTranslation';
import type { PromptEditorRef } from '../PromptEditor';

interface UsePromptTranslationParams {
  positivePrompt: string;
  negativePrompt: string;
  setPositivePrompt: Dispatch<SetStateAction<string>>;
  setNegativePrompt: Dispatch<SetStateAction<string>>;
  positiveEditorRef: RefObject<PromptEditorRef | null>;
  negativeEditorRef: RefObject<PromptEditorRef | null>;
}

// 薄壳:全部逻辑在 src/hooks/useSharedPromptTranslation.ts,行为与原实现一致。
export function usePromptTranslation(params: UsePromptTranslationParams) {
  const {
    showTranslation,
    setShowTranslation,
    translationCache,
    isTranslating,
    handleTranslationToggle,
    handleTagClick,
  } = useSharedPromptTranslation(params);

  return {
    showTranslation,
    setShowTranslation,
    translationCache,
    isTranslating,
    handleTranslationToggle,
    handleTagClick,
  };
}
