import { useCallback, useEffect, useRef } from 'react';
import type { CropRect } from '../../../utils/maskCrop';

// 画布底色取自设计 token --nai-dark(src/index.css);canvas 无法消费 Tailwind 类,运行时读 CSS 变量
const naiDarkCanvasFill = (): string => {
  const triplet = getComputedStyle(document.documentElement).getPropertyValue('--nai-dark').trim();
  return triplet ? `rgb(${triplet.split(/\s+/).join(', ')})` : 'rgb(7, 8, 9)';
};

interface UseInpaintCanvasLoaderArgs {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  maskCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  imageUrl: string;
  imageWidth: number;
  imageHeight: number;
  baseScale: number;
  initialMask?: string | null;
  onResetExpand: () => void;
  onCropPreviewChange: (rect: CropRect | null) => void;
  onHistoryChange: React.Dispatch<React.SetStateAction<ImageData[]>>;
  onCanvasReadyChange: (ready: boolean) => void;
}

export const useInpaintCanvasLoader = ({
  canvasRef,
  maskCanvasRef,
  imageUrl,
  imageWidth,
  imageHeight,
  baseScale,
  initialMask,
  onResetExpand,
  onCropPreviewChange,
  onHistoryChange,
  onCanvasReadyChange,
}: UseInpaintCanvasLoaderArgs) => {
  const isFirstLoadRef = useRef(true);
  const loadedImageRef = useRef<HTMLImageElement | null>(null);
  const loadedImageUrlRef = useRef<string | null>(null);

  const drawImageToCanvas = useCallback((
    ctx: CanvasRenderingContext2D,
    maskCtx: CanvasRenderingContext2D,
    img: HTMLImageElement,
    totalWidth: number,
    totalHeight: number,
    savedMaskData: ImageData | null,
  ) => {
    ctx.fillStyle = naiDarkCanvasFill();
    ctx.fillRect(0, 0, totalWidth, totalHeight);
    ctx.drawImage(img, 0, 0, imageWidth, imageHeight);

    if (savedMaskData) {
      maskCtx.putImageData(savedMaskData, 0, 0);
    } else {
      maskCtx.clearRect(0, 0, totalWidth, totalHeight);

      if (isFirstLoadRef.current) {
        onHistoryChange([]);
        isFirstLoadRef.current = false;

        if (initialMask) {
          const maskImg = new Image();
          maskImg.onload = () => {
            maskCtx.clearRect(0, 0, totalWidth, totalHeight);
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = totalWidth;
            tempCanvas.height = totalHeight;
            const tempCtx = tempCanvas.getContext('2d');
            if (tempCtx) {
              tempCtx.drawImage(maskImg, 0, 0, totalWidth, totalHeight);
              const maskData = tempCtx.getImageData(0, 0, totalWidth, totalHeight);
              const data = maskData.data;
              for (let i = 0; i < data.length; i += 4) {
                if (data[i] > 128) {
                  data[i] = 168;
                  data[i + 1] = 85;
                  data[i + 2] = 247;
                  data[i + 3] = 255;
                } else {
                  data[i + 3] = 0;
                }
              }
              maskCtx.putImageData(maskData, 0, 0);
            }
          };
          maskImg.src = `data:image/png;base64,${initialMask}`;
        }
      }
    }
    onCanvasReadyChange(true);
  }, [imageWidth, imageHeight, initialMask, onCanvasReadyChange, onHistoryChange]);

  useEffect(() => {
    if (!canvasRef.current || !maskCanvasRef.current || baseScale === 0) return;
    const canvas = canvasRef.current;
    const maskCanvas = maskCanvasRef.current;
    const ctx = canvas.getContext('2d');
    const maskCtx = maskCanvas.getContext('2d');
    if (!ctx || !maskCtx) return;

    const totalWidth = imageWidth;
    const totalHeight = imageHeight;
    const sizeChanged = canvas.width !== totalWidth || canvas.height !== totalHeight;

    let savedMaskData: ImageData | null = null;
    if (!isFirstLoadRef.current && !sizeChanged && maskCanvas.width > 0 && maskCanvas.height > 0) {
      savedMaskData = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
    }
    if (sizeChanged) {
      onHistoryChange([]);
      onResetExpand();
      onCropPreviewChange(null);
    }

    canvas.width = totalWidth;
    canvas.height = totalHeight;
    maskCanvas.width = totalWidth;
    maskCanvas.height = totalHeight;

    if (loadedImageRef.current && loadedImageUrlRef.current === imageUrl) {
      drawImageToCanvas(ctx, maskCtx, loadedImageRef.current, totalWidth, totalHeight, savedMaskData);
      return;
    }

    ctx.fillStyle = naiDarkCanvasFill();
    ctx.fillRect(0, 0, totalWidth, totalHeight);

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      loadedImageRef.current = img;
      loadedImageUrlRef.current = imageUrl;
      drawImageToCanvas(ctx, maskCtx, img, totalWidth, totalHeight, savedMaskData);
    };
    img.src = imageUrl;
  }, [
    canvasRef,
    maskCanvasRef,
    imageUrl,
    imageWidth,
    imageHeight,
    baseScale,
    drawImageToCanvas,
    onResetExpand,
    onCropPreviewChange,
    onHistoryChange,
  ]);

  return { loadedImageRef };
};
