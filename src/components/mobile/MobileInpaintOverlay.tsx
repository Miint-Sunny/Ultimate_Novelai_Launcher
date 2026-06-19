import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { calculateCostFromUI } from '../../services/costCalculator';
import { getCachedIsOpus } from '../../services/novelai';
import { getAISettings } from '../../services/localLibrary';
import { calculateCropRect, alignSendRect, type CropRect } from '../../utils/maskCrop';
import { MobileInpaintBottomToolbar } from './inpaint/MobileInpaintBottomToolbar';
import { MobileInpaintCompareOverlay, type InpaintSnapshot } from './inpaint/MobileInpaintCompareOverlay';
import { buildExpandPayload } from './inpaint/expandPayload';
import { MobileInpaintCropPreview } from './inpaint/MobileInpaintCropPreview';
import { MobileInpaintExpandOverlay } from './inpaint/MobileInpaintExpandOverlay';
import { MobileInpaintHeader } from './inpaint/MobileInpaintHeader';
import { MobileInpaintProgressPill } from './inpaint/MobileInpaintProgressPill';
import { calculateBaseScale } from './inpaint/scaleUtils';
import { getMaskBase64FromCanvas } from './inpaint/maskUtils';
import { useInpaintCompositePreview } from './inpaint/useInpaintCompositePreview';
import { useInpaintCanvasLoader } from './inpaint/useInpaintCanvasLoader';
import { useInpaintDrawing, type BrushShape } from './inpaint/useInpaintDrawing';

// 扩图相关类型与 payload 构建已抽到 ./inpaint/expandPayload.ts；
// 此处 re-export 保持对外类型 API 稳定（useMobileInpaintBridge 直接 import ExpandPayload）。
import type { ExpandPayload } from './inpaint/expandPayload';
export type { ExpandSelection, ExpandPayload } from './inpaint/expandPayload';

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

  // 扩图模式（上下左右箭头拓宽）
  const [isExpandMode, setIsExpandMode] = useState(false);
  const [expandPadding, setExpandPadding] = useState({ top: 0, bottom: 0, left: 0, right: 0 });
  const EXPAND_STEP = 64;
  const resetExpand = useCallback(() => {
    setExpandPadding({ top: 0, bottom: 0, left: 0, right: 0 });
  }, []);

  // 裁切重绘模式
  const [isCropMode, setIsCropMode] = useState(false);
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
  const baseScale = useMemo(
    () => calculateBaseScale(containerSize, imageWidth, imageHeight, expandPadding, isExpandMode),
    [imageWidth, imageHeight, expandPadding, isExpandMode, containerSize],
  );

  const {
    historyLength,
    setHistory,
    cropPreview,
    setCropPreview,
    updateCropPreview,
    handleUndo,
    handleClear,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
  } = useInpaintDrawing({
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
    onZoomChange: setZoom,
    onPanChange: setPan,
  });

  // 进入/退出扩图模式时重置
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [isExpandMode]);

  const { loadedImageRef } = useInpaintCanvasLoader({
    canvasRef,
    maskCanvasRef,
    imageUrl,
    imageWidth,
    imageHeight,
    baseScale,
    initialMask,
    onResetExpand: resetExpand,
    onCropPreviewChange: setCropPreview,
    onHistoryChange: setHistory,
    onCanvasReadyChange: setIsCanvasReady,
  });
  const compositeUrl = useInpaintCompositePreview({
    previewUrl,
    canvasRef,
    maskCanvasRef,
    imageWidth,
    imageHeight,
    activeGenRectRef,
  });

  // 8x8 网格区域扩张 + base64 读取：见 ./inpaint/maskUtils.ts

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
      const result = buildExpandPayload(loadedImageRef.current, imageWidth, imageHeight, expandPadding);
      if (!result) return;
      activeGenRectRef.current = result.genRect;
      onGenerate(result.maskBase64, strength, undefined, result.payload);
      return;
    }

    // ===== 普通遮罩 / 裁切重绘模式 =====
    const maskBase64 = getMaskBase64FromCanvas(maskCanvasRef.current, imageWidth, imageHeight);

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
        historyLength={historyLength}
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
