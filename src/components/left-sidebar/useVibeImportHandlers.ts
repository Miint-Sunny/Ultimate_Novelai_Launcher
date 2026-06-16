import { useCallback, useState } from 'react';
import type React from 'react';
import { saveVibeToDirectory, type FileSystemDirectoryHandle } from '../../utils/fileSystem';
import {
  createVibeFromImage,
  exportVibeToFile,
  importVibeBundleFromFile,
  importVibeFromFile,
  saveVibe,
  type VibeData,
} from '../../services/localLibrary';
import type { ActiveVibe, VibeFile } from '../vibe';
import type { ToastType } from './types';

type ShowToast = (message: string, type?: ToastType) => void;

interface UseVibeImportHandlersParams {
  localDirectoryHandle: FileSystemDirectoryHandle | null;
  loadFilesFromHandle: (handle: FileSystemDirectoryHandle) => Promise<void>;
  setLocalFiles: React.Dispatch<React.SetStateAction<VibeFile[]>>;
  setSelectedVibes: React.Dispatch<React.SetStateAction<string[]>>;
  setVibeUsageOrder: React.Dispatch<React.SetStateAction<string[]>>;
  setActiveVibes: React.Dispatch<React.SetStateAction<ActiveVibe[]>>;
  clearPreciseReference: () => void;
  showToast: ShowToast;
}

interface PendingVibeImport {
  file: File;
  vibeData: VibeData;
}

const toVibeFile = (vibe: VibeData): VibeFile => ({
  id: vibe.id,
  name: vibe.name,
  size: vibe.size,
  preview: vibe.preview,
  image: vibe.image,
  encodings: vibe.encodings,
  defaultStrength: vibe.defaultStrength,
  defaultInfoExtracted: vibe.defaultInfoExtracted,
  supportedModels: vibe.supportedModels,
});

const toActiveVibe = (vibe: VibeData): ActiveVibe => ({
  id: vibe.id,
  name: vibe.name,
  preview: vibe.preview,
  image: vibe.image,
  encodings: vibe.encodings,
  referenceStrength: vibe.defaultStrength ?? 0.5,
  informationExtracted: vibe.defaultInfoExtracted ?? 0.5,
  supportedModels: vibe.supportedModels,
  enabled: true,
});

async function createPendingVibeData(file: File): Promise<VibeData | null> {
  if (file.name.endsWith('.naiv4vibe')) {
    const content = await file.text();
    const naiv4vibe = JSON.parse(content);
    if (naiv4vibe.identifier !== 'novelai-vibe-transfer') {
      throw new Error('无效的 vibe 文件格式');
    }
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
    };
  }

  if (!file.type.startsWith('image/')) {
    return null;
  }

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
}

async function createThumbnail(file: File): Promise<string> {
  return new Promise<string>((resolve) => {
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
      const ctx = canvas.getContext('2d');
      ctx?.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = () => resolve('');
    img.src = URL.createObjectURL(file);
  });
}

async function hashImageBase64(imageBase64: string): Promise<string> {
  const simpleHash = (str: string): string => {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16).padStart(8, '0') + Date.now().toString(16);
  };

  if (typeof crypto !== 'undefined' && crypto.subtle) {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(imageBase64))
      .then(buf => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join(''))
      .catch(() => simpleHash(imageBase64));
  }
  return simpleHash(imageBase64);
}

export function useVibeImportHandlers({
  localDirectoryHandle,
  loadFilesFromHandle,
  setLocalFiles,
  setSelectedVibes,
  setVibeUsageOrder,
  setActiveVibes,
  clearPreciseReference,
  showToast,
}: UseVibeImportHandlersParams) {
  const [vibeImportPending, setVibeImportPending] = useState<PendingVibeImport | null>(null);
  const [vibeImportName, setVibeImportName] = useState('');
  const [vibeImportStrength, setVibeImportStrength] = useState(1);
  const [vibeImportInfoExtracted, setVibeImportInfoExtracted] = useState(1);

  const addVibesToLocalList = (vibes: VibeData[]) => {
    setLocalFiles(prev => [...vibes.map(toVibeFile), ...prev]);
  };

  const recordVibeUsage = (ids: string[]) => {
    setVibeUsageOrder(prev => [...ids, ...prev.filter(id => !ids.includes(id))]);
  };

  const saveVibeToLinkedFolder = async (
    savedVibe: VibeData,
    fileName: string,
    strength?: number,
    infoExtracted?: number,
  ) => {
    if (!localDirectoryHandle) {
      setLocalFiles(prev => [toVibeFile(savedVibe), ...prev]);
      return;
    }
    const vibeBlob = await exportVibeToFile(savedVibe, strength, infoExtracted, undefined, true);
    const vibeContent = await vibeBlob.text();
    await saveVibeToDirectory(localDirectoryHandle, fileName, vibeContent);
    await loadFilesFromHandle(localDirectoryHandle);
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      try {
        if (file.name.endsWith('.naiv4vibebundle')) {
          const savedVibes = await importVibeBundleFromFile(file);
          addVibesToLocalList(savedVibes);
          setSelectedVibes(prev => [...prev, ...savedVibes.map(v => v.id)]);
          recordVibeUsage(savedVibes.map(v => v.id));
          showToast(`成功导入 ${savedVibes.length} 个 Vibe`, 'success');
          if (event.target) event.target.value = '';
          return;
        }

        const vibeData = await createPendingVibeData(file);
        if (!vibeData) {
          alert('请上传图片文件、.naiv4vibe 或 .naiv4vibebundle 文件');
          if (event.target) event.target.value = '';
          return;
        }

        setVibeImportPending({ file, vibeData });
        setVibeImportName(vibeData.name);
        setVibeImportStrength(vibeData.defaultStrength ?? 1);
        setVibeImportInfoExtracted(vibeData.defaultInfoExtracted ?? 1);
      } catch (error) {
        console.error('Failed to parse vibe:', error);
        alert('解析文件失败: ' + (error as Error).message);
      }
    }
    if (event.target) event.target.value = '';
  };

  const confirmVibeImport = async () => {
    if (!vibeImportPending) return;
    const { file, vibeData } = vibeImportPending;
    const newName = vibeImportName.trim() || vibeData.name;
    setVibeImportPending(null);

    try {
      vibeData.name = newName;
      vibeData.defaultStrength = vibeImportStrength;
      vibeData.defaultInfoExtracted = vibeImportInfoExtracted;

      const savedVibe = await saveVibe(vibeData);
      const fileName = file.name.endsWith('.naiv4vibe') ? file.name : `${newName}.naiv4vibe`;
      await saveVibeToLinkedFolder(savedVibe, fileName, vibeImportStrength, vibeImportInfoExtracted);
      setSelectedVibes(prev => [...prev, savedVibe.id]);
      recordVibeUsage([savedVibe.id]);
      showToast('成功导入 Vibe', 'success');
    } catch (error) {
      console.error('Failed to save vibe:', error);
      alert('保存文件失败: ' + (error as Error).message);
    }
  };

  const handleQuickVibeUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      try {
        if (file.name.endsWith('.naiv4vibebundle')) {
          const savedVibes = await importVibeBundleFromFile(file);
          addVibesToLocalList(savedVibes);
          recordVibeUsage(savedVibes.map(v => v.id));
          setActiveVibes(prev => [...prev, ...savedVibes.map(toActiveVibe)]);
          clearPreciseReference();
          showToast(`成功导入 ${savedVibes.length} 个 Vibe`, 'success');
          return;
        }

        const imported = await importOrCreateVibe(file, true);
        if (!imported) {
          alert('请上传图片文件、.naiv4vibe 或 .naiv4vibebundle 文件');
          return;
        }

        await saveVibeToLinkedFolder(imported.savedVibe, imported.fileName);
        recordVibeUsage([imported.savedVibe.id]);
        setActiveVibes(prev => [...prev, toActiveVibe(imported.savedVibe)]);
        clearPreciseReference();
      } catch (error) {
        console.error('Failed to save vibe:', error);
        alert('保存文件失败: ' + (error as Error).message);
      }
    }
    if (event.target) event.target.value = '';
  };

  const handleVibeDropCallback = useCallback(async (file: File, _dataUrl: string) => {
    try {
      if (file.name.endsWith('.naiv4vibebundle')) {
        const savedVibes = await importVibeBundleFromFile(file);
        addVibesToLocalList(savedVibes);
        recordVibeUsage(savedVibes.map(v => v.id));
        setActiveVibes(prev => [...prev, ...savedVibes.map(toActiveVibe)]);
        clearPreciseReference();
        showToast(`成功导入 ${savedVibes.length} 个 Vibe`, 'success');
        return;
      }

      const imported = await importOrCreateVibe(file, false);
      if (!imported) return;

      await saveVibeToLinkedFolder(imported.savedVibe, imported.fileName);
      recordVibeUsage([imported.savedVibe.id]);
      setActiveVibes(prev => [...prev, toActiveVibe(imported.savedVibe)]);
      clearPreciseReference();
    } catch (error) {
      console.error('Failed to save vibe via drag-drop:', error);
    }
  }, [localDirectoryHandle, loadFilesFromHandle, showToast, clearPreciseReference]);

  return {
    vibeImportPending,
    setVibeImportPending,
    vibeImportName,
    setVibeImportName,
    vibeImportStrength,
    setVibeImportStrength,
    vibeImportInfoExtracted,
    setVibeImportInfoExtracted,
    handleFileUpload,
    confirmVibeImport,
    handleQuickVibeUpload,
    handleVibeDropCallback,
  };
}

async function importOrCreateVibe(file: File, alertInvalid: boolean): Promise<{ savedVibe: VibeData; fileName: string } | null> {
  if (file.name.endsWith('.naiv4vibe')) {
    return {
      savedVibe: await importVibeFromFile(file),
      fileName: file.name,
    };
  }

  if (file.type.startsWith('image/')) {
    const savedVibe = await createVibeFromImage(file);
    const baseName = file.name.replace(/\.[^/.]+$/, '');
    return {
      savedVibe,
      fileName: `${baseName}.naiv4vibe`,
    };
  }

  if (alertInvalid) {
    alert('请上传图片文件、.naiv4vibe 或 .naiv4vibebundle 文件');
  }
  return null;
}
