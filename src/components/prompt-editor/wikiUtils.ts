import type { TagSuggestion } from '../../services/tagAutocomplete';

export const stepNumericWeight = (weight: number, delta: number): number => Math.round((weight + delta) * 10) / 10;

export const normalizeWikiTagKey = (tag: string): string => tag.trim().toLowerCase().replace(/ /g, '_');

export const clipWikiSummaryText = (text: string, limit: number): string => {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit).replace(/[，。；、,. ]+$/u, '')}...`;
};

export const canCheckSuggestionWiki = (suggestion: TagSuggestion): boolean => {
  if (!suggestion.value || suggestion.isAiLoading || suggestion.isNaturalLanguage || suggestion.isArtist || suggestion.isOC) {
    return false;
  }
  return true;
};
