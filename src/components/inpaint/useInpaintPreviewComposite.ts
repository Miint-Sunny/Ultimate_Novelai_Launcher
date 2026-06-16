import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from 'react';

interface GenerationRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface UseInpaintPreviewCompositeParams {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  maskCanvasRef: RefObject<HTMLCanvasElement | null>;
  previewUrl?: string | null;
  imageWidth: number;
  imageHeight: number;
  isExpandGeneratingRef: RefObject<boolean>;
}

interface UseInpaintPreviewCompositeResult {
  compositeUrl: string | null;
  lastPreviewUrl: string | null;
  setLastPreviewUrl: Dispatch<SetStateAction<string | null>>;
  activeGenRectRef: MutableRefObject<GenerationRect | null>;
}

export function useInpaintPreviewComposite({
  canvasRef,
  maskCanvasRef,
  previewUrl,
  imageWidth,
  imageHeight,
  isExpandGeneratingRef,
}: UseInpaintPreviewCompositeParams): UseInpaintPreviewCompositeResult {
  const [compositeUrl, setCompositeUrl] = useState<string | null>(null);
  const [lastPreviewUrl, setLastPreviewUrl] = useState<string | null>(null);
  const activeGenRectRef = useRef<GenerationRect | null>(null);
  const prevPreviewUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (prevPreviewUrlRef.current && !previewUrl) {
      if (isExpandGeneratingRef.current) {
        setLastPreviewUrl(prevPreviewUrlRef.current);
      } else if (compositeUrl) {
        setLastPreviewUrl(compositeUrl);
      }
    }
    prevPreviewUrlRef.current = previewUrl ?? null;
  }, [compositeUrl, isExpandGeneratingRef, previewUrl]);

  useEffect(() => {
    if (!previewUrl || !canvasRef.current || !maskCanvasRef.current) {
      setCompositeUrl(null);
      return;
    }

    const canvas = canvasRef.current;
    const maskCanvas = maskCanvasRef.current;
    const width = imageWidth;
    const height = imageHeight;
    const genRect = activeGenRectRef.current;

    const compositeCanvas = document.createElement('canvas');
    compositeCanvas.width = width;
    compositeCanvas.height = height;
    const compositeCtx = compositeCanvas.getContext('2d');
    if (!compositeCtx) return;

    const previewImg = new Image();
    previewImg.crossOrigin = 'anonymous';
    previewImg.onload = () => {
      compositeCtx.drawImage(canvas, 0, 0);
      const originalData = compositeCtx.getImageData(0, 0, width, height);

      if (genRect) {
        compositeCtx.drawImage(previewImg, genRect.x, genRect.y, genRect.width, genRect.height);
      } else {
        compositeCtx.drawImage(previewImg, 0, 0, width, height);
      }
      const previewData = compositeCtx.getImageData(0, 0, width, height);

      const maskCtx = maskCanvas.getContext('2d');
      if (!maskCtx) return;
      const maskData = maskCtx.getImageData(0, 0, width, height);

      for (let i = 0; i < maskData.data.length; i += 4) {
        const hasMask = maskData.data[i] > 0
          || maskData.data[i + 1] > 0
          || maskData.data[i + 2] > 0
          || maskData.data[i + 3] > 0;
        if (!hasMask) {
          previewData.data[i] = originalData.data[i];
          previewData.data[i + 1] = originalData.data[i + 1];
          previewData.data[i + 2] = originalData.data[i + 2];
          previewData.data[i + 3] = originalData.data[i + 3];
        }
      }
      compositeCtx.putImageData(previewData, 0, 0);
      setCompositeUrl(compositeCanvas.toDataURL('image/png'));
    };
    previewImg.src = previewUrl;

    return () => {
      setCompositeUrl(null);
    };
  }, [canvasRef, imageHeight, imageWidth, maskCanvasRef, previewUrl]);

  return {
    compositeUrl,
    lastPreviewUrl,
    setLastPreviewUrl,
    activeGenRectRef,
  };
}
