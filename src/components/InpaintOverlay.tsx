import { useState, useRef, useEffect, useCallback, useMemo, Fragment } from 'react';
import { Eraser, Undo2, RotateCcw, Play, Square, Circle, Brush, Eye, Expand, Crop, ChevronsUp, ChevronsDown, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { calculateCostFromUI } from '../services/costCalculator';
import { getCachedIsOpus } from '../services/novelai';
import { getAISettings } from '../services/localLibrary';
import { calculateCropRect, alignSendRect, type CropRect } from '../utils/maskCrop';

type BrushShape = 'square' | 'circle';

// 扩图框选区域（图片坐标系，x/y 可为负表示超出图片左/上边界）
export interface ExpandSelection {
  x: number;
  y: number;
  width: number;
  height: number;
}

// 扩图预备载荷（InpaintOverlay 内部构建好的完整图+遮罩）
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

interface InpaintOverlayProps {
  imageUrl: string;
  imageWidth: number;
  imageHeight: number;
  onGenerate: (maskBase64: string, strength: number, cropRect?: CropRect, expandPayload?: ExpandPayload) => void;
  onClose: () => void;
  isGenerating: boolean;
  // 流式预览相关
  previewUrl?: string | null;
  currentStep?: number;
  totalSteps?: number;
  // 初始遮罩（base64 黑白图，白色为遮罩区域）
  initialMask?: string | null;
}

export const InpaintOverlay: React.FC<InpaintOverlayProps> = ({
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
  const [brushSize, setBrushSizeState] = useState(() => {
    const saved = localStorage.getItem('inpaint_brush_size');
    return saved ? Number(saved) : 50;
  });
  const setBrushSize = (size: number) => {
    setBrushSizeState(size);
    localStorage.setItem('inpaint_brush_size', String(size));
  };
  const [brushShape, setBrushShape] = useState<BrushShape>('square');
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
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null);
  const [showCursor, setShowCursor] = useState(false);
  const [compositeUrl, setCompositeUrl] = useState<string | null>(null);

  // 扩图模式（拖拽边缘拓宽）
  const [isExpandMode, setIsExpandMode] = useState(false);
  const [expandPadding, setExpandPadding] = useState({ top: 0, bottom: 0, left: 0, right: 0 });
  const expandDragRef = useRef<{ dir: 'top' | 'bottom' | 'left' | 'right'; startClient: number; startPad: number } | null>(null);
  const isExpandGeneratingRef = useRef(false); // 当前生成是否为扩图模式
  const expandGenSizeRef = useRef<{ width: number; height: number } | null>(null); // 扩图生成的目标尺寸

  // 裁切重绘模式 - 图像超出免费分辨率阈值（1024*1024）时默认开启以节省点数
  const [isCropMode, setIsCropMode] = useState(() => imageWidth * imageHeight > 1048576);
  const [cropPreview, setCropPreview] = useState<CropRect | null>(null);
  // 正在手动拖拽裁切框时屏蔽画布的鼠标事件
  const isDraggingCropRef = useRef(false);
  // 用户是否手动调整过裁切框；为 true 时 updateCropPreview 不再用遮罩自动覆盖
  const cropManuallyAdjustedRef = useRef(false);

  // canvas 图片加载完成标记，避免白色闪烁
  const [isCanvasReady, setIsCanvasReady] = useState(false);

  // 操作提示 toast，进入后短暂显示然后自动消失
  const [showHintToast, setShowHintToast] = useState(true);
  useEffect(() => {
    if (!isCanvasReady) return;
    const timer = setTimeout(() => setShowHintToast(false), 3000);
    return () => clearTimeout(timer);
  }, [isCanvasReady]);

  // 局部模式提示 toast
  const [showCropHint, setShowCropHint] = useState(false);
  const cropHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerCropHint = useCallback(() => {
    setShowCropHint(true);
    if (cropHintTimerRef.current) clearTimeout(cropHintTimerRef.current);
    cropHintTimerRef.current = setTimeout(() => setShowCropHint(false), 3500);
  }, []);
  useEffect(() => {
    return () => { if (cropHintTimerRef.current) clearTimeout(cropHintTimerRef.current); };
  }, []);

  // 对比功能：保存重绘前的原图
  const [originalImageUrl, setOriginalImageUrl] = useState<string | null>(null);
  // 生成结束到新图加载之间保留最后一帧预览，避免闪烁
  const [lastPreviewUrl, setLastPreviewUrl] = useState<string | null>(null);
  // 当前生成使用的裁切/扩图区域（用于流式预览定位）
  const activeGenRectRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const preGenerateImageRef = useRef<string | null>(null);
  // 对比用：生成前画布快照 + 尺寸信息
  const snapshotRef = useRef<{ url: string; width: number; height: number; padLeft: number; padTop: number } | null>(null);
  const [hasSnapshot, setHasSnapshot] = useState(false); // 仅用于触发按钮显示

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });
  const [spacePressed, setSpacePressed] = useState(false);

  // 容器尺寸，用于同步计算 baseScale
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });

  // 监听容器尺寸变化
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
    const maxWidth = width - 48;
    const maxHeight = height - 48;
    // 扩图模式需要更大的边距，留出按钮空间
    const expandModeMargin = isExpandMode ? 120 : 0;
    const availableWidth = maxWidth - expandModeMargin * 2;
    const availableHeight = maxHeight - expandModeMargin * 2;
    // 在扩图模式下，缩放要能同时显示图片和拓宽区域
    const totalW = imageWidth + expandPadding.left + expandPadding.right;
    const totalH = imageHeight + expandPadding.top + expandPadding.bottom;
    return Math.min(availableWidth / totalW, availableHeight / totalH, 1);
  }, [imageWidth, imageHeight, expandPadding, isExpandMode, containerSize]);

  // 扩图模式或拓宽变化时重置视图
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [isExpandMode]);

  // 用于追踪是否是首次加载
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
                  data[i] = 168; data[i + 1] = 85; data[i + 2] = 247; data[i + 3] = 255;
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
      // 尺寸不变时保留遮罩（生成完成后用户可继续在同一区域重绘）
      savedMaskData = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
    }
    if (sizeChanged) {
      // 尺寸变了（如扩图后）→ 清除遮罩和历史
      setHistory([]);
      resetExpand();
      setCropPreview(null);
    }

    canvas.width = totalWidth;
    canvas.height = totalHeight;
    maskCanvas.width = totalWidth;
    maskCanvas.height = totalHeight;

    if (loadedImageRef.current && loadedImageUrlRef.current === imageUrl) {
      drawImageToCanvas(ctx, maskCtx, loadedImageRef.current, totalWidth, totalHeight, savedMaskData);
      setLastPreviewUrl(null);
      return;
    }

    // 有过渡预览时不填充黑色，让过渡帧继续覆盖
    if (!lastPreviewUrl) {
      ctx.fillStyle = '#0a0a0f';
      ctx.fillRect(0, 0, totalWidth, totalHeight);
    }

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      loadedImageRef.current = img;
      loadedImageUrlRef.current = imageUrl;
      drawImageToCanvas(ctx, maskCtx, img, totalWidth, totalHeight, savedMaskData);
      setLastPreviewUrl(null); // 新图绘制完成，清除过渡预览
    };
    img.src = imageUrl;
  }, [imageUrl, imageWidth, imageHeight, baseScale, drawImageToCanvas, lastPreviewUrl]);

  // 生成结束时保留最后一帧预览，直到新图加载完成
  const prevPreviewUrlRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevPreviewUrlRef.current && !previewUrl) {
      // previewUrl 刚变为 null（生成结束），保留最后一帧
      if (isExpandGeneratingRef.current) {
        setLastPreviewUrl(prevPreviewUrlRef.current);
      } else if (compositeUrl) {
        setLastPreviewUrl(compositeUrl);
      }
    }
    prevPreviewUrlRef.current = previewUrl ?? null;
  }, [previewUrl, compositeUrl]);

  // 新图加载完成时清除过渡预览（由 drawImageToCanvas 触发）

  // 流式预览合成：将预览图叠加到原图上
  // 普通模式：全图预览，遮罩区域显示预览、非遮罩区域显示原图
  // 裁切模式：预览图是裁切尺寸，只在裁切区域内显示预览，其余保持原图
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
      // 先铺原图
      compositeCtx.drawImage(canvas, 0, 0);
      const originalData = compositeCtx.getImageData(0, 0, w, h);

      // 将预览图绘制到正确位置（裁切模式绘制到裁切区域，普通模式全图）
      if (genRect) {
        compositeCtx.drawImage(previewImg, genRect.x, genRect.y, genRect.width, genRect.height);
      } else {
        compositeCtx.drawImage(previewImg, 0, 0, w, h);
      }
      const previewData = compositeCtx.getImageData(0, 0, w, h);

      // 按遮罩混合：遮罩区域显示预览，非遮罩区域恢复原图
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
    return () => { setCompositeUrl(null); };
  }, [previewUrl, imageWidth, imageHeight]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !spacePressed) {
        e.preventDefault();
        setSpacePressed(true);
      }
      if (e.code === 'Escape') {
        onClose();
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        setSpacePressed(false);
        setIsPanning(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [spacePressed, onClose]);

  const saveHistory = useCallback(() => {
    const maskCanvas = maskCanvasRef.current;
    if (!maskCanvas) return;
    const maskCtx = maskCanvas.getContext('2d');
    if (!maskCtx) return;

    const imageData = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
    setHistory((prev) => [...prev.slice(-20), imageData]);
  }, []);

  // 计算裁切预览区域（在绘制遮罩时实时更新）
  const updateCropPreview = useCallback(() => {
    if (!isCropMode || !maskCanvasRef.current) {
      setCropPreview(null);
      return;
    }
    // 用户已手动调整过裁切框，不再用遮罩自动覆盖
    if (cropManuallyAdjustedRef.current) return;
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
    // 延迟更新裁切预览，等状态同步
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
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };

      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) / (baseScale * zoom);
      const y = (e.clientY - rect.top) / (baseScale * zoom);

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

      const scaledBrushSize = brushSize;
      const halfSize = scaledBrushSize / 2;

      if (brushShape === 'square') {
        // 方块模式：按 brushSize 决定覆盖的 8×8 网格数量
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
        // 圆形模式：自由绘制。由于扩散模型的 VAE 必需对齐 8x8 网格，生成的重绘遮罩往往比实际涂抹的大。
        // 这里略微缩小实际绘制的半径（减小 4 像素），以补偿之后的 8x8 膨胀，使其更贴近用户的视觉涂抹范围。
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
    [brushSize, brushShape, zoom]
  );

  const drawLine = useCallback(
    (x1: number, y1: number, x2: number, y2: number, erase: boolean = false) => {
      const dist = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
      // 方块模式用更细的步长确保每个格子都被填充
      const stepSize = brushShape === 'square' ? 4 : brushSize / 4;
      const steps = Math.max(1, Math.ceil(dist / stepSize));

      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = x1 + (x2 - x1) * t;
        const y = y1 + (y2 - y1) * t;
        drawBrush(x, y, erase);
      }
    },
    [brushSize, brushShape, zoom, drawBrush]
  );

  const handleMouseDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (isDraggingCropRef.current) return;
    if (e.button === 1 || spacePressed) {
      e.preventDefault();
      setIsPanning(true);
      setPanStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
      // 捕获指针，防止鼠标出界时丢失事件
      (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
      return;
    }

    // 生成中或扩图模式不允许画笔
    if (isGenerating || isExpandMode) return;

    if (e.button === 0) {
      const { x, y } = getCanvasCoords(e);
      saveHistory();
      setIsDrawing(true);
      setLastBrushPos({ x, y });
      drawBrush(x, y, isEraser);
      // 捕获指针，防止鼠标出界时中断涂抹
      (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
    }
  };

  const handleMouseMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    // 更新光标位置
    setCursorPos({ x: e.clientX, y: e.clientY });

    if (isPanning) {
      setPan({
        x: e.clientX - panStart.x,
        y: e.clientY - panStart.y,
      });
      return;
    }

    if (!isDrawing || !lastBrushPos) return;
    const { x, y } = getCanvasCoords(e);
    drawLine(lastBrushPos.x, lastBrushPos.y, x, y, isEraser);
    setLastBrushPos({ x, y });
  };

  const handleMouseEnter = () => {
    setShowCursor(true);
  };

  const handleMouseLeaveCanvas = () => {
    setShowCursor(false);
    // 不再在鼠标离开时中断绘制，pointer capture 会保证事件继续触发
  };

  const handleMouseUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (isDraggingCropRef.current) return;
    if (e.button === 1) {
      setIsPanning(false);
      // 释放指针捕获
      (e.target as HTMLCanvasElement).releasePointerCapture(e.pointerId);
      return;
    }
    setIsDrawing(false);
    setLastBrushPos(null);
    setIsPanning(false);
    // 释放指针捕获
    try { (e.target as HTMLCanvasElement).releasePointerCapture(e.pointerId); } catch {}
    // 绘制结束后更新裁切预览
    updateCropPreview();
  };

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const newZoom = Math.min(Math.max(zoom * delta, 0.5), 5);
    if (newZoom === zoom) return;

    // 缩放跟随鼠标：保持鼠标指向的图片位置不变
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const cursorRelX = e.clientX - centerX;
      const cursorRelY = e.clientY - centerY;
      const scaleFactor = 1 - newZoom / zoom;
      setPan(prev => ({
        x: prev.x + (cursorRelX - prev.x) * scaleFactor,
        y: prev.y + (cursorRelY - prev.y) * scaleFactor,
      }));
    }

    setZoom(newZoom);
  }, [zoom]);

  // 8x8 网格对齐 + 最小缓冲膨胀（仅做必要的网格量化和 1 格过渡缓冲）
  const expandMaskRegions = useCallback((imageData: ImageData): ImageData => {
    const { width, height, data } = imageData;
    const gridSize = 8;
    const gridWidth = Math.floor(width / gridSize);
    const gridHeight = Math.floor(height / gridSize);

    // Step 1: 标记包含遮罩像素的 8×8 网格（对齐 VAE 潜空间）
    const whiteGrids: boolean[][] = Array(gridHeight)
      .fill(null)
      .map(() => Array(gridWidth).fill(false));

    for (let gy = 0; gy < gridHeight; gy++) {
      for (let gx = 0; gx < gridWidth; gx++) {
        outer: for (let dy = 0; dy < gridSize; dy++) {
          for (let dx = 0; dx < gridSize; dx++) {
            const px = gx * gridSize + dx;
            const py = gy * gridSize + dy;
            const idx = (py * width + px) * 4;
            if (data[idx] > 128 || data[idx + 1] > 128 || data[idx + 2] > 128) {
              whiteGrids[gy][gx] = true;
              break outer;
            }
          }
        }
      }
    }

    // Step 2: 对遮罩网格做最小膨胀（0 = 不额外膨胀，仅保留网格对齐）
    const bufferSize = 0;
    const expanded: boolean[][] = Array(gridHeight)
      .fill(null)
      .map(() => Array(gridWidth).fill(false));

    for (let gy = 0; gy < gridHeight; gy++) {
      for (let gx = 0; gx < gridWidth; gx++) {
        if (!whiteGrids[gy][gx]) continue;
        for (let dy = -bufferSize; dy <= bufferSize; dy++) {
          for (let dx = -bufferSize; dx <= bufferSize; dx++) {
            const ny = gy + dy;
            const nx = gx + dx;
            if (ny >= 0 && ny < gridHeight && nx >= 0 && nx < gridWidth) {
              expanded[ny][nx] = true;
            }
          }
        }
      }
    }

    // Step 3: 将扩张后的网格写回像素级遮罩
    const result = new Uint8ClampedArray(data.length);
    result.set(data);

    for (let gy = 0; gy < gridHeight; gy++) {
      for (let gx = 0; gx < gridWidth; gx++) {
        if (!expanded[gy][gx]) continue;
        for (let dy = 0; dy < gridSize; dy++) {
          for (let dx = 0; dx < gridSize; dx++) {
            const px = gx * gridSize + dx;
            const py = gy * gridSize + dy;
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
    // 从 canvas 截取当前画面作为对比快照
    if (canvasRef.current) {
      snapshotRef.current = {
        url: canvasRef.current.toDataURL('image/png'),
        width: imageWidth,
        height: imageHeight,
        padLeft: expandPadding.left,
        padTop: expandPadding.top,
      };
      setHasSnapshot(true);
    }
    setOriginalImageUrl(imageUrl);

    // ===== 扩图模式（方向拓宽） =====
    isExpandGeneratingRef.current = isExpandMode && hasExpand;
    expandGenSizeRef.current = null;
    if (isExpandMode && hasExpand) {
      const expandedW = imageWidth + expandPadding.left + expandPadding.right;
      const expandedH = imageHeight + expandPadding.top + expandPadding.bottom;
      expandGenSizeRef.current = { width: expandedW, height: expandedH };
      const sel: ExpandSelection = {
        x: -expandPadding.left,
        y: -expandPadding.top,
        width: expandedW,
        height: expandedH,
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

      // 构建选区大小的遮罩（图片覆盖区域=黑=保留，外部=白=生成）
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
      // 扩图：预览图覆盖选区对应的图片区域
      activeGenRectRef.current = { x: 0, y: 0, width: sel.width, height: sel.height };
      onGenerate(selMaskBase64, strength, undefined, expandPayload);
      return;
    }

    // ===== 普通遮罩 / 裁切重绘模式 =====
    const maskBase64 = getMaskBase64();

    let cropRect: CropRect | undefined;
    if (isCropMode) {
      // 优先使用用户手动调整后的预览矩形，否则从遮罩重算
      if (cropPreview) {
        cropRect = cropPreview;
      } else if (maskCanvasRef.current) {
        const maskCtx = maskCanvasRef.current.getContext('2d');
        if (maskCtx) {
          const maskData = maskCtx.getImageData(0, 0, imageWidth, imageHeight);
          const rect = calculateCropRect(maskData, imageWidth, imageHeight);
          if (rect) cropRect = rect;
        }
      }
    }

    // 记录裁切区域用于流式预览定位
    activeGenRectRef.current = cropRect || null;
    onGenerate(maskBase64, strength, cropRect);
  };

  const displayWidth = imageWidth * baseScale * zoom;
  const displayHeight = imageHeight * baseScale * zoom;

  const resetExpand = useCallback(() => {
    setExpandPadding({ top: 0, bottom: 0, left: 0, right: 0 });
  }, []);

  const hasExpand = expandPadding.top > 0 || expandPadding.bottom > 0 || expandPadding.left > 0 || expandPadding.right > 0;

  // 本次生成实际发送到 API 的分辨率（用于点数计算）
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

  // 本次生成的点数消耗（模型固定用 v4.5-full 估算，公式与模型无关）
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

  // 拖拽拉伸
  const handleExpandDragStart = useCallback((dir: 'top' | 'bottom' | 'left' | 'right', e: React.MouseEvent) => {
    e.preventDefault();
    expandDragRef.current = {
      dir,
      startClient: (dir === 'top' || dir === 'bottom') ? e.clientY : e.clientX,
      startPad: expandPadding[dir],
    };
    const onMove = (ev: MouseEvent) => {
      const drag = expandDragRef.current;
      if (!drag) return;
      const scale = baseScale * zoom;
      const client = (drag.dir === 'top' || drag.dir === 'bottom') ? ev.clientY : ev.clientX;
      const sign = (drag.dir === 'top' || drag.dir === 'left') ? -1 : 1;
      const deltaPx = (client - drag.startClient) * sign;
      const newPad = Math.max(0, Math.round((drag.startPad + deltaPx / scale) / 64) * 64);
      setExpandPadding(prev => ({ ...prev, [drag.dir]: newPad }));
    };
    const onUp = () => {
      expandDragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [expandPadding, baseScale, zoom]);


  return (
    <div
      className="absolute inset-0 z-40 bg-[#0a0a0f]"
      style={{
        opacity: isCanvasReady ? 1 : 0,
        transition: 'opacity 150ms ease-out',
        pointerEvents: isCanvasReady ? 'auto' : 'none',
      }}
    >
      {/* 笔刷大小预览光标 */}
      {showCursor && cursorPos && !spacePressed && !isPanning && !isGenerating && (() => {
        const scale = baseScale * zoom;

        // 方块模式：平滑十字准心 + 网格区域高亮
        if (brushShape === 'square' && canvasRef.current) {
          const rect = canvasRef.current.getBoundingClientRect();
          const imgX = (cursorPos.x - rect.left) / scale;
          const imgY = (cursorPos.y - rect.top) / scale;
          const gridSize = 8;
          const gridCount = Math.max(1, Math.round(brushSize / gridSize));
          const totalSize = gridCount * gridSize;
          const halfGrids = Math.floor(gridCount / 2);
          const centerCellX = Math.floor(imgX / gridSize);
          const centerCellY = Math.floor(imgY / gridSize);
          const gx = (centerCellX - halfGrids) * gridSize;
          const gy = (centerCellY - halfGrids) * gridSize;
          const screenLeft = gx * scale + rect.left;
          const screenTop = gy * scale + rect.top;
          const screenSize = totalSize * scale;

          return (
            <>
              {/* 网格格子高亮 */}
              <div
                className="fixed pointer-events-none z-50"
                style={{ left: screenLeft, top: screenTop }}
              >
                <div
                  style={{
                    width: screenSize,
                    height: screenSize,
                    background: isEraser ? 'rgba(239,68,68,0.25)' : 'rgba(168,85,247,0.3)',
                    border: isEraser ? '1px solid rgba(239,68,68,0.6)' : '1px solid rgba(255,255,255,0.5)',
                  }}
                />
              </div>
              {/* 平滑跟随的十字准心 */}
              <div
                className="fixed pointer-events-none z-50"
                style={{ left: cursorPos.x, top: cursorPos.y, transform: 'translate(-50%, -50%)' }}
              >
                <div style={{ width: 16, height: 16, position: 'relative' }}>
                  <div style={{ position: 'absolute', left: 7, top: 0, width: 2, height: 16, background: 'white', boxShadow: '0 0 2px rgba(0,0,0,0.8)' }} />
                  <div style={{ position: 'absolute', left: 0, top: 7, width: 16, height: 2, background: 'white', boxShadow: '0 0 2px rgba(0,0,0,0.8)' }} />
                </div>
              </div>
            </>
          );
        }

        // 圆形模式：自由光标
        const actualBrushSize = Math.max(2, brushSize - 8);
        return (
          <div
            className="fixed pointer-events-none z-50"
            style={{
              left: cursorPos.x,
              top: cursorPos.y,
              transform: 'translate(-50%, -50%)',
            }}
          >
            <div
              className={`${isEraser ? 'border-2 border-red-400' : 'border-[1.5px] border-white'}`}
              style={{
                width: actualBrushSize * scale,
                height: actualBrushSize * scale,
                borderRadius: '50%',
                boxShadow: isEraser ? 'none' : '0 0 0 1.5px rgba(0,0,0,0.7)',
              }}
            />
          </div>
        );
      })()}
      {/* 画布区域 - 全屏 */}
      <div
        ref={containerRef}
        className="absolute inset-0 overflow-hidden"
        style={{ cursor: undefined }}
      >
        {/* 网格背景 */}
        <div
          className="absolute inset-0 opacity-10"
          style={{
            backgroundImage: `
              linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px),
              linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px)
            `,
            backgroundSize: '20px 20px',
          }}
        />

        {/* 画布容器 - 使用绝对定位居中，避免 flex 在超出时的问题 */}
        <div
          className="absolute"
          style={{
            left: '50%',
            top: '50%',
            transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px))`,
          }}
        >
          {/* 扩图模式：拓宽区域可视化 + 拖拽把手 */}
          {isExpandMode && !isGenerating && (() => {
            const scale = baseScale * zoom;
            const pTop = expandPadding.top * scale;
            const pBottom = expandPadding.bottom * scale;
            const pLeft = expandPadding.left * scale;
            const pRight = expandPadding.right * scale;
            const totalW = displayWidth + pLeft + pRight;
            const totalH = displayHeight + pTop + pBottom;
            // 拖拽条样式
            const gripH = `repeating-linear-gradient(0deg, rgba(252,237,164,0.6) 0px, rgba(252,237,164,0.6) 1.5px, transparent 1.5px, transparent 5px)`;
            const gripV = `repeating-linear-gradient(90deg, rgba(252,237,164,0.6) 0px, rgba(252,237,164,0.6) 1.5px, transparent 1.5px, transparent 5px)`;
            const barStyle = { background: 'rgba(252,237,164,0.08)', border: '1px solid rgba(252,237,164,0.2)' } as const;
            return (
              <>
                {/* 拓宽区域 — 棋盘格纹理 */}
                {hasExpand && (
                  <>
                    {expandPadding.top > 0 && (
                      <div style={{ position: 'absolute', left: `${-pLeft}px`, top: `${-pTop}px`, width: `${totalW}px`, height: `${pTop}px`, background: 'repeating-conic-gradient(rgba(252,237,164,0.08) 0% 25%, transparent 0% 50%) 0 0 / 16px 16px', pointerEvents: 'none' }} />
                    )}
                    {expandPadding.bottom > 0 && (
                      <div style={{ position: 'absolute', left: `${-pLeft}px`, top: `${displayHeight}px`, width: `${totalW}px`, height: `${pBottom}px`, background: 'repeating-conic-gradient(rgba(252,237,164,0.08) 0% 25%, transparent 0% 50%) 0 0 / 16px 16px', pointerEvents: 'none' }} />
                    )}
                    {expandPadding.left > 0 && (
                      <div style={{ position: 'absolute', left: `${-pLeft}px`, top: '0px', width: `${pLeft}px`, height: `${displayHeight}px`, background: 'repeating-conic-gradient(rgba(252,237,164,0.08) 0% 25%, transparent 0% 50%) 0 0 / 16px 16px', pointerEvents: 'none' }} />
                    )}
                    {expandPadding.right > 0 && (
                      <div style={{ position: 'absolute', left: `${displayWidth}px`, top: '0px', width: `${pRight}px`, height: `${displayHeight}px`, background: 'repeating-conic-gradient(rgba(252,237,164,0.08) 0% 25%, transparent 0% 50%) 0 0 / 16px 16px', pointerEvents: 'none' }} />
                    )}
                    {/* 外边框 */}
                    <div style={{
                      position: 'absolute',
                      left: `${-pLeft}px`, top: `${-pTop}px`,
                      width: `${totalW}px`, height: `${totalH}px`,
                      border: '2px dashed rgba(252,237,164,0.7)',
                      boxShadow: '0 0 12px rgba(252,237,164,0.15)',
                      borderRadius: '2px',
                      pointerEvents: 'none', zIndex: 10,
                    }} />
                  </>
                )}
                {/* 分辨率标签 */}
                {hasExpand && (
                  <div style={{
                    position: 'absolute',
                    left: `${-pLeft}px`, top: `${-pTop - 26}px`,
                    background: 'rgba(252,237,164,0.9)',
                    color: '#1a1a1a', fontSize: '11px', fontWeight: 700,
                    padding: '2px 8px', borderRadius: '4px',
                    zIndex: 11, pointerEvents: 'none',
                    whiteSpace: 'nowrap', letterSpacing: '0.02em',
                  }}>
                    {imageWidth + expandPadding.left + expandPadding.right} x {imageHeight + expandPadding.top + expandPadding.bottom}
                  </div>
                )}
                {/* 上边拖拽条 */}
                <div
                  onMouseDown={(e) => handleExpandDragStart('top', e)}
                  style={{ position: 'absolute', left: 0, top: `${-pTop - 26}px`, width: `${displayWidth}px`, height: 26, cursor: 'ns-resize', zIndex: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: '6px 6px 0 0', ...barStyle }}
                >
                  <div style={{ width: 32, height: 14, backgroundImage: gripH, backgroundSize: '100% 14px' }} />
                  <ChevronsUp className="w-4 h-4" style={{ color: '#fceda4', flexShrink: 0 }} />
                  <div style={{ width: 32, height: 14, backgroundImage: gripH, backgroundSize: '100% 14px' }} />
                  {expandPadding.top > 0 && <span style={{ fontSize: 10, color: '#fceda4', fontFamily: 'monospace', marginLeft: 4 }}>{expandPadding.top}</span>}
                </div>
                {/* 下边拖拽条 */}
                <div
                  onMouseDown={(e) => handleExpandDragStart('bottom', e)}
                  style={{ position: 'absolute', left: 0, top: `${displayHeight + pBottom}px`, width: `${displayWidth}px`, height: 26, cursor: 'ns-resize', zIndex: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: '0 0 6px 6px', ...barStyle }}
                >
                  <div style={{ width: 32, height: 14, backgroundImage: gripH, backgroundSize: '100% 14px' }} />
                  <ChevronsDown className="w-4 h-4" style={{ color: '#fceda4', flexShrink: 0 }} />
                  <div style={{ width: 32, height: 14, backgroundImage: gripH, backgroundSize: '100% 14px' }} />
                  {expandPadding.bottom > 0 && <span style={{ fontSize: 10, color: '#fceda4', fontFamily: 'monospace', marginLeft: 4 }}>{expandPadding.bottom}</span>}
                </div>
                {/* 左边拖拽条 */}
                <div
                  onMouseDown={(e) => handleExpandDragStart('left', e)}
                  style={{ position: 'absolute', left: `${-pLeft - 26}px`, top: 0, width: 26, height: `${displayHeight}px`, cursor: 'ew-resize', zIndex: 12, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: '6px 0 0 6px', ...barStyle }}
                >
                  <div style={{ width: 14, height: 32, backgroundImage: gripV, backgroundSize: '14px 100%' }} />
                  <ChevronsLeft className="w-4 h-4" style={{ color: '#fceda4', flexShrink: 0 }} />
                  <div style={{ width: 14, height: 32, backgroundImage: gripV, backgroundSize: '14px 100%' }} />
                  {expandPadding.left > 0 && <span style={{ fontSize: 10, color: '#fceda4', fontFamily: 'monospace', marginTop: 4 }}>{expandPadding.left}</span>}
                </div>
                {/* 右边拖拽条 */}
                <div
                  onMouseDown={(e) => handleExpandDragStart('right', e)}
                  style={{ position: 'absolute', left: `${displayWidth + pRight}px`, top: 0, width: 26, height: `${displayHeight}px`, cursor: 'ew-resize', zIndex: 12, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: '0 6px 6px 0', ...barStyle }}
                >
                  <div style={{ width: 14, height: 32, backgroundImage: gripV, backgroundSize: '14px 100%' }} />
                  <ChevronsRight className="w-4 h-4" style={{ color: '#fceda4', flexShrink: 0 }} />
                  <div style={{ width: 14, height: 32, backgroundImage: gripV, backgroundSize: '14px 100%' }} />
                  {expandPadding.right > 0 && <span style={{ fontSize: 10, color: '#fceda4', fontFamily: 'monospace', marginTop: 4 }}>{expandPadding.right}</span>}
                </div>
              </>
            );
          })()}

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
                cursor: spacePressed || isPanning ? 'grab' : 'none',
                pointerEvents: 'auto',
              }}
              onPointerDown={handleMouseDown}
              onPointerMove={handleMouseMove}
              onPointerUp={handleMouseUp}
              onMouseEnter={handleMouseEnter}
              onMouseLeave={handleMouseLeaveCanvas}
              onWheel={handleWheel}
              onContextMenu={(e) => e.preventDefault()}
            />
            {/* 流式预览图 */}
            {isGenerating && (isExpandGeneratingRef.current ? previewUrl : compositeUrl) && (() => {
              if (isExpandGeneratingRef.current && previewUrl && expandGenSizeRef.current) {
                // 扩图预览：按扩展后的宽高比显示，居中在画布上
                const eg = expandGenSizeRef.current;
                const scale = Math.min(displayWidth / eg.width, displayHeight / eg.height);
                const pw = eg.width * scale;
                const ph = eg.height * scale;
                return (
                  <img src={previewUrl} alt="生成预览" style={{
                    width: `${pw}px`, height: `${ph}px`,
                    position: 'absolute',
                    top: `${(displayHeight - ph) / 2}px`,
                    left: `${(displayWidth - pw) / 2}px`,
                    pointerEvents: 'none',
                  }} />
                );
              }
              return (
                <img src={compositeUrl!} alt="生成预览" style={{
                  width: `${displayWidth}px`, height: `${displayHeight}px`,
                  position: 'absolute', top: 0, left: 0,
                  pointerEvents: 'none',
                }} />
              );
            })()}
            {/* 过渡预览：生成结束到新图加载之间，保留最后一帧避免闪烁 */}
            {!isGenerating && lastPreviewUrl && (() => {
              const eg = expandGenSizeRef.current;
              if (eg) {
                const scale = Math.min(displayWidth / eg.width, displayHeight / eg.height);
                const pw = eg.width * scale;
                const ph = eg.height * scale;
                return (
                  <img src={lastPreviewUrl} alt="过渡预览" style={{
                    width: `${pw}px`, height: `${ph}px`,
                    position: 'absolute',
                    top: `${(displayHeight - ph) / 2}px`,
                    left: `${(displayWidth - pw) / 2}px`,
                    pointerEvents: 'none', zIndex: 5,
                  }} />
                );
              }
              return (
                <img src={lastPreviewUrl} alt="过渡预览" style={{
                  width: `${displayWidth}px`, height: `${displayHeight}px`,
                  position: 'absolute', top: 0, left: 0,
                  pointerEvents: 'none', zIndex: 5,
                }} />
              );
            })()}
            {/* 裁切预览框 - 显示将被裁切发送的区域，支持 8 个手柄拖拽调整 */}
            {isCropMode && cropPreview && !isGenerating && (() => {
              const scale = baseScale * zoom;
              const HANDLE = 16;
              const startDrag = (
                e: React.PointerEvent<HTMLDivElement>,
                mode: 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw',
              ) => {
                e.preventDefault();
                e.stopPropagation();
                isDraggingCropRef.current = true;
                cropManuallyAdjustedRef.current = true;
                (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
                const startRect = { ...cropPreview };
                const startClientX = e.clientX;
                const startClientY = e.clientY;
                const onMove = (ev: PointerEvent) => {
                  const dx = (ev.clientX - startClientX) / scale;
                  const dy = (ev.clientY - startClientY) / scale;
                  let nx = startRect.x;
                  let ny = startRect.y;
                  let nw = startRect.width;
                  let nh = startRect.height;
                  const MIN = 256;
                  if (mode.includes('w')) { nx = startRect.x + dx; nw = startRect.width - dx; }
                  if (mode.includes('e')) { nw = startRect.width + dx; }
                  if (mode.includes('n')) { ny = startRect.y + dy; nh = startRect.height - dy; }
                  if (mode.includes('s')) { nh = startRect.height + dy; }
                  // 只做整数化，不做 64 对齐（API 对齐由 alignSendRect 在发送时处理）
                  nx = Math.round(nx); ny = Math.round(ny);
                  nw = Math.round(nw); nh = Math.round(nh);
                  // 最小尺寸
                  if (nw < MIN) {
                    if (mode.includes('w')) nx = startRect.x + startRect.width - MIN;
                    nw = MIN;
                  }
                  if (nh < MIN) {
                    if (mode.includes('n')) ny = startRect.y + startRect.height - MIN;
                    nh = MIN;
                  }
                  // 夹紧到图像范围
                  if (nx < 0) { nw += nx; nx = 0; }
                  if (ny < 0) { nh += ny; ny = 0; }
                  if (nx + nw > imageWidth) nw = imageWidth - nx;
                  if (ny + nh > imageHeight) nh = imageHeight - ny;
                  nw = Math.max(MIN, nw);
                  nh = Math.max(MIN, nh);
                  setCropPreview({ x: nx, y: ny, width: nw, height: nh });
                };
                const onUp = () => {
                  window.removeEventListener('pointermove', onMove);
                  window.removeEventListener('pointerup', onUp);
                  // 延迟清除标志，避免与随后在画布上触发的 mouseup 竞争
                  setTimeout(() => { isDraggingCropRef.current = false; }, 0);
                };
                window.addEventListener('pointermove', onMove);
                window.addEventListener('pointerup', onUp);
              };
              const ACCENT = '#fceda4';
              const CORNER_LEN = 28;   // 角手柄 L 形长度
              const CORNER_W = 5;      // 角手柄 L 形粗细
              const EDGE_LEN = 44;     // 边手柄长度
              const EDGE_W = 6;        // 边手柄粗细
              const EDGE_R = 3;        // 边手柄圆角

              // 角手柄：两条 L 型小线 + 透明大命中区
              const cornerHandle = (
                pos: 'nw' | 'ne' | 'sw' | 'se',
                cursor: string,
                cx: number,
                cy: number,
              ) => {
                const isN = pos.includes('n');
                const isW = pos.includes('w');
                const horiz: React.CSSProperties = {
                  position: 'absolute',
                  width: `${CORNER_LEN}px`,
                  height: `${CORNER_W}px`,
                  background: ACCENT,
                  borderRadius: '1px',
                  top: `${cy - CORNER_W / 2}px`,
                  left: isW ? `${cx - CORNER_W / 2}px` : `${cx - CORNER_LEN + CORNER_W / 2}px`,
                };
                const vert: React.CSSProperties = {
                  position: 'absolute',
                  width: `${CORNER_W}px`,
                  height: `${CORNER_LEN}px`,
                  background: ACCENT,
                  borderRadius: '1px',
                  top: isN ? `${cy - CORNER_W / 2}px` : `${cy - CORNER_LEN + CORNER_W / 2}px`,
                  left: `${cx - CORNER_W / 2}px`,
                };
                const hit: React.CSSProperties = {
                  position: 'absolute',
                  width: '32px',
                  height: '32px',
                  top: `${cy - 16}px`,
                  left: `${cx - 16}px`,
                  cursor,
                  pointerEvents: 'auto',
                };
                return (
                  <Fragment key={pos}>
                    <div style={horiz} />
                    <div style={vert} />
                    <div onPointerDown={(e) => startDrag(e, pos)} style={hit} />
                  </Fragment>
                );
              };

              // 边手柄：胶囊条 + 透明大命中区
              const edgeHandle = (
                pos: 'n' | 's' | 'e' | 'w',
                cursor: string,
                cx: number,
                cy: number,
              ) => {
                const horizontal = pos === 'n' || pos === 's';
                const visual: React.CSSProperties = {
                  position: 'absolute',
                  width: horizontal ? `${EDGE_LEN}px` : `${EDGE_W}px`,
                  height: horizontal ? `${EDGE_W}px` : `${EDGE_LEN}px`,
                  background: ACCENT,
                  borderRadius: `${EDGE_R}px`,
                  top: horizontal ? `${cy - EDGE_W / 2}px` : `${cy - EDGE_LEN / 2}px`,
                  left: horizontal ? `${cx - EDGE_LEN / 2}px` : `${cx - EDGE_W / 2}px`,
                };
                const hit: React.CSSProperties = {
                  position: 'absolute',
                  width: horizontal ? '60px' : '20px',
                  height: horizontal ? '20px' : '60px',
                  top: horizontal ? `${cy - 10}px` : `${cy - 30}px`,
                  left: horizontal ? `${cx - 30}px` : `${cx - 10}px`,
                  cursor,
                  pointerEvents: 'auto',
                };
                return (
                  <Fragment key={pos}>
                    <div style={visual} />
                    <div onPointerDown={(e) => startDrag(e, pos)} style={hit} />
                  </Fragment>
                );
              };

              const rx = cropPreview.x * scale;
              const ry = cropPreview.y * scale;
              const rw = cropPreview.width * scale;
              const rh = cropPreview.height * scale;
              const cxMid = rx + rw / 2;
              const cyMid = ry + rh / 2;
              return (
                <div
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: `${displayWidth}px`,
                    height: `${displayHeight}px`,
                    pointerEvents: 'none',
                    zIndex: 5,
                  }}
                >
                  {/* 上下左右四块半透明遮罩 */}
                  <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: `${ry}px`, background: 'rgba(0,0,0,0.4)' }} />
                  <div style={{ position: 'absolute', top: `${ry + rh}px`, left: 0, width: '100%', bottom: 0, background: 'rgba(0,0,0,0.4)' }} />
                  <div style={{ position: 'absolute', top: `${ry}px`, left: 0, width: `${rx}px`, height: `${rh}px`, background: 'rgba(0,0,0,0.4)' }} />
                  <div style={{ position: 'absolute', top: `${ry}px`, left: `${rx + rw}px`, right: 0, height: `${rh}px`, background: 'rgba(0,0,0,0.4)' }} />
                  {/* 裁切框：外缘黑 + 内层主题黄 */}
                  <div
                    style={{
                      position: 'absolute',
                      top: `${ry}px`,
                      left: `${rx}px`,
                      width: `${rw}px`,
                      height: `${rh}px`,
                      boxShadow: [
                        '0 0 0 1.5px rgba(0,0,0,0.6)',
                        `inset 0 0 0 2px ${ACCENT}`,
                      ].join(', '),
                      pointerEvents: 'none',
                    }}
                  />
                  {/* 三分构图辅助线 */}
                  <div style={{ position: 'absolute', top: `${ry}px`, left: `${rx + rw / 3}px`, width: '1px', height: `${rh}px`, background: 'rgba(252, 237, 164, 0.18)', pointerEvents: 'none' }} />
                  <div style={{ position: 'absolute', top: `${ry}px`, left: `${rx + rw * 2 / 3}px`, width: '1px', height: `${rh}px`, background: 'rgba(252, 237, 164, 0.18)', pointerEvents: 'none' }} />
                  <div style={{ position: 'absolute', top: `${ry + rh / 3}px`, left: `${rx}px`, width: `${rw}px`, height: '1px', background: 'rgba(252, 237, 164, 0.18)', pointerEvents: 'none' }} />
                  <div style={{ position: 'absolute', top: `${ry + rh * 2 / 3}px`, left: `${rx}px`, width: `${rw}px`, height: '1px', background: 'rgba(252, 237, 164, 0.18)', pointerEvents: 'none' }} />
                  {/* 4 个角手柄（L 型） */}
                  {cornerHandle('nw', 'nwse-resize', rx, ry)}
                  {cornerHandle('ne', 'nesw-resize', rx + rw, ry)}
                  {cornerHandle('sw', 'nesw-resize', rx, ry + rh)}
                  {cornerHandle('se', 'nwse-resize', rx + rw, ry + rh)}
                  {/* 4 个边手柄（胶囊条） */}
                  {edgeHandle('n', 'ns-resize', cxMid, ry)}
                  {edgeHandle('s', 'ns-resize', cxMid, ry + rh)}
                  {edgeHandle('w', 'ew-resize', rx, cyMid)}
                  {edgeHandle('e', 'ew-resize', rx + rw, cyMid)}
                  {/* 尺寸标签 */}
                  <div style={{
                    position: 'absolute',
                    top: `${ry - 24}px`,
                    left: `${rx}px`,
                    background: 'rgba(252, 237, 164, 0.95)',
                    color: 'black',
                    fontSize: '11px',
                    fontWeight: 600,
                    padding: '2px 6px',
                    borderRadius: '4px',
                    pointerEvents: 'none',
                  }}>
                    {cropPreview.width}x{cropPreview.height}
                  </div>
                </div>
              );
            })()}
            {/* 对比原图覆盖层 - 按住时显示生成前快照，扩图时遮挡新增区域 */}
            {showOriginal && snapshotRef.current && (() => {
              const snap = snapshotRef.current!;
              const s = displayWidth / imageWidth;
              const offL = snap.padLeft * s;
              const offT = snap.padTop * s;
              const origW = snap.width * s;
              const origH = snap.height * s;
              return (
                <div style={{ position: 'absolute', top: 0, left: 0, width: `${displayWidth}px`, height: `${displayHeight}px`, zIndex: 50, pointerEvents: 'none' }}>
                  {/* 原图区域显示旧图快照 */}
                  <img src={snap.url} alt="原图对比" style={{
                    position: 'absolute', top: `${offT}px`, left: `${offL}px`,
                    width: `${origW}px`, height: `${origH}px`,
                    display: 'block',
                  }} />
                  {/* 用深色遮挡扩图新增区域（普通重绘时这些条件都 false，不显示） */}
                  {offT > 0 && <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: `${offT}px`, background: '#0a0a0f' }} />}
                  {offT + origH < displayHeight && <div style={{ position: 'absolute', bottom: 0, left: 0, width: '100%', height: `${displayHeight - offT - origH}px`, background: '#0a0a0f' }} />}
                  {offL > 0 && <div style={{ position: 'absolute', top: `${offT}px`, left: 0, width: `${offL}px`, height: `${origH}px`, background: '#0a0a0f' }} />}
                  {offL + origW < displayWidth && <div style={{ position: 'absolute', top: `${offT}px`, right: 0, width: `${displayWidth - offL - origW}px`, height: `${origH}px`, background: '#0a0a0f' }} />}
                </div>
              );
            })()}
          </div>
        </div>

        {/* 生成进度条 - 和正常生成一样的样式 */}
        <div
          className={`absolute bottom-20 left-1/2 -translate-x-1/2 z-20 transition-all duration-300 ease-out ${isGenerating && totalSteps > 0
            ? 'opacity-100 translate-y-0'
            : 'opacity-0 translate-y-4 pointer-events-none'
            }`}
        >
          <div className="bg-gray-900/90 backdrop-blur-sm px-4 py-2 rounded-full shadow-xl border border-gray-600/50 h-9 flex items-center justify-center">
            <div className="flex items-center gap-3">
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
      </div>

      {/* 顶部悬浮工具栏 - 生成时隐藏 */}
      {
        !isGenerating && (
          <div className="absolute top-8 left-4 right-4 flex items-center justify-center pointer-events-none">
            <div className="flex items-center gap-2 flex-wrap justify-center">
              {/* 笔刷工具 */}
              <div className="flex items-center gap-1 bg-gray-900/90 backdrop-blur-md rounded-xl p-1 border border-white/10 shadow-xl h-11 pointer-events-auto">
                <button
                  className={`h-9 w-9 flex items-center justify-center rounded-lg transition-all ${!isEraser ? 'bg-nai-accent text-black' : 'text-gray-400 hover:text-white hover:bg-white/10'
                    }`}
                  onClick={() => setIsEraser(false)}
                  title="笔刷"
                >
                  <Brush className="w-[18px] h-[18px]" />
                </button>
                <button
                  className={`h-9 w-9 flex items-center justify-center rounded-lg transition-all ${isEraser ? 'bg-nai-accent text-black' : 'text-gray-400 hover:text-white hover:bg-white/10'
                    }`}
                  onClick={() => setIsEraser(true)}
                  title="橡皮擦"
                >
                  <Eraser className="w-[18px] h-[18px]" />
                </button>
              </div>

              {/* 笔刷形状 */}
              <div className="flex items-center gap-1 bg-gray-900/90 backdrop-blur-md rounded-xl p-1 border border-white/10 shadow-xl h-11 pointer-events-auto">
                <button
                  className={`h-9 w-9 flex items-center justify-center rounded-lg transition-all ${brushShape === 'square' ? 'bg-white/20 text-white' : 'text-gray-400 hover:text-white hover:bg-white/10'
                    }`}
                  onClick={() => setBrushShape('square')}
                  title="方形笔刷"
                >
                  <Square className="w-[18px] h-[18px]" />
                </button>
                <button
                  className={`h-9 w-9 flex items-center justify-center rounded-lg transition-all ${brushShape === 'circle' ? 'bg-white/20 text-white' : 'text-gray-400 hover:text-white hover:bg-white/10'
                    }`}
                  onClick={() => setBrushShape('circle')}
                  title="圆形笔刷"
                >
                  <Circle className="w-[18px] h-[18px]" />
                </button>
              </div>

              {/* 笔刷大小 */}
              <div className="flex items-center gap-2 bg-gray-900/90 backdrop-blur-md rounded-xl px-3 border border-white/10 shadow-xl whitespace-nowrap h-11 pointer-events-auto">
                <span className="text-xs text-gray-400">大小</span>
                <input
                  type="range"
                  min="5"
                  max="200"
                  value={brushSize}
                  onChange={(e) => setBrushSize(Number(e.target.value))}
                  className="w-26 accent-nai-accent h-1 bg-gray-700 rounded-full appearance-none cursor-pointer flex-shrink-0"
                />
                <span className="text-xs text-white font-mono w-8 text-right">{brushSize}</span>
              </div>

              {/* 局部重绘模式切换 */}
              <button
                onClick={() => {
                  // 未在局部模式且已有涂抹时点击：直接进入局部模式并立即显示裁切预览 UI
                  if (!isCropMode && history.length > 0 && !isExpandMode) {
                    cropManuallyAdjustedRef.current = false;
                    setIsCropMode(true);
                    setIsExpandMode(false);
                    resetExpand();
                    triggerCropHint();
                    // 同步计算裁切矩形，避免 updateCropPreview 闭包里读到旧的 isCropMode=false
                    const mc = maskCanvasRef.current;
                    if (mc) {
                      const ctx = mc.getContext('2d');
                      if (ctx) {
                        const maskData = ctx.getImageData(0, 0, imageWidth, imageHeight);
                        setCropPreview(calculateCropRect(maskData, imageWidth, imageHeight));
                      }
                    }
                    return;
                  }
                  const next = !isCropMode;
                  setIsCropMode(next);
                  if (next) {
                    cropManuallyAdjustedRef.current = false;
                    setIsExpandMode(false);
                    resetExpand();
                    updateCropPreview();
                    triggerCropHint();
                  } else {
                    cropManuallyAdjustedRef.current = false;
                    setCropPreview(null);
                  }
                }}
                disabled={isExpandMode}
                className={`flex items-center gap-1.5 bg-gray-900/90 backdrop-blur-md rounded-xl px-3 border shadow-xl h-11 transition-all pointer-events-auto ${isCropMode
                  ? 'text-black bg-nai-accent border-nai-accent'
                  : isExpandMode
                    ? 'text-gray-600 border-white/5 cursor-not-allowed'
                    : 'text-gray-400 hover:text-white border-white/10'
                  }`}
                title="局部重绘 - 仅裁切遮罩区域发送重绘，节省点数；已有涂抹时点击会直接显示裁切预览"
              >
                <Crop className="w-[18px] h-[18px]" />
                <span className="text-xs">局部</span>
              </button>

              {/* 扩图模式切换 */}
              <button
                onClick={() => {
                  const entering = !isExpandMode;
                  setIsExpandMode(entering);
                  if (entering) {
                    resetExpand();
                    setIsCropMode(false);
                    setCropPreview(null);
                  } else {
                    resetExpand();
                  }
                }}
                className={`flex items-center gap-1.5 bg-gray-900/90 backdrop-blur-md rounded-xl px-3 border shadow-xl h-11 transition-all pointer-events-auto ${isExpandMode
                  ? 'text-black bg-nai-accent border-nai-accent'
                  : hasExpand
                    ? 'text-nai-accent border-nai-accent/50'
                    : 'text-gray-400 hover:text-white border-white/10'
                  }`}
                title="扩图"
              >
                <Expand className="w-[18px] h-[18px]" />
                <span className="text-xs">{isExpandMode ? '完成' : '扩图'}</span>
              </button>

            </div>
          </div>
        )
      }

      {/* 底部悬浮工具栏 - 生成时隐藏 */}
      {
        !isGenerating && (
          <div className="absolute bottom-8 left-4 right-4 flex flex-col items-center justify-center pointer-events-none">
            {/* 操作提示 toast - 底部控件上方，自动消失 */}
            {!isExpandMode && !showCropHint && (
              <div
                className="mb-2 pointer-events-none"
                style={{
                  opacity: showHintToast ? 1 : 0,
                  transition: 'opacity 500ms ease-out',
                }}
              >
                <div className="text-xs text-gray-200 bg-gray-900/80 rounded-lg px-4 py-2 border border-white/10 whitespace-nowrap">
                  {'滚轮缩放 · 中键/空格拖动 · Esc退出'}
                </div>
              </div>
            )}
            {/* 局部模式提示 toast */}
            {!isExpandMode && showCropHint && (
              <div
                className="mb-2 pointer-events-none"
                style={{
                  opacity: 1,
                  transition: 'opacity 500ms ease-out',
                }}
              >
                <div className="text-xs text-gray-200 bg-gray-900/80 rounded-lg px-4 py-2 border border-white/10 whitespace-nowrap">
                  {'涂抹区域将自动框选为发送范围'}
                </div>
              </div>
            )}

            <div className="flex items-center gap-2 flex-wrap justify-center">
              {/* 撤销/清空 */}
              <div className="flex items-center bg-gray-900/90 backdrop-blur-md rounded-xl p-1 border border-white/10 shadow-xl h-11 pointer-events-auto">
                <button
                  onClick={handleUndo}
                  disabled={history.length === 0}
                  className="h-9 w-9 flex items-center justify-center rounded-lg text-red-400 hover:text-red-300 hover:bg-white/10 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                  title="撤销"
                >
                  <Undo2 className="w-[18px] h-[18px]" />
                </button>
                <button
                  onClick={() => { handleClear(); if (isExpandMode) resetExpand(); }}
                  className="h-9 w-9 flex items-center justify-center rounded-lg text-red-400 hover:text-red-300 hover:bg-white/10 transition-all"
                  title={isExpandMode ? '重置扩图' : '清空遮罩'}
                >
                  <RotateCcw className="w-[18px] h-[18px]" />
                </button>
              </div>

              {/* 按住对比原图 - 生成过后显示 */}
              {hasSnapshot && !isGenerating && (
                <button
                  onMouseDown={() => setShowOriginal(true)}
                  onMouseUp={() => setShowOriginal(false)}
                  onMouseLeave={() => setShowOriginal(false)}
                  className={`flex items-center gap-1.5 bg-gray-900/90 backdrop-blur-md rounded-xl px-3 border shadow-xl h-11 pointer-events-auto ${showOriginal ? 'text-black bg-nai-accent border-nai-accent' : 'text-gray-400 hover:text-white border-white/10'}`}
                  title="按住对比原图"
                >
                  <Eye className="w-[18px] h-[18px]" />
                  <span className="text-xs">对比</span>
                </button>
              )}

              {/* 重绘强度 */}
              <div className="flex items-center gap-2 bg-gray-900/90 backdrop-blur-md rounded-xl px-3 border border-white/10 shadow-xl whitespace-nowrap h-11 pointer-events-auto">
                <span className="text-xs text-gray-400">强度</span>
                <input
                  type="range"
                  min="0.1"
                  max="1"
                  step="0.05"
                  value={strength}
                  onChange={(e) => handleStrengthChange(Number(e.target.value))}
                  className="w-22 accent-nai-accent h-1 bg-gray-700 rounded-full appearance-none cursor-pointer flex-shrink-0"
                />
                <span className="text-xs text-white font-mono w-9">{strength.toFixed(2)}</span>
              </div>

              {/* 操作按钮 */}
              <div className="flex items-center bg-gray-900/90 backdrop-blur-md rounded-xl border border-white/10 shadow-xl h-11 pointer-events-auto">
                <button
                  onClick={onClose}
                  className="h-11 px-3 text-xs text-gray-400 hover:text-white transition-colors"
                >
                  退出
                </button>
                <button
                  onClick={handleGenerate}
                  disabled={isGenerating || (isExpandMode && !hasExpand)}
                  className="h-9 flex items-center gap-1.5 px-4 bg-nai-accent hover:bg-nai-accent/80 text-black rounded-lg text-xs font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed mr-1"
                >
                  <Play className="w-4 h-4" />
                  {isGenerating ? '生成中...' : isExpandMode ? '开始扩图' : '开始重绘'}
                  {!isGenerating && (
                    <span className="flex items-center gap-0.5 bg-black/15 px-1.5 py-0.5 rounded text-[11px] font-mono font-bold">
                      {costInfo.total}<span>💎</span>
                    </span>
                  )}
                </button>
              </div>
            </div>

          </div>
        )
      }

    </div >
  );
};
