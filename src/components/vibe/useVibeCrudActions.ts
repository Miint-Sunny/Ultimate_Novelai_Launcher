import { useState, type Dispatch, type MouseEvent, type SetStateAction } from 'react';
import {
  deleteVibe,
  exportVibeToFile,
  getVibes,
  removeRecentVibeEntry,
  saveVibe,
  type VibeData,
} from '../../services/localLibrary';
import {
  deletePublicVibe,
  getPublicVibeDownloadUrl,
  getPublicVibeFile,
  uploadVibeToPublic,
} from '../../services/publicLibrary';
import { encodeVibeImage } from '../../services/novelai';
import type { VibeFile } from './types';

type ConfirmAction = (options: {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}) => Promise<boolean>;

export interface EditingVibeDefaults {
  vibeId: string;
  name: string;
  editName: string;
  strength: number;
  infoExtracted: number;
  tags: Set<string>;
}

interface UseVibeCrudActionsParams {
  currentBotUserId: string;
  localFiles: VibeFile[];
  publicFiles: VibeFile[];
  selectedVibes: string[];
  setLocalFiles: Dispatch<SetStateAction<VibeFile[]>>;
  setPublicFiles: Dispatch<SetStateAction<VibeFile[]>>;
  setSelectedVibes: Dispatch<SetStateAction<string[]>>;
  isVibeInLocal: (vibeId: string) => boolean;
  loadLocalVibes: () => Promise<void>;
  loadPublicVibes: (forceRefresh?: boolean) => Promise<void>;
  reloadTagPool: () => Promise<void>;
  refreshRecentEntries: () => void;
  confirmAction: ConfirmAction;
  showToast: (message: string, type: 'success' | 'error') => void;
}

export function useVibeCrudActions({
  currentBotUserId,
  localFiles,
  publicFiles,
  selectedVibes,
  setLocalFiles,
  setPublicFiles,
  setSelectedVibes,
  isVibeInLocal,
  loadLocalVibes,
  loadPublicVibes,
  reloadTagPool,
  refreshRecentEntries,
  confirmAction,
  showToast,
}: UseVibeCrudActionsParams) {
  const [downloadingVibeIds] = useState<Set<string>>(new Set());
  const [savingVibeIds, setSavingVibeIds] = useState<Set<string>>(new Set());
  const [uploadingVibeIds, setUploadingVibeIds] = useState<Set<string>>(new Set());
  const [vibeMenuOpenId, setVibeMenuOpenId] = useState<string | null>(null);
  const [editingVibeDefaults, setEditingVibeDefaults] = useState<EditingVibeDefaults | null>(null);
  const [vibeUploadTarget, setVibeUploadTarget] = useState<VibeFile | null>(null);
  const [vibeUploadName, setVibeUploadName] = useState('');
  const [vibeUploadStrength, setVibeUploadStrength] = useState(1);
  const [vibeUploadInfoExtracted, setVibeUploadInfoExtracted] = useState(1);

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
        tags: ['收藏'],
        cloudSync: 'none',
      };
      await saveVibe(vibeData);
      if (currentBotUserId) {
        // Reserved for cloud push parity.
      }
      await loadLocalVibes();
      await reloadTagPool();
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

  const handleDeleteVibeFile = async (id: string, event: MouseEvent) => {
    event.stopPropagation();
    const target = localFiles.find(file => file.id === id);
    const ok = await confirmAction({
      title: '删除 Vibe',
      message: target?.name
        ? `确定要删除 "${target.name}" 吗？此操作不可恢复。`
        : '确定要删除此 Vibe 吗？此操作不可恢复。',
      confirmLabel: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteVibe(id);
      setLocalFiles(prev => prev.filter(file => file.id !== id));
      if (selectedVibes.includes(id)) {
        setSelectedVibes(prev => prev.filter(vibeId => vibeId !== id));
      }
      removeRecentVibeEntry(id);
      refreshRecentEntries();
    } catch (error) {
      console.error('Failed to delete vibe:', error);
    }
  };

  const handleDownloadVibe = async (vibeFile: VibeFile) => {
    try {
      const vibes = await getVibes();
      const vibe = vibes.find(item => item.id === vibeFile.id);
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
    const publicFile = publicFiles.find(file => file.id === vibeFile.id);
    if (!publicFile) {
      showToast('未在公共Vibe中找到匹配', 'error');
      return;
    }
    const filename = publicFile.fileName || `${publicFile.name}.naiv4vibe`;
    if (!confirm('确定从公共Vibe撤回吗？')) return;
    try {
      const result = await deletePublicVibe(filename);
      if (result.success) {
        setPublicFiles(prev => prev.filter(file => file.id !== publicFile.id));
        showToast('已从公共Vibe撤回', 'success');
      } else {
        showToast(result.message || '撤回失败', 'error');
      }
    } catch (err) {
      console.error('撤回失败:', err);
      showToast('撤回失败', 'error');
    }
  };

  const saveVibeEdit = async (vibeId: string, editName: string, strength: number, infoExtracted: number) => {
    try {
      const vibes = await getVibes();
      const vibe = vibes.find(item => item.id === vibeId);
      if (vibe) {
        const newName = editName.trim();
        if (newName) vibe.name = newName;
        vibe.defaultStrength = strength;
        vibe.defaultInfoExtracted = infoExtracted;
        await saveVibe(vibe);
        void loadLocalVibes();
        if (currentBotUserId) {
          // Reserved for cloud push parity.
        }
      }
      setEditingVibeDefaults(null);
      showToast('已保存', 'success');
    } catch (err) {
      console.error('保存失败:', err);
      showToast('保存失败', 'error');
    }
  };

  const handleUploadVibeToPublic = (vibeFile: VibeFile, event: MouseEvent) => {
    event.stopPropagation();
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
      let fullVibeData: Record<string, unknown> | null = null;

      const vibes = await getVibes();
      const vibe = vibes.find(item => item.id === vibeFile.id);
      if (vibe) {
        fullVibeData = {
          identifier: 'novelai-vibe-transfer',
          version: 1,
          type: 'image',
          id: vibe.id,
          name: vibe.name,
          image: vibe.image,
          thumbnail: vibe.preview,
          encodings: vibe.encodings,
          createdAt: vibe.createdAt,
          importInfo: { strength: vibeUploadStrength, information_extracted: vibeUploadInfoExtracted },
        };
      }

      if (!fullVibeData) {
        showToast('无法获取vibe数据', 'error');
        return;
      }

      const imageData = (fullVibeData as any).image as string | undefined;
      if (imageData) {
        const { computeVibeEncodingHash } = await import('../../services/localLibrary');
        const targetIE = vibeUploadInfoExtracted;
        const modelsToEncode = ['nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated'];
        const modelKeyMap: Record<string, string> = {
          'nai-diffusion-4-5-full': 'v4-5full',
          'nai-diffusion-4-5-curated': 'v4-5curated',
        };
        const encodings = ((fullVibeData as any).encodings || {}) as Record<string, Record<string, any>>;
        for (const model of modelsToEncode) {
          const modelKey = modelKeyMap[model];
          const modelEncodings = encodings[modelKey] || {};
          let hasEncoding = false;
          for (const entry of Object.values(modelEncodings)) {
            if (entry?.params && Math.abs(entry.params.information_extracted - targetIE) < 0.001) {
              hasEncoding = true;
              break;
            }
          }
          if (!hasEncoding) {
            showToast(`正在为 ${modelKey} 预编码 (IE=${targetIE})...`, 'success');
            try {
              const encoded = await encodeVibeImage(imageData, targetIE, model);
              if (encoded) {
                const hashKey = await computeVibeEncodingHash(targetIE);
                if (!encodings[modelKey]) encodings[modelKey] = {};
                encodings[modelKey][hashKey] = { encoding: encoded, params: { information_extracted: targetIE } };
              }
            } catch (err) {
              console.warn(`[上传预编码] ${modelKey} 编码失败:`, err);
            }
          }
        }
        (fullVibeData as any).encodings = encodings;
      }

      const result = await uploadVibeToPublic(fullVibeData, vibeUploadName.trim());
      showToast(result.message, result.success ? 'success' : 'error');
      if (result.success) loadPublicVibes();
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

  const handlePublicVibeDownload = async (file: VibeFile, event: MouseEvent) => {
    event.stopPropagation();
    const fileName = file.fileName || `${file.name}.naiv4vibe`;

    const a = document.createElement('a');
    a.href = await getPublicVibeDownloadUrl(fileName);
    a.download = fileName;
    a.click();
  };

  return {
    downloadingVibeIds,
    savingVibeIds,
    uploadingVibeIds,
    vibeMenuOpenId,
    setVibeMenuOpenId,
    editingVibeDefaults,
    setEditingVibeDefaults,
    vibeUploadTarget,
    setVibeUploadTarget,
    vibeUploadName,
    setVibeUploadName,
    vibeUploadStrength,
    setVibeUploadStrength,
    vibeUploadInfoExtracted,
    setVibeUploadInfoExtracted,
    handleSaveVibeToLocal,
    handleDeleteVibeFile,
    handleDownloadVibe,
    handleRemoveFromPublic,
    saveVibeEdit,
    handleUploadVibeToPublic,
    confirmUploadVibeToPublic,
    handlePublicVibeDownload,
  };
}
