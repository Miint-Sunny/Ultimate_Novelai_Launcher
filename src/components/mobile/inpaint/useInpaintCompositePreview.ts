import { useEffect, useState, type RefObject } from 'react';

interface GenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface UseInpaintCompositePreviewArgs {
  previewUrl?: string | null;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  maskCanvasRef: RefObject<HTMLCanvasElement | null>;
  imageWidth: number;
  imageHeight: number;
  activeGenRectRef: RefObject<GenRect | null>;
}

export const useInpaintCompositePreview = ({
  previewUrl,
  canvasRef,
  maskCanvasRef,
  imageWidth,
  imageHeight,
  activeGenRectRef,
}: UseInpaintCompositePreviewArgs) => {
  const [compositeUrl, setCompositeUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!previewUrl || !canvasRef.current || !maskCanvasRef.current) {
      setCompositeUrl(null);
      return;
    }
    const canvas = canvasRef.current;
    const maskCanvas = maskCanvasRef.current;
    const w = imageWidth;
    const h = imageHeight;
    const genRect = activeGenRectRef.current;

    const compositeCanvas = document.createElement('canvas');
    compositeCanvas.width = w;
    compositeCanvas.height = h;
    const compositeCtx = compositeCanvas.getContext('2d');
    if (!compositeCtx) return;

    const previewImg = new Image();
    previewImg.crossOrigin = 'anonymous';
    previewImg.onload = () => {
      compositeCtx.drawImage(canvas, 0, 0);
      const originalData = compositeCtx.getImageData(0, 0, w, h);

      if (genRect) {
        compositeCtx.drawImage(previewImg, genRect.x, genRect.y, genRect.width, genRect.height);
      } else {
        compositeCtx.drawImage(previewImg, 0, 0, w, h);
      }
      const previewData = compositeCtx.getImageData(0, 0, w, h);

      const maskCtx = maskCanvas.getContext('2d');
      if (!maskCtx) return;
      const maskData = maskCtx.getImageData(0, 0, w, h);

      for (let i = 0; i < maskData.data.length; i += 4) {
        const hasMask = maskData.data[i] > 0 || maskData.data[i + 1] > 0 || maskData.data[i + 2] > 0 || maskData.data[i + 3] > 0;
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
    return () => setCompositeUrl(null);
  }, [previewUrl, imageWidth, imageHeight, canvasRef, maskCanvasRef, activeGenRectRef]);

  return compositeUrl;
};
