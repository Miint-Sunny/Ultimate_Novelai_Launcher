import { useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react';

interface UseSuggestionDismissalParams {
  showSuggestions: boolean;
  suggestionsRef: RefObject<HTMLDivElement | null>;
  setShowSuggestions: Dispatch<SetStateAction<boolean>>;
}

export function useSuggestionDismissal({
  showSuggestions,
  suggestionsRef,
  setShowSuggestions,
}: UseSuggestionDismissalParams) {
  useEffect(() => {
    if (!showSuggestions) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as globalThis.Node;
      if (target instanceof Element && target.closest('.wiki-preview-floating')) return;
      if (suggestionsRef.current && !suggestionsRef.current.contains(target)) {
        setShowSuggestions(false);
      }
    };

    const handleScroll = (event: Event) => {
      if (suggestionsRef.current && suggestionsRef.current.contains(event.target as globalThis.Node)) return;
      setShowSuggestions(false);
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('scroll', handleScroll, true);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('scroll', handleScroll, true);
    };
  }, [setShowSuggestions, showSuggestions, suggestionsRef]);
}
