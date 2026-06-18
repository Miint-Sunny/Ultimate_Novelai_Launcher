import React, { useState, useEffect, useRef } from 'react';
import {
  Image as ImageIcon,
  Download,
  FileDigit,
  Maximize2,
  Settings2,
  X,
  RefreshCw,
  Settings,
  Paintbrush,
  ChevronRight,
  AlertCircle,
} from 'lucide-react';
import { useGeneration } from '../../contexts/GenerationContext';
import { processImageForSave, getSaveExt, estimateSavedSize, type SaveFormat } from '../../utils/imageMetadata';
import { generateImageFileName } from '../../utils/fileSystem';
import { MobileInpaintOverlay, type ExpandPayload } from './MobileInpaintOverlay';
import { MobileUpscaleSheet } from './MobileUpscaleSheet';
import { MobileFullscreenImageViewer } from './MobileFullscreenImageViewer';
import { MobileExpandedGallerySheet } from './MobileExpandedGallerySheet';
import { MobileSaveSettingsSheet } from './MobileSaveSettingsSheet';
import { alignSendRect, type CropRect } from '../../utils/maskCrop';
import { registerBackHandler } from './MobileLayout';
import JSZip from 'jszip';

const STORAGE_KEY_SAVE_MODE = 'nai_save_mode';
const STORAGE_KEY_CUSTOM_PROMPT = 'nai_save_custom_prompt';
const STORAGE_KEY_SAVE_FORMAT = 'nai_save_format';
const STORAGE_KEY_SAVE_QUALITY = 'nai_save_quality';
const DEFAULT_QUALITY = 0.92;

export const MobileGalleryPage: React.FC = () => {
  const {
    isGenerating,
    currentStep,
    totalSteps,
    previewUrl,
    result,
    imageUrl,
    currentSeed,
    targetWidth,
    targetHeight,
    isQueuing,
    queuePosition,
    cancelTask,
    history,
    selectHistoryItem,
    setSeedSetting,
    addUpscaledImage,
    deleteHistoryItem,
    deleteHistoryItems,
    viewingHistory,
    setViewingHistory,
  } = useGeneration();

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showSaveSettings, setShowSaveSettings] = useState(false);
  const [saveMode, setSaveMode] = useState<'original' | 'clean' | 'custom'>('original');
  const [customPrompt, setCustomPrompt] = useState('');
  const [saveFormat, setSaveFormat] = useState<SaveFormat>('png');
  const [saveQuality, setSaveQuality] = useState<number>(DEFAULT_QUALITY);
  const [estimatedSize, setEstimatedSize] = useState<number | null>(null);
  const [isEstimating, setIsEstimating] = useState(false);
  const estimateSeqRef = useRef(0);
  const [showError, setShowError] = useState(true);

  // 工具栏相关状态
  const [isInpaintMode, setIsInpaintMode] = useState(false);
  const [isInpainting, setIsInpainting] = useState(false);
  const [isUpscaleModalOpen, setIsUpscaleModalOpen] = useState(false);

  // 展开图库状态
  const [isGalleryExpanded, setIsGalleryExpanded] = useState(false);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);

  const displayUrl = (isGenerating || isQueuing)
    ? (viewingHistory ? imageUrl : previewUrl)
    : imageUrl;
  const hasImage = !!imageUrl && !isGenerating && !isInpaintMode;

  // 注册返回处理器 - 处理各种弹出层的关闭
  useEffect(() => {
    const handleBack = () => {
      // 按优先级处理各种弹出层
      if (isFullscreen) {
        setIsFullscreen(false);
        return true;
      }
      if (isGalleryExpanded) {
        setIsGalleryExpanded(false);
        setIsSelectionMode(false);
        setSelectedItems(new Set());
        return true;
      }
      if (showSaveSettings) {
        setShowSaveSettings(false);
        return true;
      }
      if (isUpscaleModalOpen) {
        setIsUpscaleModalOpen(false);
        return true;
      }
      if (isInpaintMode) {
        setIsInpaintMode(false);
        return true;
      }
      return false;
    };

    return registerBackHandler(handleBack);
  }, [isFullscreen, isGalleryExpanded, showSaveSettings, isUpscaleModalOpen, isInpaintMode]);

  // 监听从生成页面发来的打开重绘模式事件
  const [initialMask, setInitialMask] = useState<string | null>(null);
  const [inpaintOriginalImage, setInpaintOriginalImage] = useState<string | null>(null);
  const [inpaintDimensions, setInpaintDimensions] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      setInitialMask(detail?.maskBase64 || null);
      setInpaintOriginalImage(detail?.imageBase64 ? `data:image/png;base64,${detail.imageBase64}` : null);
      setInpaintDimensions(detail?.width && detail?.height ? { width: detail.width, height: detail.height } : null);
      setIsInpaintMode(true);
    };
    window.addEventListener('open-inpaint-mode', handler);
    return () => window.removeEventListener('open-inpaint-mode', handler);
  }, []);

  // 当有新错误时重置显示状态
  useEffect(() => {
    if (result && !result.success) {
      setShowError(true);
    }
  }, [result]);

  // 加载保存设置
  useEffect(() => {
    const savedMode = localStorage.getItem(STORAGE_KEY_SAVE_MODE) as 'original' | 'clean' | 'custom' | null;
    const savedPrompt = localStorage.getItem(STORAGE_KEY_CUSTOM_PROMPT);
    const savedFormat = localStorage.getItem(STORAGE_KEY_SAVE_FORMAT) as SaveFormat | null;
    const savedQuality = localStorage.getItem(STORAGE_KEY_SAVE_QUALITY);
    if (savedMode) setSaveMode(savedMode);
    if (savedPrompt) setCustomPrompt(savedPrompt);
    if (savedFormat === 'png' || savedFormat === 'jpg') setSaveFormat(savedFormat);
    if (savedQuality) {
      const q = Number(savedQuality);
      if (Number.isFinite(q) && q > 0 && q <= 1) setSaveQuality(q);
    }
  }, []);

  // 保存设置弹窗打开时估算大小（debounced）
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

  // 保存设置到 localStorage
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

  // 通用下载单张图片函数（根据保存设置）
  const downloadSingleImage = async (url: string, _seed: number | string): Promise<Blob | null> => {
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

  // 文件名后缀（jpg 模式不附加 _clean/_custom，因 jpg 等价无元数据）
  const getModeSuffix = () => {
    if (saveFormat !== 'png') return '';
    if (saveMode === 'clean') return '_clean';
    if (saveMode === 'custom') return '_custom';
    return '';
  };

  // 下载并保存单张图片
  const downloadAndSaveImage = async (url: string, seed: number | string, timestamp?: number) => {
    const blob = await downloadSingleImage(url, seed);
    if (blob) {
      const downloadUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = generateImageFileName(getModeSuffix(), timestamp, getSaveExt(saveFormat));
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(downloadUrl);
    }
  };

  // 下载图片（根据保存设置）
  const handleDownload = async () => {
    if (!imageUrl) return;
    const currentTimestamp = history.find(h => h.imageUrl === imageUrl)?.timestamp;
    await downloadAndSaveImage(imageUrl, currentSeed || Date.now(), currentTimestamp);
  };

  // 使用种子
  const handleUseSeed = () => {
    if (currentSeed) {
      setSeedSetting(String(currentSeed));
    }
  };

  // 重新生成
  const handleRegenerate = () => {
    window.dispatchEvent(new Event('regenerate-image'));
  };

  // 局部重绘处理
  const handleInpaintGenerate = async (
    maskBase64: string,
    strength: number,
    cropRect?: CropRect,
    expandPayload?: ExpandPayload,
  ) => {
    // 优先使用从图生图传入的原始图片，没有才回退到主画布图片
    const sourceImageUrl = inpaintOriginalImage || imageUrl;
    if (!sourceImageUrl) return;


    // 获取原图实际尺寸
    const sourceWidth = inpaintDimensions?.width || targetWidth;
    const sourceHeight = inpaintDimensions?.height || targetHeight;

    setIsInpainting(true);
    try {
      // ===== 扩图框选模式：MobileInpaintOverlay 已准备好完整载荷 =====
      if (expandPayload) {
        pendingPasteBackRef.current = true;
        const event = new CustomEvent('inpaint-generate', {
          detail: {
            imageBase64: expandPayload.imageBase64,
            maskBase64: expandPayload.maskBase64,
            strength,
            width: expandPayload.width,
            height: expandPayload.height,
            cropInfo: {
              cropRect: expandPayload.selection,
              originalImageBase64: expandPayload.originalImageBase64,
              originalWidth: expandPayload.originalWidth,
              originalHeight: expandPayload.originalHeight,
              isExpand: true,
            },
          }
        });
        window.dispatchEvent(event);
        return;
      }

      // ===== 普通重绘 / 裁切重绘模式 =====
      const response = await fetch(sourceImageUrl);
      const blob = await response.blob();

      let imageBase64: string;
      let fullWidth = sourceWidth;
      let fullHeight = sourceHeight;

      const reader = new FileReader();
      imageBase64 = await new Promise<string>((resolve, reject) => {
        reader.onload = () => resolve((reader.result as string).split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });

      // 裁切重绘模式
      let cropInfo: { cropRect: CropRect; sendRect?: CropRect; originalImageBase64: string; originalWidth: number; originalHeight: number } | undefined;

      if (cropRect) {
        const fullImageBase64 = imageBase64;

        // tight cropRect 用于回贴；sendRect 是 64 对齐后发送给 API 的区域
        const sendRect = alignSendRect(cropRect, fullWidth, fullHeight);

        const fullImg = new Image();
        await new Promise<void>((resolve) => {
          fullImg.onload = () => resolve();
          fullImg.src = `data:image/png;base64,${fullImageBase64}`;
        });
        const cropCanvas = document.createElement('canvas');
        cropCanvas.width = sendRect.width;
        cropCanvas.height = sendRect.height;
        const cropCtx = cropCanvas.getContext('2d')!;
        cropCtx.drawImage(fullImg, -sendRect.x, -sendRect.y);
        imageBase64 = cropCanvas.toDataURL('image/png').split(',')[1];

        const maskImg = new Image();
        await new Promise<void>((resolve) => {
          maskImg.onload = () => resolve();
          maskImg.src = `data:image/png;base64,${maskBase64}`;
        });
        const maskCropCanvas = document.createElement('canvas');
        maskCropCanvas.width = sendRect.width;
        maskCropCanvas.height = sendRect.height;
        const maskCropCtx = maskCropCanvas.getContext('2d')!;
        maskCropCtx.fillStyle = '#000000';
        maskCropCtx.fillRect(0, 0, sendRect.width, sendRect.height);
        maskCropCtx.drawImage(maskImg, -sendRect.x, -sendRect.y);
        maskBase64 = maskCropCanvas.toDataURL('image/png').split(',')[1];

        cropInfo = {
          cropRect,
          sendRect,
          originalImageBase64: fullImageBase64,
          originalWidth: fullWidth,
          originalHeight: fullHeight,
        };

        fullWidth = sendRect.width;
        fullHeight = sendRect.height;
      }

      if (cropInfo) pendingPasteBackRef.current = true;
      const event = new CustomEvent('inpaint-generate', {
        detail: {
          imageBase64,
          maskBase64,
          strength,
          width: fullWidth,
          height: fullHeight,
          cropInfo,
        }
      });
      window.dispatchEvent(event);
    } catch (error) {
      console.error('局部重绘失败:', error);
      setIsInpainting(false);
    }
  };

  // 追踪生成状态变化
  const wasGeneratingRef = useRef(false);
  const wasQueuingRef = useRef(false);
  const pendingPasteBackRef = useRef(false);

  useEffect(() => {
    const wasActive = wasGeneratingRef.current || wasQueuingRef.current;
    const isActive = isGenerating || isQueuing;

    if (isInpainting && wasActive && !isActive) {
      setIsInpainting(false);
      if (!pendingPasteBackRef.current) {
        setInpaintOriginalImage(null);
        setInpaintDimensions(null);
        setInitialMask(null);
      }
    }

    wasGeneratingRef.current = isGenerating;
    wasQueuingRef.current = isQueuing;
  }, [isGenerating, isQueuing, isInpainting]);

  useEffect(() => {
    const onDone = () => {
      pendingPasteBackRef.current = false;
      setInpaintOriginalImage(null);
      setInpaintDimensions(null);
      setInitialMask(null);
    };
    window.addEventListener('inpaint-pasteback-done', onDone);
    return () => window.removeEventListener('inpaint-pasteback-done', onDone);
  }, []);

  const handleCloseInpaint = () => {
    setIsInpaintMode(false);
    setInitialMask(null);
    setInpaintOriginalImage(null);
    setInpaintDimensions(null);
  };

  // 超分辨率完成处理
  const handleUpscaleComplete = async (resultBlob: Blob, scale: number) => {
    const url = URL.createObjectURL(resultBlob);

    // 使用 Image 元素获取尺寸（兼容移动端）
    const img = new Image();
    img.src = url;
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = reject;
    });

    const width = img.naturalWidth;
    const height = img.naturalHeight;
    addUpscaledImage(url, width, height, currentSeed || 0, scale);
  };

  // 展开图库相关处理
  const toggleSelectItem = (id: string) => {
    setSelectedItems((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id);
      }
      return newSet;
    });
  };

  const selectAll = () => {
    setSelectedItems(new Set(history.map((item) => item.id)));
  };

  const deselectAll = () => {
    setSelectedItems(new Set());
  };

  const handleDeleteSelected = () => {
    if (selectedItems.size === 0) return;
    deleteHistoryItems(Array.from(selectedItems));
    setSelectedItems(new Set());
    setIsSelectionMode(false);
  };

  const handleDownloadSelected = async () => {
    if (selectedItems.size === 0) return;

    setIsDownloading(true);
    try {
      const selectedHistory = history.filter((item) => selectedItems.has(item.id));

      if (selectedHistory.length === 1) {
        // 单张直接下载
        const item = selectedHistory[0];
        await downloadAndSaveImage(item.imageUrl, item.seed, item.timestamp);
      } else {
        // 多张打包下载
        const zip = new JSZip();
        const suffix = getModeSuffix();
        const ext = getSaveExt(saveFormat);

        for (let i = 0; i < selectedHistory.length; i++) {
          const item = selectedHistory[i];
          const blob = await downloadSingleImage(item.imageUrl, item.seed);
          if (blob) {
            zip.file(generateImageFileName(suffix, item.timestamp, ext), blob);
          }
        }

        const zipBlob = await zip.generateAsync({ type: 'blob' });
        const url = URL.createObjectURL(zipBlob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `novelai_images_${Date.now()}.zip`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
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

      for (let i = 0; i < history.length; i++) {
        const item = history[i];
        const blob = await downloadSingleImage(item.imageUrl, item.seed);
        if (blob) {
          zip.file(generateImageFileName(suffix, item.timestamp, ext), blob);
        }
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(zipBlob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `novelai_all_${Date.now()}.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('打包下载失败:', error);
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-nai-bg">
      {/* Error Toast */}
      {result && !result.success && showError && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-50 animate-in slide-in-from-top-2 duration-300 px-4 w-full max-w-md">
          <div className="bg-red-500/95 backdrop-blur-sm text-white px-4 py-3 rounded-xl shadow-xl flex items-start gap-3">
            <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="font-medium text-sm mb-1">生成失败</div>
              <div className="text-sm opacity-90 break-words whitespace-pre-wrap">{result.error}</div>
            </div>
            <button onClick={() => setShowError(false)} className="p-1 active:bg-white/20 rounded transition-colors shrink-0">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* 顶部状态栏 */}
      <header className="flex-shrink-0 flex items-center justify-between px-4 py-3 bg-nai-panel border-b border-gray-800">
        <div className="flex items-center gap-2">
          <ImageIcon className="w-5 h-5 text-gray-400" />
          <span className="font-medium">图库</span>
          <span className="text-sm text-gray-500">({history.length})</span>
        </div>
        <div className="flex items-center gap-2">
          {imageUrl && (
            <span className="text-xs text-gray-500 font-mono">
              {targetWidth}×{targetHeight}
            </span>
          )}
          <button
            onClick={() => setShowSaveSettings(true)}
            className="p-1.5 text-gray-400 hover:text-white rounded-lg hover:bg-gray-700/50 transition-colors"
            title="保存设置"
          >
            <Settings className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* 主内容区 - 当前图片 */}
      <div className="flex-1 relative bg-black/20 overflow-hidden">
        {/* 顶部悬浮工具栏 - inpaint 模式下隐藏 */}
        {!isInpaintMode && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20">
            <div className="bg-gray-900/80 backdrop-blur-xl rounded-xl flex items-center p-1 shadow-xl border border-white/5">
              <button
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm whitespace-nowrap transition-all ${hasImage ? 'text-gray-300 active:bg-white/10' : 'text-gray-600'
                  }`}
                onClick={() => { setInitialMask(null); setInpaintOriginalImage(null); setInpaintDimensions(null); setIsInpaintMode(true); }}
                disabled={!hasImage}
              >
                <Paintbrush className="w-4 h-4" />
                <span>重绘</span>
              </button>

              <div className="w-px h-5 bg-white/10 mx-0.5" />

              <button
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm whitespace-nowrap transition-all ${hasImage ? 'text-gray-300 active:bg-white/10' : 'text-gray-600'
                  }`}
                onClick={() => setIsUpscaleModalOpen(true)}
                disabled={!hasImage}
              >
                <Maximize2 className="w-4 h-4" />
                <span>放大</span>
              </button>
            </div>
          </div>
        )}

        {/* Inpaint Overlay */}
        {isInpaintMode && (inpaintOriginalImage || imageUrl) && (
          <MobileInpaintOverlay
            imageUrl={(inpaintOriginalImage || imageUrl)!}
            imageWidth={inpaintDimensions?.width || targetWidth}
            imageHeight={inpaintDimensions?.height || targetHeight}
            onGenerate={handleInpaintGenerate}
            onClose={handleCloseInpaint}
            isGenerating={isInpainting || isGenerating}
            previewUrl={previewUrl}
            currentStep={currentStep}
            totalSteps={totalSteps}
            initialMask={initialMask}
          />
        )}

        {displayUrl ? (
          <div
            className="relative w-full h-full flex items-center justify-center p-4"
            onTouchStart={(e) => {
              // 检测到双指触摸 → 进入全屏缩放模式
              if (e.touches.length >= 2 && (!isGenerating || viewingHistory) && imageUrl) {
                e.preventDefault();
                setIsFullscreen(true);
              }
            }}
          >
            <img
              src={displayUrl}
              alt={isGenerating ? 'Preview' : 'Generated'}
              className={`max-w-full max-h-full object-contain rounded-lg shadow-2xl ${isGenerating ? 'opacity-90' : ''
                }`}
              onClick={() => (!isGenerating || viewingHistory) && setIsFullscreen(true)}
            />
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-gray-500">
            <ImageIcon className="w-12 h-12 opacity-20 mb-2" />
            <span className="text-sm">{isQueuing || isGenerating ? '' : '未生成图像'}</span>
          </div>
        )}

        {/* 统一状态条 - 排队 + 生成进度（与 web 端一致） */}
        <div
          className={`absolute bottom-20 left-1/2 -translate-x-1/2 z-20 transition-all duration-300 ease-out ${isQueuing || isGenerating
            ? 'opacity-100 translate-y-0'
            : 'opacity-0 translate-y-4 pointer-events-none'
            }`}
        >
          <div className="bg-gray-900/90 backdrop-blur-sm px-4 py-2 rounded-full shadow-xl border border-gray-600/50 h-9 flex items-center justify-center">
            {/* 排队状态 */}
            <div
              className={`flex items-center gap-3 transition-opacity duration-200 ${isQueuing ? 'opacity-100' : 'opacity-0 invisible absolute'
                }`}
            >
              {/* 脉冲圆环 */}
              <div className="relative w-4 h-4 flex-shrink-0">
                <div className="absolute inset-0 bg-nai-accent/40 rounded-full animate-ping" />
                <div className="absolute inset-0.5 bg-nai-accent rounded-full" />
              </div>
              <span className="text-gray-200 text-sm shrink-0 whitespace-nowrap">排队中</span>
              <span className="text-nai-accent font-bold text-sm shrink-0 whitespace-nowrap">
                #{queuePosition > 0 ? queuePosition : '-'}
              </span>
              <button
                onClick={() => cancelTask()}
                className="ml-1 px-2 py-0.5 text-xs text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors shrink-0 whitespace-nowrap"
              >
                取消
              </button>
            </div>

            {/* 生成进度 */}
            <div
              className={`flex items-center gap-3 transition-opacity duration-200 ${isGenerating && !isQueuing ? 'opacity-100' : 'opacity-0 invisible absolute'
                }`}
            >
              <div className="w-28 h-1.5 bg-gray-700 rounded-full overflow-hidden flex-shrink-0">
                <div
                  className="h-full bg-nai-accent rounded-full transition-all duration-200 ease-out"
                  style={{ width: `${totalSteps > 0 ? (currentStep / totalSteps) * 100 : 0}%` }}
                />
              </div>
              <span className="text-gray-200 text-sm font-mono tabular-nums">
                {currentStep}/{totalSteps}
              </span>
            </div>
          </div>
        </div>

        {/* 当前图片工具栏 */}
        {imageUrl && !isGenerating && (
          <div className="absolute bottom-3 right-3 flex items-center gap-1.5">
            {/* 对比按钮 - 仅在当前图片是重绘图片且有对比原图时显示 */}
            <button
              onClick={handleUseSeed}
              className="flex items-center gap-1.5 px-3 py-2 bg-black/70 backdrop-blur-sm rounded-lg text-sm"
            >
              <FileDigit className="w-4 h-4" />
              {currentSeed}
            </button>
            <button
              onClick={handleRegenerate}
              className="p-2.5 bg-nai-accent/90 backdrop-blur-sm rounded-lg"
              title="重新生成"
            >
              <RefreshCw className="w-5 h-5 text-black" />
            </button>
            <button
              onClick={handleDownload}
              className="p-2.5 bg-black/70 backdrop-blur-sm rounded-lg"
              title="下载"
            >
              <Download className="w-5 h-5" />
            </button>
            <button
              onClick={() => {
                if (!imageUrl) return;
                const currentItem = history.find(h => h.imageUrl === imageUrl);
                // 通过事件触发 MobileGeneratePage 的导入面板
                window.dispatchEvent(new CustomEvent('open-image-import', {
                  detail: {
                    dataUrl: imageUrl,
                    metadata: currentItem?.metadata ? (() => {
                      const m = currentItem.metadata!;
                      return {
                        source: `NovelAI (${m.model})`,
                        sourceType: 'novelai',
                        prompt: m.positivePrompt,
                        negativePrompt: m.negativePrompt,
                        width: currentItem.width,
                        height: currentItem.height,
                        seed: String(currentItem.seed),
                        steps: String(m.steps),
                        scale: String(m.scale),
                        sampler: m.sampler,
                        cfgRescale: m.cfgRescale,
                        noiseSchedule: m.noiseSchedule,
                        characterPrompts: m.characterPrompts?.map(cp => ({
                          prompt: cp.positive,
                          uc: cp.negative,
                          center: cp.position ? { x: 0, y: 0 } : undefined,
                        })),
                      };
                    })() : null,
                  },
                }));
              }}
              className="p-2.5 bg-black/70 backdrop-blur-sm rounded-lg"
              title="导入元数据"
            >
              <Settings2 className="w-5 h-5" />
            </button>
          </div>
        )}
      </div>

      {/* 历史记录 - 底部固定一行 */}
      <div className="flex-shrink-0 bg-nai-panel border-t border-gray-800">
        {history.length === 0 && !isGenerating && !isQueuing ? (
          <div className="flex items-center justify-center h-20 text-gray-500">
            <span className="text-sm">暂无历史记录</span>
          </div>
        ) : (
          <div className="flex items-center p-2">
            <div className="flex-1 overflow-x-auto scrollbar-hide">
              <div className="flex flex-nowrap gap-2 items-center p-0.5">
                {/* 生成中占位缩略图 */}
                {(isGenerating || isQueuing) && (
                  <div
                    className={`flex-shrink-0 w-16 h-16 bg-gray-800 rounded-lg overflow-hidden relative ${!viewingHistory ? 'ring-2 ring-nai-accent' : ''}`}
                    onClick={() => setViewingHistory(false)}
                  >
                    {previewUrl ? (
                      <img src={previewUrl} alt="生成中" className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <div className="relative w-5 h-5">
                          <div className="absolute inset-0 bg-nai-accent/30 rounded-full animate-ping" />
                          <div className="absolute inset-1 bg-nai-accent/60 rounded-full animate-pulse" />
                        </div>
                      </div>
                    )}
                    {/* 底部进度 */}
                    <div className="absolute inset-x-0 bottom-0 bg-black/70 px-1 py-0.5">
                      {isQueuing ? (
                        <div className="text-[8px] text-nai-accent text-center font-bold">#{queuePosition > 0 ? queuePosition : '-'}</div>
                      ) : (
                        <div className="w-full h-1 bg-gray-700 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-nai-accent rounded-full transition-all duration-200"
                            style={{ width: `${totalSteps > 0 ? (currentStep / totalSteps) * 100 : 0}%` }}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                )}
                {history.map((item) => (
                  <div
                    key={item.id}
                    className={`flex-shrink-0 w-16 h-16 bg-gray-800 rounded-lg overflow-hidden relative ${imageUrl === item.imageUrl ? 'ring-2 ring-nai-accent' : ''
                      }`}
                    onClick={() => selectHistoryItem(item.id)}
                  >
                    <img
                      src={item.imageUrl}
                      alt={`Seed: ${item.seed}`}
                      className="w-full h-full object-cover"
                    />
                    {/* 标记 */}
                    {item.isUpscaled && (
                      <div className="absolute top-0.5 left-0.5 px-1 py-0.5 bg-green-500/80 rounded text-[8px] text-white font-bold">
                        {item.upscaleScale || 4}x
                      </div>
                    )}
                    {item.isInpainted && !item.isUpscaled && (
                      <div className="absolute top-0.5 left-0.5 px-1 py-0.5 bg-blue-500/80 rounded text-[8px] text-white font-bold">
                        重绘
                      </div>
                    )}
                    {item.isBananaRepaint && !item.isUpscaled && !item.isInpainted && (
                      <div className="absolute top-0.5 left-0.5 px-1 py-0.5 bg-yellow-500/80 rounded text-[8px] text-black font-bold">
                        🍌
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
            {/* 展开按钮 */}
            <div className="flex-shrink-0 flex items-center justify-center pl-2">
              <button
                onClick={() => setIsGalleryExpanded(true)}
                className="w-9 h-9 rounded-full bg-gray-700/80 flex items-center justify-center text-gray-400 active:bg-gray-600 active:text-white transition-colors"
              >
                <ChevronRight className="w-5 h-5" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 全屏预览 - 支持双指缩放 */}
      {isFullscreen && imageUrl && (
        <MobileFullscreenImageViewer
          imageUrl={imageUrl}
          onClose={() => setIsFullscreen(false)}
        />
      )}

      <MobileSaveSettingsSheet
        isOpen={showSaveSettings}
        onClose={() => setShowSaveSettings(false)}
        saveMode={saveMode}
        setSaveMode={setSaveMode}
        customPrompt={customPrompt}
        setCustomPrompt={setCustomPrompt}
        saveFormat={saveFormat}
        setSaveFormat={setSaveFormat}
        saveQuality={saveQuality}
        setSaveQuality={setSaveQuality}
        isEstimating={isEstimating}
        estimatedSize={estimatedSize}
        onApply={handleApplySaveSettings}
      />

      {/* Upscale Sheet */}
      <MobileUpscaleSheet
        isOpen={isUpscaleModalOpen}
        onClose={() => setIsUpscaleModalOpen(false)}
        imageUrl={imageUrl || ''}
        onComplete={handleUpscaleComplete}
      />

      <MobileExpandedGallerySheet
        isOpen={isGalleryExpanded}
        history={history}
        isGenerating={isGenerating}
        isQueuing={isQueuing}
        viewingHistory={viewingHistory}
        setViewingHistory={setViewingHistory}
        previewUrl={previewUrl}
        queuePosition={queuePosition}
        currentStep={currentStep}
        totalSteps={totalSteps}
        isSelectionMode={isSelectionMode}
        setIsSelectionMode={setIsSelectionMode}
        selectedItems={selectedItems}
        clearSelection={() => setSelectedItems(new Set())}
        selectAll={selectAll}
        deselectAll={deselectAll}
        toggleSelectItem={toggleSelectItem}
        selectHistoryItem={selectHistoryItem}
        closeGallery={() => {
          setIsGalleryExpanded(false);
          setIsSelectionMode(false);
          setSelectedItems(new Set());
        }}
        isDownloading={isDownloading}
        handleDownloadAll={handleDownloadAll}
        handleDownloadSelected={handleDownloadSelected}
        handleDeleteSelected={handleDeleteSelected}
        downloadAndSaveImage={downloadAndSaveImage}
        deleteHistoryItem={deleteHistoryItem}
      />

    </div>
  );
};
