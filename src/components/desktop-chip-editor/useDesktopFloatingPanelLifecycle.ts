import { useEffect, useState } from 'react';
import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react';
import { fetchWikiChineseNames, verifyTags, type TagSuggestion } from '../../services/tagAutocomplete';
import { translateSegments } from '../../services/translate';
import { NEWLINE_SENTINEL, cleanTagName } from '../../utils/promptTags';

interface TagPanelState {
  index: number;
  rawTag: string;
  tag: string;
  translation: string;
  screenX: number;
  screenY: number;
}

interface UseDesktopFloatingPanelLifecycleParams {
  tagPanel: TagPanelState | null;
  tagPanelRef: RefObject<HTMLDivElement | null>;
  scrollRef: RefObject<HTMLDivElement | null>;
  suggestionsRef: RefObject<HTMLDivElement | null>;
  inputRef: RefObject<HTMLInputElement | null>;
  chipRefsMap: MutableRefObject<Map<number, HTMLElement>>;
  chipClickTimeRef: MutableRefObject<number>;
  parsedTags: string[];
  tagTranslations: Map<string, string>;
  showSuggestions: boolean;
  setNumWeight: Dispatch<SetStateAction<number>>;
  setTagPanel: Dispatch<SetStateAction<TagPanelState | null>>;
  setSelectedTags: Dispatch<SetStateAction<Set<number>>>;
  setTagTranslations: Dispatch<SetStateAction<Map<string, string>>>;
  setShowSuggestions: Dispatch<SetStateAction<boolean>>;
  setSuggestions: Dispatch<SetStateAction<TagSuggestion[]>>;
}

export function useDesktopFloatingPanelLifecycle({
  tagPanel,
  tagPanelRef,
  scrollRef,
  suggestionsRef,
  inputRef,
  chipRefsMap,
  chipClickTimeRef,
  parsedTags,
  tagTranslations,
  showSuggestions,
  setNumWeight,
  setTagPanel,
  setSelectedTags,
  setTagTranslations,
  setShowSuggestions,
  setSuggestions,
}: UseDesktopFloatingPanelLifecycleParams) {
  const [translationLoading, setTranslationLoading] = useState(false);
  const [tagPanelPostCount, setTagPanelPostCount] = useState<number | null>(null);

  useEffect(() => {
    if (!tagPanel) return;
    const match = tagPanel.rawTag.match(/^(-?\d+(?:\.\d+)?)::/);
    setNumWeight(match ? parseFloat(match[1]) : 1.0);
  }, [tagPanel, setNumWeight]);

  useEffect(() => {
    if (!tagPanel || tagPanel.translation) {
      setTranslationLoading(false);
      return;
    }
    let cancelled = false;
    const queryTag = tagPanel.tag.replace(/ /g, '_');
    setTranslationLoading(true);
    (async () => {
      try {
        const result = await fetchWikiChineseNames([queryTag]);
        if (cancelled) return;
        let translation = result[queryTag]?.[0] || '';
        if (!translation) {
          const aiResults = await translateSegments([tagPanel.tag]);
          if (cancelled) return;
          translation = aiResults[0] && aiResults[0] !== tagPanel.tag ? aiResults[0] : '';
        }
        if (cancelled) return;
        if (translation) {
          setTagTranslations(prev => new Map(prev).set(tagPanel.tag, translation));
          setTagPanel(prev => prev && prev.index === tagPanel.index ? { ...prev, translation } : prev);
        }
      } catch {
        // Translation is a best-effort panel enhancement.
      } finally {
        if (!cancelled) setTranslationLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [tagPanel?.index, tagPanel?.tag, tagPanel?.translation, setTagPanel, setTagTranslations]);

  useEffect(() => {
    if (!tagPanel) {
      setTagPanelPostCount(null);
      return;
    }
    let cancelled = false;
    const queryTag = tagPanel.tag.toLowerCase().replace(/ /g, '_').replace(/-/g, '_');
    setTagPanelPostCount(null);
    (async () => {
      try {
        const data = await verifyTags([queryTag]);
        if (cancelled) return;
        const value = data[queryTag];
        if (typeof value === 'number') setTagPanelPostCount(value);
      } catch {
        // Keep tag quick panel usable when verification is unavailable.
      }
    })();
    return () => { cancelled = true; };
  }, [tagPanel?.index, tagPanel?.tag]);

  useEffect(() => {
    if (!tagPanel) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (tagPanelRef.current?.contains(event.target as globalThis.Node)) return;
      if (scrollRef.current?.contains(event.target as globalThis.Node)) return;
      setTagPanel(null);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [tagPanel, tagPanelRef, scrollRef, setTagPanel]);

  useEffect(() => {
    if (!tagPanel) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const activeElement = document.activeElement as HTMLElement | null;
      if (activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA' || activeElement.isContentEditable)) return;
      const direction = event.key === 'ArrowLeft' ? -1 : 1;
      let newIndex = tagPanel.index + direction;
      while (newIndex >= 0 && newIndex < parsedTags.length && parsedTags[newIndex] === NEWLINE_SENTINEL) {
        newIndex += direction;
      }
      if (newIndex < 0 || newIndex >= parsedTags.length) return;
      const rawTag = parsedTags[newIndex];
      if (!rawTag) return;
      event.preventDefault();
      chipClickTimeRef.current = Date.now();
      const chipEl = chipRefsMap.current.get(newIndex);
      chipEl?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
      requestAnimationFrame(() => {
        const el = chipRefsMap.current.get(newIndex);
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const clean = cleanTagName(rawTag);
        setSelectedTags(new Set([newIndex]));
        setTagPanel({
          index: newIndex,
          rawTag: rawTag.trim(),
          tag: clean,
          translation: tagTranslations.get(clean) || '',
          screenX: rect.left,
          screenY: rect.bottom + 4,
        });
      });
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [tagPanel, parsedTags, tagTranslations, chipRefsMap, chipClickTimeRef, setSelectedTags, setTagPanel]);

  useEffect(() => {
    if (!showSuggestions) return;
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as globalThis.Node;
      if (suggestionsRef.current?.contains(target)) return;
      if (inputRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest('.wiki-preview-floating')) return;
      setShowSuggestions(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showSuggestions, suggestionsRef, inputRef, setShowSuggestions]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const handleScroll = () => {
      if (Date.now() - chipClickTimeRef.current < 150) return;
      setTagPanel(null);
      setShowSuggestions(false);
      setSuggestions([]);
    };
    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [scrollRef, chipClickTimeRef, setTagPanel, setShowSuggestions, setSuggestions]);

  return { translationLoading, tagPanelPostCount };
}
