import { useCallback, useEffect, useState } from 'react';
import {
  saveCustomTag,
  getCustomTags,
  deleteCustomTag,
  type CustomTagData,
} from '../../services/localLibrary';

export function useCustomTagStore() {
  const [tags, setTags] = useState<CustomTagData[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const reload = useCallback(async () => {
    setIsLoading(true);
    try {
      const all = await getCustomTags();
      setTags(all);
    } catch (err) {
      console.warn('[useCustomTagStore] reload failed', err);
      setTags([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const create = useCallback(async (tag: Omit<CustomTagData, 'createdAt'> & { createdAt?: number }) => {
    const saved = await saveCustomTag(tag);
    setTags(prev => [...prev.filter(t => t.id !== saved.id), saved]);
    return saved;
  }, []);

  const remove = useCallback(async (id: string) => {
    await deleteCustomTag(id);
    setTags(prev => prev.filter(t => t.id !== id));
  }, []);

  const getBySubtype = useCallback((subtypeId: string) => {
    return tags.filter(t => t.subtypeId === subtypeId);
  }, [tags]);

  return { tags, isLoading, reload, create, remove, getBySubtype };
}
