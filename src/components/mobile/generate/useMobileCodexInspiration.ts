import { useCallback, useEffect, useMemo, useState } from 'react';
import { loadCodexData, type CodexItem } from '../../../services/codexData';

export type CodexR18Filter = 'all' | 'safe' | 'r18';
export type InspirationTab = 'codex' | 'random';

export function useMobileCodexInspiration(isOpen: boolean) {
  const [inspirationTab, setInspirationTab] = useState<InspirationTab>('codex');
  const [codexData, setCodexData] = useState<CodexItem[]>([]);
  const [isLoadingCodex, setIsLoadingCodex] = useState(false);
  const [codexSearchQuery, setCodexSearchQuery] = useState('');
  const [codexR18Filter, setCodexR18Filter] = useState<CodexR18Filter>('all');
  const [codexSelectedCategories, setCodexSelectedCategories] = useState<string[]>([]);
  const [showCategoryFilter, setShowCategoryFilter] = useState(false);
  const [randomCodexItem, setRandomCodexItem] = useState<CodexItem | null>(null);
  const [codexDisplayCount, setCodexDisplayCount] = useState(30);

  const loadCodex = useCallback(async () => {
    if (codexData.length > 0) return;
    setIsLoadingCodex(true);
    try {
      const data = await loadCodexData();
      setCodexData(data);
    } catch (error) {
      console.error('Failed to load codex:', error);
    } finally {
      setIsLoadingCodex(false);
    }
  }, [codexData.length]);

  const categoriesByType = useMemo(() => {
    const nsfwCategories = new Set<string>();
    const commonCategories = new Set<string>();

    codexData.forEach((item) => {
      if (item.isR18) {
        nsfwCategories.add(item.category);
      } else {
        commonCategories.add(item.category);
      }
    });

    return {
      nsfw: Array.from(nsfwCategories).sort(),
      common: Array.from(commonCategories).sort(),
    };
  }, [codexData]);

  const filteredCodexData = useMemo(() => {
    return codexData.filter((item) => {
      if (codexSearchQuery) {
        const query = codexSearchQuery.toLowerCase();
        if (!item.title.toLowerCase().includes(query) && !item.content.toLowerCase().includes(query)) {
          return false;
        }
      }
      if (codexR18Filter === 'safe' && item.isR18) return false;
      if (codexR18Filter === 'r18' && !item.isR18) return false;
      if (codexSelectedCategories.length > 0) {
        const itemKey = `${item.isR18 ? 'nsfw' : 'common'}:${item.category}`;
        if (!codexSelectedCategories.includes(itemKey)) return false;
      }
      return true;
    });
  }, [codexData, codexR18Filter, codexSearchQuery, codexSelectedCategories]);

  const toggleCodexCategory = useCallback((category: string) => {
    setCodexSelectedCategories((prev) =>
      prev.includes(category) ? prev.filter((item) => item !== category) : [...prev, category]
    );
  }, []);

  const handleCodexScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
    if (scrollHeight - scrollTop - clientHeight < 200) {
      setCodexDisplayCount((prev) => Math.min(prev + 30, filteredCodexData.length));
    }
  }, [filteredCodexData.length]);

  const handleRandomCodex = useCallback(() => {
    if (filteredCodexData.length > 0) {
      const randomItem = filteredCodexData[Math.floor(Math.random() * filteredCodexData.length)];
      setRandomCodexItem(randomItem);
      setInspirationTab('random');
    }
  }, [filteredCodexData]);

  const showRandomTab = useCallback(() => {
    if (!randomCodexItem && filteredCodexData.length > 0) {
      handleRandomCodex();
    }
    setInspirationTab('random');
  }, [filteredCodexData.length, handleRandomCodex, randomCodexItem]);

  useEffect(() => {
    setCodexDisplayCount(30);
  }, [codexR18Filter, codexSearchQuery, codexSelectedCategories]);

  useEffect(() => {
    if (isOpen) {
      loadCodex();
    }
  }, [isOpen, loadCodex]);

  return {
    inspirationTab,
    setInspirationTab,
    isLoadingCodex,
    codexSearchQuery,
    setCodexSearchQuery,
    codexR18Filter,
    setCodexR18Filter,
    codexSelectedCategories,
    setCodexSelectedCategories,
    showCategoryFilter,
    setShowCategoryFilter,
    randomCodexItem,
    codexDisplayCount,
    categoriesByType,
    filteredCodexData,
    toggleCodexCategory,
    handleCodexScroll,
    handleRandomCodex,
    showRandomTab,
  };
}
