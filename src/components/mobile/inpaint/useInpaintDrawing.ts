import { useCallback, useRef, useState, type Dispatch, type RefObject, type SetStateAction, type TouchEvent } from 'react';
import { calculateCropRect, type CropRect } from '../../../utils/maskCrop';

export type BrushShape = 'square' | 'circle';

interface UseInpaintDrawingArgs {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  maskCanvasRef: RefObject<HTMLCanvasElement | null>;
  imageWidth: number;
  imageHeight: number;
  baseScale: number;
  zoom: number;
  brushSize: number;
  brushShape: BrushShape;
  isEraser: boolean;
  isGenerating: boolean;
  isExpandMode: boolean;
  isCropMode: boolean;
  onZoomChange: Dispatch<SetStateAction<number>>;
  onPanChange: Dispatch<SetStateAction<{ x: number; y: number }>>;
}

export const useInpaintDrawing = ({
  canvasRef,
  maskCanvasRef,
  imageWidth,
  imageHeight,
  baseScale,
  zoom,
  brushSize,
  brushShape,
  isEraser,
  isGenerating,
  isExpandMode,
  isCropMode,
  onZoomChange,
  onPanChange,
}: UseInpaintDrawingArgs) => {
  const [isDrawing, setIsDrawing] = useState(false);
  const [history, setHistory] = useState<ImageData[]>([]);
  const [lastBrushPos, setLastBrushPos] = useState<{ x: number; y: number } | null>(null);
  const [cropPreview, setCropPreview] = useState<CropRect | null>(null);
  const [isPinching, setIsPinching] = useState(false);
  const lastPinchDistRef = useRef<number>(0);
  const lastPinchCenterRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const pendingDrawRef = useRef<{ x: number; y: number } | null>(null);
  const drawDelayMs = 80;

  const saveHistory = useCallback(() => {
    const maskCanvas = maskCanvasRef.current;
    if (!maskCanvas) return;
    const maskCtx = maskCanvas.getContext('2d');
    if (!maskCtx) return;
    const imageData = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
    setHistory((prev) => [...prev.slice(-20), imageData]);
  }, [maskCanvasRef]);

  const updateCropPreview = useCallback(() => {
    if (!isCropMode || !maskCanvasRef.current) {
      setCropPreview(null);
      return;
    }
    const maskCtx = maskCanvasRef.current.getContext('2d');
    if (!maskCtx) return;
    const maskData = maskCtx.getImageData(0, 0, imageWidth, imageHeight);
    const rect = calculateCropRect(maskData, imageWidth, imageHeight);
    setCropPreview(rect);
  }, [isCropMode, imageWidth, imageHeight, maskCanvasRef]);

  const handleUndo = useCallback(() => {
    if (history.length === 0) return;
    const maskCanvas = maskCanvasRef.current;
    if (!maskCanvas) return;
    const maskCtx = maskCanvas.getContext('2d');
    if (!maskCtx) return;
    const prevState = history[history.length - 1];
    maskCtx.putImageData(prevState, 0, 0);
    setHistory((prev) => prev.slice(0, -1));
    setTimeout(() => updateCropPreview(), 0);
  }, [history, maskCanvasRef, updateCropPreview]);

  const handleClear = useCallback(() => {
    const maskCanvas = maskCanvasRef.current;
    if (!maskCanvas) return;
    const maskCtx = maskCanvas.getContext('2d');
    if (!maskCtx) return;
    saveHistory();
    maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    setCropPreview(null);
  }, [maskCanvasRef, saveHistory]);

  const getCanvasCoords = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const rect = canvas.getBoundingClientRect();
      const x = (clientX - rect.left) / (baseScale * zoom);
      const y = (clientY - rect.top) / (baseScale * zoom);
      return { x, y };
    },
    [baseScale, zoom, canvasRef],
  );

  const drawBrush = useCallback(
    (x: number, y: number, erase: boolean = false) => {
      const maskCanvas = maskCanvasRef.current;
      if (!maskCanvas) return;
      const maskCtx = maskCanvas.getContext('2d');
      if (!maskCtx) return;
      const scaledBrushSize = brushSize / zoom;
      const halfSize = scaledBrushSize / 2;
      const actualHalfSize = brushShape === 'circle' ? Math.max(1, halfSize - 4) : halfSize;
      const actualScaledBrushSize = brushShape === 'circle' ? actualHalfSize * 2 : scaledBrushSize;

      if (erase) {
        if (brushShape === 'square') {
          maskCtx.clearRect(x - halfSize, y - halfSize, scaledBrushSize, scaledBrushSize);
        } else {
          maskCtx.save();
          maskCtx.beginPath();
          maskCtx.arc(x, y, actualHalfSize, 0, Math.PI * 2);
          maskCtx.clip();
          maskCtx.clearRect(x - actualHalfSize, y - actualHalfSize, actualScaledBrushSize, actualScaledBrushSize);
          maskCtx.restore();
        }
      } else {
        maskCtx.fillStyle = 'rgba(168, 85, 247, 1)';
        if (brushShape === 'square') {
          maskCtx.fillRect(x - halfSize, y - halfSize, scaledBrushSize, scaledBrushSize);
        } else {
          maskCtx.beginPath();
          maskCtx.arc(x, y, actualHalfSize, 0, Math.PI * 2);
          maskCtx.fill();
        }
      }
    },
    [brushSize, brushShape, zoom, maskCanvasRef],
  );

  const drawLine = useCallback(
    (x1: number, y1: number, x2: number, y2: number, erase: boolean = false) => {
      const dist = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
      const scaledBrushSize = brushSize / zoom;
      const steps = Math.max(1, Math.ceil(dist / (scaledBrushSize / 4)));
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = x1 + (x2 - x1) * t;
        const y = y1 + (y2 - y1) * t;
        drawBrush(x, y, erase);
      }
    },
    [brushSize, zoom, drawBrush],
  );

  const handleTouchStart = (e: TouchEvent<HTMLCanvasElement>) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      pendingDrawRef.current = null;
      setIsPinching(true);
      setIsDrawing(false);
      setLastBrushPos(null);
      const touch1 = e.touches[0];
      const touch2 = e.touches[1];
      lastPinchDistRef.current = Math.hypot(touch2.clientX - touch1.clientX, touch2.clientY - touch1.clientY);
      lastPinchCenterRef.current = {
        x: (touch1.clientX + touch2.clientX) / 2,
        y: (touch1.clientY + touch2.clientY) / 2,
      };
    } else if (e.touches.length === 1 && !isPinching) {
      if (isGenerating || isExpandMode) return;
      const touch = e.touches[0];
      const { x, y } = getCanvasCoords(touch.clientX, touch.clientY);
      pendingDrawRef.current = { x, y };

      setTimeout(() => {
        if (pendingDrawRef.current && !isPinching) {
          saveHistory();
          setIsDrawing(true);
          setLastBrushPos(pendingDrawRef.current);
          drawBrush(pendingDrawRef.current.x, pendingDrawRef.current.y, isEraser);
          pendingDrawRef.current = null;
        }
      }, drawDelayMs);
    }
  };

  const handleTouchMove = (e: TouchEvent<HTMLCanvasElement>) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      pendingDrawRef.current = null;
      setIsDrawing(false);

      if (!isPinching) {
        setIsPinching(true);
        const touch1 = e.touches[0];
        const touch2 = e.touches[1];
        lastPinchDistRef.current = Math.hypot(touch2.clientX - touch1.clientX, touch2.clientY - touch1.clientY);
        lastPinchCenterRef.current = {
          x: (touch1.clientX + touch2.clientX) / 2,
          y: (touch1.clientY + touch2.clientY) / 2,
        };
        return;
      }

      const touch1 = e.touches[0];
      const touch2 = e.touches[1];
      const dist = Math.hypot(touch2.clientX - touch1.clientX, touch2.clientY - touch1.clientY);
      const center = {
        x: (touch1.clientX + touch2.clientX) / 2,
        y: (touch1.clientY + touch2.clientY) / 2,
      };

      if (lastPinchDistRef.current > 0) {
        const scale = dist / lastPinchDistRef.current;
        onZoomChange((prev) => Math.min(Math.max(prev * scale, 0.5), 5));
      }

      const dx = center.x - lastPinchCenterRef.current.x;
      const dy = center.y - lastPinchCenterRef.current.y;
      onPanChange((prev) => ({ x: prev.x + dx, y: prev.y + dy }));

      lastPinchDistRef.current = dist;
      lastPinchCenterRef.current = center;
    } else if (e.touches.length === 1 && !isPinching) {
      const touch = e.touches[0];
      const { x, y } = getCanvasCoords(touch.clientX, touch.clientY);

      if (pendingDrawRef.current) {
        pendingDrawRef.current = { x, y };
      } else if (isDrawing && lastBrushPos) {
        drawLine(lastBrushPos.x, lastBrushPos.y, x, y, isEraser);
        setLastBrushPos({ x, y });
      }
    }
  };

  const handleTouchEnd = () => {
    pendingDrawRef.current = null;
    setIsDrawing(false);
    setLastBrushPos(null);
    setIsPinching(false);
    lastPinchDistRef.current = 0;
    updateCropPreview();
  };

  return {
    historyLength: history.length,
    setHistory,
    cropPreview,
    setCropPreview,
    updateCropPreview,
    handleUndo,
    handleClear,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
  };
};
