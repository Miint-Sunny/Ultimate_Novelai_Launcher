import { useCallback, useEffect, useRef, useState, type Dispatch, type PointerEvent, type RefObject, type SetStateAction, type WheelEvent } from 'react';
import { calculateCropRect, type CropRect } from '../../utils/maskCrop';

/** 方 / 圆 / 软圆,照官方画布的三种笔形;软圆 = 径向渐变的边,导出时按官方阈值(alpha > 155)二值化。 */
export type BrushShape = 'square' | 'circle' | 'soft';
/** 笔刷 / 套索:套索是拖一圈闭合后整块填充(橡皮模式下整块擦除)。 */
export type MaskTool = 'brush' | 'lasso';

export const DEFAULT_MASK_COLOR = '#a855f7';
export const MIN_BRUSH_SIZE = 5;
export const MAX_BRUSH_SIZE = 200;

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
  /** 自动裁切框在遮罩外接框外留的上下文内边距(原图像素)。 */
  cropContextPadding?: number;
  /** 遮罩的显示颜色(只影响画布上的颜色,导出按 alpha 二值化)。 */
  maskColor?: string;
  /** 一笔画完 / 撤销 / 重做 / 清空 / 套索填充之后回调,给描边等装饰层刷新用。 */
  onMaskChanged?: () => void;
}

const clampBrushSize = (size: number) => Math.min(MAX_BRUSH_SIZE, Math.max(MIN_BRUSH_SIZE, Math.round(size)));

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
  cropContextPadding,
  maskColor = DEFAULT_MASK_COLOR,
  onMaskChanged,
}: UseInpaintBrushParams) {
  const [isDrawing, setIsDrawing] = useState(false);
  const [brushSize, setBrushSizeState] = useState(() => {
    const saved = localStorage.getItem('inpaint_brush_size');
    return saved ? clampBrushSize(Number(saved)) : 50;
  });
  const [brushShape, setBrushShapeState] = useState<BrushShape>(() => {
    const saved = localStorage.getItem('inpaint_brush_shape');
    return saved === 'circle' || saved === 'soft' || saved === 'square' ? saved : 'square';
  });
  const [tool, setTool] = useState<MaskTool>('brush');
  const [isEraser, setIsEraser] = useState(false);
  const [history, setHistory] = useState<ImageData[]>([]);
  const [redoStack, setRedoStack] = useState<ImageData[]>([]);
  const [lastBrushPos, setLastBrushPos] = useState<Point | null>(null);
  const [cursorPos, setCursorPos] = useState<Point | null>(null);
  const [showCursor, setShowCursor] = useState(false);
  /** 正在拖的套索(原图坐标);松手后闭合填充。 */
  const [lassoPoints, setLassoPoints] = useState<Point[]>([]);
  const lassoRef = useRef<Point[]>([]);

  const changedRef = useRef(onMaskChanged);
  useEffect(() => { changedRef.current = onMaskChanged; }, [onMaskChanged]);
  const notifyChanged = useCallback(() => { changedRef.current?.(); }, []);

  const setBrushSize = (size: number) => {
    const next = clampBrushSize(size);
    setBrushSizeState(next);
    localStorage.setItem('inpaint_brush_size', String(next));
  };
  const adjustBrushSize = useCallback((delta: number) => {
    setBrushSizeState((prev) => {
      const next = clampBrushSize(prev + delta);
      localStorage.setItem('inpaint_brush_size', String(next));
      return next;
    });
  }, []);
  const setBrushShape = (shape: BrushShape) => {
    setBrushShapeState(shape);
    localStorage.setItem('inpaint_brush_shape', shape);
  };

  const saveHistory = useCallback(() => {
    const maskCanvas = maskCanvasRef.current;
    if (!maskCanvas) return;
    const maskCtx = maskCanvas.getContext('2d');
    if (!maskCtx) return;

    const imageData = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
    setHistory(prev => [...prev.slice(-20), imageData]);
    // 新的一笔之后,之前撤销掉的分支就作废了
    setRedoStack([]);
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
    const rect = calculateCropRect(maskData, imageWidth, imageHeight, cropContextPadding);
    setCropPreview(rect);
  }, [cropContextPadding, cropManuallyAdjustedRef, imageHeight, imageWidth, isCropMode, maskCanvasRef, setCropPreview]);

  const handleUndo = useCallback(() => {
    if (history.length === 0) return;

    const maskCanvas = maskCanvasRef.current;
    if (!maskCanvas) return;
    const maskCtx = maskCanvas.getContext('2d');
    if (!maskCtx) return;

    const current = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
    const prevState = history[history.length - 1];
    maskCtx.putImageData(prevState, 0, 0);
    setHistory(prev => prev.slice(0, -1));
    setRedoStack(prev => [...prev.slice(-20), current]);
    setTimeout(() => { updateCropPreview(); notifyChanged(); }, 0);
  }, [history, maskCanvasRef, notifyChanged, updateCropPreview]);

  const handleRedo = useCallback(() => {
    if (redoStack.length === 0) return;

    const maskCanvas = maskCanvasRef.current;
    if (!maskCanvas) return;
    const maskCtx = maskCanvas.getContext('2d');
    if (!maskCtx) return;

    const current = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
    const nextState = redoStack[redoStack.length - 1];
    maskCtx.putImageData(nextState, 0, 0);
    setRedoStack(prev => prev.slice(0, -1));
    setHistory(prev => [...prev.slice(-20), current]);
    setTimeout(() => { updateCropPreview(); notifyChanged(); }, 0);
  }, [maskCanvasRef, notifyChanged, redoStack, updateCropPreview]);

  const handleClear = useCallback(() => {
    const maskCanvas = maskCanvasRef.current;
    if (!maskCanvas) return;
    const maskCtx = maskCanvas.getContext('2d');
    if (!maskCtx) return;

    saveHistory();
    maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    setCropPreview(null);
    notifyChanged();
  }, [maskCanvasRef, notifyChanged, saveHistory, setCropPreview]);

  /** 换显示颜色:把已画的像素整体换色,alpha 原样保留(软边不变),导出不受影响。 */
  const recolorMask = useCallback((color: string) => {
    const maskCanvas = maskCanvasRef.current;
    if (!maskCanvas) return;
    const maskCtx = maskCanvas.getContext('2d');
    if (!maskCtx) return;
    maskCtx.save();
    maskCtx.globalCompositeOperation = 'source-in';
    maskCtx.fillStyle = color;
    maskCtx.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
    maskCtx.restore();
  }, [maskCanvasRef]);

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
          maskCtx.fillStyle = maskColor;
          maskCtx.fillRect(gridMinX, gridMinY, totalSize, totalSize);
        }
      } else if (brushShape === 'soft') {
        // 软圆:中心实、边缘渐变到透明。擦除用 destination-out,让软边的擦除也是渐进的。
        const radius = Math.max(2, halfSize);
        const gradient = maskCtx.createRadialGradient(x, y, radius * 0.45, x, y, radius);
        maskCtx.save();
        if (erase) {
          maskCtx.globalCompositeOperation = 'destination-out';
          gradient.addColorStop(0, 'rgba(0,0,0,1)');
          gradient.addColorStop(1, 'rgba(0,0,0,0)');
        } else {
          gradient.addColorStop(0, maskColor);
          gradient.addColorStop(1, 'rgba(0,0,0,0)');
        }
        maskCtx.fillStyle = gradient;
        maskCtx.beginPath();
        maskCtx.arc(x, y, radius, 0, Math.PI * 2);
        maskCtx.fill();
        maskCtx.restore();
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
          maskCtx.fillStyle = maskColor;
          maskCtx.beginPath();
          maskCtx.arc(x, y, actualHalfSize, 0, Math.PI * 2);
          maskCtx.fill();
        }
      }
    },
    [brushShape, brushSize, maskCanvasRef, maskColor]
  );

  const drawLine = useCallback(
    (x1: number, y1: number, x2: number, y2: number, erase: boolean = false) => {
      const dist = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
      const stepSize = brushShape === 'square' ? 4 : brushShape === 'soft' ? Math.max(2, brushSize / 8) : brushSize / 4;
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

  /** 套索松手:至少三个点才成面;橡皮模式下整块擦掉,否则整块填充。 */
  const finishLasso = useCallback(() => {
    const points = lassoRef.current;
    lassoRef.current = [];
    setLassoPoints([]);
    if (points.length < 3) return;
    const maskCanvas = maskCanvasRef.current;
    if (!maskCanvas) return;
    const maskCtx = maskCanvas.getContext('2d');
    if (!maskCtx) return;
    saveHistory();
    maskCtx.save();
    maskCtx.beginPath();
    maskCtx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) maskCtx.lineTo(points[i].x, points[i].y);
    maskCtx.closePath();
    if (isEraser) {
      maskCtx.globalCompositeOperation = 'destination-out';
      maskCtx.fillStyle = 'rgba(0,0,0,1)';
    } else {
      maskCtx.fillStyle = maskColor;
    }
    maskCtx.fill();
    maskCtx.restore();
    updateCropPreview();
    notifyChanged();
  }, [isEraser, maskCanvasRef, maskColor, notifyChanged, saveHistory, updateCropPreview]);

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
      // 捕获指针,拖出画布也能继续画;合成事件没有活动指针会抛,不影响画
      const capture = () => { try { (event.target as HTMLCanvasElement).setPointerCapture(event.pointerId); } catch { /* 无活动指针 */ } };
      if (tool === 'lasso') {
        lassoRef.current = [{ x, y }];
        setLassoPoints([{ x, y }]);
        setIsDrawing(true);
        capture();
        return;
      }
      saveHistory();
      setIsDrawing(true);
      setLastBrushPos({ x, y });
      drawBrush(x, y, isEraser);
      capture();
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

    if (!isDrawing) return;
    const { x, y } = getCanvasCoords(event);
    if (tool === 'lasso') {
      const last = lassoRef.current[lassoRef.current.length - 1];
      // 太密的点没意义,隔 2 像素记一个
      if (!last || Math.abs(last.x - x) + Math.abs(last.y - y) >= 2) {
        lassoRef.current = [...lassoRef.current, { x, y }];
        setLassoPoints(lassoRef.current);
      }
      return;
    }
    if (!lastBrushPos) return;
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
    const wasDrawing = isDrawing;
    setIsDrawing(false);
    setLastBrushPos(null);
    setIsPanning(false);
    try {
      (event.target as HTMLCanvasElement).releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be released.
    }
    if (tool === 'lasso') {
      if (wasDrawing) finishLasso();
      return;
    }
    updateCropPreview();
    if (wasDrawing) notifyChanged();
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
    adjustBrushSize,
    brushShape,
    setBrushShape,
    tool,
    setTool,
    lassoPoints,
    isEraser,
    setIsEraser,
    history,
    setHistory,
    canRedo: redoStack.length > 0,
    cursorPos,
    showCursor,
    saveHistory,
    updateCropPreview,
    recolorMask,
    handleUndo,
    handleRedo,
    handleClear,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleMouseEnter,
    handleMouseLeaveCanvas,
    handleWheel,
  };
}
