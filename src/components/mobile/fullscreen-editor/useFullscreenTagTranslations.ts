import { useEffect, useMemo, useState } from 'react';
import {
  cleanTagName,
  isCollapsibleMarker,
} from '../../../utils/promptTags';
import { translateSegments } from '../../../services/translate';
import {
  fetchWikiChineseNames,
  getTranslationCacheSnapshot,
  setTranslationCacheEntries,
} from '../../../services/tagAutocomplete';

const globalTagTranslationCache = getTranslationCacheSnapshot();
const failedTranslationTags = new Set<string>();

export const useFullscreenTagTranslations = (parsedTags: string[]) => {
  const [tagTranslations, setTagTranslations] = useState<Map<string, string>>(() => new Map(globalTagTranslationCache));
  const [translatingTags, setTranslatingTags] = useState<Set<string>>(new Set());

  useEffect(() => {
    tagTranslations.forEach((v, k) => globalTagTranslationCache.set(k, v));
    setTranslationCacheEntries(tagTranslations);
  }, [tagTranslations]);

  const cleanTagKeys = useMemo(() => {
    const set = new Set<string>();
    parsedTags.forEach(t => {
      if (isCollapsibleMarker(t)) return;
      const c = cleanTagName(t);
      if (c && !c.includes('\n') && !/[\u4e00-\u9fa5]/.test(c) && /[a-zA-Z]/.test(c) && !c.startsWith('artist:')) set.add(c);
    });
    return Array.from(set);
  }, [parsedTags]);
  const cleanTagKeysKey = cleanTagKeys.join('\n');

  useEffect(() => {
    if (cleanTagKeys.length === 0) return;
    const toTranslate = cleanTagKeys.filter(t => !tagTranslations.has(t) && !failedTranslationTags.has(t));
    if (toTranslate.length === 0) return;
    setTranslatingTags(prev => {
      const next = new Set(prev);
      toTranslate.forEach(t => next.add(t));
      return next;
    });
    let cancelled = false;
    const loadTranslations = async () => {
      const newMap = new Map(tagTranslations);

      try {
        const queryTags = toTranslate.map(t => t.replace(/ /g, '_'));
        const result = await fetchWikiChineseNames(queryTags);
        if (cancelled) return;
        for (const tag of toTranslate) {
          const queryTag = tag.replace(/ /g, '_');
          const translation = result[queryTag]?.[0];
          if (translation) newMap.set(tag, translation);
        }
      } catch { /* ignore wiki errors */ }

      const stillMissing = toTranslate.filter(t => !newMap.has(t));
      if (!cancelled && stillMissing.length > 0) {
        try {
          const aiResults = await translateSegments(stillMissing);
          if (cancelled) return;
          for (let i = 0; i < stillMissing.length; i++) {
            const translated = aiResults[i];
            if (translated && translated !== stillMissing[i]) {
              newMap.set(stillMissing[i], translated);
            }
          }
          for (const t of stillMissing) {
            if (!newMap.has(t)) failedTranslationTags.add(t);
          }
        } catch { /* ignore AI errors */ }
      }

      if (!cancelled) {
        setTagTranslations(new Map(newMap));
        setTranslatingTags(prev => {
          const next = new Set(prev);
          toTranslate.forEach(t => next.delete(t));
          return next;
        });
      }
    };
    const timer = setTimeout(loadTranslations, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      setTranslatingTags(prev => {
        const next = new Set(prev);
        toTranslate.forEach(t => next.delete(t));
        return next;
      });
    };
    // Keep tagTranslations out of this dependency list to preserve the old retry behavior.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cleanTagKeysKey]);

  return { tagTranslations, setTagTranslations, translatingTags };
};
