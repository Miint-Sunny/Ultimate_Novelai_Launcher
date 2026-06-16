import { useEffect, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { fetchWikiChineseNames, translateTagWithGemini } from '../../services/tagAutocomplete';
import type { TagPanelState } from './TagQuickPanel';

interface UseTagPanelStateParams {
  panel: TagPanelState | null;
  setPanel: Dispatch<SetStateAction<TagPanelState | null>>;
  translationCacheRef: MutableRefObject<Map<string, string>>;
}

export function useTagPanelState({
  panel,
  setPanel,
  translationCacheRef,
}: UseTagPanelStateParams) {
  const [numWeight, setNumWeight] = useState(1.0);
  const [translationLoading, setTranslationLoading] = useState(false);

  useEffect(() => {
    if (!panel) return;
    const match = panel.rawTag.match(/^(-?\d+(?:\.\d+)?)::/);
    setNumWeight(match ? parseFloat(match[1]) : 1.0);
  }, [panel]);

  useEffect(() => {
    if (!panel || panel.translation) {
      setTranslationLoading(false);
      return;
    }

    let cancelled = false;
    const queryTag = panel.tag.replace(/ /g, '_');
    setTranslationLoading(true);

    (async () => {
      try {
        const result = await fetchWikiChineseNames([queryTag]);
        if (cancelled) return;
        let translation = result[queryTag]?.[0] || '';
        if (!translation) {
          translation = await translateTagWithGemini(queryTag) || '';
        }
        if (cancelled) return;
        if (translation) {
          translationCacheRef.current.set(panel.tag, translation);
          setPanel(prev => prev && prev.from === panel.from ? { ...prev, translation } : prev);
        }
      } catch {
        // Keep the existing silent failure behavior.
      } finally {
        if (!cancelled) setTranslationLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [panel?.from, panel?.tag, panel?.translation, setPanel, translationCacheRef]);

  return {
    numWeight,
    setNumWeight,
    translationLoading,
  };
}
