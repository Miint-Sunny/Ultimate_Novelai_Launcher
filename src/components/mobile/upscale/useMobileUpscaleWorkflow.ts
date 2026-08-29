import { useCallback, useEffect, useMemo, useState } from 'react';
import { calculateCostFromUI } from '../../../services/costCalculator';
import { getCachedIsOpus, isOpusUsageExhausted } from '../../../services/novelai';
import {
  isModelLoaded,
  UPSCALE_15X_MAX_PIXELS,
  upscaleFromCanvas,
  upscaleImage,
  upscaleViaImg2Img,
  type UpscaleMethod,
  type UpscaleProgress,
} from '../../../services/upscaleService';
import { resolveEnhanceModel } from '../../../services/novelai';
import { getAISettings } from '../../../services/localLibrary';
import {
  MAGNITUDE_PRESETS,
  enhanceScaleOptions,
  enhanceTargetSize,
  resolveEnhanceScaleChoice,
  type EnhanceMode,
  type EnhanceScaleId,
} from '../../../services/naiEnhanceScale';
import { loadImageToCanvas } from './loadImageToCanvas';

interface UseMobileUpscaleWorkflowOptions {
  isOpen: boolean;
  imageUrl: string;
  onComplete: (resultBlob: Blob, scale: number) => void;
  onClose: () => void;
}

const imageUrlToBlob = (imageUrl: string) => new Promise<Blob>((resolve, reject) => {
  const img = new Image();
  const timeoutId = setTimeout(() => reject(new Error('图片加载超时')), 15000);

  img.onload = () => {
    clearTimeout(timeoutId);
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      reject(new Error('无法创建 Canvas'));
      return;
    }
    ctx.drawImage(img, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('无法转换为 Blob'));
      },
      'image/png',
      1.0
    );
  };

  img.onerror = () => {
    clearTimeout(timeoutId);
    reject(new Error('图片加载失败'));
  };

  img.src = imageUrl;
});

const imageUrlToLocalCanvas = async (
  imageUrl: string,
  setProgress: (progress: UpscaleProgress) => void
) => {
  const urlType = imageUrl.startsWith('blob:') ? 'blob' :
    imageUrl.startsWith('data:') ? 'data' :
      imageUrl.startsWith('http') ? 'http' : 'other';
  setProgress({ stage: 'loading', progress: 2, message: `[1] URL: ${urlType}, 长度: ${imageUrl.length}` });

  let canvas: HTMLCanvasElement | null = null;

  if (imageUrl.startsWith('blob:') || imageUrl.startsWith('http')) {
    setProgress({ stage: 'loading', progress: 3, message: '[2] Fetch 图片...' });

    try {
      const response = await fetch(imageUrl, { mode: 'cors' });
      if (!response.ok) {
        throw new Error(`Fetch 失败: ${response.status}`);
      }

      const blob = await response.blob();
      setProgress({ stage: 'loading', progress: 4, message: `[3] Blob: ${(blob.size / 1024).toFixed(0)}KB` });

      if (typeof createImageBitmap === 'function') {
        try {
          setProgress({ stage: 'loading', progress: 5, message: '[4] createImageBitmap...' });
          const bitmap = await createImageBitmap(blob);
          setProgress({ stage: 'loading', progress: 6, message: `[5] Bitmap: ${bitmap.width}x${bitmap.height}` });

          canvas = document.createElement('canvas');
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('无法创建 Canvas Context');
          ctx.drawImage(bitmap, 0, 0);
          bitmap.close();
        } catch (error) {
          console.warn('createImageBitmap failed:', error);
        }
      }

      if (!canvas) {
        canvas = await loadImageToCanvas(blob, setProgress);
      }
    } catch (error) {
      console.warn('Fetch failed:', error);
    }
  }

  if (!canvas) {
    setProgress({ stage: 'loading', progress: 4, message: '[3b] 使用 Image 加载 URL...' });
    canvas = await loadImageToCanvas(imageUrl, setProgress);
  }

  return canvas;
};

export function useMobileUpscaleWorkflow({
  isOpen,
  imageUrl,
  onComplete,
  onClose,
}: UseMobileUpscaleWorkflowOptions) {
  // 与桌面端同一套形状:方式与倍率分开存,不再用哨兵 0 表示 Max。
  const [mode, setMode] = useState<EnhanceMode>('upscale');
  const [redrawScale, setRedrawScale] = useState<EnhanceScaleId>('x1.5');
  const [upscaleScale, setUpscaleScale] = useState<2 | 4>(4);
  const [method, setMethod] = useState<UpscaleMethod>('local');
  const [magnitude, setMagnitude] = useState<number>(3);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState<UpscaleProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    if (isOpen && imageUrl) {
      const img = new Image();
      img.src = imageUrl;
      img.onload = () => setImageSize({ width: img.naturalWidth, height: img.naturalHeight });
    }
  }, [imageUrl, isOpen]);

  useEffect(() => {
    if (!isOpen) {
      setProgress(null);
      setError(null);
    }
  }, [isOpen]);

  const enhanceModel = resolveEnhanceModel(getAISettings().model);
  const isRedraw = mode === 'redraw';
  // 档位完全由官方筛选规则给出。⚠ 可能是空的(源图大到连 1× 都越上限)。
  const redrawOptions = imageSize
    ? enhanceScaleOptions(imageSize.width, imageSize.height, enhanceModel)
    : [];
  const redrawUnavailable = imageSize !== null && redrawOptions.length === 0;
  const activeRedrawScale = resolveEnhanceScaleChoice(redrawOptions, redrawScale);

  const redrawSize = imageSize
    ? enhanceTargetSize(imageSize.width, imageSize.height, activeRedrawScale)
    : null;
  const resultWidth = imageSize
    ? (isRedraw ? (redrawSize?.width ?? 0) : Math.round(imageSize.width * upscaleScale))
    : 0;
  const resultHeight = imageSize
    ? (isRedraw ? (redrawSize?.height ?? 0) : Math.round(imageSize.height * upscaleScale))
    : 0;
  const modelLoaded = isModelLoaded();
  const isOverLimit = isRedraw && imageSize !== null && resultWidth * resultHeight > UPSCALE_15X_MAX_PIXELS;

  const estimatedRedrawCost = useMemo(() => {
    if (!isRedraw || !imageSize) return null;
    const preset = MAGNITUDE_PRESETS[magnitude];
    const result = calculateCostFromUI({
    // V5 体力条耗尽后 NAI 静默改扣 Anlas；不带上这个标志，界面会一直显示「免费」
    opusUsageExhausted: isOpusUsageExhausted(),
      width: resultWidth,
      height: resultHeight,
      steps: 28,
      modelId: enhanceModel,
      sampler: 'Euler Ancestral',
      isOpus: getCachedIsOpus(),
      img2imgStrength: preset.strength,
    });
    return result.total;
  }, [enhanceModel, imageSize, isRedraw, magnitude, resultHeight, resultWidth]);

  const handleUpscale = useCallback(async () => {
    if (isOverLimit) {
      setError(`重绘目标尺寸 ${resultWidth}×${resultHeight} 超过上限（约 1024×3072），请先缩小原图。`);
      return;
    }

    setIsProcessing(true);
    setError(null);
    setProgress({ stage: 'loading', progress: 0, message: '准备中...' });

    try {
      let resultBlob: Blob;

      if (isRedraw) {
        setProgress({ stage: 'loading', progress: 5, message: '准备图片...' });
        const imageBlob = await imageUrlToBlob(imageUrl);
        const preset = MAGNITUDE_PRESETS[magnitude];
        resultBlob = await upscaleViaImg2Img(
          imageBlob,
          preset.strength,
          preset.noise,
          setProgress,
          activeRedrawScale
        );
      } else if (method === 'local') {
        const canvas = await imageUrlToLocalCanvas(imageUrl, setProgress);
        setProgress({ stage: 'loading', progress: 10, message: '[7] 开始超分处理...' });
        resultBlob = await upscaleFromCanvas(canvas, upscaleScale, setProgress);
      } else {
        setProgress({ stage: 'loading', progress: 5, message: '准备图片...' });
        const imageBlob = await imageUrlToBlob(imageUrl);
        setProgress({ stage: 'loading', progress: 10, message: '开始超分处理...' });
        resultBlob = await upscaleImage(imageBlob, upscaleScale, method, setProgress);
      }

      setProgress({ stage: 'done', progress: 100, message: '超分完成！' });

      // 下游要的是**实际达成的倍率**。重绘没有现成倍数可报,按结果宽 ÷ 原图宽算,
      // 兜底 1 —— 不能报 0。
      const achievedScale = isRedraw
        ? (imageSize ? Math.max(1, Math.round(resultWidth / imageSize.width)) : 1)
        : upscaleScale;

      setTimeout(() => {
        setIsProcessing(false);
        onComplete(resultBlob, achievedScale);
        onClose();
      }, 500);
    } catch (err) {
      console.error('超分失败:', err);
      setError(err instanceof Error ? err.message : '超分失败');
      setProgress(null);
      setIsProcessing(false);
    }
  }, [activeRedrawScale, imageSize, imageUrl, isOverLimit, isRedraw, magnitude, method, onClose, onComplete, resultHeight, resultWidth, upscaleScale]);

  return {
    mode,
    setMode,
    redrawScale,
    setRedrawScale,
    upscaleScale,
    setUpscaleScale,
    redrawOptions,
    activeRedrawScale,
    redrawUnavailable,
    method,
    setMethod,
    magnitude,
    setMagnitude,
    isProcessing,
    progress,
    error,
    imageSize,
    resultWidth,
    resultHeight,
    modelLoaded,
    isOverLimit,
    estimatedRedrawCost,
    handleUpscale,
    isRedraw,
    enhanceModel,
  };
}
