import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Copy, FileDigit, Image as ImageIcon, X, AlertCircle, Download, Settings, Loader2 } from 'lucide-react';
import { useGeneration } from '../contexts/GenerationContext';
import { useAuth } from '../contexts/AuthContext';
import { SaveModal, type SaveOptions } from './SaveModal';
import { useImageActions } from './desktop/imageActions';
import { InpaintOverlay, type ExpandPayload } from './InpaintOverlay';
import { WorkshopInputBar } from './workshop/WorkshopInputBar';
import { alignSendRect, focusSendSize, type CropRect } from '../utils/maskCrop';
import { expandMaskRegions } from './inpaint/maskUtils';
import { UpscaleModal } from './UpscaleModal';
import { processImageForSave, getSaveExt, isWatermarkExportActive, type SaveFormat } from '../utils/imageMetadata';
import { WatermarkPlacementOverlay } from './watermark/WatermarkPlacementOverlay';
import { publishCanvasImage, useWatermarkOverlayMode } from './watermark/overlayMode';
import { generateImageFileName } from '../utils/fileSystem';

const STORAGE_KEY_SAVE_MODE = 'nai_default_save_mode';
const STORAGE_KEY_CUSTOM_PROMPT = 'nai_save_custom_prompt';
const STORAGE_KEY_SAVE_FORMAT = 'nai_save_format';
const STORAGE_KEY_SAVE_QUALITY = 'nai_save_quality';
const DEFAULT_QUALITY = 0.92;

export const MainContent: React.FC = () => {
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
    setSeedSetting,
    isQueuing,
    queuePosition,
    cancelTask,
    addUpscaledImage,
    selectHistoryItem,
    history,
    viewingHistory,
    setViewingHistory,
  } = useGeneration();
  const { isAuthenticated, requireAuth } = useAuth();
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showError, setShowError] = useState(true);
  const [isSaveModalOpen, setIsSaveModalOpen] = useState(false);
  const [isInpaintMode, setIsInpaintMode] = useState(false);
  const [isInpainting, setIsInpainting] = useState(false);
  const [isUpscaleModalOpen, setIsUpscaleModalOpen] = useState(false);

  // 取消按钮反馈
  const [isCancelling, setIsCancelling] = useState(false);
  const [cancelToast, setCancelToast] = useState<string | null>(null);
  const handleCancelQueue = useCallback(async () => {
    if (isCancelling) return;
    setIsCancelling(true);
    try {
      const ok = await cancelTask();
      if (!ok) {
        setCancelToast('取消失败，任务可能已开始处理');
        setTimeout(() => setCancelToast(null), 2500);
      }
    } catch {
      setCancelToast('取消失败，请稍后重试');
      setTimeout(() => setCancelToast(null), 2500);
    } finally {
      setIsCancelling(false);
    }
  }, [cancelTask, isCancelling]);

  // 工坊输入条：监听全局事件触发，原图保持显示在画布上
  const [isWorkshopOpen, setIsWorkshopOpen] = useState(false);
  const [workshopInitialUrl, setWorkshopInitialUrl] = useState<string | undefined>(undefined);
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      setWorkshopInitialUrl(detail?.imageUrl || undefined);
      setIsWorkshopOpen(true);
    };
    window.addEventListener('open-image-gen-page', handler);
    return () => window.removeEventListener('open-image-gen-page', handler);
  }, []);

  // 画布动作的按钮住在顶栏(外壳重排第 2 步),状态留在这里:只把开法注册上去。
  // 见 desktop/imageActions.tsx 里为什么不提状态、也不再加 window 事件。
  // `open-image-gen-page` 这个事件原样保留 —— 它是外部(以后的导演工具、助手)
  // 打开工坊的入口,只是不再由画布上那条浮动工具条来发。
  const imageActions = useImageActions();
  const canActOnImage = !!imageUrl && !isGenerating && !isInpaintMode && !isWorkshopOpen;
  useEffect(() => {
    imageActions.setHasImage(canActOnImage);
  }, [imageActions, canActOnImage]);
  useEffect(() => {
    imageActions.register({
      openInpaint: () => {
        setInitialMask(null);
        setInpaintOriginalImage(null);
        setInpaintDimensions(null);
        setIsInpaintMode(true);
      },
      openUpscale: () => setIsUpscaleModalOpen(true),
      openEditor: () => {
        setWorkshopInitialUrl(imageUrl || undefined);
        setIsWorkshopOpen(true);
      },
    });
  }, [imageActions, imageUrl]);

  // 默认保存设置
  const [defaultSaveMode, setDefaultSaveMode] = useState<'original' | 'clean' | 'custom'>('original');
  const [defaultCustomPrompt, setDefaultCustomPrompt] = useState('');
  const [defaultFormat, setDefaultFormat] = useState<SaveFormat>('png');
  const [defaultQuality, setDefaultQuality] = useState<number>(DEFAULT_QUALITY);

  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const lastPosition = useRef({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const watermarkOverlayOn = useWatermarkOverlayMode();
  const isDragRef = useRef(false);

  // 当有新错误时重置显示状态
  useEffect(() => {
    if (result && !result.success) {
      setShowError(true);
    }
  }, [result]);

  // 加载默认保存设置
  useEffect(() => {
    const savedMode = localStorage.getItem(STORAGE_KEY_SAVE_MODE) as 'original' | 'clean' | 'custom' | null;
    const savedPrompt = localStorage.getItem(STORAGE_KEY_CUSTOM_PROMPT);
    const savedFormat = localStorage.getItem(STORAGE_KEY_SAVE_FORMAT) as SaveFormat | null;
    const savedQuality = localStorage.getItem(STORAGE_KEY_SAVE_QUALITY);
    if (savedMode) setDefaultSaveMode(savedMode);
    if (savedPrompt) setDefaultCustomPrompt(savedPrompt);
    if (savedFormat === 'png' || savedFormat === 'jpg') setDefaultFormat(savedFormat);
    if (savedQuality) {
      const q = Number(savedQuality);
      if (Number.isFinite(q) && q > 0 && q <= 1) setDefaultQuality(q);
    }
  }, []);

  useEffect(() => {
    setScale(1);
    setPosition({ x: 0, y: 0 });
  }, [imageUrl, isGenerating]);

  const handleWheel = (e: React.WheelEvent) => {
    if ((isGenerating && !viewingHistory) || !imageUrl) return;

    const scaleFactor = e.deltaY > 0 ? 0.9 : 1.1;
    let newScale = scale * scaleFactor;
    newScale = Math.min(Math.max(newScale, 0.1), 20);

    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left - rect.width / 2;
      const y = e.clientY - rect.top - rect.height / 2;

      const newPos = {
        x: x - (x - position.x) * (newScale / scale),
        y: y - (y - position.y) * (newScale / scale)
      };
      setPosition(newPos);
    }

    setScale(newScale);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if ((isGenerating && !viewingHistory) || !imageUrl) return;
    e.preventDefault();
    setIsDragging(true);
    isDragRef.current = false;
    dragStart.current = { x: e.clientX, y: e.clientY };
    lastPosition.current = { ...position };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return;
    const deltaX = e.clientX - dragStart.current.x;
    const deltaY = e.clientY - dragStart.current.y;

    if (Math.abs(deltaX) > 5 || Math.abs(deltaY) > 5) {
      isDragRef.current = true;
    }

    setPosition({
      x: lastPosition.current.x + deltaX,
      y: lastPosition.current.y + deltaY
    });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const handleImageClick = () => {
    if (isDragRef.current || (isGenerating && !viewingHistory)) return;
    if (scale > 1.1) {
      setScale(1);
      setPosition({ x: 0, y: 0 });
    } else {
      setScale(2);
      setPosition({ x: 0, y: 0 });
    }
  };

  const displayUrl = (isGenerating || isQueuing)
    ? (viewingHistory ? imageUrl : previewUrl)
    : imageUrl;
  // 设置页的「在当前图上选一次」和画板水印定位都看这张图。
  useEffect(() => { publishCanvasImage(imageUrl); }, [imageUrl]);

  // 复制到剪贴板（使用默认设置）
  const handleCopyToClipboard = async () => {
    if (!imageUrl) return;
    try {
      // 剪贴板写入仅原生支持 image/png；jpg 模式下退化为 png 复制
      const blob = await processImageForSave(imageUrl, {
        mode: defaultSaveMode,
        customPrompt: defaultCustomPrompt,
        format: 'png',
      });
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    } catch (error) {
      console.error('复制失败:', error);
    }
  };

  // 直接保存（使用默认设置）
  const handleQuickSave = () => {
    if (!imageUrl) return;
    handleSaveWithOptions({
      mode: defaultSaveMode,
      customPrompt: defaultCustomPrompt,
      format: defaultFormat,
      quality: defaultQuality,
    });
  };

  // 应用默认设置
  const handleApplyDefault = (options: SaveOptions) => {
    setDefaultSaveMode(options.mode);
    localStorage.setItem(STORAGE_KEY_SAVE_MODE, options.mode);
    if (options.customPrompt !== undefined) {
      setDefaultCustomPrompt(options.customPrompt);
      localStorage.setItem(STORAGE_KEY_CUSTOM_PROMPT, options.customPrompt);
    }
    setDefaultFormat(options.format);
    localStorage.setItem(STORAGE_KEY_SAVE_FORMAT, options.format);
    setDefaultQuality(options.quality);
    localStorage.setItem(STORAGE_KEY_SAVE_QUALITY, String(options.quality));
    // 触发自定义事件通知其他组件设置已更新
    window.dispatchEvent(new Event('saveSettingsUpdated'));
  };

  const handleSaveWithOptions = async (options: SaveOptions) => {
    if (!imageUrl) return;
    const currentTimestamp = history.find(h => h.imageUrl === imageUrl)?.timestamp;
    const ext = getSaveExt(options.format);

    // 文件名后缀：original 无后缀；jpg 模式下 clean/custom 也只是格式不同，不再附加 _clean/_custom（jpg 等价无元数据）
    let suffix = '';
    if (options.format === 'png') {
      if (options.mode === 'clean') suffix = '_clean';
      else if (options.mode === 'custom') suffix = '_custom';
    }

    try {
      // PNG + original 可以走 <a download> 直链，避免重新加载;水印生效时不行,得进管道重新编码
      if (options.format === 'png' && options.mode === 'original' && !isWatermarkExportActive()) {
        const link = document.createElement('a');
        link.href = imageUrl;
        link.download = generateImageFileName(suffix, currentTimestamp, ext);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        return;
      }

      const blob = await processImageForSave(imageUrl, options);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = generateImageFileName(suffix, currentTimestamp, ext);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('保存失败:', error);
    }
  };

  // 局部重绘处理
  const handleInpaintGenerate = async (maskBase64: string, strength: number, cropRect?: CropRect, expandPayload?: ExpandPayload) => {
    const sourceImageUrl = inpaintOriginalImage || imageUrl;
    if (!sourceImageUrl) return;

    if (!isAuthenticated) {
      requireAuth(() => handleInpaintGenerate(maskBase64, strength, cropRect, expandPayload));
      return;
    }

    setIsInpainting(true);

    try {
      // ===== 扩图框选模式：InpaintOverlay 已准备好完整载荷 =====
      if (expandPayload) {
        pendingPasteBackRef.current = true; // 扩图总有回贴
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
      const sourceWidth = inpaintDimensions?.width || targetWidth;
      const sourceHeight = inpaintDimensions?.height || targetHeight;

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
      let cropInfo: { cropRect: CropRect; sendRect?: CropRect; sentWidth?: number; sentHeight?: number; originalImageBase64: string; originalWidth: number; originalHeight: number } | undefined;

      if (cropRect) {
        const fullImageBase64 = imageBase64;

        // tight cropRect 是"真正贴回去"的区域；sendRect 是 64 对齐后从原图截取的区域;
        // 照官方的焦点重绘,截下来的这块再放大到 ~1MP 发送(只放大不缩小),模型在更高分辨率上补细节,回贴时缩回。
        const sendRect = alignSendRect(cropRect, fullWidth, fullHeight);
        const sent = focusSendSize(sendRect);

        const fullImg = new Image();
        await new Promise<void>((resolve) => { fullImg.onload = () => resolve(); fullImg.src = `data:image/png;base64,${fullImageBase64}`; });
        const cropCanvas = document.createElement('canvas');
        cropCanvas.width = sent.width;
        cropCanvas.height = sent.height;
        const cropCtx = cropCanvas.getContext('2d')!;
        cropCtx.imageSmoothingQuality = 'high';
        cropCtx.drawImage(fullImg, sendRect.x, sendRect.y, sendRect.width, sendRect.height, 0, 0, sent.width, sent.height);
        imageBase64 = cropCanvas.toDataURL('image/png').split(',')[1];

        const maskImg = new Image();
        await new Promise<void>((resolve) => { maskImg.onload = () => resolve(); maskImg.src = `data:image/png;base64,${maskBase64}`; });
        const maskCropCanvas = document.createElement('canvas');
        maskCropCanvas.width = sent.width;
        maskCropCanvas.height = sent.height;
        const maskCropCtx = maskCropCanvas.getContext('2d')!;
        maskCropCtx.fillStyle = '#000000';
        maskCropCtx.fillRect(0, 0, sent.width, sent.height);
        // 蒙版是二值图,放大时不插值,免得边缘出现灰阶
        maskCropCtx.imageSmoothingEnabled = false;
        maskCropCtx.drawImage(maskImg, sendRect.x, sendRect.y, sendRect.width, sendRect.height, 0, 0, sent.width, sent.height);
        // 8px 潜空间对齐必须在**发送分辨率**上做:原图尺度量化过的块被放大 s 倍后,块边落在 8px 网格中间,
        // NovelAI 对只覆盖一部分的 8px 块会吐半透明像素(真链路实测:贴回来是一块绿色补丁)。
        // 发送尺寸是 64 的倍数,8px 块刚好铺满。
        maskCropCtx.putImageData(expandMaskRegions(maskCropCtx.getImageData(0, 0, sent.width, sent.height)), 0, 0);
        maskBase64 = maskCropCanvas.toDataURL('image/png').split(',')[1];

        cropInfo = { cropRect, sendRect, sentWidth: sent.width, sentHeight: sent.height, originalImageBase64: fullImageBase64, originalWidth: fullWidth, originalHeight: fullHeight };
        fullWidth = sent.width;
        fullHeight = sent.height;
      }

      if (cropInfo) pendingPasteBackRef.current = true; // 裁切有回贴
      const event = new CustomEvent('inpaint-generate', {
        detail: { imageBase64, maskBase64, strength, width: fullWidth, height: fullHeight, cropInfo }
      });
      window.dispatchEvent(event);
    } catch (error) {
      console.error('局部重绘失败:', error);
      setIsInpainting(false);
    }
  };

  // 追踪生成状态变化
  const wasGeneratingRef = useRef(false);

  // 重绘完成后：保持面板打开，更新图片为生成结果
  // 如果有裁切/扩图回贴，等回贴完成后再更新（避免显示中间的裁切尺寸结果）
  const pendingPasteBackRef = useRef(false);
  useEffect(() => {
    if (isInpainting && wasGeneratingRef.current && !isGenerating) {
      setIsInpainting(false);
      if (!pendingPasteBackRef.current) {
        // 无回贴，直接更新
        setInpaintOriginalImage(null);
        setInpaintDimensions(null);
        setInitialMask(null);
      }
      // 有回贴时由 inpaint-pasteback-done 事件处理
    }
    wasGeneratingRef.current = isGenerating;
  }, [isGenerating, isInpainting]);

  // 监听裁切/扩图回贴完成事件
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

  // 退出 inpaint 模式时重置状态
  const handleCloseInpaint = () => {
    setIsInpaintMode(false);
    setInitialMask(null);
    setInpaintOriginalImage(null);
    setInpaintDimensions(null);
    window.dispatchEvent(new Event('close-inpaint-mode'));
  };

  // 监听从 LeftSidebar 发来的打开重绘模式事件
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

  // 超分辨率完成处理
  const handleUpscaleComplete = async (resultBlob: Blob, scale: number) => {
    // 创建 URL
    const url = URL.createObjectURL(resultBlob);

    // 获取超分后的实际尺寸
    const img = await createImageBitmap(resultBlob);
    const width = img.width;
    const height = img.height;

    // 添加到历史记录
    addUpscaledImage(url, width, height, currentSeed || 0, scale);
  };



  return (
    <div className="flex-1 bg-nai-bg flex flex-col relative overflow-hidden">
      {/* Save Modal */}
      <SaveModal
        isOpen={isSaveModalOpen}
        onClose={() => setIsSaveModalOpen(false)}
        imageUrl={imageUrl || ''}
        seed={currentSeed}
        onSave={handleSaveWithOptions}
        onApplyDefault={handleApplyDefault}
        defaultMode={defaultSaveMode}
        defaultCustomPrompt={defaultCustomPrompt}
        defaultFormat={defaultFormat}
        defaultQuality={defaultQuality}
      />

      {/* Upscale Modal */}
      <UpscaleModal
        isOpen={isUpscaleModalOpen}
        onClose={() => setIsUpscaleModalOpen(false)}
        imageUrl={imageUrl || ''}
        onComplete={handleUpscaleComplete}
      />



      {/* Inpaint Overlay */}
      {isInpaintMode && (inpaintOriginalImage || imageUrl) && (
        <InpaintOverlay
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

      {/* 图像编辑（大GPT 工坊）：嵌在画布底部的紧凑输入条，提交后立即关闭 */}
      <WorkshopInputBar
        isOpen={isWorkshopOpen}
        onClose={() => setIsWorkshopOpen(false)}
        initialImageUrl={workshopInitialUrl || imageUrl || undefined}
      />

      {/* Error Toast */}
      {result && !result.success && showError && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-30 animate-in slide-in-from-top-2 duration-300">
          <div className="bg-red-500/90 backdrop-blur-sm text-white px-4 py-3 rounded-lg shadow-xl flex items-start gap-3 max-w-lg">
            <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="font-medium text-sm mb-1">生成失败</div>
              <div className="text-sm opacity-90 break-words whitespace-pre-wrap">{result.error}</div>
            </div>
            <button onClick={() => setShowError(false)} className="p-1 hover:bg-white/20 rounded transition-colors shrink-0">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Cancel Queue Toast */}
      {cancelToast && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-30 animate-in slide-in-from-top-2 duration-300">
          <div className="bg-amber-500/90 backdrop-blur-sm text-white px-4 py-2.5 rounded-lg shadow-xl flex items-center gap-2 max-w-lg">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span className="text-sm">{cancelToast}</span>
          </div>
        </div>
      )}

      {/* Fullscreen Modal */}
      {isFullscreen && imageUrl && (
        <div className="fixed inset-0 z-50 bg-black/95 flex items-center justify-center cursor-zoom-out" onClick={() => setIsFullscreen(false)}>
          <img src={imageUrl} alt="Generated" className="max-w-[95vw] max-h-[95vh] object-contain" />
          <button className="absolute top-4 right-4 p-2 bg-white/10 hover:bg-white/20 rounded-full transition-colors" onClick={() => setIsFullscreen(false)}>
            <X className="w-6 h-6 text-white" />
          </button>
        </div>
      )}

      {/* Canvas Area - 填满整个区域 */}
      <div
        className="flex-1 flex items-center justify-center p-10 overflow-hidden relative"
        ref={containerRef}
        onWheel={handleWheel}
      >
        {displayUrl ? (
          <div
            className="relative w-full h-full flex items-center justify-center"
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
          >
            <img
              ref={imageRef}
              src={displayUrl}
              alt={isGenerating ? 'Preview' : 'Generated'}
              className={`shadow-2xl ${isGenerating ? 'opacity-90' : ''}`}
              style={{
                width: targetWidth > targetHeight ? '100%' : 'auto',
                height: targetWidth > targetHeight ? 'auto' : '100%',
                maxWidth: '100%',
                maxHeight: '100%',
                aspectRatio: `${targetWidth} / ${targetHeight}`,
                objectFit: 'contain',
                transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
                cursor: isDragging ? 'grabbing' : (scale > 1 ? 'grab' : 'zoom-in'),
                transition: isDragging ? 'none' : 'transform 0.1s ease-out'
              }}
              onClick={handleImageClick}
            />
            {watermarkOverlayOn && imageUrl && !isGenerating && (
              <WatermarkPlacementOverlay imageRef={imageRef} imageUrl={imageUrl} />
            )}
          </div>
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-500 flex-col gap-2">
            <ImageIcon className="w-16 h-16 opacity-20" />
            <span className="opacity-50 text-sm">{isQueuing || isGenerating ? '' : '未生成图像'}</span>
          </div>
        )}
      </div>

      {/* 统一状态条 - 排队 + 生成进度 */}
      <div
        className={`absolute bottom-20 left-1/2 -translate-x-1/2 z-20 transition-all duration-300 ease-out ${(isQueuing || isGenerating) && !isInpaintMode && !viewingHistory
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
            <span className="text-nai-accent font-bold text-sm shrink-0 whitespace-nowrap">#{queuePosition > 0 ? queuePosition : '-'}</span>
            <button
              onClick={handleCancelQueue}
              disabled={isCancelling}
              className="ml-1 w-6 h-6 flex items-center justify-center text-gray-300 bg-white/5 hover:bg-white/15 hover:text-white rounded-full transition-colors shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
              title="取消排队"
            >
              {isCancelling ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <X className="w-3.5 h-3.5" strokeWidth={2.5} />
              )}
            </button>
          </div>

          {/* 生成进度 */}
          <div
            className={`flex items-center gap-3 transition-opacity duration-200 ${isGenerating && !isQueuing ? 'opacity-100' : 'opacity-0 invisible absolute'
              }`}
          >
            <div className="w-32 h-1.5 bg-gray-700 rounded-full overflow-hidden flex-shrink-0">
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



      {/* Bottom Info Bar */}
      <div className="absolute bottom-4 left-0 right-0 px-6 flex items-center justify-between pointer-events-none">
        {/* 左侧：尺寸 */}
        <div className="bg-nai-panel/90 backdrop-blur border border-gray-700 rounded-lg flex items-center p-1 pointer-events-auto shadow-xl">
          <button className="px-3 py-2 text-xs font-mono text-white hover:bg-gray-700 rounded">
            {targetWidth} × {targetHeight}
          </button>
        </div>

        {/* 右侧：三个独立块 */}
        <div className="flex items-center gap-2 pointer-events-auto">
          {/* 复制 */}
          <div className="bg-nai-panel/90 backdrop-blur border border-gray-700 rounded-lg shadow-xl">
            <button
              className={`p-2 hover:bg-gray-700 rounded transition-colors ${imageUrl ? 'text-gray-300 hover:text-white' : 'text-gray-600 cursor-not-allowed'}`}
              onClick={handleCopyToClipboard}
              disabled={!imageUrl}
              title="复制到剪贴板"
            >
              <Copy className="w-4 h-4" />
            </button>
          </div>

          {/* 保存 */}
          <div className="bg-nai-panel/90 backdrop-blur border border-gray-700 rounded-lg flex items-center shadow-xl">
            <button
              className={`p-2 hover:bg-gray-700 rounded-l transition-colors ${imageUrl ? 'text-gray-300 hover:text-white' : 'text-gray-600 cursor-not-allowed'}`}
              onClick={handleQuickSave}
              disabled={!imageUrl}
              title={`保存图片 (${defaultSaveMode === 'original' ? '原始' : defaultSaveMode === 'clean' ? '清除元数据' : '自定义'})`}
            >
              <Download className="w-4 h-4" />
            </button>
            <button
              className={`p-2 hover:bg-gray-700 rounded-r transition-colors ${imageUrl ? 'text-gray-300 hover:text-white' : 'text-gray-600 cursor-not-allowed'}`}
              onClick={() => setIsSaveModalOpen(true)}
              disabled={!imageUrl}
              title="保存选项"
            >
              <Settings className="w-4 h-4" />
            </button>
          </div>

          {/* 种子 */}
          <div
            className="bg-nai-panel/90 backdrop-blur border border-gray-700 rounded-lg shadow-xl cursor-pointer hover:border-gray-600"
            onClick={() => {
              if (currentSeed !== null) setSeedSetting(String(currentSeed));
            }}
          >
            <div className="px-2 py-2 text-xs font-mono text-gray-300 flex items-center gap-1.5 hover:text-white">
              <FileDigit className="w-4 h-4" />
              {currentSeed || '—'}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
