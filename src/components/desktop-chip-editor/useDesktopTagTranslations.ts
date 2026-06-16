import { useEffect, useMemo, useState } from 'react';
import {
  fetchWikiChineseNames,
  getTranslationCacheSnapshot,
  setTranslationCacheEntries,
} from '../../services/tagAutocomplete';
import { translateSegments } from '../../services/translate';
import { cleanTagName, isCollapsibleMarker } from '../../utils/promptTags';

const globalTagTranslationCache = getTranslationCacheSnapshot();

export function useDesktopTagTranslations(parsedTags: string[]) {
  const [tagTranslations, setTagTranslations] = useState<Map<string, string>>(() => new Map(globalTagTranslationCache));
  const [translatingTags, setTranslatingTags] = useState<Set<string>>(new Set());

  useEffect(() => {
    tagTranslations.forEach((value, key) => globalTagTranslationCache.set(key, value));
    setTranslationCacheEntries(tagTranslations);
  }, [tagTranslations]);

  const cleanTagKeys = useMemo(() => {
    const set = new Set<string>();
    parsedTags.forEach(tag => {
      if (isCollapsibleMarker(tag)) return;
      const clean = cleanTagName(tag);
      if (clean && !/[\u4e00-\u9fa5]/.test(clean) && /[a-zA-Z]/.test(clean) && !clean.startsWith('artist:')) {
        set.add(clean);
      }
    });
    return Array.from(set);
  }, [parsedTags]);

  const cleanTagKeysKey = cleanTagKeys.join('\n');

  useEffect(() => {
    if (cleanTagKeys.length === 0) return;
    const toTranslate = cleanTagKeys.filter(tag => !tagTranslations.has(tag));
    if (toTranslate.length === 0) return;
    setTranslatingTags(prev => {
      const next = new Set(prev);
      toTranslate.forEach(tag => next.add(tag));
      return next;
    });
    let cancelled = false;
    const load = async () => {
      const newMap = new Map(tagTranslations);
      try {
        const queryTags = toTranslate.map(tag => tag.replace(/ /g, '_'));
        const result = await fetchWikiChineseNames(queryTags);
        if (cancelled) return;
        for (const tag of toTranslate) {
          const queryTag = tag.replace(/ /g, '_');
          const translation = result[queryTag]?.[0];
          if (translation) newMap.set(tag, translation);
        }
      } catch {
        // Ignore wiki lookup failures; AI translation below may still help.
      }

      const stillMissing = toTranslate.filter(tag => !newMap.has(tag));
      if (!cancelled && stillMissing.length > 0) {
        try {
          const aiResults = await translateSegments(stillMissing);
          if (cancelled) return;
          for (let index = 0; index < stillMissing.length; index++) {
            const translated = aiResults[index];
            if (translated && translated !== stillMissing[index]) newMap.set(stillMissing[index], translated);
          }
        } catch {
          // Translation is best effort.
        }
      }

      if (!cancelled) {
        setTagTranslations(new Map(newMap));
        setTranslatingTags(prev => {
          const next = new Set(prev);
          toTranslate.forEach(tag => next.delete(tag));
          return next;
        });
      }
    };
    const timer = setTimeout(load, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      setTranslatingTags(prev => {
        const next = new Set(prev);
        toTranslate.forEach(tag => next.delete(tag));
        return next;
      });
    };
    // Preserve the original loading cadence: only react to the cleaned tag key set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cleanTagKeysKey]);

  return { tagTranslations, translatingTags, setTagTranslations };
}
