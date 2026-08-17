import React, { useCallback, useState } from 'react';
import {
  Image as ImageIcon,
  Maximize2,
  X,
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
import { useMobileGalleryBackStack } from './gallery/useMobileGalleryBackStack';
import { MobileCompactGalleryStrip } from './gallery/MobileCompactGalleryStrip';
import { MobileGalleryFlipCanvas } from './gallery/MobileGalleryFlipCanvas';
import { MobileCurrentImageToolbar } from './gallery/MobileCurrentImageToolbar';
import { useMobileGallerySelection } from './gallery/useMobileGallerySelection';
import { useMobileGenerationErrorToast } from './gallery/useMobileGenerationErrorToast';
import { MobileImageStatusPill } from './gallery/MobileImageStatusPill';
import { useMobileInpaintBridge } from './gallery/useMobileInpaintBridge';
import { useMobileSaveDownloadWorkflow } from './gallery/useMobileSaveDownloadWorkflow';
import { useMobileUpscaleCompletion } from './gallery/useMobileUpscaleCompletion';

interface MobileGalleryPageProps {
  /** P3 pager 壳:重绘/放大改为带当前图跳创作室(页 2);tabs 壳下缺省,保持原覆盖物行为 */
  onStudioTool?: (tool: 'inpaint' | 'upscale') => void;
}

export const MobileGalleryPage: React.FC<MobileGalleryPageProps> = ({ onStudioTool }) => {
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
    addUpscaledImage,
    deleteHistoryItems,
    viewingHistory,
    setViewingHistory,
  } = useGeneration();

  const [isFullscreen, setIsFullscreen] = useState(false);
  const { showError, setShowError } = useMobileGenerationErrorToast(result);

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
  const {
    selectedItems,
    setSelectedItems,
    isSelectionMode,
    setIsSelectionMode,
    clearSelection,
    toggleSelectItem,
    enterSelectionWith,
    convergeSelection,
    selectAll,
    deselectAll,
  } = useMobileGallerySelection(history);
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

  const hasImage = !!imageUrl && !isGenerating && !isInpaintMode;

  const closeGallery = useCallback(() => {
    setIsGalleryExpanded(false);
    setIsSelectionMode(false);
    clearSelection();
  }, [clearSelection, setIsSelectionMode]);
  const closeFullscreen = useCallback(() => setIsFullscreen(false), []);
  const closeSaveSettings = useCallback(() => setShowSaveSettings(false), [setShowSaveSettings]);
  const closeUpscaleModal = useCallback(() => setIsUpscaleModalOpen(false), []);
  const closeInpaintMode = useCallback(() => setIsInpaintMode(false), [setIsInpaintMode]);

  useMobileGalleryBackStack({
    isFullscreen,
    closeFullscreen,
    isGalleryExpanded,
    closeGallery,
    showSaveSettings,
    closeSaveSettings,
    isUpscaleModalOpen,
    closeUpscaleModal,
    isInpaintMode,
    closeInpaintMode,
  });

  // 重新生成:画布翻到的老图有元数据时按入库快照换新种子复跑(不动编辑器),
  // 否则维持原语义按编辑器现状重跑
  const handleRegenerate = () => {
    const currentItem = history.find((item) => item.imageUrl === imageUrl);
    window.dispatchEvent(currentItem?.metadata
      ? new CustomEvent('regenerate-image', { detail: { snapshot: currentItem } })
      : new Event('regenerate-image'));
  };

  // 超分辨率完成处理
  const handleUpscaleComplete = useMobileUpscaleCompletion({
    currentSeed,
    addUpscaledImage,
  });

  const handleDeleteSelected = () => deleteSelectedDownloads(deleteHistoryItems);

  return (
    <div className="flex flex-col h-full bg-nai-bg">
      {/* Error Toast */}
      {result && !result.success && showError && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-50 animate-in slide-in-from-top-2 duration-300 px-4 w-full max-w-md">
          <div className="bg-red-500/95 text-white px-4 py-3 rounded-xl shadow-xl flex items-start gap-3">
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
            <div className="bg-gray-900/80 rounded-xl flex items-center p-1 shadow-xl border border-white/5">
              <button
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm whitespace-nowrap transition-all ${hasImage ? 'text-gray-300 active:bg-white/10' : 'text-gray-600'
                  }`}
                onClick={() => (onStudioTool ? onStudioTool('inpaint') : openInpaintMode())}
                disabled={!hasImage}
              >
                <Paintbrush className="w-4 h-4" />
                <span>重绘</span>
              </button>

              <div className="w-px h-5 bg-white/10 mx-0.5" />

              <button
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm whitespace-nowrap transition-all ${hasImage ? 'text-gray-300 active:bg-white/10' : 'text-gray-600'
                  }`}
                onClick={() => (onStudioTool ? onStudioTool('upscale') : setIsUpscaleModalOpen(true))}
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

        {/* P5 翻图画布:在跑任务卡头页 + history 一项一页,横滑翻图;
            双指/单击进全屏;inpaint 模式下被 overlay 取代(enabled=false 停手势) */}
        <MobileGalleryFlipCanvas
          history={history}
          imageUrl={imageUrl}
          previewUrl={previewUrl}
          isGenerating={isGenerating}
          isQueuing={isQueuing}
          viewingHistory={viewingHistory}
          enabled={!isInpaintMode}
          selectHistoryItem={selectHistoryItem}
          setViewingHistory={setViewingHistory}
          onOpenFullscreen={() => setIsFullscreen(true)}
        />

        {/* 统一状态条 - 排队 + 生成进度（与 web 端一致） */}
        <MobileImageStatusPill
          isGenerating={isGenerating}
          isQueuing={isQueuing}
          queuePosition={queuePosition}
          currentStep={currentStep}
          totalSteps={totalSteps}
          onCancel={() => cancelTask()}
        />

        <MobileCurrentImageToolbar
          imageUrl={imageUrl}
          isGenerating={isGenerating}
          currentSeed={currentSeed}
          history={history}
          onRegenerate={handleRegenerate}
          onDownload={handleDownload}
          onOpenSaveSettings={() => setShowSaveSettings(true)}
        />
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
        onLongPressItem={(id) => {
          enterSelectionWith(id);
          setIsGalleryExpanded(true);
        }}
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
        clearSelection={clearSelection}
        selectAll={selectAll}
        deselectAll={deselectAll}
        toggleSelectItem={toggleSelectItem}
        selectHistoryItem={selectHistoryItem}
        closeGallery={closeGallery}
        isDownloading={isDownloading}
        handleDownloadAll={handleDownloadAll}
        handleDownloadSelected={handleDownloadSelected}
        handleDeleteSelected={handleDeleteSelected}
        downloadAndSaveImage={downloadAndSaveImage}
        convergeSelection={convergeSelection}
      />

    </div>
  );
};
