import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import JSZip from 'jszip';
import type { HistoryItem } from '../../../contexts/GenerationContext';
import { generateImageFileName } from '../../../utils/fileSystem';
import {
  estimateSavedSize,
  getSaveExt,
  processImageForSave,
  type SaveFormat,
} from '../../../utils/imageMetadata';

type SaveMode = 'original' | 'clean' | 'custom';

const STORAGE_KEY_SAVE_MODE = 'nai_save_mode';
const STORAGE_KEY_CUSTOM_PROMPT = 'nai_save_custom_prompt';
const STORAGE_KEY_SAVE_FORMAT = 'nai_save_format';
const STORAGE_KEY_SAVE_QUALITY = 'nai_save_quality';
const DEFAULT_QUALITY = 0.92;

interface UseMobileSaveDownloadWorkflowOptions {
  imageUrl: string | null;
  currentSeed: number | null;
  history: HistoryItem[];
  selectedItems: Set<string>;
  setSelectedItems: Dispatch<SetStateAction<Set<string>>>;
  setIsSelectionMode: Dispatch<SetStateAction<boolean>>;
}

export function useMobileSaveDownloadWorkflow({
  imageUrl,
  currentSeed,
  history,
  selectedItems,
  setSelectedItems,
  setIsSelectionMode,
}: UseMobileSaveDownloadWorkflowOptions) {
  const [showSaveSettings, setShowSaveSettings] = useState(false);
  const [saveMode, setSaveMode] = useState<SaveMode>('original');
  const [customPrompt, setCustomPrompt] = useState('');
  const [saveFormat, setSaveFormat] = useState<SaveFormat>('png');
  const [saveQuality, setSaveQuality] = useState<number>(DEFAULT_QUALITY);
  const [estimatedSize, setEstimatedSize] = useState<number | null>(null);
  const [isEstimating, setIsEstimating] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const estimateSeqRef = useRef(0);

  useEffect(() => {
    const savedMode = localStorage.getItem(STORAGE_KEY_SAVE_MODE) as SaveMode | null;
    const savedPrompt = localStorage.getItem(STORAGE_KEY_CUSTOM_PROMPT);
    const savedFormat = localStorage.getItem(STORAGE_KEY_SAVE_FORMAT) as SaveFormat | null;
    const savedQuality = localStorage.getItem(STORAGE_KEY_SAVE_QUALITY);
    if (savedMode) setSaveMode(savedMode);
    if (savedPrompt) setCustomPrompt(savedPrompt);
    if (savedFormat === 'png' || savedFormat === 'jpg') setSaveFormat(savedFormat);
    if (savedQuality) {
      const quality = Number(savedQuality);
      if (Number.isFinite(quality) && quality > 0 && quality <= 1) setSaveQuality(quality);
    }
  }, []);

  useEffect(() => {
    if (!showSaveSettings || !imageUrl) {
      setEstimatedSize(null);
      return;
    }
    const seq = ++estimateSeqRef.current;
    setIsEstimating(true);
    const timer = window.setTimeout(async () => {
      try {
        const size = await estimateSavedSize(imageUrl, {
          mode: saveMode,
          customPrompt,
          format: saveFormat,
          quality: saveQuality,
        });
        if (seq === estimateSeqRef.current) setEstimatedSize(size);
      } catch {
        if (seq === estimateSeqRef.current) setEstimatedSize(null);
      } finally {
        if (seq === estimateSeqRef.current) setIsEstimating(false);
      }
    }, saveFormat === 'jpg' ? 220 : 60);
    return () => window.clearTimeout(timer);
  }, [showSaveSettings, imageUrl, saveMode, customPrompt, saveFormat, saveQuality]);

  const handleApplySaveSettings = () => {
    localStorage.setItem(STORAGE_KEY_SAVE_MODE, saveMode);
    if (saveMode === 'custom') {
      localStorage.setItem(STORAGE_KEY_CUSTOM_PROMPT, customPrompt);
    }
    localStorage.setItem(STORAGE_KEY_SAVE_FORMAT, saveFormat);
    localStorage.setItem(STORAGE_KEY_SAVE_QUALITY, String(saveQuality));
    window.dispatchEvent(new Event('saveSettingsUpdated'));
    setShowSaveSettings(false);
  };

  const downloadSingleImage = async (url: string): Promise<Blob | null> => {
    try {
      return await processImageForSave(url, {
        mode: saveMode,
        customPrompt,
        format: saveFormat,
        quality: saveQuality,
      });
    } catch (error) {
      console.error('处理图片失败:', error);
      return null;
    }
  };

  const getModeSuffix = () => {
    if (saveFormat !== 'png') return '';
    if (saveMode === 'clean') return '_clean';
    if (saveMode === 'custom') return '_custom';
    return '';
  };

  const downloadBlob = (blob: Blob, filename: string) => {
    const downloadUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(downloadUrl);
  };

  const downloadAndSaveImage = async (url: string, _seed: number | string, timestamp?: number) => {
    const blob = await downloadSingleImage(url);
    if (blob) {
      downloadBlob(blob, generateImageFileName(getModeSuffix(), timestamp, getSaveExt(saveFormat)));
    }
  };

  const handleDownload = async () => {
    if (!imageUrl) return;
    const currentTimestamp = history.find((item) => item.imageUrl === imageUrl)?.timestamp;
    await downloadAndSaveImage(imageUrl, currentSeed || Date.now(), currentTimestamp);
  };

  const handleDownloadSelected = async () => {
    if (selectedItems.size === 0) return;

    setIsDownloading(true);
    try {
      const selectedHistory = history.filter((item) => selectedItems.has(item.id));

      if (selectedHistory.length === 1) {
        const item = selectedHistory[0];
        await downloadAndSaveImage(item.imageUrl, item.seed, item.timestamp);
      } else {
        const zip = new JSZip();
        const suffix = getModeSuffix();
        const ext = getSaveExt(saveFormat);

        for (const item of selectedHistory) {
          const blob = await downloadSingleImage(item.imageUrl);
          if (blob) {
            zip.file(generateImageFileName(suffix, item.timestamp, ext), blob);
          }
        }

        const zipBlob = await zip.generateAsync({ type: 'blob' });
        downloadBlob(zipBlob, `novelai_images_${Date.now()}.zip`);
      }
    } catch (error) {
      console.error('下载失败:', error);
    } finally {
      setIsDownloading(false);
    }
  };

  const handleDownloadAll = async () => {
    if (history.length === 0) return;

    setIsDownloading(true);
    try {
      const zip = new JSZip();
      const suffix = getModeSuffix();
      const ext = getSaveExt(saveFormat);

      for (const item of history) {
        const blob = await downloadSingleImage(item.imageUrl);
        if (blob) {
          zip.file(generateImageFileName(suffix, item.timestamp, ext), blob);
        }
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      downloadBlob(zipBlob, `novelai_all_${Date.now()}.zip`);
    } catch (error) {
      console.error('打包下载失败:', error);
    } finally {
      setIsDownloading(false);
    }
  };

  const handleDeleteSelected = (deleteHistoryItems: (ids: string[]) => void) => {
    if (selectedItems.size === 0) return;
    deleteHistoryItems(Array.from(selectedItems));
    setSelectedItems(new Set());
    setIsSelectionMode(false);
  };

  return {
    showSaveSettings,
    setShowSaveSettings,
    saveMode,
    setSaveMode,
    customPrompt,
    setCustomPrompt,
    saveFormat,
    setSaveFormat,
    saveQuality,
    setSaveQuality,
    estimatedSize,
    isEstimating,
    isDownloading,
    handleApplySaveSettings,
    handleDownload,
    downloadAndSaveImage,
    handleDownloadSelected,
    handleDownloadAll,
    handleDeleteSelected,
  };
}
