import { useEffect, useState } from 'react';
import type React from 'react';
import { deleteVibe, recordVibeUsageBatch, type VibeData } from '../../services/localLibrary';
import { deletePublicVibe, getPublicVibeFile, uploadVibeToPublic } from '../../services/publicLibrary';
import { deleteFileFromDirectory, type FileSystemDirectoryHandle } from '../../utils/fileSystem';
import type { ToastType } from './types';
import type { ActiveVibe, VibeFile } from '../vibe';
import { ensurePublicUploadEncodings, loadCompleteVibeData } from './vibePublicUpload';

type ShowToast = (message: string, type: ToastType) => void;

interface UseActiveVibesParams {
  publicFiles: VibeFile[];
  setPublicFiles: React.Dispatch<React.SetStateAction<VibeFile[]>>;
  localFiles: VibeFile[];
  setLocalFiles: React.Dispatch<React.SetStateAction<VibeFile[]>>;
  selectedVibes: string[];
  setSelectedVibes: React.Dispatch<React.SetStateAction<string[]>>;
  setVibeUsageOrder: React.Dispatch<React.SetStateAction<string[]>>;
  localDirectoryHandle: FileSystemDirectoryHandle | null;
  loadFilesFromHandle: (handle: FileSystemDirectoryHandle) => Promise<void>;
  setIsVibeModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  clearPreciseReference: () => void;
  loadPublicVibes: () => Promise<void> | void;
  showToast: ShowToast;
}

export function useActiveVibes({
  publicFiles,
  setPublicFiles,
  localFiles,
  setLocalFiles,
  selectedVibes,
  setSelectedVibes,
  setVibeUsageOrder,
  localDirectoryHandle,
  loadFilesFromHandle,
  setIsVibeModalOpen,
  clearPreciseReference,
  loadPublicVibes,
  showToast,
}: UseActiveVibesParams) {
  const [activeVibes, setActiveVibes] = useState<ActiveVibe[]>([]);
  const [loadingVibeIds, setLoadingVibeIds] = useState<Set<string>>(new Set());
  const [exportingVibeId, setExportingVibeId] = useState<string | null>(null);
  const [uploadingVibeIds, setUploadingVibeIds] = useState<Set<string>>(new Set());
  const [vibeUploadTarget, setVibeUploadTarget] = useState<VibeFile | null>(null);
  const [vibeUploadName, setVibeUploadName] = useState('');
  const [vibeUploadStrength, setVibeUploadStrength] = useState(1);
  const [vibeUploadInfoExtracted, setVibeUploadInfoExtracted] = useState(1);

  useEffect(() => {
    if (activeVibes.length === 0) return;
    recordVibeUsageBatch(activeVibes.map(vibe => ({
      id: vibe.id,
      name: vibe.name,
      preview: vibe.preview,
    })));
  }, [activeVibes]);

  const toggleVibeSelection = (id: string) => {
    const isLocalVibe = localFiles.some(file => file.id === id);

    if (selectedVibes.includes(id)) {
      setSelectedVibes(prev => prev.filter(vibeId => vibeId !== id));
      return;
    }

    setSelectedVibes(prev => [...prev, id]);

    if (isLocalVibe) {
      setVibeUsageOrder(prev => [id, ...prev.filter(vibeId => vibeId !== id)]);
    }
  };

  const closeVibeModal = () => {
    setSelectedVibes(activeVibes.map(vibe => vibe.id));
    setIsVibeModalOpen(false);
  };

  const handleVibeConfirmSelection = async (selectedIds: string[], allFiles: VibeFile[]) => {
    setIsVibeModalOpen(false);

    const publicVibesToLoad = selectedIds.filter(id => {
      const file = allFiles.find(candidate => candidate.id === id);
      return file?.fileName && (!file.image || !file.encodings);
    });

    const publicIdSet = new Set(
      allFiles.filter(file => file.hasImage !== undefined).map(file => file.id)
    );

    const placeholderVibes: ActiveVibe[] = [];
    for (const id of selectedIds) {
      const file = allFiles.find(candidate => candidate.id === id);
      const existing = activeVibes.find(vibe => vibe.id === id);

      placeholderVibes.push({
        id,
        name: file?.name || 'Unknown Vibe',
        preview: file?.preview,
        image: file?.image,
        encodings: file?.encodings,
        referenceStrength: existing?.referenceStrength ?? file?.defaultStrength ?? 0.5,
        informationExtracted: existing?.informationExtracted ?? file?.defaultInfoExtracted ?? 0.5,
        supportedModels: file?.supportedModels,
        enabled: existing?.enabled ?? true,
        fileName: file?.fileName,
        isPublic: publicIdSet.has(id),
      });
    }
    setActiveVibes(placeholderVibes);

    if (placeholderVibes.length > 0) {
      clearPreciseReference();
    }

    if (publicVibesToLoad.length > 0) {
      setLoadingVibeIds(new Set(publicVibesToLoad));

      const loadPromises = publicVibesToLoad.map(async (id) => {
        const file = allFiles.find(candidate => candidate.id === id);
        if (!file?.fileName) return;

        try {
          const fullData = await getPublicVibeFile(file.fileName);
          if (fullData) {
            setActiveVibes(prev => prev.map(vibe =>
              vibe.id === id ? {
                ...vibe,
                image: fullData.image as string,
                encodings: fullData.encodings as VibeData['encodings'],
              } : vibe
            ));
          }
        } catch (err) {
          console.error('Failed to load public vibe file:', err);
        } finally {
          setLoadingVibeIds(prev => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        }
      });

      await Promise.all(loadPromises);
    }
  };

  const removeActiveVibe = (id: string) => {
    setActiveVibes(prev => prev.filter(vibe => vibe.id !== id));
    setSelectedVibes(prev => prev.filter(vibeId => vibeId !== id));
  };

  const updateActiveVibe = (
    id: string,
    key: 'referenceStrength' | 'informationExtracted' | 'enabled',
    value: number | boolean
  ) => {
    setActiveVibes(prev => prev.map(vibe =>
      vibe.id === id ? { ...vibe, [key]: value } : vibe
    ));
  };

  const handleDeleteVibeFile = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      if (localDirectoryHandle) {
        const vibe = localFiles.find(file => file.id === id);
        const fileName = vibe?.fileName || `${vibe?.name || id}.naiv4vibe`;
        await deleteFileFromDirectory(localDirectoryHandle, fileName);
        await loadFilesFromHandle(localDirectoryHandle);
      } else {
        await deleteVibe(id);
        setLocalFiles(prev => prev.filter(file => file.id !== id));
      }
      if (selectedVibes.includes(id)) {
        setSelectedVibes(prev => prev.filter(vibeId => vibeId !== id));
      }
    } catch (error) {
      console.error('Failed to delete vibe:', error);
    }
  };

  const handleDeletePublicVibe = async (id: string, filename: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const result = await deletePublicVibe(filename);
      if (result.success) {
        setPublicFiles(prev => prev.filter(file => file.id !== id));
        if (selectedVibes.includes(id)) {
          setSelectedVibes(prev => prev.filter(vibeId => vibeId !== id));
        }
        setActiveVibes(prev => prev.filter(vibe => vibe.id !== id));
      } else {
        alert(result.message || '删除失败，请重试');
      }
    } catch (error) {
      console.error('Failed to delete public vibe:', error);
      alert('删除失败：' + (error instanceof Error ? error.message : '未知错误'));
    }
  };

  const handleUploadVibeToPublic = async (vibeFile: VibeFile, e: React.MouseEvent) => {
    e.stopPropagation();
    if (uploadingVibeIds.has(vibeFile.id)) return;
    setVibeUploadTarget(vibeFile);
    setVibeUploadName('');
    setVibeUploadStrength(vibeFile.defaultStrength ?? 1);
    setVibeUploadInfoExtracted(vibeFile.defaultInfoExtracted ?? 1);
  };

  const confirmUploadVibeToPublic = async () => {
    const vibeFile = vibeUploadTarget;
    if (!vibeFile || !vibeUploadName.trim()) return;
    setVibeUploadTarget(null);

    try {
      setUploadingVibeIds(prev => new Set(prev).add(vibeFile.id));

      const fullVibeData = await loadCompleteVibeData({
        vibeFile,
        localDirectoryHandle,
        vibeUploadStrength,
        vibeUploadInfoExtracted,
        showToast,
      });
      if (!fullVibeData) return;

      await ensurePublicUploadEncodings(fullVibeData, vibeUploadInfoExtracted, showToast);

      const result = await uploadVibeToPublic(fullVibeData, vibeUploadName.trim());

      if (result.success) {
        showToast(result.message, 'success');
        await loadPublicVibes();
      } else {
        showToast(result.message, 'error');
      }
    } catch (error) {
      console.error('上传vibe失败:', error);
      showToast('上传失败：' + (error instanceof Error ? error.message : '未知错误'), 'error');
    } finally {
      setUploadingVibeIds(prev => {
        const next = new Set(prev);
        next.delete(vibeFile.id);
        return next;
      });
    }
  };

  return {
    activeVibes,
    setActiveVibes,
    loadingVibeIds,
    setLoadingVibeIds,
    exportingVibeId,
    setExportingVibeId,
    uploadingVibeIds,
    vibeUploadTarget,
    setVibeUploadTarget,
    vibeUploadName,
    setVibeUploadName,
    vibeUploadStrength,
    setVibeUploadStrength,
    vibeUploadInfoExtracted,
    setVibeUploadInfoExtracted,
    toggleVibeSelection,
    closeVibeModal,
    handleVibeConfirmSelection,
    removeActiveVibe,
    updateActiveVibe,
    handleDeleteVibeFile,
    handleDeletePublicVibe,
    handleUploadVibeToPublic,
    confirmUploadVibeToPublic,
  };
}
