import type { Dispatch, SetStateAction } from 'react';
import { createVibeFromImageBase64 } from '../../../services/localLibrary';
import type { ActiveCR, ActiveVibe } from '../types';

interface UseMobileImportedImageActionsOptions {
  importImageDataUrl: string | null;
  setActiveVibes: Dispatch<SetStateAction<ActiveVibe[]>>;
  setImg2imgWithAutoRes: (dataUrl: string) => void;
  setActiveCR: (cr: ActiveCR | null) => void;
  closeImageImportModal: () => void;
}

export function useMobileImportedImageActions({
  importImageDataUrl,
  setActiveVibes,
  setImg2imgWithAutoRes,
  setActiveCR,
  closeImageImportModal,
}: UseMobileImportedImageActionsOptions) {
  const useImportedImageAsVibe = async () => {
    if (importImageDataUrl) {
      try {
        const base64Data = importImageDataUrl.split(',')[1];
        const newVibe = await createVibeFromImageBase64(base64Data, 0.6, 1, `vibe_${Date.now()}`);
        if (newVibe) {
          setActiveVibes((prev) => [...prev, {
            ...newVibe,
            referenceStrength: newVibe.defaultStrength || 0.6,
            informationExtracted: newVibe.defaultInfoExtracted || 1,
            enabled: true,
          }]);
        }
      } catch (error) {
        console.error('创建 Vibe 失败:', error);
      }
    }
    closeImageImportModal();
  };

  const useImportedImageAsImg2Img = () => {
    if (importImageDataUrl) setImg2imgWithAutoRes(importImageDataUrl);
    closeImageImportModal();
  };

  const useImportedImageAsCR = () => {
    if (importImageDataUrl) {
      setActiveCR({
        id: `cr_${Date.now()}`,
        name: '导入的CR',
        preview: importImageDataUrl,
        fidelity: 1,
        styleAware: false,
      });
    }
    closeImageImportModal();
  };

  return {
    useImportedImageAsVibe,
    useImportedImageAsImg2Img,
    useImportedImageAsCR,
  };
}
