import { useCallback, useState } from 'react';
import {
  getVibeTagPool,
  saveVibeTagPool,
  setVibeTags as setVibeTagsStorage,
} from '../../../services/localLibrary';
import type { ActiveVibe } from '../types';
import { applyTagsToMobileActiveVibes } from './mobileVibeLibraryData';

interface UseMobileVibeTagsOptions {
  activeVibes: ActiveVibe[];
  refreshLocalVibes: () => Promise<void>;
}

export function useMobileVibeTags({
  activeVibes,
  refreshLocalVibes,
}: UseMobileVibeTagsOptions) {
  const [vibeTagPool, setVibeTagPool] = useState<string[]>([]);
  const [vibeSelectedTagFilter, setVibeSelectedTagFilter] = useState<Set<string>>(new Set());
  const [vibeTagSettingsOpen, setVibeTagSettingsOpen] = useState(false);
  const [vibeTagSettingsCreating, setVibeTagSettingsCreating] = useState(false);
  const [vibeTagSettingsNewName, setVibeTagSettingsNewName] = useState('');
  const [vibeBatchTagOpen, setVibeBatchTagOpen] = useState(false);
  const [vibeBatchTagsToAdd, setVibeBatchTagsToAdd] = useState<Set<string>>(new Set());
  const [vibeTagEditorTarget, setVibeTagEditorTarget] = useState<{ vibeId: string; current: Set<string> } | null>(null);

  const reloadVibeTagPool = useCallback(async () => {
    const pool = await getVibeTagPool();
    setVibeTagPool(pool);
  }, []);

  const saveVibeTags = useCallback(async () => {
    if (!vibeTagEditorTarget) return;
    await setVibeTagsStorage(vibeTagEditorTarget.vibeId, Array.from(vibeTagEditorTarget.current));
    await refreshLocalVibes();
    await reloadVibeTagPool();
    setVibeTagEditorTarget(null);
  }, [refreshLocalVibes, reloadVibeTagPool, vibeTagEditorTarget]);

  const applyBatchTags = useCallback(async () => {
    const tagsToAdd = Array.from(vibeBatchTagsToAdd);
    if (tagsToAdd.length === 0) {
      setVibeBatchTagOpen(false);
      return;
    }
    await applyTagsToMobileActiveVibes(activeVibes, tagsToAdd);
    await refreshLocalVibes();
    await reloadVibeTagPool();
    setVibeBatchTagOpen(false);
    setVibeBatchTagsToAdd(new Set());
  }, [activeVibes, refreshLocalVibes, reloadVibeTagPool, vibeBatchTagsToAdd]);

  const createVibeTag = useCallback((tag: string) => {
    const next = [...vibeTagPool, tag].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    setVibeTagPool(next);
    saveVibeTagPool(next);
    setVibeTagSettingsNewName('');
    setVibeTagSettingsCreating(false);
  }, [vibeTagPool]);

  const deleteVibeTag = useCallback((tag: string) => {
    const next = vibeTagPool.filter((item) => item !== tag);
    setVibeTagPool(next);
    saveVibeTagPool(next);
  }, [vibeTagPool]);

  return {
    vibeTagPool,
    setVibeTagPool,
    vibeSelectedTagFilter,
    setVibeSelectedTagFilter,
    vibeTagSettingsOpen,
    setVibeTagSettingsOpen,
    vibeTagSettingsCreating,
    setVibeTagSettingsCreating,
    vibeTagSettingsNewName,
    setVibeTagSettingsNewName,
    vibeBatchTagOpen,
    setVibeBatchTagOpen,
    vibeBatchTagsToAdd,
    setVibeBatchTagsToAdd,
    vibeTagEditorTarget,
    setVibeTagEditorTarget,
    reloadVibeTagPool,
    saveVibeTags,
    applyBatchTags,
    createVibeTag,
    deleteVibeTag,
  };
}
