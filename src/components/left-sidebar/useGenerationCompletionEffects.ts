import { useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';

const VIBE_HISTORY_KEY = 'novelai_vibe_history';
const PENDING_VIBES_KEY = 'novelai_pending_vibes';
const VIBE_HISTORY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface UseGenerationCompletionEffectsParams {
  isGenerating: boolean;
  currentSeed: string | number | null | undefined;
  fetchAnlas: () => Promise<void>;
  loopGeneratingRef: MutableRefObject<boolean>;
  handleGenerate: () => void;
}

function persistPendingVibes(currentSeed: string | number) {
  const pendingVibesStr = sessionStorage.getItem(PENDING_VIBES_KEY);
  if (!pendingVibesStr) return;

  try {
    const pendingVibes = JSON.parse(pendingVibesStr);
    const historyStr = localStorage.getItem(VIBE_HISTORY_KEY);
    const history: Record<string, { vibes: unknown; timestamp: number }> =
      historyStr ? JSON.parse(historyStr) : {};

    history[String(currentSeed)] = {
      vibes: pendingVibes,
      timestamp: Date.now(),
    };

    const expiresBefore = Date.now() - VIBE_HISTORY_TTL_MS;
    for (const seedKey in history) {
      if (history[seedKey].timestamp < expiresBefore) {
        delete history[seedKey];
      }
    }

    localStorage.setItem(VIBE_HISTORY_KEY, JSON.stringify(history));
    sessionStorage.removeItem(PENDING_VIBES_KEY);
    console.log(`[Vibe历史] 已保存 seed=${currentSeed} 的 vibe 关联:`, pendingVibes);
  } catch (error) {
    console.warn('[Vibe历史] 保存失败:', error);
  }
}

export function useGenerationCompletionEffects({
  isGenerating,
  currentSeed,
  fetchAnlas,
  loopGeneratingRef,
  handleGenerate,
}: UseGenerationCompletionEffectsParams) {
  const wasGeneratingRef = useRef(false);

  useEffect(() => {
    if (wasGeneratingRef.current && !isGenerating) {
      void fetchAnlas();

      if (currentSeed) {
        persistPendingVibes(currentSeed);
      }

      if (loopGeneratingRef.current) {
        handleGenerate();
      }
    }

    wasGeneratingRef.current = isGenerating;
  }, [currentSeed, fetchAnlas, handleGenerate, isGenerating, loopGeneratingRef]);
}
