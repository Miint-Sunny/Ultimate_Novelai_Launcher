import { useCallback, useRef, useState, type ChangeEvent } from 'react';
import JSZip from 'jszip';
import {
  extractImageMetadata,
  writeCustomMetadataToImage,
  type ImageMetadata,
} from '../../../utils/imageMetadata';
import type { MetadataFile, MobileProcessFileForTarget } from './types';

async function cleanImageMetadataProper(dataUrl: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('无法创建 canvas'));
        return;
      }
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;
      for (let i = 3; i < data.length; i += 4) data[i] = 255;
      ctx.putImageData(imageData, 0, 0);
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error('转换失败'));
        },
        'image/png'
      );
    };
    img.onerror = () => reject(new Error('加载图片失败'));
    img.src = dataUrl;
  });
}

const readFileAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('读取失败'));
    reader.readAsDataURL(file);
  });

export function useMobileMetadataBatch(processFileForTarget: MobileProcessFileForTarget) {
  const [metadataFiles, setMetadataFiles] = useState<MetadataFile[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState({ current: 0, total: 0 });
  const [batchMode, setBatchMode] = useState<'clean' | 'custom'>('clean');
  const [customPrompt, setCustomPrompt] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [viewingIndex, setViewingIndex] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleImport = useCallback((metadata: ImageMetadata) => {
    processFileForTarget('import', metadata, {
      prompt: true,
      negativePrompt: true,
      characters: true,
      appendCharacters: false,
      settings: true,
      seed: true,
      vibes: true,
      cleanImports: true,
    });
    setViewingIndex(null);
    window.dispatchEvent(new CustomEvent('switch-to-generate'));
  }, [processFileForTarget]);

  const processFiles = useCallback(async (files: File[]) => {
    const imgs = files.filter((file) => file.type.startsWith('image/'));
    if (!imgs.length) return;
    setIsLoading(true);
    setLoadingProgress({ current: 0, total: imgs.length });
    const newFiles: MetadataFile[] = [];
    for (let i = 0; i < imgs.length; i++) {
      setLoadingProgress({ current: i + 1, total: imgs.length });
      try {
        const dataUrl = await readFileAsDataUrl(imgs[i]);
        const metadata = await extractImageMetadata(imgs[i]);
        newFiles.push({ name: imgs[i].name, dataUrl, metadata, isSelected: false, fileSize: imgs[i].size });
      } catch {
        newFiles.push({ name: imgs[i].name, dataUrl: '', metadata: null, isSelected: false, fileSize: imgs[i].size });
      }
    }
    setMetadataFiles((prev) => [...prev, ...newFiles]);
    setIsLoading(false);
    setLoadingProgress({ current: 0, total: 0 });
  }, []);

  const handleFileSelect = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    if (!event.target.files?.length) return;
    await processFiles(Array.from(event.target.files));
    event.target.value = '';
  }, [processFiles]);

  const toggleSelect = useCallback((index: number) => {
    setMetadataFiles((prev) => prev.map((file, idx) => (
      idx === index ? { ...file, isSelected: !file.isSelected } : file
    )));
  }, []);

  const toggleSelectAll = useCallback(() => {
    const all = metadataFiles.every((file) => file.isSelected);
    setMetadataFiles((prev) => prev.map((file) => ({ ...file, isSelected: !all })));
  }, [metadataFiles]);

  const removeSelected = useCallback(() => {
    setMetadataFiles((prev) => prev.filter((file) => !file.isSelected));
    setViewingIndex(null);
  }, []);

  const clearAll = useCallback(() => {
    setMetadataFiles([]);
    setViewingIndex(null);
  }, []);

  const getProcessed = useCallback((file: MetadataFile) => (
    batchMode === 'clean'
      ? cleanImageMetadataProper(file.dataUrl)
      : writeCustomMetadataToImage(file.dataUrl, customPrompt)
  ), [batchMode, customPrompt]);

  const getSuffix = useCallback(() => batchMode === 'clean' ? '_clean' : '_custom', [batchMode]);
  const getOutName = useCallback((file: MetadataFile) => `${file.name.replace(/\.[^/.]+$/, '')}${getSuffix()}.png`, [getSuffix]);

  const handleDownloadZip = useCallback(async () => {
    const selected = metadataFiles.filter((file) => file.isSelected && file.dataUrl);
    if (!selected.length) return;
    setIsProcessing(true);
    try {
      if (selected.length === 1) {
        const blob = await getProcessed(selected[0]);
        const url = URL.createObjectURL(blob);
        Object.assign(document.createElement('a'), { href: url, download: getOutName(selected[0]) }).click();
        URL.revokeObjectURL(url);
      } else {
        const zip = new JSZip();
        for (const file of selected) {
          try {
            zip.file(getOutName(file), await getProcessed(file));
          } catch (error) {
            console.error(`处理 ${file.name} 失败:`, error);
          }
        }
        const url = URL.createObjectURL(await zip.generateAsync({ type: 'blob' }));
        Object.assign(document.createElement('a'), { href: url, download: `processed_${Date.now()}.zip` }).click();
        URL.revokeObjectURL(url);
      }
    } catch (error) {
      console.error('处理失败:', error);
    }
    setIsProcessing(false);
  }, [getOutName, getProcessed, metadataFiles]);

  const selectedCount = metadataFiles.filter((file) => file.isSelected).length;
  const allSelected = metadataFiles.length > 0 && metadataFiles.every((file) => file.isSelected);
  const hasFiles = metadataFiles.length > 0;
  const viewingFile = viewingIndex !== null ? metadataFiles[viewingIndex] : null;

  return {
    metadataFiles,
    isLoading,
    loadingProgress,
    batchMode,
    setBatchMode,
    customPrompt,
    setCustomPrompt,
    isProcessing,
    viewingFile,
    setViewingIndex,
    fileInputRef,
    handleImport,
    handleFileSelect,
    toggleSelect,
    toggleSelectAll,
    removeSelected,
    clearAll,
    handleDownloadZip,
    selectedCount,
    allSelected,
    hasFiles,
  };
}
