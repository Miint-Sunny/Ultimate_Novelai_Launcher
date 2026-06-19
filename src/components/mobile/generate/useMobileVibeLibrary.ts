import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  deleteVibe,
  recordVibeUsageBatch,
  removeRecentVibeEntry,
  type VibeData,
} from '../../../services/localLibrary';
import { getPublicVibeFile } from '../../../services/publicLibrary';
import { MODEL_MAP, MODEL_TO_ENCODING_KEY } from '../../generation/modelResolutionOptions';
import type { ActiveVibe, VibeFile } from '../types';
import {
  collectPublicVibeFile,
  exportMobileActiveVibes,
  importMobileVibeFile,
  loadMobileVibeLists,
} from './mobileVibeLibraryData';
import { useMobileVibeTags } from './useMobileVibeTags';

interface UseMobileVibeLibraryOptions {
  model: string;
  clearActiveCR: () => void;
  showVibeModal: boolean;
}

export function useMobileVibeLibrary({
  model,
  clearActiveCR,
  showVibeModal,
}: UseMobileVibeLibraryOptions) {
  const [vibeTab, setVibeTab] = useState<'public' | 'local'>('public');
  const [vibeFiles, setVibeFiles] = useState<VibeFile[]>([]);
  const [localVibeFiles, setLocalVibeFiles] = useState<VibeFile[]>([]);
  const [activeVibes, setActiveVibes] = useState<ActiveVibe[]>([]);
  const [isLoadingVibes, setIsLoadingVibes] = useState(false);
  const [isVibeExpanded, setIsVibeExpanded] = useState(true);
  const [loadingVibeIds, setLoadingVibeIds] = useState<Set<string>>(new Set());
  const [collectingVibeIds, setCollectingVibeIds] = useState<Set<string>>(new Set());
  const [vibeSearchQuery, setVibeSearchQuery] = useState('');
  const [vibeModelFilter] = useState<string>('all');
  const [vibeMenuOpenId, setVibeMenuOpenId] = useState<string | null>(null);
  const [vibeFabOpen, setVibeFabOpen] = useState(false);
  const [vibeCloudMenuOpen, setVibeCloudMenuOpen] = useState(false);

  useEffect(() => {
    if (activeVibes.length === 0) return;
    recordVibeUsageBatch(activeVibes.map((vibe) => ({
      id: vibe.id,
      name: vibe.name,
      preview: vibe.preview,
    })));
  }, [activeVibes]);

  const refreshLocalVibes = useCallback(async () => {
    const { local } = await loadMobileVibeLists();
    setLocalVibeFiles(local);
  }, []);

  const vibeTags = useMobileVibeTags({
    activeVibes,
    refreshLocalVibes,
  });

  const currentModelApi = useMemo(
    () => MODEL_MAP[model] || 'nai-diffusion-4-5-full',
    [model],
  );

  const isVibeCompatibleWithModel = useCallback((vibe: VibeFile & { hasImage?: boolean }) => {
    if (vibe.image || vibe.hasImage) return true;
    if (!vibe.supportedModels || vibe.supportedModels.length === 0) return true;
    const currentEncodingKey = MODEL_TO_ENCODING_KEY[currentModelApi];
    if (!currentEncodingKey) return true;
    return vibe.supportedModels.some((supportedModel) =>
      supportedModel === currentEncodingKey ||
      (currentModelApi === 'nai-diffusion-4-5-full' && supportedModel === 'v4full') ||
      (currentModelApi === 'nai-diffusion-4-5-curated' && supportedModel === 'v4curated')
    );
  }, [currentModelApi]);

  const filterVibeList = useCallback((files: VibeFile[]) => {
    let filtered = files;
    const query = vibeSearchQuery.trim().toLowerCase();
    if (query) {
      filtered = filtered.filter((file) => file.name.toLowerCase().includes(query));
    }
    if (vibeModelFilter !== 'all') {
      filtered = filtered.filter((file) => file.supportedModels?.includes(vibeModelFilter));
    }
    return filtered;
  }, [vibeModelFilter, vibeSearchQuery]);

  const filteredPublicVibes = useMemo(() => filterVibeList(vibeFiles), [filterVibeList, vibeFiles]);
  const vibeTagFilteredLocalFiles = useMemo(() => {
    let files = localVibeFiles;
    if (vibeSearchQuery.trim()) {
      const query = vibeSearchQuery.trim().toLowerCase();
      files = files.filter((file) => file.name.toLowerCase().includes(query));
    }
    if (vibeTags.vibeSelectedTagFilter.size > 0) {
      files = files.filter((file) => {
        const tags = (file as VibeFile & { tags?: string[] }).tags || [];
        return tags.some((tag) => vibeTags.vibeSelectedTagFilter.has(tag));
      });
    }
    return files;
  }, [localVibeFiles, vibeSearchQuery, vibeTags.vibeSelectedTagFilter]);

  const vibeTagUsageCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const file of localVibeFiles) {
      const tags = (file as VibeFile & { tags?: string[] }).tags || [];
      for (const tag of tags) counts.set(tag, (counts.get(tag) || 0) + 1);
    }
    return counts;
  }, [localVibeFiles]);

  const loadVibes = useCallback(async () => {
    setIsLoadingVibes(true);
    try {
      const { local, public: publicVibes } = await loadMobileVibeLists();
      setLocalVibeFiles(local);
      setVibeFiles(publicVibes);
    } catch (error) {
      console.error('Failed to load vibes:', error);
    } finally {
      setIsLoadingVibes(false);
    }
  }, []);

  useEffect(() => {
    if (!showVibeModal) return;
    loadVibes();
    vibeTags.reloadVibeTagPool();
  }, [loadVibes, showVibeModal, vibeTags.reloadVibeTagPool]);

  const handleAddVibe = useCallback(async (vibe: VibeFile) => {
    if (activeVibes.some((item) => item.id === vibe.id)) return;
    const isPublicVibe = !vibe.image && vibeFiles.some((item) => item.id === vibe.id);
    const publicVibeFile = isPublicVibe ? vibeFiles.find((item) => item.id === vibe.id) : null;

    setActiveVibes((prev) => [...prev, {
      ...vibe,
      referenceStrength: vibe.defaultStrength ?? 0.6,
      informationExtracted: vibe.defaultInfoExtracted ?? 1,
      enabled: true,
      isPublic: isPublicVibe,
    }]);
    clearActiveCR();

    if (isPublicVibe && publicVibeFile?.fileName) {
      setLoadingVibeIds((prev) => new Set(prev).add(vibe.id));
      try {
        const fullData = await getPublicVibeFile(publicVibeFile.fileName);
        if (fullData) {
          setActiveVibes((prev) => prev.map((item) => (
            item.id === vibe.id
              ? { ...item, image: fullData.image as string, encodings: fullData.encodings as VibeData['encodings'] }
              : item
          )));
        }
      } catch (error) {
        console.error('Failed to load public vibe file:', error);
      } finally {
        setLoadingVibeIds((prev) => {
          const next = new Set(prev);
          next.delete(vibe.id);
          return next;
        });
      }
    }
  }, [activeVibes, clearActiveCR, vibeFiles]);

  const handleCollectPublicVibe = useCallback(async (vibe: VibeFile) => {
    if (localVibeFiles.some((localVibe) => localVibe.id === vibe.id)) {
      alert('该 Vibe 已在本地');
      return;
    }
    if (!vibe.fileName) {
      alert('该公共 Vibe 缺少文件信息');
      return;
    }

    setCollectingVibeIds((prev) => new Set(prev).add(vibe.id));
    try {
      const saved = await collectPublicVibeFile(vibe);
      setLocalVibeFiles((prev) => prev.some((item) => item.id === saved.id) ? prev : [saved, ...prev]);
    } catch (error) {
      console.error('Collect public vibe failed:', error);
      alert('收藏失败: ' + (error as Error).message);
    } finally {
      setCollectingVibeIds((prev) => {
        const next = new Set(prev);
        next.delete(vibe.id);
        return next;
      });
    }
  }, [localVibeFiles]);

  const handleUnifiedVibeImport = useCallback(async (file: File) => {
    try {
      setIsLoadingVibes(true);
      const newVibes = await importMobileVibeFile(file);
      setLocalVibeFiles((prev) => [...newVibes, ...prev]);
    } catch (error) {
      console.error('Unified vibe import failed:', error);
      alert('导入失败: ' + (error as Error).message);
    } finally {
      setIsLoadingVibes(false);
    }
  }, []);

  const removeActiveVibe = useCallback((id: string) => {
    setActiveVibes((prev) => prev.filter((vibe) => vibe.id !== id));
  }, []);

  const updateActiveVibe = useCallback(<K extends keyof ActiveVibe>(id: string, key: K, value: ActiveVibe[K]) => {
    setActiveVibes((prev) => prev.map((vibe) => vibe.id === id ? { ...vibe, [key]: value } : vibe));
  }, []);

  const deleteLocalVibe = useCallback(async (vibe: VibeFile) => {
    removeRecentVibeEntry(vibe.id);
    await deleteVibe(vibe.id);
    setLocalVibeFiles((prev) => prev.filter((item) => item.id !== vibe.id));
    setActiveVibes((prev) => prev.filter((item) => item.id !== vibe.id));
  }, []);

  const deleteSelectedLocalVibes = useCallback(async () => {
    if (!confirm(`确定要删除选中的 ${activeVibes.length} 个 Vibe 吗？`)) return;
    for (const vibe of activeVibes) {
      removeRecentVibeEntry(vibe.id);
      await deleteVibe(vibe.id);
    }
    setActiveVibes([]);
    await refreshLocalVibes();
  }, [activeVibes, refreshLocalVibes]);

  const exportSelectedVibes = useCallback(async () => {
    try {
      await exportMobileActiveVibes(activeVibes);
    } catch (error) {
      console.error('打包下载失败:', error);
    }
  }, [activeVibes]);

  return {
    activeVibes,
    setActiveVibes,
    localVibeFiles,
    setLocalVibeFiles,
    vibeFiles,
    vibeTab,
    setVibeTab,
    isLoadingVibes,
    isVibeExpanded,
    setIsVibeExpanded,
    loadingVibeIds,
    collectingVibeIds,
    vibeSearchQuery,
    setVibeSearchQuery,
    filteredPublicVibes,
    vibeTagPool: vibeTags.vibeTagPool,
    setVibeTagPool: vibeTags.setVibeTagPool,
    vibeSelectedTagFilter: vibeTags.vibeSelectedTagFilter,
    setVibeSelectedTagFilter: vibeTags.setVibeSelectedTagFilter,
    vibeTagFilteredLocalFiles,
    vibeTagUsageCounts,
    vibeMenuOpenId,
    setVibeMenuOpenId,
    vibeTagSettingsOpen: vibeTags.vibeTagSettingsOpen,
    setVibeTagSettingsOpen: vibeTags.setVibeTagSettingsOpen,
    vibeTagSettingsCreating: vibeTags.vibeTagSettingsCreating,
    setVibeTagSettingsCreating: vibeTags.setVibeTagSettingsCreating,
    vibeTagSettingsNewName: vibeTags.vibeTagSettingsNewName,
    setVibeTagSettingsNewName: vibeTags.setVibeTagSettingsNewName,
    vibeBatchTagOpen: vibeTags.vibeBatchTagOpen,
    setVibeBatchTagOpen: vibeTags.setVibeBatchTagOpen,
    vibeBatchTagsToAdd: vibeTags.vibeBatchTagsToAdd,
    setVibeBatchTagsToAdd: vibeTags.setVibeBatchTagsToAdd,
    vibeTagEditorTarget: vibeTags.vibeTagEditorTarget,
    setVibeTagEditorTarget: vibeTags.setVibeTagEditorTarget,
    vibeFabOpen,
    setVibeFabOpen,
    vibeCloudMenuOpen,
    setVibeCloudMenuOpen,
    loadVibes,
    reloadVibeTagPool: vibeTags.reloadVibeTagPool,
    refreshLocalVibes,
    isVibeCompatibleWithModel,
    handleAddVibe,
    handleCollectPublicVibe,
    handleUnifiedVibeImport,
    removeActiveVibe,
    updateActiveVibe,
    deleteLocalVibe,
    deleteSelectedLocalVibes,
    exportSelectedVibes,
    saveVibeTags: vibeTags.saveVibeTags,
    applyBatchTags: vibeTags.applyBatchTags,
    createVibeTag: vibeTags.createVibeTag,
    deleteVibeTag: vibeTags.deleteVibeTag,
  };
}
