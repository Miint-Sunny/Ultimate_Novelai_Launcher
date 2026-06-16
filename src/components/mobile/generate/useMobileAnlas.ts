import { useCallback, useEffect, useRef, useState } from 'react';
import { getAppSettings } from '../../../services/localLibrary';
import { botService } from '../../../services/botService';
import {
  getAnlas,
  type AnlasInfo,
  updateCachedIsOpus,
} from '../../../services/novelai';

export function useMobileAnlas(isGenerating: boolean) {
  const [anlasInfo, setAnlasInfo] = useState<AnlasInfo | null>(null);
  const [isLoadingAnlas, setIsLoadingAnlas] = useState(false);
  const wasGeneratingRef = useRef(false);

  const fetchAnlas = useCallback(async () => {
    setIsLoadingAnlas(true);
    try {
      const settings = getAppSettings();
      if (settings.loginMode === 'bot') {
        const result = await botService.getAnlas();
        if (result) {
          setAnlasInfo({ fixedTrainingStepsLeft: result.anlas, purchasedTrainingSteps: 0, isOpus: true });
          updateCachedIsOpus(true);
        }
      } else {
        const info = await getAnlas();
        setAnlasInfo(info);
        if (info) updateCachedIsOpus(info.isOpus);
      }
    } finally {
      setIsLoadingAnlas(false);
    }
  }, []);

  useEffect(() => {
    if (wasGeneratingRef.current && !isGenerating) {
      void fetchAnlas();
    }
    wasGeneratingRef.current = isGenerating;
  }, [fetchAnlas, isGenerating]);

  return {
    anlasInfo,
    isLoadingAnlas,
    fetchAnlas,
  };
}
