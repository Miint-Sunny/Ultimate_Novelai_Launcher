import { useCallback, useEffect, useState } from 'react';
import { getAppSettings } from '../../services/localLibrary';
import { botService, onlineService } from '../../services/botService';
import { getAnlas, type AnlasInfo, updateCachedIsOpus } from '../../services/novelai';

const MIN_LOADING_DURATION_MS = 500;

export function useAnlasStatus() {
  const [anlasInfo, setAnlasInfo] = useState<AnlasInfo | null>(null);
  const [isLoadingAnlas, setIsLoadingAnlas] = useState(false);
  const [onlineCount, setOnlineCount] = useState(0);

  const fetchAnlas = useCallback(async () => {
    setIsLoadingAnlas(true);
    const startTime = Date.now();

    try {
      const settings = getAppSettings();
      if (settings.loginMode === 'bot') {
        const result = await botService.getAnlas();
        if (result) {
          setAnlasInfo({
            fixedTrainingStepsLeft: result.anlas,
            purchasedTrainingSteps: 0,
            isOpus: true,
          });
          updateCachedIsOpus(true);
        }
      } else {
        const info = await getAnlas();
        setAnlasInfo(info);
        if (info) updateCachedIsOpus(info.isOpus);
      }
    } finally {
      const elapsed = Date.now() - startTime;
      if (elapsed < MIN_LOADING_DURATION_MS) {
        await new Promise((resolve) => setTimeout(resolve, MIN_LOADING_DURATION_MS - elapsed));
      }
      setIsLoadingAnlas(false);
    }
  }, []);

  useEffect(() => {
    void fetchAnlas();
  }, [fetchAnlas]);

  useEffect(() => {
    onlineService.start();
    const unsubscribe = onlineService.addEventListener(setOnlineCount);
    return () => {
      unsubscribe();
      onlineService.stop();
    };
  }, []);

  return {
    anlasInfo,
    isLoadingAnlas,
    onlineCount,
    fetchAnlas,
  };
}
