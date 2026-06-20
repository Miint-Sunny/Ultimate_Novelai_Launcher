import { useCallback, useEffect, useState } from 'react';
import type { SubtypeDef } from './types';

const STORAGE_KEY = 'tag_subtypes_custom_v1';

function readFromStorage(): SubtypeDef[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeToStorage(list: SubtypeDef[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

export function useCustomRegistry() {
  const [custom, setCustom] = useState<SubtypeDef[]>(() => readFromStorage());

  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setCustom(readFromStorage());
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  const add = useCallback((def: SubtypeDef) => {
    setCustom(prev => {
      const next = [...prev.filter(s => s.id !== def.id), def];
      writeToStorage(next);
      return next;
    });
  }, []);

  const remove = useCallback((id: string) => {
    setCustom(prev => {
      const next = prev.filter(s => s.id !== id);
      writeToStorage(next);
      return next;
    });
  }, []);

  const update = useCallback((id: string, patch: Partial<SubtypeDef>) => {
    setCustom(prev => {
      const next = prev.map(s => (s.id === id ? { ...s, ...patch } : s));
      writeToStorage(next);
      return next;
    });
  }, []);

  return { custom, add, remove, update };
}
