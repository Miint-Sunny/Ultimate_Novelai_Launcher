import { useCallback, useState } from 'react';
import { getAppSettings } from '../services/localLibrary';
import { botService } from '../services/botService';
import {
  getAnlas,
  type AnlasInfo,
  updateCachedIsOpus,
} from '../services/novelai';

interface UseSharedAnlasStatusOptions {
  /** 最短 loading 时长(桌面防闪烁 500ms;移动端无此要求,传 0) */
  minLoadingDurationMs?: number;
}

// anlas 余额查询的双端共享核心(桌面 useAnlasStatus 语义);
// 在线人数、生成完成后自动刷新等端侧差异留在各自壳里。
export function useSharedAnlasStatus({ minLoadingDurationMs = 0 }: UseSharedAnlasStatusOptions = {}) {
  const [anlasInfo, setAnlasInfo] = useState<AnlasInfo | null>(null);
  const [isLoadingAnlas, setIsLoadingAnlas] = useState(false);

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
      if (elapsed < minLoadingDurationMs) {
        await new Promise((resolve) => setTimeout(resolve, minLoadingDurationMs - elapsed));
      }
      setIsLoadingAnlas(false);
    }
  }, [minLoadingDurationMs]);

  return {
    anlasInfo,
    isLoadingAnlas,
    fetchAnlas,
  };
}
