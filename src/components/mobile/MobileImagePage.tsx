import React, { useState, useEffect } from 'react';
import {
  Image as ImageIcon,
  Download,
  FileDigit,
  Maximize2,
  Settings2,
  X,
  RefreshCw,
  Settings,
  Paintbrush,
  AlertCircle,
} from 'lucide-react';
import { useGeneration } from '../../contexts/GenerationContext';
import { MobileInpaintOverlay } from './MobileInpaintOverlay';
import { MobileUpscaleSheet } from './MobileUpscaleSheet';
import { MobileFullscreenImageViewer } from './MobileFullscreenImageViewer';
import { MobileExpandedGallerySheet } from './MobileExpandedGallerySheet';
import { MobileSaveSettingsSheet } from './MobileSaveSettingsSheet';
import { registerBackHandler } from './MobileLayout';
import { MobileCompactGalleryStrip } from './gallery/MobileCompactGalleryStrip';
import { useMobileInpaintBridge } from './gallery/useMobileInpaintBridge';
import { useMobileSaveDownloadWorkflow } from './gallery/useMobileSaveDownloadWorkflow';

export const MobileGalleryPage: React.FC = () => {
  const {
    isGenerating,
    currentStep,
    totalSteps,
    previewUrl,
    result,
    imageUrl,
    currentSeed,
    targetWidth,
    targetHeight,
    isQueuing,
    queuePosition,
    cancelTask,
    history,
    selectHistoryItem,
    setSeedSetting,
    addUpscaledImage,
    deleteHistoryItem,
    deleteHistoryItems,
    viewingHistory,
    setViewingHistory,
  } = useGeneration();

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showError, setShowError] = useState(true);

  // 工具栏相关状态
  const [isUpscaleModalOpen, setIsUpscaleModalOpen] = useState(false);
  const {
    isInpaintMode,
    setIsInpaintMode,
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
  });

  // 展开图库状态
  const [isGalleryExpanded, setIsGalleryExpanded] = useState(false);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const {
    showSaveSettings,
    setShowSaveSettings,
    saveMode,
    setSaveMode,
    customPrompt,
    setCustomPrompt,
    saveFormat,
    setSaveFormat,
    saveQuality,
    setSaveQuality,
    estimatedSize,
    isEstimating,
    isDownloading,
    handleApplySaveSettings,
    handleDownload,
    downloadAndSaveImage,
    handleDownloadSelected,
    handleDownloadAll,
    handleDeleteSelected: deleteSelectedDownloads,
  } = useMobileSaveDownloadWorkflow({
    imageUrl,
    currentSeed,
    history,
    selectedItems,
    setSelectedItems,
    setIsSelectionMode,
  });

  const displayUrl = (isGenerating || isQueuing)
    ? (viewingHistory ? imageUrl : previewUrl)
    : imageUrl;
  const hasImage = !!imageUrl && !isGenerating && !isInpaintMode;

  // 注册返回处理器 - 处理各种弹出层的关闭
  useEffect(() => {
    const handleBack = () => {
      // 按优先级处理各种弹出层
      if (isFullscreen) {
        setIsFullscreen(false);
        return true;
      }
      if (isGalleryExpanded) {
        setIsGalleryExpanded(false);
        setIsSelectionMode(false);
        setSelectedItems(new Set());
        return true;
      }
      if (showSaveSettings) {
        setShowSaveSettings(false);
        return true;
      }
      if (isUpscaleModalOpen) {
        setIsUpscaleModalOpen(false);
        return true;
      }
      if (isInpaintMode) {
        setIsInpaintMode(false);
        return true;
      }
      return false;
    };

    return registerBackHandler(handleBack);
  }, [isFullscreen, isGalleryExpanded, showSaveSettings, isUpscaleModalOpen, isInpaintMode]);

  // 当有新错误时重置显示状态
  useEffect(() => {
    if (result && !result.success) {
      setShowError(true);
    }
  }, [result]);

  // 使用种子
  const handleUseSeed = () => {
    if (currentSeed) {
      setSeedSetting(String(currentSeed));
    }
  };

  // 重新生成
  const handleRegenerate = () => {
    window.dispatchEvent(new Event('regenerate-image'));
  };

  // 超分辨率完成处理
  const handleUpscaleComplete = async (resultBlob: Blob, scale: number) => {
    const url = URL.createObjectURL(resultBlob);

    // 使用 Image 元素获取尺寸（兼容移动端）
    const img = new Image();
    img.src = url;
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = reject;
    });

    const width = img.naturalWidth;
    const height = img.naturalHeight;
    addUpscaledImage(url, width, height, currentSeed || 0, scale);
  };

  // 展开图库相关处理
  const toggleSelectItem = (id: string) => {
    setSelectedItems((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id);
      }
      return newSet;
    });
  };

  const selectAll = () => {
    setSelectedItems(new Set(history.map((item) => item.id)));
  };

  const deselectAll = () => {
    setSelectedItems(new Set());
  };

  const handleDeleteSelected = () => deleteSelectedDownloads(deleteHistoryItems);

  return (
    <div className="flex flex-col h-full bg-nai-bg">
      {/* Error Toast */}
      {result && !result.success && showError && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-50 animate-in slide-in-from-top-2 duration-300 px-4 w-full max-w-md">
          <div className="bg-red-500/95 backdrop-blur-sm text-white px-4 py-3 rounded-xl shadow-xl flex items-start gap-3">
            <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="font-medium text-sm mb-1">生成失败</div>
              <div className="text-sm opacity-90 break-words whitespace-pre-wrap">{result.error}</div>
            </div>
            <button onClick={() => setShowError(false)} className="p-1 active:bg-white/20 rounded transition-colors shrink-0">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* 顶部状态栏 */}
      <header className="flex-shrink-0 flex items-center justify-between px-4 py-3 bg-nai-panel border-b border-gray-800">
        <div className="flex items-center gap-2">
          <ImageIcon className="w-5 h-5 text-gray-400" />
          <span className="font-medium">图库</span>
          <span className="text-sm text-gray-500">({history.length})</span>
        </div>
        <div className="flex items-center gap-2">
          {imageUrl && (
            <span className="text-xs text-gray-500 font-mono">
              {targetWidth}×{targetHeight}
            </span>
          )}
          <button
            onClick={() => setShowSaveSettings(true)}
            className="p-1.5 text-gray-400 hover:text-white rounded-lg hover:bg-gray-700/50 transition-colors"
            title="保存设置"
          >
            <Settings className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* 主内容区 - 当前图片 */}
      <div className="flex-1 relative bg-black/20 overflow-hidden">
        {/* 顶部悬浮工具栏 - inpaint 模式下隐藏 */}
        {!isInpaintMode && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20">
            <div className="bg-gray-900/80 backdrop-blur-xl rounded-xl flex items-center p-1 shadow-xl border border-white/5">
              <button
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm whitespace-nowrap transition-all ${hasImage ? 'text-gray-300 active:bg-white/10' : 'text-gray-600'
                  }`}
                onClick={openInpaintMode}
                disabled={!hasImage}
              >
                <Paintbrush className="w-4 h-4" />
                <span>重绘</span>
              </button>

              <div className="w-px h-5 bg-white/10 mx-0.5" />

              <button
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm whitespace-nowrap transition-all ${hasImage ? 'text-gray-300 active:bg-white/10' : 'text-gray-600'
                  }`}
                onClick={() => setIsUpscaleModalOpen(true)}
                disabled={!hasImage}
              >
                <Maximize2 className="w-4 h-4" />
                <span>放大</span>
              </button>
            </div>
          </div>
        )}

        {/* Inpaint Overlay */}
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

        {displayUrl ? (
          <div
            className="relative w-full h-full flex items-center justify-center p-4"
            onTouchStart={(e) => {
              // 检测到双指触摸 → 进入全屏缩放模式
              if (e.touches.length >= 2 && (!isGenerating || viewingHistory) && imageUrl) {
                e.preventDefault();
                setIsFullscreen(true);
              }
            }}
          >
            <img
              src={displayUrl}
              alt={isGenerating ? 'Preview' : 'Generated'}
              className={`max-w-full max-h-full object-contain rounded-lg shadow-2xl ${isGenerating ? 'opacity-90' : ''
                }`}
              onClick={() => (!isGenerating || viewingHistory) && setIsFullscreen(true)}
            />
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-gray-500">
            <ImageIcon className="w-12 h-12 opacity-20 mb-2" />
            <span className="text-sm">{isQueuing || isGenerating ? '' : '未生成图像'}</span>
          </div>
        )}

        {/* 统一状态条 - 排队 + 生成进度（与 web 端一致） */}
        <div
          className={`absolute bottom-20 left-1/2 -translate-x-1/2 z-20 transition-all duration-300 ease-out ${isQueuing || isGenerating
            ? 'opacity-100 translate-y-0'
            : 'opacity-0 translate-y-4 pointer-events-none'
            }`}
        >
          <div className="bg-gray-900/90 backdrop-blur-sm px-4 py-2 rounded-full shadow-xl border border-gray-600/50 h-9 flex items-center justify-center">
            {/* 排队状态 */}
            <div
              className={`flex items-center gap-3 transition-opacity duration-200 ${isQueuing ? 'opacity-100' : 'opacity-0 invisible absolute'
                }`}
            >
              {/* 脉冲圆环 */}
              <div className="relative w-4 h-4 flex-shrink-0">
                <div className="absolute inset-0 bg-nai-accent/40 rounded-full animate-ping" />
                <div className="absolute inset-0.5 bg-nai-accent rounded-full" />
              </div>
              <span className="text-gray-200 text-sm shrink-0 whitespace-nowrap">排队中</span>
              <span className="text-nai-accent font-bold text-sm shrink-0 whitespace-nowrap">
                #{queuePosition > 0 ? queuePosition : '-'}
              </span>
              <button
                onClick={() => cancelTask()}
                className="ml-1 px-2 py-0.5 text-xs text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors shrink-0 whitespace-nowrap"
              >
                取消
              </button>
            </div>

            {/* 生成进度 */}
            <div
              className={`flex items-center gap-3 transition-opacity duration-200 ${isGenerating && !isQueuing ? 'opacity-100' : 'opacity-0 invisible absolute'
                }`}
            >
              <div className="w-28 h-1.5 bg-gray-700 rounded-full overflow-hidden flex-shrink-0">
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

        {/* 当前图片工具栏 */}
        {imageUrl && !isGenerating && (
          <div className="absolute bottom-3 right-3 flex items-center gap-1.5">
            {/* 对比按钮 - 仅在当前图片是重绘图片且有对比原图时显示 */}
            <button
              onClick={handleUseSeed}
              className="flex items-center gap-1.5 px-3 py-2 bg-black/70 backdrop-blur-sm rounded-lg text-sm"
            >
              <FileDigit className="w-4 h-4" />
              {currentSeed}
            </button>
            <button
              onClick={handleRegenerate}
              className="p-2.5 bg-nai-accent/90 backdrop-blur-sm rounded-lg"
              title="重新生成"
            >
              <RefreshCw className="w-5 h-5 text-black" />
            </button>
            <button
              onClick={handleDownload}
              className="p-2.5 bg-black/70 backdrop-blur-sm rounded-lg"
              title="下载"
            >
              <Download className="w-5 h-5" />
            </button>
            <button
              onClick={() => {
                if (!imageUrl) return;
                const currentItem = history.find(h => h.imageUrl === imageUrl);
                // 通过事件触发 MobileGeneratePage 的导入面板
                window.dispatchEvent(new CustomEvent('open-image-import', {
                  detail: {
                    dataUrl: imageUrl,
                    metadata: currentItem?.metadata ? (() => {
                      const m = currentItem.metadata!;
                      return {
                        source: `NovelAI (${m.model})`,
                        sourceType: 'novelai',
                        prompt: m.positivePrompt,
                        negativePrompt: m.negativePrompt,
                        width: currentItem.width,
                        height: currentItem.height,
                        seed: String(currentItem.seed),
                        steps: String(m.steps),
                        scale: String(m.scale),
                        sampler: m.sampler,
                        cfgRescale: m.cfgRescale,
                        noiseSchedule: m.noiseSchedule,
                        characterPrompts: m.characterPrompts?.map(cp => ({
                          prompt: cp.positive,
                          uc: cp.negative,
                          center: cp.position ? { x: 0, y: 0 } : undefined,
                        })),
                      };
                    })() : null,
                  },
                }));
              }}
              className="p-2.5 bg-black/70 backdrop-blur-sm rounded-lg"
              title="导入元数据"
            >
              <Settings2 className="w-5 h-5" />
            </button>
          </div>
        )}
      </div>

      <MobileCompactGalleryStrip
        history={history}
        imageUrl={imageUrl}
        isGenerating={isGenerating}
        isQueuing={isQueuing}
        viewingHistory={viewingHistory}
        previewUrl={previewUrl}
        queuePosition={queuePosition}
        currentStep={currentStep}
        totalSteps={totalSteps}
        setViewingHistory={setViewingHistory}
        selectHistoryItem={selectHistoryItem}
        onExpand={() => setIsGalleryExpanded(true)}
      />

      {/* 全屏预览 - 支持双指缩放 */}
      {isFullscreen && imageUrl && (
        <MobileFullscreenImageViewer
          imageUrl={imageUrl}
          onClose={() => setIsFullscreen(false)}
        />
      )}

      <MobileSaveSettingsSheet
        isOpen={showSaveSettings}
        onClose={() => setShowSaveSettings(false)}
        saveMode={saveMode}
        setSaveMode={setSaveMode}
        customPrompt={customPrompt}
        setCustomPrompt={setCustomPrompt}
        saveFormat={saveFormat}
        setSaveFormat={setSaveFormat}
        saveQuality={saveQuality}
        setSaveQuality={setSaveQuality}
        isEstimating={isEstimating}
        estimatedSize={estimatedSize}
        onApply={handleApplySaveSettings}
      />

      {/* Upscale Sheet */}
      <MobileUpscaleSheet
        isOpen={isUpscaleModalOpen}
        onClose={() => setIsUpscaleModalOpen(false)}
        imageUrl={imageUrl || ''}
        onComplete={handleUpscaleComplete}
      />

      <MobileExpandedGallerySheet
        isOpen={isGalleryExpanded}
        history={history}
        isGenerating={isGenerating}
        isQueuing={isQueuing}
        viewingHistory={viewingHistory}
        setViewingHistory={setViewingHistory}
        previewUrl={previewUrl}
        queuePosition={queuePosition}
        currentStep={currentStep}
        totalSteps={totalSteps}
        isSelectionMode={isSelectionMode}
        setIsSelectionMode={setIsSelectionMode}
        selectedItems={selectedItems}
        clearSelection={() => setSelectedItems(new Set())}
        selectAll={selectAll}
        deselectAll={deselectAll}
        toggleSelectItem={toggleSelectItem}
        selectHistoryItem={selectHistoryItem}
        closeGallery={() => {
          setIsGalleryExpanded(false);
          setIsSelectionMode(false);
          setSelectedItems(new Set());
        }}
        isDownloading={isDownloading}
        handleDownloadAll={handleDownloadAll}
        handleDownloadSelected={handleDownloadSelected}
        handleDeleteSelected={handleDeleteSelected}
        downloadAndSaveImage={downloadAndSaveImage}
        deleteHistoryItem={deleteHistoryItem}
      />

    </div>
  );
};
