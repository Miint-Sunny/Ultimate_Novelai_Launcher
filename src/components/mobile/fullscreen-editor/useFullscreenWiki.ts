import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  NEWLINE_SENTINEL,
  cleanTagName,
  isCollapsibleMarker,
} from '../../../utils/promptTags';
import { getBackendUrl } from '../../../utils/apiConfig';
import {
  fetchTagWikiPreview,
  fetchTagWikiSummaryZh,
} from '../../../services/tagAutocomplete';
import type { WikiPreviewState } from './WikiPreviewSheet';

interface UseFullscreenWikiArgs {
  selectedTags: Set<number>;
  parsedTags: string[];
}

export const useFullscreenWiki = ({
  selectedTags,
  parsedTags,
}: UseFullscreenWikiArgs) => {
  const [selectedPostCount, setSelectedPostCount] = useState<number | null>(null);
  const [wikiPreview, setWikiPreview] = useState<WikiPreviewState | null>(null);
  const [wikiImageIndex, setWikiImageIndex] = useState(0);
  const wikiReqRef = useRef(0);

  const singleCleanTag = useMemo(() => {
    if (selectedTags.size !== 1) return null;
    const t = parsedTags[Array.from(selectedTags)[0]];
    if (!t || t === NEWLINE_SENTINEL || isCollapsibleMarker(t)) return null;
    return cleanTagName(t);
  }, [selectedTags, parsedTags]);

  useEffect(() => {
    setSelectedPostCount(null);
    if (!singleCleanTag) return;
    let cancelled = false;
    const queryTag = singleCleanTag.toLowerCase().replace(/ /g, '_').replace(/-/g, '_');
    (async () => {
      try {
        const res = await fetch(`${getBackendUrl()}/api/tags/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tags: [queryTag] }),
        });
        if (!res.ok || cancelled) return;
        const data = await res.json() as Record<string, number>;
        const v = data[queryTag];
        if (typeof v === 'number') setSelectedPostCount(v);
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, [singleCleanTag]);

  const openWikiPreview = useCallback((tag: string) => {
    const normalized = tag.trim().toLowerCase().replace(/ /g, '_');
    if (!normalized) return;
    const reqId = ++wikiReqRef.current;
    setWikiImageIndex(0);
    setWikiPreview({ tag: normalized, data: null, loading: true });
    fetchTagWikiPreview(normalized).then((data) => {
      if (wikiReqRef.current !== reqId) return;
      if (!data) {
        setWikiPreview(prev => prev && prev.tag === normalized ? { ...prev, data: null, loading: false } : prev);
        return;
      }
      setWikiPreview({ tag: normalized, data, loading: false, summaryZhLoading: !data.summaryZh });
      if (!data.summaryZh) {
        fetchTagWikiSummaryZh(normalized).then((summaryZh) => {
          if (wikiReqRef.current !== reqId) return;
          setWikiPreview(prev => prev && prev.tag === normalized && prev.data ? {
            ...prev,
            summaryZhLoading: false,
            data: summaryZh ? { ...prev.data, summaryZh } : prev.data,
          } : prev);
        }).catch(() => {
          if (wikiReqRef.current !== reqId) return;
          setWikiPreview(prev => prev && prev.tag === normalized ? { ...prev, summaryZhLoading: false } : prev);
        });
      }
    }).catch(() => {
      if (wikiReqRef.current !== reqId) return;
      setWikiPreview(prev => prev && prev.tag === normalized ? { ...prev, data: null, loading: false } : prev);
    });
  }, []);

  return {
    selectedPostCount,
    wikiPreview,
    wikiImageIndex,
    setWikiImageIndex,
    setWikiPreview,
    singleCleanTag,
    openWikiPreview,
  };
};
