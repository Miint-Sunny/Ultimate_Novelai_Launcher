import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  scanVibeFilesFromDirectory,
  type FileSystemDirectoryHandle,
} from '../../utils/fileSystem';
import {
  addLinkedFolder,
  exportVibeToFile,
  getLinkedFolders,
  getVibes,
  removeLinkedFolder,
  saveVibe,
  type LinkedFolder,
  type VibeData,
} from '../../services/localLibrary';
import {
  deletePublicVibe,
  getPublicVibeFile,
  getPublicVibes,
  resolvePublicVibeThumbnailUrl,
} from '../../services/publicLibrary';
import type { VibeFile } from '../vibe';
import type { ToastType } from './types';

type ShowToast = (message: string, type?: ToastType) => void;

const VIBE_FILES_PUBLIC_INIT: VibeFile[] = [];
const VIBE_FILES_LOCAL_INIT: VibeFile[] = [];

export function useVibeLibrary(showToast: ShowToast, isVibeModalOpen: boolean) {
  const [vibeTab, setVibeTab] = useState<'public' | 'local'>(() => {
    try {
      const saved = localStorage.getItem('vibe_tab');
      return (saved === 'public' || saved === 'local') ? saved : 'public';
    } catch {
      return 'public';
    }
  });
  const [selectedVibes, setSelectedVibes] = useState<string[]>([]);
  const [vibeUsageOrder, setVibeUsageOrder] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('vibe_usage_order');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [vibeSelectionSnapshot, setVibeSelectionSnapshot] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (isVibeModalOpen) {
      setVibeSelectionSnapshot(new Set(selectedVibes));
    }
  }, [isVibeModalOpen]);

  useEffect(() => {
    try {
      localStorage.setItem('vibe_tab', vibeTab);
    } catch {
      // ignore storage errors
    }
  }, [vibeTab]);

  useEffect(() => {
    try {
      localStorage.setItem('vibe_usage_order', JSON.stringify(vibeUsageOrder));
    } catch {
      // ignore storage errors
    }
  }, [vibeUsageOrder]);

  const [publicFiles, setPublicFiles] = useState<VibeFile[]>(VIBE_FILES_PUBLIC_INIT);
  const [localFiles, setLocalFiles] = useState<VibeFile[]>(VIBE_FILES_LOCAL_INIT);
  const [visiblePublicVibeCount, setVisiblePublicVibeCount] = useState(20);
  const publicVibeEndRef = useRef<HTMLDivElement>(null);
  const [vibeSearchQuery, setVibeSearchQuery] = useState('');
  const [vibeModelFilter, setVibeModelFilter] = useState<string>('all');

  const filteredPublicFiles = useMemo(() => {
    let files = publicFiles;
    if (vibeSearchQuery.trim()) {
      const q = vibeSearchQuery.trim().toLowerCase();
      files = files.filter(f => f.name.toLowerCase().includes(q));
    }
    if (vibeModelFilter !== 'all') {
      files = files.filter(f => f.supportedModels?.includes(vibeModelFilter));
    }
    return files;
  }, [publicFiles, vibeSearchQuery, vibeModelFilter]);

  const filteredLocalFiles = useMemo(() => {
    let files = localFiles;
    if (vibeSearchQuery.trim()) {
      const q = vibeSearchQuery.trim().toLowerCase();
      files = files.filter(f => f.name.toLowerCase().includes(q));
    }
    if (vibeModelFilter !== 'all') {
      files = files.filter(f => f.supportedModels?.includes(vibeModelFilter));
    }
    return files;
  }, [localFiles, vibeSearchQuery, vibeModelFilter]);

  const availableVibeModels = useMemo(() => {
    const models = new Set<string>();
    const source = vibeTab === 'public' ? publicFiles : localFiles;
    source.forEach(f => f.supportedModels?.forEach(m => models.add(m)));
    return [...models].sort();
  }, [publicFiles, localFiles, vibeTab]);

  useEffect(() => {
    const el = publicVibeEndRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setVisiblePublicVibeCount(prev => prev + 20);
      }
    }, { threshold: 0.1 });
    observer.observe(el);
    return () => observer.disconnect();
  });

  const [linkedFolders, setLinkedFolders] = useState<LinkedFolder[]>([]);
  const [currentFolderName, setCurrentFolderName] = useState<string | null>(null);
  const [currentFolderHandle, setCurrentFolderHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [folderVibeFiles, setFolderVibeFiles] = useState<VibeFile[]>([]);
  const [foldersNeedingPermission, setFoldersNeedingPermission] = useState<Set<string>>(new Set());

  const localDirectoryHandle = currentFolderHandle;
  const needsPermission = currentFolderName ? foldersNeedingPermission.has(currentFolderName) : false;

  const [isLinkingFolder, setIsLinkingFolder] = useState(false);
  const [downloadingVibeIds, setDownloadingVibeIds] = useState<Set<string>>(new Set());
  const [pinnedVibeIds, setPinnedVibeIds] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem('pinned_vibe_ids');
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch {
      return new Set();
    }
  });

  const togglePinVibe = (id: string) => {
    setPinnedVibeIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      localStorage.setItem('pinned_vibe_ids', JSON.stringify([...next]));
      return next;
    });
  };

  const [savingVibeIds, setSavingVibeIds] = useState<Set<string>>(new Set());

  const isVibeInLocal = useCallback((vibeId: string) => {
    return localFiles.some(lf => lf.id === vibeId);
  }, [localFiles]);

  const [vibeMenuOpenId, setVibeMenuOpenId] = useState<string | null>(null);
  const [editingVibeDefaults, setEditingVibeDefaults] = useState<{
    vibeId: string;
    name: string;
    strength: number;
    infoExtracted: number;
  } | null>(null);

  const isVibeInPublic = useCallback((vibeId: string) => {
    return publicFiles.some(pf => pf.id === vibeId);
  }, [publicFiles]);

  const loadFilesFromHandle = async (handle: FileSystemDirectoryHandle) => {
    try {
      const parsedVibes = await scanVibeFilesFromDirectory(handle);
      const vibeFiles: VibeFile[] = parsedVibes.map(v => ({
        id: v.id,
        name: v.name,
        size: v.size,
        preview: v.preview,
        image: v.image,
        encodings: v.encodings,
        defaultStrength: v.defaultStrength,
        defaultInfoExtracted: v.defaultInfoExtracted,
        supportedModels: v.supportedModels,
        fileName: v.fileName,
      }));
      setFolderVibeFiles(vibeFiles);
    } catch (err) {
      console.error('Error loading from handle:', err);
    }
  };

  const enterFolder = async (folder: LinkedFolder) => {
    try {
      const permission = await folder.handle.queryPermission({ mode: 'readwrite' });
      if (permission === 'granted') {
        setCurrentFolderName(folder.name);
        setCurrentFolderHandle(folder.handle);
        setFoldersNeedingPermission(prev => {
          const next = new Set(prev);
          next.delete(folder.name);
          return next;
        });
        await loadFilesFromHandle(folder.handle);
      } else {
        const newPermission = await folder.handle.requestPermission({ mode: 'readwrite' });
        if (newPermission === 'granted') {
          setCurrentFolderName(folder.name);
          setCurrentFolderHandle(folder.handle);
          setFoldersNeedingPermission(prev => {
            const next = new Set(prev);
            next.delete(folder.name);
            return next;
          });
          await loadFilesFromHandle(folder.handle);
        } else {
          setFoldersNeedingPermission(prev => new Set(prev).add(folder.name));
        }
      }
    } catch (err) {
      console.error('Error entering folder:', err);
    }
  };

  const exitFolder = () => {
    setCurrentFolderName(null);
    setCurrentFolderHandle(null);
    setFolderVibeFiles([]);
  };

  const loadLocalVibes = async () => {
    try {
      const savedVibes = await getVibes();
      if (savedVibes.length > 0) {
        const vibeFiles: VibeFile[] = savedVibes.map(v => ({
          id: v.id,
          name: v.name,
          size: v.size,
          preview: v.preview,
          image: v.image,
          encodings: v.encodings,
          defaultStrength: v.defaultStrength,
          defaultInfoExtracted: v.defaultInfoExtracted,
          supportedModels: v.supportedModels,
          createdAt: v.createdAt,
        }));
        setLocalFiles(vibeFiles);
      }

      const folders = await getLinkedFolders();
      setLinkedFolders(folders);

      const needPermission = new Set<string>();
      for (const folder of folders) {
        try {
          const permission = await folder.handle.queryPermission({ mode: 'readwrite' });
          if (permission !== 'granted') {
            needPermission.add(folder.name);
          }
        } catch {
          needPermission.add(folder.name);
        }
      }
      setFoldersNeedingPermission(needPermission);
    } catch (err) {
      console.error('Error loading local vibes:', err);
    }
  };

  const [isLoadingPublicVibes, setIsLoadingPublicVibes] = useState(false);

  const loadPublicVibes = async (forceRefresh = false) => {
    setIsLoadingPublicVibes(true);
    try {
      const vibes = await getPublicVibes(forceRefresh);

      const vibeFiles: VibeFile[] = vibes.map(v => ({
        id: v.id || v.filename || `vibe-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: v.name,
        size: '',
        preview: resolvePublicVibeThumbnailUrl(v.thumbnail),
        supportedModels: v.supportedModels,
        defaultStrength: v.defaultStrength,
        defaultInfoExtracted: v.defaultInfoExtracted,
        fileName: v.filename,
        hasImage: v.hasImage,
      }));
      setPublicFiles(vibeFiles);
      setVisiblePublicVibeCount(20);
    } catch (err) {
      console.error('Failed to load public vibes:', err);
      setPublicFiles([]);
    } finally {
      setIsLoadingPublicVibes(false);
    }
  };

  useEffect(() => {
    loadLocalVibes();
    loadPublicVibes();
  }, []);

  const handleSaveVibeToLocal = async (file: VibeFile) => {
    if (isVibeInLocal(file.id) || savingVibeIds.has(file.id)) return;
    setSavingVibeIds(prev => new Set(prev).add(file.id));
    try {
      const fileName = file.fileName || `${file.name}.naiv4vibe`;
      const fullData = await getPublicVibeFile(fileName);
      if (!fullData) {
        showToast('获取Vibe数据失败', 'error');
        return;
      }
      const supportedModels = fullData.encodings ? Object.keys(fullData.encodings as Record<string, unknown>) : [];
      const vibeData: VibeData = {
        id: (fullData.id as string) || file.id,
        name: (fullData.name as string) || file.name,
        size: '',
        preview: (fullData.thumbnail as string) || file.preview || '',
        image: (fullData.image as string) || '',
        encodings: (fullData.encodings as VibeData['encodings']) || {},
        createdAt: Date.now(),
        defaultStrength: (fullData.importInfo as any)?.strength ?? file.defaultStrength,
        defaultInfoExtracted: (fullData.importInfo as any)?.information_extracted ?? file.defaultInfoExtracted,
        supportedModels,
      };
      await saveVibe(vibeData);
      await loadLocalVibes();
      showToast('已收藏到我的Vibe', 'success');
    } catch (err) {
      console.error('收藏Vibe失败:', err);
      showToast('收藏失败', 'error');
    } finally {
      setSavingVibeIds(prev => {
        const next = new Set(prev);
        next.delete(file.id);
        return next;
      });
    }
  };

  const saveVibeDefaults = async (vibeId: string, strength: number, infoExtracted: number) => {
    try {
      const vibes = await getVibes();
      const vibe = vibes.find(v => v.id === vibeId);
      if (vibe) {
        vibe.defaultStrength = strength;
        vibe.defaultInfoExtracted = infoExtracted;
        await saveVibe(vibe);
        loadLocalVibes();
      }
      setEditingVibeDefaults(null);
      showToast('已保存默认权重', 'success');
    } catch (err) {
      console.error('保存默认权重失败:', err);
      showToast('保存失败', 'error');
    }
  };

  const handleDownloadVibe = async (vibeFile: VibeFile) => {
    try {
      const vibes = await getVibes();
      const vibe = vibes.find(v => v.id === vibeFile.id);
      if (vibe) {
        const blob = await exportVibeToFile(vibe, vibe.defaultStrength, vibe.defaultInfoExtracted, undefined, true);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${vibe.name}.naiv4vibe`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      console.error('下载vibe失败:', err);
      showToast('下载失败', 'error');
    }
  };

  const handleRemoveFromPublic = async (vibeFile: VibeFile) => {
    const publicFile = publicFiles.find(pf => pf.id === vibeFile.id);
    if (!publicFile) {
      showToast('未在公共Vibe中找到匹配', 'error');
      return;
    }
    const filename = publicFile.fileName || `${publicFile.name}.naiv4vibe`;
    if (!confirm('确定从公共Vibe撤回吗？')) return;
    try {
      const result = await deletePublicVibe(filename);
      if (result.success) {
        setPublicFiles(prev => prev.filter(f => f.id !== publicFile.id));
        showToast('已从公共Vibe撤回', 'success');
      } else {
        showToast(result.message || '撤回失败', 'error');
      }
    } catch (err) {
      console.error('撤回失败:', err);
      showToast('撤回失败', 'error');
    }
  };

  const handleLinkFolder = async () => {
    if (isLinkingFolder) return;
    setIsLinkingFolder(true);
    try {
      const handle = await (window as any).showDirectoryPicker();
      if (handle) {
        const newFolder: LinkedFolder = { handle, name: handle.name };
        await addLinkedFolder(newFolder);
        setLinkedFolders(prev => {
          if (prev.some(f => f.name === handle.name)) return prev;
          return [...prev, newFolder];
        });
        await enterFolder(newFolder);
      }
    } catch (err) {
      const error = err as Error;
      if (error.name === 'AbortError' || (error.name === 'NotAllowedError' && error.message.includes('already active'))) {
        // Ignore AbortError and File picker already active error.
      } else {
        console.error('Error linking folder:', err);
      }
    } finally {
      setIsLinkingFolder(false);
    }
  };

  const handleUnlinkFolder = async (folderName: string) => {
    await removeLinkedFolder(folderName);
    setLinkedFolders(prev => prev.filter(f => f.name !== folderName));
    if (currentFolderName === folderName) {
      exitFolder();
    }
  };

  return {
    vibeTab,
    setVibeTab,
    selectedVibes,
    setSelectedVibes,
    vibeUsageOrder,
    setVibeUsageOrder,
    vibeSelectionSnapshot,
    publicFiles,
    setPublicFiles,
    localFiles,
    setLocalFiles,
    visiblePublicVibeCount,
    publicVibeEndRef,
    vibeSearchQuery,
    setVibeSearchQuery,
    vibeModelFilter,
    setVibeModelFilter,
    filteredPublicFiles,
    filteredLocalFiles,
    availableVibeModels,
    linkedFolders,
    currentFolderName,
    folderVibeFiles,
    localDirectoryHandle,
    needsPermission,
    isLinkingFolder,
    downloadingVibeIds,
    setDownloadingVibeIds,
    pinnedVibeIds,
    togglePinVibe,
    savingVibeIds,
    isVibeInLocal,
    handleSaveVibeToLocal,
    vibeMenuOpenId,
    setVibeMenuOpenId,
    editingVibeDefaults,
    setEditingVibeDefaults,
    saveVibeDefaults,
    isVibeInPublic,
    handleDownloadVibe,
    handleRemoveFromPublic,
    loadFilesFromHandle,
    enterFolder,
    exitFolder,
    loadLocalVibes,
    isLoadingPublicVibes,
    loadPublicVibes,
    handleLinkFolder,
    handleUnlinkFolder,
  };
}
