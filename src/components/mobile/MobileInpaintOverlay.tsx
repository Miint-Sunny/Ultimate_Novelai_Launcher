import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { calculateCostFromUI } from '../../services/costCalculator';
import { getCachedIsOpus } from '../../services/novelai';
import { getAISettings } from '../../services/localLibrary';
import { calculateCropRect, alignSendRect, type CropRect } from '../../utils/maskCrop';
import { MobileInpaintBottomToolbar } from './inpaint/MobileInpaintBottomToolbar';
import { MobileInpaintCompareOverlay, type InpaintSnapshot } from './inpaint/MobileInpaintCompareOverlay';
import { MobileInpaintCropPreview } from './inpaint/MobileInpaintCropPreview';
import { MobileInpaintExpandOverlay } from './inpaint/MobileInpaintExpandOverlay';
import { MobileInpaintHeader } from './inpaint/MobileInpaintHeader';
import { MobileInpaintProgressPill } from './inpaint/MobileInpaintProgressPill';

type BrushShape = 'square' | 'circle';

// 扩图框选区域（图片坐标系，x/y 可为负表示超出图片左/上边界）
export interface ExpandSelection {
  x: number;
  y: number;
  width: number;
  height: number;
}

// 扩图预备载荷（MobileInpaintOverlay 内部构建好的完整图+遮罩）
export interface ExpandPayload {
  imageBase64: string;
  maskBase64: string;
  width: number;
  height: number;
  // 回贴信息
  selection: ExpandSelection;
  originalImageBase64: string;
  originalWidth: number;
  originalHeight: number;
}

interface MobileInpaintOverlayProps {
  imageUrl: string;
  imageWidth: number;
  imageHeight: number;
  onGenerate: (maskBase64: string, strength: number, cropRect?: CropRect, expandPayload?: ExpandPayload) => void;
  onClose: () => void;
  isGenerating: boolean;
  previewUrl?: string | null;
  currentStep?: number;
  totalSteps?: number;
  // 初始遮罩（base64 黑白图，白色为遮罩区域）
  initialMask?: string | null;
}

export const MobileInpaintOverlay: React.FC<MobileInpaintOverlayProps> = ({
  imageUrl,
  imageWidth,
  imageHeight,
  onGenerate,
  onClose,
  isGenerating,
  previewUrl,
  currentStep = 0,
  totalSteps = 0,
  initialMask,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [isDrawing, setIsDrawing] = useState(false);
  const [brushSize, setBrushSize] = useState(40);
  const [brushShape, setBrushShape] = useState<BrushShape>('circle');
  const [isEraser, setIsEraser] = useState(false);
  const [strength, setStrength] = useState(0.7);

  // 监听图生图区域的重绘强度变化
  useEffect(() => {
    const handler = (e: Event) => {
      const { strength: newStrength } = (e as CustomEvent).detail;
      setStrength(newStrength);
    };
    window.addEventListener('inpaint-strength-sync', handler);
    return () => window.removeEventListener('inpaint-strength-sync', handler);
  }, []);

  // 实时同步 strength 到图生图区域（仅在用户拖动时）
  const handleStrengthChange = (newStrength: number) => {
    setStrength(newStrength);
    window.dispatchEvent(new CustomEvent('inpaint-panel-strength-change', { detail: { strength: newStrength } }));
  };

  const [history, setHistory] = useState<ImageData[]>([]);
  const [lastBrushPos, setLastBrushPos] = useState<{ x: number; y: number } | null>(null);
  const [compositeUrl, setCompositeUrl] = useState<string | null>(null);

  const [originalImageUrl, setOriginalImageUrl] = useState<string | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const preGenerateImageRef = useRef<string | null>(null);
  const snapshotRef = useRef<InpaintSnapshot | null>(null);
  const [hasSnapshot, setHasSnapshot] = useState(false);
  const preGenerateSizeRef = useRef<{ width: number; height: number; padLeft: number; padTop: number } | null>(null);
  // 当前生成使用的裁切/扩图区域（用于流式预览定位）
  const activeGenRectRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);

  // canvas 图片加载完成标记，避免白色闪烁
  const [isCanvasReady, setIsCanvasReady] = useState(false);

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });

  // 触摸相关状态
  const [isPinching, setIsPinching] = useState(false);
  const lastPinchDistRef = useRef<number>(0);
  const lastPinchCenterRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  // 延迟绘制，防止双指误触
  const touchStartTimeRef = useRef<number>(0);
  const pendingDrawRef = useRef<{ x: number; y: number } | null>(null);
  const drawDelayMs = 80; // 延迟时间，等待判断是否有第二根手指

  // 扩图模式（上下左右箭头拓宽）
  const [isExpandMode, setIsExpandMode] = useState(false);
  const [expandPadding, setExpandPadding] = useState({ top: 0, bottom: 0, left: 0, right: 0 });
  const EXPAND_STEP = 64;

  // 裁切重绘模式
  const [isCropMode, setIsCropMode] = useState(false);
  const [cropPreview, setCropPreview] = useState<CropRect | null>(null);

  // 容器尺寸，用于同步计算 baseScale
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;
    const w = container.clientWidth;
    const h = container.clientHeight;
    setContainerSize(prev => (prev.width === w && prev.height === h) ? prev : { width: w, height: h });
  });

  // 同步计算 baseScale
  const baseScale = useMemo(() => {
    const { width, height } = containerSize;
    if (width === 0 || height === 0) return 0;
    const maxWidth = width - 16;
    const maxHeight = height - 180;
    // 扩图模式需要更大的边距，留出按钮空间
    const expandModeMargin = isExpandMode ? 80 : 0;
    const availableWidth = maxWidth - expandModeMargin * 2;
    const availableHeight = maxHeight - expandModeMargin * 2;
    const totalW = imageWidth + expandPadding.left + expandPadding.right;
    const totalH = imageHeight + expandPadding.top + expandPadding.bottom;
    return Math.min(availableWidth / totalW, availableHeight / totalH, 1);
  }, [imageWidth, imageHeight, expandPadding, isExpandMode, containerSize]);

  // 进入/退出扩图模式时重置
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [isExpandMode]);

  const isFirstLoadRef = useRef(true);
  // 缓存已加载的图片，避免扩图时重复异步加载导致闪烁
  const loadedImageRef = useRef<HTMLImageElement | null>(null);
  const loadedImageUrlRef = useRef<string | null>(null);

  // 将图片绘制到 canvas 的核心逻辑（同步，要求 img 已加载）
  const drawImageToCanvas = useCallback((
    ctx: CanvasRenderingContext2D,
    maskCtx: CanvasRenderingContext2D,
    img: HTMLImageElement,
    totalWidth: number,
    totalHeight: number,
    savedMaskData: ImageData | null,
  ) => {
    ctx.fillStyle = '#0a0a0f';
    ctx.fillRect(0, 0, totalWidth, totalHeight);
    ctx.drawImage(img, 0, 0, imageWidth, imageHeight);

    // 恢复遮罩数据
    if (savedMaskData) {
      maskCtx.putImageData(savedMaskData, 0, 0);
    } else {
      maskCtx.clearRect(0, 0, totalWidth, totalHeight);

      if (isFirstLoadRef.current) {
        setHistory([]);
        isFirstLoadRef.current = false;

        // 如果有初始遮罩，加载并绘制到遮罩画布
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
    setIsCanvasReady(true);
  }, [imageWidth, imageHeight, initialMask]);

  useEffect(() => {
    if (!canvasRef.current || !maskCanvasRef.current || baseScale === 0) return;
    const canvas = canvasRef.current;
    const maskCanvas = maskCanvasRef.current;
    const ctx = canvas.getContext('2d');
    const maskCtx = maskCanvas.getContext('2d');
    if (!ctx || !maskCtx) return;

    // 画布始终为图片原始尺寸
    const totalWidth = imageWidth;
    const totalHeight = imageHeight;

    const sizeChanged = canvas.width !== totalWidth || canvas.height !== totalHeight;

    let savedMaskData: ImageData | null = null;
    if (!isFirstLoadRef.current && !sizeChanged && maskCanvas.width > 0 && maskCanvas.height > 0) {
      savedMaskData = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
    }
    if (sizeChanged) {
      setHistory([]);
      resetExpand();
      setCropPreview(null);
    }

    canvas.width = totalWidth;
    canvas.height = totalHeight;
    maskCanvas.width = totalWidth;
    maskCanvas.height = totalHeight;

    // 如果图片已缓存且 URL 没变，直接同步绘制（无闪烁）
    if (loadedImageRef.current && loadedImageUrlRef.current === imageUrl) {
      drawImageToCanvas(ctx, maskCtx, loadedImageRef.current, totalWidth, totalHeight, savedMaskData);
      return;
    }

    // 首次加载或 URL 变化，异步加载图片
    ctx.fillStyle = '#0a0a0f';
    ctx.fillRect(0, 0, totalWidth, totalHeight);

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      loadedImageRef.current = img;
      loadedImageUrlRef.current = imageUrl;
      drawImageToCanvas(ctx, maskCtx, img, totalWidth, totalHeight, savedMaskData);
    };
    img.src = imageUrl;
  }, [imageUrl, imageWidth, imageHeight, baseScale, drawImageToCanvas]);

  // 流式预览合成
  // 普通模式：全图预览按遮罩混合；裁切模式：只在裁切区域内显示预览
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
  }, [previewUrl, imageWidth, imageHeight]);

  const saveHistory = useCallback(() => {
    const maskCanvas = maskCanvasRef.current;
    if (!maskCanvas) return;
    const maskCtx = maskCanvas.getContext('2d');
    if (!maskCtx) return;
    const imageData = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
    setHistory((prev) => [...prev.slice(-20), imageData]);
  }, []);

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
  }, [isCropMode, imageWidth, imageHeight]);

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
  }, [history, updateCropPreview]);

  const handleClear = useCallback(() => {
    const maskCanvas = maskCanvasRef.current;
    if (!maskCanvas) return;
    const maskCtx = maskCanvas.getContext('2d');
    if (!maskCtx) return;
    saveHistory();
    maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    setCropPreview(null);
  }, [saveHistory]);

  const getCanvasCoords = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const rect = canvas.getBoundingClientRect();
      const x = (clientX - rect.left) / (baseScale * zoom);
      const y = (clientY - rect.top) / (baseScale * zoom);
      return { x, y };
    },
    [baseScale, zoom]
  );

  const drawBrush = useCallback(
    (x: number, y: number, erase: boolean = false) => {
      const maskCanvas = maskCanvasRef.current;
      if (!maskCanvas) return;
      const maskCtx = maskCanvas.getContext('2d');
      if (!maskCtx) return;
      const scaledBrushSize = brushSize / zoom;
      const halfSize = scaledBrushSize / 2;

      // 略微缩小圆形笔刷实际绘制的半径（减小 4 像素），补偿后续处理中的 8x8 VAE 膨胀
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
        // 使用紫色
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
    [brushSize, brushShape, zoom]
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
    [brushSize, zoom, drawBrush]
  );

  // 触摸事件处理
  const handleTouchStart = (e: React.TouchEvent<HTMLCanvasElement>) => {
    if (e.touches.length === 2) {
      // 双指缩放/平移 - 生成中也允许
      e.preventDefault();
      pendingDrawRef.current = null;
      setIsPinching(true);
      setIsDrawing(false);
      setLastBrushPos(null);
      const touch1 = e.touches[0];
      const touch2 = e.touches[1];
      const dist = Math.hypot(touch2.clientX - touch1.clientX, touch2.clientY - touch1.clientY);
      lastPinchDistRef.current = dist;
      lastPinchCenterRef.current = {
        x: (touch1.clientX + touch2.clientX) / 2,
        y: (touch1.clientY + touch2.clientY) / 2,
      };
    } else if (e.touches.length === 1 && !isPinching) {
      // 单指绘制 - 生成中或扩图模式不允许
      if (isGenerating || isExpandMode) return;
      const touch = e.touches[0];
      const { x, y } = getCanvasCoords(touch.clientX, touch.clientY);
      touchStartTimeRef.current = Date.now();
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

  const handleTouchMove = (e: React.TouchEvent<HTMLCanvasElement>) => {

    if (e.touches.length === 2) {
      // 双指操作 - 取消待处理的绘制
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

      // 缩放
      if (lastPinchDistRef.current > 0) {
        const scale = dist / lastPinchDistRef.current;
        setZoom((prev) => Math.min(Math.max(prev * scale, 0.5), 5));
      }

      // 平移
      const dx = center.x - lastPinchCenterRef.current.x;
      const dy = center.y - lastPinchCenterRef.current.y;
      setPan((prev) => ({ x: prev.x + dx, y: prev.y + dy }));

      lastPinchDistRef.current = dist;
      lastPinchCenterRef.current = center;
    } else if (e.touches.length === 1 && !isPinching) {
      const touch = e.touches[0];
      const { x, y } = getCanvasCoords(touch.clientX, touch.clientY);

      // 如果还在等待延迟，更新待绘制位置
      if (pendingDrawRef.current) {
        pendingDrawRef.current = { x, y };
      } else if (isDrawing && lastBrushPos) {
        // 已经开始绘制
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

  // 8x8 网格区域扩张
  const expandMaskRegions = useCallback((imageData: ImageData): ImageData => {
    const { width, height, data } = imageData;
    const gridSize = 8;
    const gridWidth = Math.floor(width / gridSize);
    const gridHeight = Math.floor(height / gridSize);

    const whiteGrids: boolean[][] = Array(gridHeight).fill(null).map(() => Array(gridWidth).fill(false));

    for (let gy = 0; gy < gridHeight; gy++) {
      for (let gx = 0; gx < gridWidth; gx++) {
        outer: for (let dy = 0; dy < gridSize; dy++) {
          for (let dx = 0; dx < gridSize; dx++) {
            const px = gx * gridSize + dx;
            const py = gy * gridSize + dy;
            const idx = (py * width + px) * 4;
            if (data[idx] > 128) {
              whiteGrids[gy][gx] = true;
              break outer;
            }
          }
        }
      }
    }

    const visited: boolean[][] = Array(gridHeight).fill(null).map(() => Array(gridWidth).fill(false));
    const regions: Array<Array<[number, number]>> = [];

    const bfs = (startY: number, startX: number): Array<[number, number]> => {
      const region: Array<[number, number]> = [];
      const queue: Array<[number, number]> = [[startY, startX]];
      visited[startY][startX] = true;
      while (queue.length > 0) {
        const [y, x] = queue.shift()!;
        region.push([y, x]);
        for (const [dy, dx] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
          const ny = y + dy;
          const nx = x + dx;
          if (ny >= 0 && ny < gridHeight && nx >= 0 && nx < gridWidth && whiteGrids[ny][nx] && !visited[ny][nx]) {
            visited[ny][nx] = true;
            queue.push([ny, nx]);
          }
        }
      }
      return region;
    };

    for (let gy = 0; gy < gridHeight; gy++) {
      for (let gx = 0; gx < gridWidth; gx++) {
        if (whiteGrids[gy][gx] && !visited[gy][gx]) {
          regions.push(bfs(gy, gx));
        }
      }
    }

    const result = new Uint8ClampedArray(data.length);
    result.set(data);
    const brushHalf = 2;

    for (const region of regions) {
      const ys = region.map((p) => p[0]);
      const xs = region.map((p) => p[1]);
      const minY = Math.min(...ys);
      const maxY = Math.max(...ys);
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);

      const topDist = minY;
      const bottomDist = gridHeight - 1 - maxY;
      const leftDist = minX;
      const rightDist = gridWidth - 1 - maxX;

      const targetTop = Math.floor(topDist / 8) * 8;
      const targetBottom = Math.floor(bottomDist / 8) * 8;
      const targetLeft = Math.floor(leftDist / 8) * 8;
      const targetRight = Math.floor(rightDist / 8) * 8;

      const expandedMinY = Math.max(0, minY - (topDist - targetTop));
      const expandedMaxY = Math.min(gridHeight - 1, maxY + (bottomDist - targetBottom));
      const expandedMinX = Math.max(0, minX - (leftDist - targetLeft));
      const expandedMaxX = Math.min(gridWidth - 1, maxX + (rightDist - targetRight));

      for (let cy = expandedMinY; cy <= expandedMaxY; cy++) {
        for (let cx = expandedMinX; cx <= expandedMaxX; cx++) {
          const inRange = region.some(([ry, rx]) => Math.abs(cy - ry) <= brushHalf && Math.abs(cx - rx) <= brushHalf);
          if (inRange) {
            for (let dy = 0; dy < gridSize; dy++) {
              for (let dx = 0; dx < gridSize; dx++) {
                const px = cx * gridSize + dx;
                const py = cy * gridSize + dy;
                if (px < width && py < height) {
                  const idx = (py * width + px) * 4;
                  result[idx] = 255;
                  result[idx + 1] = 255;
                  result[idx + 2] = 255;
                  result[idx + 3] = 255;
                }
              }
            }
          }
        }
      }
    }
    return new ImageData(result, width, height);
  }, []);

  const getMaskBase64 = useCallback(() => {
    const maskCanvas = maskCanvasRef.current;
    if (!maskCanvas) return '';
    const maskCtx = maskCanvas.getContext('2d');
    if (!maskCtx) return '';

    const w = imageWidth;
    const h = imageHeight;

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = w;
    tempCanvas.height = h;
    const tempCtx = tempCanvas.getContext('2d');
    if (!tempCtx) return '';

    tempCtx.fillStyle = '#000000';
    tempCtx.fillRect(0, 0, w, h);

    const maskData = maskCtx.getImageData(0, 0, w, h);
    const data = maskData.data;
    const outputData = tempCtx.getImageData(0, 0, w, h);
    const output = outputData.data;

    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 0 || data[i + 1] > 0 || data[i + 2] > 0 || data[i + 3] > 0) {
        output[i] = 255; output[i + 1] = 255; output[i + 2] = 255; output[i + 3] = 255;
      } else {
        output[i] = 0; output[i + 1] = 0; output[i + 2] = 0; output[i + 3] = 255;
      }
    }

    tempCtx.putImageData(outputData, 0, 0);
    const imageData = tempCtx.getImageData(0, 0, w, h);
    const expandedData = expandMaskRegions(imageData);
    tempCtx.putImageData(expandedData, 0, 0);

    return tempCanvas.toDataURL('image/png').split(',')[1];
  }, [expandMaskRegions, imageWidth, imageHeight]);

  const handleGenerate = () => {
    if (!preGenerateImageRef.current) {
      preGenerateImageRef.current = imageUrl;
    }
    if (canvasRef.current) {
      snapshotRef.current = {
        url: canvasRef.current.toDataURL('image/png'),
        width: imageWidth, height: imageHeight,
        padLeft: expandPadding.left, padTop: expandPadding.top,
      };
      setHasSnapshot(true);
    }
    preGenerateSizeRef.current = { width: imageWidth, height: imageHeight, padLeft: expandPadding.left, padTop: expandPadding.top };
    setOriginalImageUrl(imageUrl);

    // ===== 扩图框选模式 =====
    if (isExpandMode && hasExpand) {
      const sel: ExpandSelection = {
        x: -expandPadding.left,
        y: -expandPadding.top,
        width: imageWidth + expandPadding.left + expandPadding.right,
        height: imageHeight + expandPadding.top + expandPadding.bottom,
      };
      const img = loadedImageRef.current;
      if (!img) return;

      // 构建选区大小的图片（白底 + 原图对应部分）
      const imgCanvas = document.createElement('canvas');
      imgCanvas.width = sel.width;
      imgCanvas.height = sel.height;
      const imgCtx = imgCanvas.getContext('2d')!;
      imgCtx.fillStyle = '#ffffff';
      imgCtx.fillRect(0, 0, sel.width, sel.height);
      imgCtx.drawImage(img, expandPadding.left, expandPadding.top, imageWidth, imageHeight);
      const imageBase64 = imgCanvas.toDataURL('image/png').split(',')[1];

      // 构建选区大小的遮罩（图片覆盖区域=黑=保留，外部=白=生���）
      const maskCanvas = document.createElement('canvas');
      maskCanvas.width = sel.width;
      maskCanvas.height = sel.height;
      const maskCtx = maskCanvas.getContext('2d')!;
      maskCtx.fillStyle = '#ffffff';
      maskCtx.fillRect(0, 0, sel.width, sel.height);
      // 原图区域设为黑色（保留）
      maskCtx.fillStyle = '#000000';
      maskCtx.fillRect(expandPadding.left, expandPadding.top, imageWidth, imageHeight);
      // 8x8 网格对齐
      const maskData = maskCtx.getImageData(0, 0, sel.width, sel.height);
      const expandedMask = expandMaskRegions(maskData);
      maskCtx.putImageData(expandedMask, 0, 0);
      const selMaskBase64 = maskCanvas.toDataURL('image/png').split(',')[1];

      // 获取原图 base64
      const origCanvas = document.createElement('canvas');
      origCanvas.width = imageWidth;
      origCanvas.height = imageHeight;
      origCanvas.getContext('2d')!.drawImage(img, 0, 0);
      const originalImageBase64 = origCanvas.toDataURL('image/png').split(',')[1];

      const expandPayload: ExpandPayload = {
        imageBase64,
        maskBase64: selMaskBase64,
        width: sel.width,
        height: sel.height,
        selection: sel,
        originalImageBase64,
        originalWidth: imageWidth,
        originalHeight: imageHeight,
      };
      activeGenRectRef.current = { x: 0, y: 0, width: sel.width, height: sel.height };
      onGenerate(selMaskBase64, strength, undefined, expandPayload);
      return;
    }

    // ===== 普通遮罩 / 裁切重绘模式 =====
    const maskBase64 = getMaskBase64();

    let cropRect: CropRect | undefined;
    if (isCropMode && maskCanvasRef.current) {
      const maskCtx = maskCanvasRef.current.getContext('2d');
      if (maskCtx) {
        const maskData = maskCtx.getImageData(0, 0, imageWidth, imageHeight);
        const rect = calculateCropRect(maskData, imageWidth, imageHeight);
        if (rect) cropRect = rect;
      }
    }

    activeGenRectRef.current = cropRect || null;
    onGenerate(maskBase64, strength, cropRect);
  };

  const displayWidth = imageWidth * baseScale * zoom;
  const displayHeight = imageHeight * baseScale * zoom;

  // 拓宽控制函数
  const adjustExpand = useCallback((direction: 'top' | 'bottom' | 'left' | 'right', delta: number) => {
    setExpandPadding(prev => {
      const newValue = Math.max(0, prev[direction] + delta);
      return { ...prev, [direction]: newValue };
    });
  }, []);

  const resetExpand = useCallback(() => {
    setExpandPadding({ top: 0, bottom: 0, left: 0, right: 0 });
  }, []);

  const hasExpand = expandPadding.top > 0 || expandPadding.bottom > 0 || expandPadding.left > 0 || expandPadding.right > 0;

  // 本次生成实际分辨率 + 点数消耗
  const genDimensions = useMemo(() => {
    if (isExpandMode && hasExpand) {
      return {
        width: imageWidth + expandPadding.left + expandPadding.right,
        height: imageHeight + expandPadding.top + expandPadding.bottom,
      };
    }
    if (isCropMode && cropPreview) {
      const aligned = alignSendRect(cropPreview, imageWidth, imageHeight);
      return { width: aligned.width, height: aligned.height };
    }
    return { width: imageWidth, height: imageHeight };
  }, [isExpandMode, hasExpand, expandPadding, isCropMode, cropPreview, imageWidth, imageHeight]);

  const costInfo = useMemo(() => {
    const ai = getAISettings();
    return calculateCostFromUI({
      width: genDimensions.width,
      height: genDimensions.height,
      steps: ai.steps,
      modelId: 'v4.5-full',
      sampler: ai.sampler,
      isOpus: getCachedIsOpus(),
      img2imgStrength: strength,
    });
  }, [genDimensions, strength]);

  const handleClearAll = () => {
    handleClear();
    if (isExpandMode) resetExpand();
  };

  const handleToggleCrop = () => {
    const next = !isCropMode;
    setIsCropMode(next);
    if (next) {
      setIsExpandMode(false);
      resetExpand();
      updateCropPreview();
    } else {
      setCropPreview(null);
    }
  };

  const handleToggleExpand = () => {
    const entering = !isExpandMode;
    setIsExpandMode(entering);
    if (entering) {
      resetExpand();
      setIsCropMode(false);
      setCropPreview(null);
    } else {
      resetExpand();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-[#0a0a0f] flex flex-col"
      style={{
        opacity: isCanvasReady ? 1 : 0,
        transition: 'opacity 150ms ease-out',
        pointerEvents: isCanvasReady ? 'auto' : 'none',
      }}
    >
      <MobileInpaintHeader
        onClose={onClose}
        onGenerate={handleGenerate}
        isGenerating={isGenerating}
        isExpandMode={isExpandMode}
        hasExpand={hasExpand}
        cost={costInfo.total}
      />

      {/* 画布区域 */}
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden relative"
      >
        <div
          className="absolute inset-0 opacity-10"
          style={{
            backgroundImage: `linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px)`,
            backgroundSize: '20px 20px',
          }}
        />

        <div
          className="absolute"
          style={{
            left: '50%',
            top: '50%',
            transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px))`,
          }}
        >
          <MobileInpaintExpandOverlay
            isExpandMode={isExpandMode}
            isGenerating={isGenerating}
            hasExpand={hasExpand}
            expandPadding={expandPadding}
            imageWidth={imageWidth}
            imageHeight={imageHeight}
            displayWidth={displayWidth}
            displayHeight={displayHeight}
            baseScale={baseScale}
            zoom={zoom}
            expandStep={EXPAND_STEP}
            adjustExpand={adjustExpand}
          />

          <div className="relative shadow-2xl" style={{ width: `${displayWidth}px`, height: `${displayHeight}px` }}>
            <canvas
              ref={canvasRef}
              style={{ width: `${displayWidth}px`, height: `${displayHeight}px`, position: 'absolute', top: 0, left: 0 }}
            />
            <canvas
              ref={maskCanvasRef}
              style={{
                width: `${displayWidth}px`,
                height: `${displayHeight}px`,
                position: 'absolute',
                top: 0,
                left: 0,
                opacity: isGenerating ? 0 : 0.5,
                touchAction: 'none',
                pointerEvents: 'auto',
              }}
              onTouchStart={handleTouchStart}
              onTouchMove={handleTouchMove}
              onTouchEnd={handleTouchEnd}
              onTouchCancel={handleTouchEnd}
            />
            {isGenerating && compositeUrl && (
              <img
                src={compositeUrl}
                alt="生成预览"
                style={{
                  width: `${displayWidth}px`,
                  height: `${displayHeight}px`,
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  pointerEvents: 'none',
                }}
              />
            )}
            <MobileInpaintCropPreview
              isCropMode={isCropMode}
              cropPreview={cropPreview}
              isGenerating={isGenerating}
              displayWidth={displayWidth}
              displayHeight={displayHeight}
              baseScale={baseScale}
              zoom={zoom}
            />
            <MobileInpaintCompareOverlay
              showOriginal={showOriginal}
              snapshot={snapshotRef.current}
              displayWidth={displayWidth}
              displayHeight={displayHeight}
              imageWidth={imageWidth}
            />
          </div>
        </div>

        <MobileInpaintProgressPill
          isGenerating={isGenerating}
          currentStep={currentStep}
          totalSteps={totalSteps}
        />
      </div>

      <MobileInpaintBottomToolbar
        isEraser={isEraser}
        setIsEraser={setIsEraser}
        brushShape={brushShape}
        setBrushShape={setBrushShape}
        historyLength={history.length}
        onUndo={handleUndo}
        onClear={handleClearAll}
        isCropMode={isCropMode}
        isExpandMode={isExpandMode}
        onToggleCrop={handleToggleCrop}
        onToggleExpand={handleToggleExpand}
        hasSnapshot={hasSnapshot}
        isGenerating={isGenerating}
        showOriginal={showOriginal}
        setShowOriginal={setShowOriginal}
        brushSize={brushSize}
        setBrushSize={setBrushSize}
        strength={strength}
        onStrengthChange={handleStrengthChange}
      />
    </div>
  );
};
