import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Eraser, Undo2, RotateCcw, Play, Square, Circle, Brush, Eye, Expand, Crop, ChevronsUp, ChevronsDown, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { calculateCostFromUI } from '../services/costCalculator';
import { getCachedIsOpus, isOpusUsageExhausted } from '../services/novelai';
import { getAISettings } from '../services/localLibrary';
import { calculateCropRect, alignSendRect, focusSendSize, type CropRect } from '../utils/maskCrop';
import { CropSelectionOverlay } from './inpaint/CropSelectionOverlay';
import { useInpaintBrush } from './inpaint/useInpaintBrush';
import { buildExpandPayload } from './inpaint/expandPayload';
import { buildBoxMask, getMaskBase64FromCanvas, maskHasPaintInside } from './inpaint/maskUtils';
import type { ExpandPayload } from './inpaint/types';
import { useInpaintCanvas } from './inpaint/useInpaintCanvas';
import { useInpaintKeyboard } from './inpaint/useInpaintKeyboard';
import { useInpaintPreviewComposite } from './inpaint/useInpaintPreviewComposite';

export type { ExpandPayload, ExpandSelection } from './inpaint/types';

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

  // 扩图模式（拖拽边缘拓宽）
  const [isExpandMode, setIsExpandMode] = useState(false);
  const [expandPadding, setExpandPadding] = useState({ top: 0, bottom: 0, left: 0, right: 0 });
  const resetExpand = useCallback(() => {
    setExpandPadding({ top: 0, bottom: 0, left: 0, right: 0 });
  }, []);
  const expandDragRef = useRef<{ dir: 'top' | 'bottom' | 'left' | 'right'; startClient: number; startPad: number } | null>(null);
  const isExpandGeneratingRef = useRef(false); // 当前生成是否为扩图模式
  const expandGenSizeRef = useRef<{ width: number; height: number } | null>(null); // 扩图生成的目标尺寸

  // 裁切重绘模式 - 图像超出免费分辨率阈值（1024*1024）时默认开启以节省点数
  const [isCropMode, setIsCropMode] = useState(() => imageWidth * imageHeight > 1048576);
  const [cropPreview, setCropPreview] = useState<CropRect | null>(null);
  // 上下文内边距(原图像素,照官方焦点重绘的「最小上下文区」):遮罩外接框往外扩这么多进发送区,
  // 框内靠边这一圈模型看得见但不重绘;框内没画遮罩时,整框去掉这一圈就是重绘区。
  const [contextPadding, setContextPadding] = useState(128);
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
  const {
    compositeUrl,
    lastPreviewUrl,
    setLastPreviewUrl,
    activeGenRectRef,
  } = useInpaintPreviewComposite({
    canvasRef,
    maskCanvasRef,
    previewUrl,
    imageWidth,
    imageHeight,
    isExpandGeneratingRef,
  });
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

  const {
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
  } = useInpaintBrush({
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
    cropContextPadding: contextPadding,
  });

  useInpaintKeyboard({
    onClose,
    setSpacePressed,
    setIsPanning,
  });

  const { loadedImageRef } = useInpaintCanvas({
    canvasRef,
    maskCanvasRef,
    imageUrl,
    imageWidth,
    imageHeight,
    baseScale,
    initialMask,
    lastPreviewUrl,
    setLastPreviewUrl,
    setHistory,
    setCropPreview,
    setIsCanvasReady,
    resetExpand,
  });

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
      const img = loadedImageRef.current;
      if (!img) return;

      const expandResult = buildExpandPayload({
        image: img,
        imageWidth,
        imageHeight,
        expandPadding,
      });
      if (!expandResult) return;

      // 扩图：预览图覆盖选区对应的图片区域
      activeGenRectRef.current = {
        x: 0,
        y: 0,
        width: expandResult.selection.width,
        height: expandResult.selection.height,
      };
      onGenerate(expandResult.maskBase64, strength, undefined, expandResult.payload);
      return;
    }

    // ===== 普通遮罩 / 裁切重绘模式 =====
    let maskBase64 = getMaskBase64FromCanvas(maskCanvasRef.current, imageWidth, imageHeight);

    let cropRect: CropRect | undefined;
    if (isCropMode) {
      // 优先使用用户手动调整后的预览矩形，否则从遮罩重算
      if (cropPreview) {
        cropRect = cropPreview;
        // 照官方:框内没画遮罩就整框重绘,只留上下文内边距那一圈不动
        if (!maskHasPaintInside(maskCanvasRef.current, cropPreview)) {
          maskBase64 = buildBoxMask(cropPreview, contextPadding, imageWidth, imageHeight);
        }
      } else if (maskCanvasRef.current) {
        const maskCtx = maskCanvasRef.current.getContext('2d');
        if (maskCtx) {
          const maskData = maskCtx.getImageData(0, 0, imageWidth, imageHeight);
          const rect = calculateCropRect(maskData, imageWidth, imageHeight, contextPadding);
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
      // 焦点重绘:64 对齐后再放大到 ~1MP 发送,估价按实际发送尺寸
      const sent = focusSendSize(alignSendRect(cropPreview, imageWidth, imageHeight));
      return { width: sent.width, height: sent.height };
    }
    return { width: imageWidth, height: imageHeight };
  }, [isExpandMode, hasExpand, expandPadding, isCropMode, cropPreview, imageWidth, imageHeight]);

  // 本次生成的点数消耗（模型固定用 v4.5-full 估算，公式与模型无关）
  const costInfo = useMemo(() => {
    const ai = getAISettings();
    return calculateCostFromUI({
    // V5 体力条耗尽后 NAI 静默改扣 Anlas；不带上这个标志，界面会一直显示「免费」
    opusUsageExhausted: isOpusUsageExhausted(),
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
            {isCropMode && cropPreview && !isGenerating && (
              <CropSelectionOverlay
                cropPreview={cropPreview}
                displayWidth={displayWidth}
                displayHeight={displayHeight}
                imageWidth={imageWidth}
                imageHeight={imageHeight}
                scale={baseScale * zoom}
                isDraggingCropRef={isDraggingCropRef}
                cropManuallyAdjustedRef={cropManuallyAdjustedRef}
                setCropPreview={setCropPreview}
                contextPadding={contextPadding}
              />
            )}
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
                        setCropPreview(calculateCropRect(maskData, imageWidth, imageHeight, contextPadding));
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

              {/* 上下文内边距(官方焦点重绘的「最小上下文区」):框内红边那一圈只给模型看、不重绘 */}
              {isCropMode && !isExpandMode && (
                <div
                  className="flex items-center gap-2 bg-gray-900/90 backdrop-blur-md rounded-xl px-3 border border-white/10 shadow-xl h-11 pointer-events-auto"
                  title="上下文:遮罩外接框往外扩这么多一起发给模型看但不重绘;框内没画遮罩时,整框去掉这一圈就是重绘区。发送前会把框内放大到约 1MP 再重绘,细节更好,Opus 免费档内不扣点"
                >
                  <span className="text-xs text-gray-400 whitespace-nowrap">上下文</span>
                  <input
                    type="range"
                    min={0}
                    max={256}
                    step={16}
                    value={contextPadding}
                    onChange={(e) => {
                      const next = Number(e.target.value);
                      setContextPadding(next);
                      // 自动框跟着上下文重算;用户手动拖过的框不动
                      if (!cropManuallyAdjustedRef.current && maskCanvasRef.current) {
                        const ctx = maskCanvasRef.current.getContext('2d');
                        if (ctx) setCropPreview(calculateCropRect(ctx.getImageData(0, 0, imageWidth, imageHeight), imageWidth, imageHeight, next));
                      }
                    }}
                    className="w-20 accent-nai-accent h-1 bg-gray-700 rounded-full appearance-none cursor-pointer flex-shrink-0"
                  />
                  <span className="text-xs text-white font-mono w-8 text-right">{contextPadding}</span>
                </div>
              )}

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
