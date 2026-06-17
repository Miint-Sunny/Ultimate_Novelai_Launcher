import { useCallback, type Dispatch, type SetStateAction } from 'react';
import type { WDTaggerResult } from '../../../services/wdTagger';
import type { MobileImageImportOptions } from './useMobileImageImport';

interface UseMobileTaggerImportActionOptions {
  taggerResult: WDTaggerResult | null;
  includeCharacter: boolean;
  importOptions: MobileImageImportOptions;
  setPositivePrompt: Dispatch<SetStateAction<string>>;
  closeImageImportModal: () => void;
}

export function useMobileTaggerImportAction({
  taggerResult,
  includeCharacter,
  importOptions,
  setPositivePrompt,
  closeImageImportModal,
}: UseMobileTaggerImportActionOptions) {
  const importTaggerPrompt = useCallback(() => {
    if (!taggerResult?.tags) return;

    const finalPrompt = includeCharacter && taggerResult.character
      ? `${taggerResult.character}, ${taggerResult.tags}`
      : taggerResult.tags;

    if (importOptions.cleanImports) {
      setPositivePrompt(finalPrompt);
    } else {
      setPositivePrompt((prev) => (prev ? `${prev}, ${finalPrompt}` : finalPrompt));
    }
    closeImageImportModal();
  }, [closeImageImportModal, includeCharacter, importOptions.cleanImports, setPositivePrompt, taggerResult]);

  return {
    importTaggerPrompt,
  };
}
