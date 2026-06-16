import { useState, type ChangeEvent, type Dispatch, type DragEvent, type SetStateAction } from 'react';
import {
  createVibeFromImage,
  importVibeBundleFromFile,
  importVibeFromFile,
  saveVibe,
  saveVibeTagPool,
  type VibeData,
} from '../../services/localLibrary';
import type { VibeFile } from './types';

export interface VibeImportItem {
  uid: string;
  vibeData: VibeData;
  name: string;
  strength: number;
  infoExtracted: number;
  tags: Set<string>;
}

interface UseVibeImportFlowParams {
  currentBotUserId: string;
  tagPool: string[];
  setTagPool: Dispatch<SetStateAction<string[]>>;
  setLocalFiles: Dispatch<SetStateAction<VibeFile[]>>;
  setSelectedVibes: Dispatch<SetStateAction<string[]>>;
  bumpRecentUsage: (vibes: Array<{ id: string; name?: string; preview?: string }>) => void;
  reloadTagPool: () => Promise<void>;
  showToast: (message: string, type: 'success' | 'error') => void;
}

function makeImportItem(vibeData: VibeData, index: number): VibeImportItem {
  return {
    uid: `imp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${index}`,
    vibeData,
    name: vibeData.name,
    strength: vibeData.defaultStrength ?? 0.5,
    infoExtracted: vibeData.defaultInfoExtracted ?? 1,
    tags: new Set(vibeData.tags || []),
  };
}

async function createThumbnail(file: File): Promise<string> {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const maxSize = 256;
      let width = img.width;
      let height = img.height;
      if (width > height) {
        if (width > maxSize) {
          height = (height * maxSize) / width;
          width = maxSize;
        }
      } else if (height > maxSize) {
        width = (width * maxSize) / height;
        height = maxSize;
      }
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d')?.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = () => resolve('');
    img.src = URL.createObjectURL(file);
  });
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash &= hash;
  }
  return Math.abs(hash).toString(16).padStart(8, '0') + Date.now().toString(16);
}

async function hashImageBase64(imageBase64: string): Promise<string> {
  if (typeof crypto === 'undefined' || !crypto.subtle) return simpleHash(imageBase64);
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(imageBase64))
    .then(buf => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join(''))
    .catch(() => simpleHash(imageBase64));
}

export function useVibeImportFlow({
  currentBotUserId,
  tagPool,
  setTagPool,
  setLocalFiles,
  setSelectedVibes,
  bumpRecentUsage,
  reloadTagPool,
  showToast,
}: UseVibeImportFlowParams) {
  const [importItems, setImportItems] = useState<VibeImportItem[] | null>(null);
  const [importItemNewTagDraft, setImportItemNewTagDraft] = useState<Record<string, string>>({});

  const parseFileToVibeData = async (file: File): Promise<VibeData | null> => {
    if (file.name.endsWith('.naiv4vibe')) {
      const content = await file.text();
      const naiv4vibe = JSON.parse(content);
      if (naiv4vibe.identifier !== 'novelai-vibe-transfer') throw new Error('无效的 vibe 文件格式');
      const supportedModels = naiv4vibe.encodings ? Object.keys(naiv4vibe.encodings) : [];
      return {
        id: naiv4vibe.id || Date.now().toString(),
        name: naiv4vibe.name || file.name.replace('.naiv4vibe', ''),
        size: (content.length / 1024 / 1024).toFixed(2) + ' MB',
        preview: naiv4vibe.thumbnail || '',
        image: naiv4vibe.image || '',
        encodings: naiv4vibe.encodings || {},
        createdAt: naiv4vibe.createdAt || Date.now(),
        defaultStrength: naiv4vibe.importInfo?.strength,
        defaultInfoExtracted: naiv4vibe.importInfo?.information_extracted,
        supportedModels,
        tags: naiv4vibe.tags || [],
      };
    }
    if (!file.type.startsWith('image/')) return null;

    const size = (file.size / 1024 / 1024).toFixed(2) + ' MB';
    const arrayBuffer = await file.arrayBuffer();
    const imageBase64 = btoa(
      new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
    );
    const thumbnail = await createThumbnail(file);
    const id = await hashImageBase64(imageBase64);
    return {
      id,
      name: file.name.replace(/\.[^/.]+$/, ''),
      size,
      preview: thumbnail,
      image: imageBase64,
      encodings: {},
      createdAt: Date.now(),
    };
  };

  const importBundleFile = async (file: File): Promise<number> => {
    const savedVibes = await importVibeBundleFromFile(file);
    const newFiles: VibeFile[] = savedVibes.map(v => ({
      id: v.id,
      name: v.name,
      size: v.size,
      preview: v.preview,
      image: v.image,
      encodings: v.encodings,
      defaultStrength: v.defaultStrength,
      defaultInfoExtracted: v.defaultInfoExtracted,
      supportedModels: v.supportedModels,
      tags: v.tags,
    }));
    setLocalFiles(prev => [...newFiles, ...prev]);
    setSelectedVibes(prev => [...prev, ...savedVibes.map(v => v.id)]);
    bumpRecentUsage(savedVibes.map(v => ({ id: v.id, name: v.name, preview: v.preview })));
    if (currentBotUserId) {
      savedVibes.forEach(() => {
        // Reserved for cloud push parity.
      });
    }
    return savedVibes.length;
  };

  const saveVibeDataDirect = async (vibeData: VibeData): Promise<void> => {
    const savedVibe = await saveVibe(vibeData);
    const newFile: VibeFile = {
      id: savedVibe.id,
      name: savedVibe.name,
      size: savedVibe.size,
      preview: savedVibe.preview,
      image: savedVibe.image,
      encodings: savedVibe.encodings,
      defaultStrength: savedVibe.defaultStrength,
      defaultInfoExtracted: savedVibe.defaultInfoExtracted,
      supportedModels: savedVibe.supportedModels,
      tags: savedVibe.tags,
    };
    setLocalFiles(prev => [newFile, ...prev]);
    setSelectedVibes(prev => [...prev, newFile.id]);
    bumpRecentUsage([{ id: newFile.id, name: newFile.name, preview: newFile.preview }]);
    if (currentBotUserId) {
      // Reserved for cloud push parity.
    }
  };

  const handleFileUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    if (event.target) event.target.value = '';
    if (files.length === 0) return;

    const items: VibeImportItem[] = [];
    let bundleImported = 0;
    let parseFailed = 0;
    let unsupported = 0;

    for (const file of files) {
      try {
        if (file.name.endsWith('.naiv4vibebundle')) {
          bundleImported += await importBundleFile(file);
          continue;
        }
        const vibeData = await parseFileToVibeData(file);
        if (!vibeData) {
          unsupported++;
          continue;
        }
        items.push(makeImportItem(vibeData, items.length));
      } catch (err) {
        console.error(`解析 ${file.name} 失败:`, err);
        parseFailed++;
      }
    }

    if (bundleImported > 0) {
      showToast(`已导入 ${bundleImported} 个 Vibe (来自 bundle)`, 'success');
    }
    if (parseFailed > 0) {
      showToast(`${parseFailed} 个文件解析失败`, 'error');
    }
    if (unsupported > 0 && items.length === 0 && bundleImported === 0) {
      alert('请上传图片文件、.naiv4vibe 或 .naiv4vibebundle 文件');
      return;
    }

    if (items.length > 0) {
      setImportItemNewTagDraft({});
      setImportItems(items);
    }
  };

  const confirmVibeImport = async () => {
    if (!importItems || importItems.length === 0) return;
    const items = importItems;
    setImportItems(null);
    setImportItemNewTagDraft({});

    let imported = 0;
    let failed = 0;
    for (const item of items) {
      try {
        const finalName = item.name.trim() || item.vibeData.name;
        const merged: VibeData = {
          ...item.vibeData,
          name: finalName,
          defaultStrength: item.strength,
          defaultInfoExtracted: item.infoExtracted,
          tags: Array.from(item.tags),
        };
        await saveVibeDataDirect(merged);
        imported++;
      } catch (err) {
        console.error('导入失败:', err);
        failed++;
      }
    }
    await reloadTagPool();
    showToast(
      failed > 0
        ? `已导入 ${imported}，${failed} 个失败`
        : `已成功导入 ${imported} 个 Vibe`,
      failed > 0 ? 'error' : 'success'
    );
  };

  const toggleItemTag = (uid: string, tag: string) => {
    setImportItems(items => items?.map(item => {
      if (item.uid !== uid) return item;
      const next = new Set(item.tags);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return { ...item, tags: next };
    }) || null);
  };

  const addNewTagToItem = (uid: string, tag: string) => {
    const trimmed = tag.trim();
    if (!trimmed) return;
    setImportItems(items => items?.map(item => {
      if (item.uid !== uid) return item;
      const next = new Set(item.tags);
      next.add(trimmed);
      return { ...item, tags: next };
    }) || null);
    if (!tagPool.includes(trimmed)) {
      const merged = [...tagPool, trimmed].sort((a, b) => a.localeCompare(b, 'zh-CN'));
      setTagPool(merged);
      saveVibeTagPool(merged);
    }
  };

  const handleModalDrop = async (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const files = Array.from(event.dataTransfer.files);
    const pushIfAuthed = (_id: string) => {
      if (currentBotUserId) {
        // Reserved for cloud push parity.
      }
    };
    for (const file of files) {
      try {
        if (file.name.endsWith('.naiv4vibebundle')) {
          const savedVibes = await importVibeBundleFromFile(file);
          const newFiles: VibeFile[] = savedVibes.map(v => ({
            id: v.id,
            name: v.name,
            size: v.size,
            preview: v.preview,
            image: v.image,
            encodings: v.encodings,
            defaultStrength: v.defaultStrength,
            defaultInfoExtracted: v.defaultInfoExtracted,
            supportedModels: v.supportedModels,
          }));
          setLocalFiles(prev => [...newFiles, ...prev]);
          setSelectedVibes(prev => [...prev, ...savedVibes.map(v => v.id)]);
          bumpRecentUsage(savedVibes.map(v => ({ id: v.id, name: v.name, preview: v.preview })));
          savedVibes.forEach(v => pushIfAuthed(v.id));
          showToast(`成功导入 ${savedVibes.length} 个 Vibe`, 'success');
        } else if (file.name.endsWith('.naiv4vibe')) {
          const savedVibe = await importVibeFromFile(file);
          const newFile: VibeFile = {
            id: savedVibe.id,
            name: savedVibe.name,
            size: savedVibe.size,
            preview: savedVibe.preview,
            image: savedVibe.image,
            encodings: savedVibe.encodings,
            defaultStrength: savedVibe.defaultStrength,
            defaultInfoExtracted: savedVibe.defaultInfoExtracted,
            supportedModels: savedVibe.supportedModels,
          };
          setLocalFiles(prev => [newFile, ...prev]);
          setSelectedVibes(prev => [...prev, savedVibe.id]);
          bumpRecentUsage([{ id: savedVibe.id, name: savedVibe.name, preview: savedVibe.preview }]);
          pushIfAuthed(savedVibe.id);
          showToast('成功导入 Vibe', 'success');
        } else if (file.type.startsWith('image/')) {
          const savedVibe = await createVibeFromImage(file);
          const newFile: VibeFile = {
            id: savedVibe.id,
            name: savedVibe.name,
            size: savedVibe.size,
            preview: savedVibe.preview,
            image: savedVibe.image,
            encodings: savedVibe.encodings,
            defaultStrength: savedVibe.defaultStrength,
            defaultInfoExtracted: savedVibe.defaultInfoExtracted,
            supportedModels: savedVibe.supportedModels,
          };
          setLocalFiles(prev => [newFile, ...prev]);
          setSelectedVibes(prev => [...prev, savedVibe.id]);
          bumpRecentUsage([{ id: savedVibe.id, name: savedVibe.name, preview: savedVibe.preview }]);
          pushIfAuthed(savedVibe.id);
          showToast('成功导入图片为 Vibe', 'success');
        }
      } catch (error) {
        console.error('Failed to import vibe:', error);
        showToast('导入失败: ' + (error as Error).message, 'error');
      }
    }
  };

  return {
    importItems,
    setImportItems,
    importItemNewTagDraft,
    setImportItemNewTagDraft,
    handleFileUpload,
    confirmVibeImport,
    toggleItemTag,
    addNewTagToItem,
    handleModalDrop,
  };
}
