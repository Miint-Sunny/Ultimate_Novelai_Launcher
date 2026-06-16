import { useCallback, useState, type Dispatch, type PointerEvent, type RefObject, type SetStateAction, type WheelEvent } from 'react';
import { calculateCropRect, type CropRect } from '../../utils/maskCrop';

export type BrushShape = 'square' | 'circle';

interface Point {
  x: number;
  y: number;
}

interface UseInpaintBrushParams {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  maskCanvasRef: RefObject<HTMLCanvasElement | null>;
  containerRef: RefObject<HTMLDivElement | null>;
  baseScale: number;
  zoom: number;
  setZoom: Dispatch<SetStateAction<number>>;
  pan: Point;
  setPan: Dispatch<SetStateAction<Point>>;
  isPanning: boolean;
  setIsPanning: Dispatch<SetStateAction<boolean>>;
  panStart: Point;
  setPanStart: Dispatch<SetStateAction<Point>>;
  spacePressed: boolean;
  isDraggingCropRef: RefObject<boolean>;
  isGenerating: boolean;
  isExpandMode: boolean;
  imageWidth: number;
  imageHeight: number;
  isCropMode: boolean;
  cropManuallyAdjustedRef: RefObject<boolean>;
  setCropPreview: Dispatch<SetStateAction<CropRect | null>>;
}

export function useInpaintBrush({
  canvasRef,
  maskCanvasRef,
  containerRef,
  baseScale,
  zoom,
  setZoom,
  pan,
  setPan,
  isPanning,
  setIsPanning,
  panStart,
  setPanStart,
  spacePressed,
  isDraggingCropRef,
  isGenerating,
  isExpandMode,
  imageWidth,
  imageHeight,
  isCropMode,
  cropManuallyAdjustedRef,
  setCropPreview,
}: UseInpaintBrushParams) {
  const [isDrawing, setIsDrawing] = useState(false);
  const [brushSize, setBrushSizeState] = useState(() => {
    const saved = localStorage.getItem('inpaint_brush_size');
    return saved ? Number(saved) : 50;
  });
  const [brushShape, setBrushShape] = useState<BrushShape>('square');
  const [isEraser, setIsEraser] = useState(false);
  const [history, setHistory] = useState<ImageData[]>([]);
  const [lastBrushPos, setLastBrushPos] = useState<Point | null>(null);
  const [cursorPos, setCursorPos] = useState<Point | null>(null);
  const [showCursor, setShowCursor] = useState(false);

  const setBrushSize = (size: number) => {
    setBrushSizeState(size);
    localStorage.setItem('inpaint_brush_size', String(size));
  };

  const saveHistory = useCallback(() => {
    const maskCanvas = maskCanvasRef.current;
    if (!maskCanvas) return;
    const maskCtx = maskCanvas.getContext('2d');
    if (!maskCtx) return;

    const imageData = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
    setHistory(prev => [...prev.slice(-20), imageData]);
  }, [maskCanvasRef]);

  const updateCropPreview = useCallback(() => {
    if (!isCropMode || !maskCanvasRef.current) {
      setCropPreview(null);
      return;
    }
    if (cropManuallyAdjustedRef.current) return;
    const maskCtx = maskCanvasRef.current.getContext('2d');
    if (!maskCtx) return;
    const maskData = maskCtx.getImageData(0, 0, imageWidth, imageHeight);
    const rect = calculateCropRect(maskData, imageWidth, imageHeight);
    setCropPreview(rect);
  }, [cropManuallyAdjustedRef, imageHeight, imageWidth, isCropMode, maskCanvasRef, setCropPreview]);

  const handleUndo = useCallback(() => {
    if (history.length === 0) return;

    const maskCanvas = maskCanvasRef.current;
    if (!maskCanvas) return;
    const maskCtx = maskCanvas.getContext('2d');
    if (!maskCtx) return;

    const prevState = history[history.length - 1];
    maskCtx.putImageData(prevState, 0, 0);
    setHistory(prev => prev.slice(0, -1));
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
  }, [maskCanvasRef, saveHistory, setCropPreview]);

  const getCanvasCoords = useCallback(
    (event: PointerEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };

      const rect = canvas.getBoundingClientRect();
      const x = (event.clientX - rect.left) / (baseScale * zoom);
      const y = (event.clientY - rect.top) / (baseScale * zoom);

      return { x, y };
    },
    [baseScale, canvasRef, zoom]
  );

  const drawBrush = useCallback(
    (x: number, y: number, erase: boolean = false) => {
      const maskCanvas = maskCanvasRef.current;
      if (!maskCanvas) return;
      const maskCtx = maskCanvas.getContext('2d');
      if (!maskCtx) return;

      const scaledBrushSize = brushSize;
      const halfSize = scaledBrushSize / 2;

      if (brushShape === 'square') {
        const gridSize = 8;
        const gridCount = Math.max(1, Math.round(brushSize / gridSize));
        const totalSize = gridCount * gridSize;
        const halfGrids = Math.floor(gridCount / 2);
        const centerCellX = Math.floor(x / gridSize);
        const centerCellY = Math.floor(y / gridSize);
        const gridMinX = (centerCellX - halfGrids) * gridSize;
        const gridMinY = (centerCellY - halfGrids) * gridSize;

        if (erase) {
          maskCtx.clearRect(gridMinX, gridMinY, totalSize, totalSize);
        } else {
          maskCtx.fillStyle = 'rgba(168, 85, 247, 1)';
          maskCtx.fillRect(gridMinX, gridMinY, totalSize, totalSize);
        }
      } else {
        const actualHalfSize = Math.max(1, halfSize - 4);
        const actualSize = actualHalfSize * 2;

        if (erase) {
          maskCtx.save();
          maskCtx.beginPath();
          maskCtx.arc(x, y, actualHalfSize, 0, Math.PI * 2);
          maskCtx.clip();
          maskCtx.clearRect(x - actualHalfSize, y - actualHalfSize, actualSize, actualSize);
          maskCtx.restore();
        } else {
          maskCtx.fillStyle = 'rgba(168, 85, 247, 1)';
          maskCtx.beginPath();
          maskCtx.arc(x, y, actualHalfSize, 0, Math.PI * 2);
          maskCtx.fill();
        }
      }
    },
    [brushShape, brushSize, maskCanvasRef]
  );

  const drawLine = useCallback(
    (x1: number, y1: number, x2: number, y2: number, erase: boolean = false) => {
      const dist = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
      const stepSize = brushShape === 'square' ? 4 : brushSize / 4;
      const steps = Math.max(1, Math.ceil(dist / stepSize));

      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = x1 + (x2 - x1) * t;
        const y = y1 + (y2 - y1) * t;
        drawBrush(x, y, erase);
      }
    },
    [brushShape, brushSize, drawBrush]
  );

  const handleMouseDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (isDraggingCropRef.current) return;
    if (event.button === 1 || spacePressed) {
      event.preventDefault();
      setIsPanning(true);
      setPanStart({ x: event.clientX - pan.x, y: event.clientY - pan.y });
      (event.target as HTMLCanvasElement).setPointerCapture(event.pointerId);
      return;
    }

    if (isGenerating || isExpandMode) return;

    if (event.button === 0) {
      const { x, y } = getCanvasCoords(event);
      saveHistory();
      setIsDrawing(true);
      setLastBrushPos({ x, y });
      drawBrush(x, y, isEraser);
      (event.target as HTMLCanvasElement).setPointerCapture(event.pointerId);
    }
  };

  const handleMouseMove = (event: PointerEvent<HTMLCanvasElement>) => {
    setCursorPos({ x: event.clientX, y: event.clientY });

    if (isPanning) {
      setPan({
        x: event.clientX - panStart.x,
        y: event.clientY - panStart.y,
      });
      return;
    }

    if (!isDrawing || !lastBrushPos) return;
    const { x, y } = getCanvasCoords(event);
    drawLine(lastBrushPos.x, lastBrushPos.y, x, y, isEraser);
    setLastBrushPos({ x, y });
  };

  const handleMouseEnter = () => {
    setShowCursor(true);
  };

  const handleMouseLeaveCanvas = () => {
    setShowCursor(false);
  };

  const handleMouseUp = (event: PointerEvent<HTMLCanvasElement>) => {
    if (isDraggingCropRef.current) return;
    if (event.button === 1) {
      setIsPanning(false);
      (event.target as HTMLCanvasElement).releasePointerCapture(event.pointerId);
      return;
    }
    setIsDrawing(false);
    setLastBrushPos(null);
    setIsPanning(false);
    try {
      (event.target as HTMLCanvasElement).releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be released.
    }
    updateCropPreview();
  };

  const handleWheel = useCallback((event: WheelEvent) => {
    event.preventDefault();
    const delta = event.deltaY > 0 ? 0.9 : 1.1;
    const newZoom = Math.min(Math.max(zoom * delta, 0.5), 5);
    if (newZoom === zoom) return;

    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const cursorRelX = event.clientX - centerX;
      const cursorRelY = event.clientY - centerY;
      const scaleFactor = 1 - newZoom / zoom;
      setPan(prev => ({
        x: prev.x + (cursorRelX - prev.x) * scaleFactor,
        y: prev.y + (cursorRelY - prev.y) * scaleFactor,
      }));
    }

    setZoom(newZoom);
  }, [containerRef, setPan, setZoom, zoom]);

  return {
    brushSize,
    setBrushSize,
    brushShape,
    setBrushShape,
    isEraser,
    setIsEraser,
    history,
    setHistory,
    cursorPos,
    showCursor,
    saveHistory,
    updateCropPreview,
    handleUndo,
    handleClear,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleMouseEnter,
    handleMouseLeaveCanvas,
    handleWheel,
  };
}
