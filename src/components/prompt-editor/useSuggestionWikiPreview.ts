import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  fetchTagWikiPreview,
  fetchTagWikiSummaryZh,
  fetchWikiExistsBatch,
  type TagSuggestion,
} from '../../services/tagAutocomplete';
import type { SuggestionWikiPreviewState } from './types';
import { canCheckSuggestionWiki, normalizeWikiTagKey } from './wikiUtils';

interface UseSuggestionWikiPreviewParams {
  suggestions: TagSuggestion[];
  visible: boolean;
}

export function useSuggestionWikiPreview({ suggestions, visible }: UseSuggestionWikiPreviewParams) {
  const [wikiMap, setWikiMap] = useState<Record<string, boolean>>({});
  const [preview, setPreview] = useState<SuggestionWikiPreviewState | null>(null);
  const [imageIndex, setImageIndex] = useState(0);
  const [height, setHeight] = useState<number | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    if (!visible || suggestions.length === 0) {
      setPreview(null);
      return;
    }

    const tags = Array.from(new Set(
      suggestions
        .filter(canCheckSuggestionWiki)
        .map(suggestion => normalizeWikiTagKey(suggestion.value))
        .filter(Boolean)
    ));
    if (tags.length === 0) return;

    let cancelled = false;
    fetchWikiExistsBatch(tags).then((result) => {
      if (cancelled) return;
      setWikiMap(prev => ({ ...prev, ...result }));
    }).catch(() => { /* ignore */ });

    return () => { cancelled = true; };
  }, [visible, suggestions]);

  useEffect(() => {
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      if (showTimerRef.current) clearTimeout(showTimerRef.current);
    };
  }, []);

  useEffect(() => {
    setImageIndex(0);
    const examples = preview?.data?.examples?.filter(example => example.previewUrl) || [];
    if (examples.length <= 1) return;
    const timer = setInterval(() => {
      setImageIndex(prev => (prev + 1) % examples.length);
    }, 2600);
    return () => clearInterval(timer);
  }, [preview?.tag, preview?.data]);

  useLayoutEffect(() => {
    if (!preview) {
      setHeight(null);
      return;
    }

    const content = contentRef.current;
    if (!content) return;

    const updateHeight = () => {
      const maxHeight = Math.max(80, window.innerHeight - 16);
      const nextHeight = Math.min(Math.ceil(content.scrollHeight), maxHeight);
      setHeight(prev => (
        prev !== null && Math.abs(prev - nextHeight) < 1 ? prev : nextHeight
      ));
    };

    const frame = requestAnimationFrame(updateHeight);
    const observer = new ResizeObserver(updateHeight);
    observer.observe(content);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [preview?.tag, preview?.loading, preview?.data, preview?.summaryZhLoading, imageIndex]);

  const hidePreview = useCallback((delay = 120) => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    if (showTimerRef.current) clearTimeout(showTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      const reqId = ++requestRef.current;
      setPreview(prev => prev ? { ...prev, closing: true } : prev);
      hideTimerRef.current = setTimeout(() => {
        if (requestRef.current === reqId) {
          setPreview(null);
        }
      }, 140);
    }, delay);
  }, []);

  const keepPreviewVisible = useCallback(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
  }, []);

  const showPreview = useCallback((suggestion: TagSuggestion, anchor: HTMLElement, delay = 220, showLoading = true) => {
    const tag = normalizeWikiTagKey(suggestion.value);
    if (!tag) return;

    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    if (showTimerRef.current) clearTimeout(showTimerRef.current);

    const anchorRect = anchor.getBoundingClientRect();
    showTimerRef.current = setTimeout(() => {
      const reqId = ++requestRef.current;
      if (showLoading) {
        setPreview({ tag, data: null, loading: true, anchor: anchorRect, closing: false });
      }

      fetchTagWikiPreview(tag).then((data) => {
        if (requestRef.current !== reqId) return;
        if (!data) {
          setWikiMap(prev => ({ ...prev, [tag]: false }));
          setPreview(prev => prev && prev.tag === tag ? null : prev);
          return;
        }

        setWikiMap(prev => ({ ...prev, [tag]: true }));
        setPreview(prev => prev && prev.tag === tag
          ? { ...prev, data, loading: false, summaryZhLoading: !data.summaryZh, closing: false }
          : { tag, data, loading: false, summaryZhLoading: !data.summaryZh, anchor: anchorRect, closing: false });

        if (!data.summaryZh) {
          fetchTagWikiSummaryZh(tag).then((summaryZh) => {
            if (requestRef.current !== reqId) return;
            setPreview(prev => prev && prev.tag === tag && prev.data ? {
              ...prev,
              summaryZhLoading: false,
              data: summaryZh ? { ...prev.data, summaryZh } : prev.data,
            } : prev);
          }).catch(() => {
            if (requestRef.current !== reqId) return;
            setPreview(prev => prev && prev.tag === tag ? { ...prev, summaryZhLoading: false } : prev);
          });
        }
      }).catch(() => {
        if (requestRef.current !== reqId) return;
        setPreview(prev => prev && prev.tag === tag ? null : prev);
      });
    }, delay);
  }, []);

  return {
    wikiMap,
    preview,
    previewHeight: height,
    previewContentRef: contentRef,
    previewImageIndex: imageIndex,
    showPreview,
    hidePreview,
    keepPreviewVisible,
  };
}
