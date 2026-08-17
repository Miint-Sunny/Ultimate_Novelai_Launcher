import { useEffect, useRef, useState } from 'react';
import { alignSendRect, type CropRect } from '../../../utils/maskCrop';
import type { ExpandPayload } from '../MobileInpaintOverlay';

interface UseMobileInpaintBridgeOptions {
  imageUrl: string | null;
  targetWidth: number;
  targetHeight: number;
  isGenerating: boolean;
  isQueuing: boolean;
  /** 是否监听全局 'open-inpaint-mode' 事件(图库页:true;P3 创作室页:false,避免双开覆盖物) */
  listenGlobalOpenEvent?: boolean;
}

export function useMobileInpaintBridge({
  imageUrl,
  targetWidth,
  targetHeight,
  isGenerating,
  isQueuing,
  listenGlobalOpenEvent = true,
}: UseMobileInpaintBridgeOptions) {
  const [isInpaintMode, setIsInpaintMode] = useState(false);
  const [isInpainting, setIsInpainting] = useState(false);
  const [initialMask, setInitialMask] = useState<string | null>(null);
  const [inpaintOriginalImage, setInpaintOriginalImage] = useState<string | null>(null);
  const [inpaintDimensions, setInpaintDimensions] = useState<{ width: number; height: number } | null>(null);

  const wasGeneratingRef = useRef(false);
  const wasQueuingRef = useRef(false);
  const pendingPasteBackRef = useRef(false);

  const resetInpaintSource = () => {
    setInitialMask(null);
    setInpaintOriginalImage(null);
    setInpaintDimensions(null);
  };

  const openInpaintMode = () => {
    resetInpaintSource();
    setIsInpaintMode(true);
  };

  useEffect(() => {
    if (!listenGlobalOpenEvent) return;
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      setInitialMask(detail?.maskBase64 || null);
      setInpaintOriginalImage(detail?.imageBase64 ? `data:image/png;base64,${detail.imageBase64}` : null);
      setInpaintDimensions(detail?.width && detail?.height ? { width: detail.width, height: detail.height } : null);
      setIsInpaintMode(true);
    };
    window.addEventListener('open-inpaint-mode', handler);
    return () => window.removeEventListener('open-inpaint-mode', handler);
  }, [listenGlobalOpenEvent]);

  const handleInpaintGenerate = async (
    maskBase64: string,
    strength: number,
    cropRect?: CropRect,
    expandPayload?: ExpandPayload,
  ) => {
    const sourceImageUrl = inpaintOriginalImage || imageUrl;
    if (!sourceImageUrl) return;

    let mutableMaskBase64 = maskBase64;
    let imageBase64: string;
    let fullWidth = inpaintDimensions?.width || targetWidth;
    let fullHeight = inpaintDimensions?.height || targetHeight;

    setIsInpainting(true);
    try {
      if (expandPayload) {
        pendingPasteBackRef.current = true;
        window.dispatchEvent(new CustomEvent('inpaint-generate', {
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
          },
        }));
        return;
      }

      const response = await fetch(sourceImageUrl);
      const blob = await response.blob();
      const reader = new FileReader();
      imageBase64 = await new Promise<string>((resolve, reject) => {
        reader.onload = () => resolve((reader.result as string).split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });

      let cropInfo: {
        cropRect: CropRect;
        sendRect?: CropRect;
        originalImageBase64: string;
        originalWidth: number;
        originalHeight: number;
      } | undefined;

      if (cropRect) {
        const fullImageBase64 = imageBase64;
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
          maskImg.src = `data:image/png;base64,${mutableMaskBase64}`;
        });
        const maskCropCanvas = document.createElement('canvas');
        maskCropCanvas.width = sendRect.width;
        maskCropCanvas.height = sendRect.height;
        const maskCropCtx = maskCropCanvas.getContext('2d')!;
        maskCropCtx.fillStyle = '#000000';
        maskCropCtx.fillRect(0, 0, sendRect.width, sendRect.height);
        maskCropCtx.drawImage(maskImg, -sendRect.x, -sendRect.y);
        mutableMaskBase64 = maskCropCanvas.toDataURL('image/png').split(',')[1];

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
      window.dispatchEvent(new CustomEvent('inpaint-generate', {
        detail: {
          imageBase64,
          maskBase64: mutableMaskBase64,
          strength,
          width: fullWidth,
          height: fullHeight,
          cropInfo,
        },
      }));
    } catch (error) {
      console.error('局部重绘失败:', error);
      setIsInpainting(false);
    }
  };

  useEffect(() => {
    const wasActive = wasGeneratingRef.current || wasQueuingRef.current;
    const isActive = isGenerating || isQueuing;

    if (isInpainting && wasActive && !isActive) {
      setIsInpainting(false);
      if (!pendingPasteBackRef.current) {
        resetInpaintSource();
      }
    }

    wasGeneratingRef.current = isGenerating;
    wasQueuingRef.current = isQueuing;
  }, [isGenerating, isQueuing, isInpainting]);

  useEffect(() => {
    const onDone = () => {
      pendingPasteBackRef.current = false;
      resetInpaintSource();
    };
    window.addEventListener('inpaint-pasteback-done', onDone);
    return () => window.removeEventListener('inpaint-pasteback-done', onDone);
  }, []);

  const handleCloseInpaint = () => {
    setIsInpaintMode(false);
    resetInpaintSource();
  };

  return {
    isInpaintMode,
    setIsInpaintMode,
    isInpainting,
    initialMask,
    inpaintOriginalImage,
    inpaintDimensions,
    openInpaintMode,
    handleInpaintGenerate,
    handleCloseInpaint,
  };
}
