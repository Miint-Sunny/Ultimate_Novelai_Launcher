import React, { useEffect, useState } from 'react';
import { Image as ImageIcon, ImagePlus, Maximize2, Paintbrush, Wrench } from 'lucide-react';
import { useGeneration } from '../../../contexts/GenerationContext';
import { registerBackHandler } from '../MobileLayout';
import { MobileInpaintOverlay } from '../MobileInpaintOverlay';
import { MobileUpscaleSheet } from '../MobileUpscaleSheet';
import { useMobileInpaintBridge } from '../gallery/useMobileInpaintBridge';
import { useMobileUpscaleCompletion } from '../gallery/useMobileUpscaleCompletion';

interface MobileStudioPageProps {
  onOverlayStateChange?: (open: boolean) => void;
}

// 创作室页(页 2,最小可用版,P3):
// 来源图区(当前图 + 最近生成缩略条 + 导入入口)+ 操作卡两张(重绘/放大),
// 覆盖物复用现有 MobileInpaintOverlay / MobileUpscaleSheet,不重写业务。
// 手势:本页出让水平竞技场给壳(缩略条用 grid 平铺,不做横滑);
// 图库工具条的「重绘/放大」经壳跳本页后由 'studio-open-tool' 事件触发对应操作卡。
export const MobileStudioPage: React.FC<MobileStudioPageProps> = ({ onOverlayStateChange }) => {
  const {
    isGenerating,
    isQueuing,
    currentStep,
    totalSteps,
    previewUrl,
    imageUrl,
    currentSeed,
    targetWidth,
    targetHeight,
    history,
    selectHistoryItem,
    addUpscaledImage,
  } = useGeneration();

  const [isUpscaleOpen, setIsUpscaleOpen] = useState(false);
  const {
    isInpaintMode,
    isInpainting,
    initialMask,
    inpaintOriginalImage,
    inpaintDimensions,
    openInpaintMode,
    handleInpaintGenerate,
    handleCloseInpaint,
  } = useMobileInpaintBridge({
    imageUrl,
    targetWidth,
    targetHeight,
    isGenerating,
    isQueuing,
    listenGlobalOpenEvent: false,
  });

  const hasImage = !!imageUrl && !isGenerating && !isInpaintMode;

  // 覆盖物打开期间上报壳(壳手势整体失效)
  useEffect(() => {
    onOverlayStateChange?.(isInpaintMode || isUpscaleOpen);
  }, [isInpaintMode, isUpscaleOpen, onOverlayStateChange]);

  // 返回键:覆盖物优先关闭(与图库 back stack 同一注册表语义)
  useEffect(() => registerBackHandler(() => {
    if (isInpaintMode) {
      handleCloseInpaint();
      return true;
    }
    if (isUpscaleOpen) {
      setIsUpscaleOpen(false);
      return true;
    }
    return false;
  }), [isInpaintMode, isUpscaleOpen, handleCloseInpaint]);

  // 壳导航到本页后触发对应操作卡(图库工具条「重绘/放大」)
  useEffect(() => {
    const handler = (event: Event) => {
      const tool = (event as CustomEvent).detail?.tool;
      if (tool === 'inpaint' && hasImage) openInpaintMode();
      if (tool === 'upscale' && hasImage) setIsUpscaleOpen(true);
    };
    window.addEventListener('studio-open-tool', handler);
    return () => window.removeEventListener('studio-open-tool', handler);
  }, [hasImage, openInpaintMode]);

  const handleUpscaleComplete = useMobileUpscaleCompletion({ currentSeed, addUpscaledImage });

  const recentHistory = history.slice(0, 8);

  return (
    <div className="flex flex-col h-full bg-nai-bg">
      <header className="flex-shrink-0 flex items-center gap-2 px-4 py-3 bg-nai-panel border-b border-gray-800">
        <Wrench className="w-5 h-5 text-gray-400" />
        <span className="font-medium">创作室</span>
      </header>

      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
        {/* 来源图区 */}
        <section className="bg-nai-panel border border-gray-800 rounded-xl p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-300">来源图</span>
            <button
              onClick={() => window.dispatchEvent(new CustomEvent('pager-navigate', { detail: { page: 1 } }))}
              title="到生图页导入新图"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-gray-400 bg-gray-800 active:bg-gray-700 transition-colors"
            >
              <ImagePlus className="w-3.5 h-3.5" />
              导入
            </button>
          </div>

          {imageUrl ? (
            <div className="flex items-center justify-center bg-black/30 rounded-lg p-2">
              <img
                src={imageUrl}
                alt="当前图"
                className="max-h-48 max-w-full object-contain rounded-lg"
              />
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-8 text-gray-500">
              <ImageIcon className="w-10 h-10 opacity-20 mb-1" />
              <span className="text-xs">暂无当前图,先在生图页生成或导入</span>
            </div>
          )}

          {recentHistory.length > 0 && (
            <div className="grid grid-cols-4 gap-2 mt-3">
              {recentHistory.map((item) => (
                <button
                  key={item.id}
                  onClick={() => selectHistoryItem(item.id)}
                  title="设为当前图"
                  className={`aspect-square bg-gray-800 rounded-lg border-2 overflow-hidden relative transition-colors ${
                    item.imageUrl === imageUrl ? 'border-nai-accent shadow-[0_0_10px_rgba(252,237,164,0.3)]' : 'border-transparent active:border-gray-600'
                  }`}
                >
                  <img src={item.imageUrl} alt="" className="w-full h-full object-contain" />
                </button>
              ))}
            </div>
          )}
        </section>

        {/* 操作卡 */}
        <section className="grid grid-cols-2 gap-3">
          <button
            onClick={openInpaintMode}
            disabled={!hasImage}
            title={hasImage ? '对当前图局部重绘' : '暂无可用当前图'}
            className={`flex flex-col items-center gap-2 p-4 rounded-xl border transition-colors ${
              hasImage
                ? 'bg-nai-panel border-gray-700 active:bg-gray-800 text-white'
                : 'bg-nai-panel border-gray-800 text-gray-600 cursor-not-allowed'
            }`}
          >
            <Paintbrush className={`w-6 h-6 ${hasImage ? 'text-blue-400' : 'text-gray-600'}`} />
            <span className="text-sm font-medium">重绘</span>
            <span className="text-[11px] text-gray-500">局部重绘 / 裁切 / 扩图</span>
          </button>

          <button
            onClick={() => setIsUpscaleOpen(true)}
            disabled={!hasImage}
            title={hasImage ? '放大当前图' : '暂无可用当前图'}
            className={`flex flex-col items-center gap-2 p-4 rounded-xl border transition-colors ${
              hasImage
                ? 'bg-nai-panel border-gray-700 active:bg-gray-800 text-white'
                : 'bg-nai-panel border-gray-800 text-gray-600 cursor-not-allowed'
            }`}
          >
            <Maximize2 className={`w-6 h-6 ${hasImage ? 'text-green-400' : 'text-gray-600'}`} />
            <span className="text-sm font-medium">放大</span>
            <span className="text-[11px] text-gray-500">超分辨率 2x / 4x</span>
          </button>
        </section>
      </div>

      {/* 全屏覆盖物:复用现有实现 */}
      {isInpaintMode && (inpaintOriginalImage || imageUrl) && (
        <MobileInpaintOverlay
          imageUrl={(inpaintOriginalImage || imageUrl)!}
          imageWidth={inpaintDimensions?.width || targetWidth}
          imageHeight={inpaintDimensions?.height || targetHeight}
          onGenerate={handleInpaintGenerate}
          onClose={handleCloseInpaint}
          isGenerating={isInpainting || isGenerating}
          previewUrl={previewUrl}
          currentStep={currentStep}
          totalSteps={totalSteps}
          initialMask={initialMask}
        />
      )}

      <MobileUpscaleSheet
        isOpen={isUpscaleOpen}
        onClose={() => setIsUpscaleOpen(false)}
        imageUrl={imageUrl || ''}
        onComplete={handleUpscaleComplete}
      />
    </div>
  );
};
