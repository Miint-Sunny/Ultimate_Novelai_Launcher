import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Download, ChevronRight, Trash2, X, Copy, FileDigit, Maximize2, Check, CheckSquare, ChevronLeft, ChevronRight as ChevronRightIcon, Settings2, Archive } from 'lucide-react';
import { useGeneration, type HistoryItemMetadata } from '../contexts/GenerationContext';
import { useDragDrop } from '../contexts/DragDropContext';
import { processImageForSave, getSaveExt, type SaveFormat } from '../utils/imageMetadata';
import { generateImageFileName } from '../utils/fileSystem';
import JSZip from 'jszip';

const STORAGE_KEY_SAVE_MODE = 'nai_default_save_mode';
const STORAGE_KEY_CUSTOM_PROMPT = 'nai_save_custom_prompt';
const STORAGE_KEY_SAVE_FORMAT = 'nai_save_format';
const STORAGE_KEY_SAVE_QUALITY = 'nai_save_quality';
const DEFAULT_QUALITY = 0.92;

interface RightSidebarProps {
  onClose: () => void;
  onApplyMetadata?: (metadata: HistoryItemMetadata, seed: number, width?: number, height?: number) => void;
}

export const RightSidebar: React.FC<RightSidebarProps> = ({ onClose, onApplyMetadata }) => {
  const { history, imageUrl, selectHistoryItem, clearHistory, deleteHistoryItem, deleteHistoryItems, setSeedSetting, isGenerating, isQueuing, previewUrl, currentStep, totalSteps, queuePosition, viewingHistory, setViewingHistory } = useGeneration();
  const { setPendingFile } = useDragDrop();
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; itemId: string } | null>(null);
  const [isGalleryOpen, setIsGalleryOpen] = useState(false);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [previewItem, setPreviewItem] = useState<string | null>(null);
  const [isZipping, setIsZipping] = useState(false);

  // 保存设置
  const [saveMode, setSaveMode] = useState<'original' | 'clean' | 'custom'>('original');
  const [customPrompt, setCustomPrompt] = useState('');
  const [saveFormat, setSaveFormat] = useState<SaveFormat>('png');
  const [saveQuality, setSaveQuality] = useState<number>(DEFAULT_QUALITY);

  // 加载保存设置（每次组件渲染时检查更新）
  useEffect(() => {
    const loadSettings = () => {
      const savedMode = localStorage.getItem(STORAGE_KEY_SAVE_MODE) as 'original' | 'clean' | 'custom' | null;
      const savedPrompt = localStorage.getItem(STORAGE_KEY_CUSTOM_PROMPT);
      const savedFormat = localStorage.getItem(STORAGE_KEY_SAVE_FORMAT) as SaveFormat | null;
      const savedQuality = localStorage.getItem(STORAGE_KEY_SAVE_QUALITY);
      if (savedMode) setSaveMode(savedMode);
      if (savedPrompt) setCustomPrompt(savedPrompt);
      if (savedFormat === 'png' || savedFormat === 'jpg') setSaveFormat(savedFormat);
      if (savedQuality) {
        const q = Number(savedQuality);
        if (Number.isFinite(q) && q > 0 && q <= 1) setSaveQuality(q);
      } else {
        setSaveQuality(DEFAULT_QUALITY);
      }
    };

    // 初始加载
    loadSettings();

    // 监听 storage 事件（当其他标签页或组件修改 localStorage 时）
    const handleStorageChange = (e: StorageEvent) => {
      if (
        e.key === STORAGE_KEY_SAVE_MODE ||
        e.key === STORAGE_KEY_CUSTOM_PROMPT ||
        e.key === STORAGE_KEY_SAVE_FORMAT ||
        e.key === STORAGE_KEY_SAVE_QUALITY
      ) {
        loadSettings();
      }
    };

    // 监听自定义事件（同一页面内的更新）
    const handleSettingsUpdate = () => {
      loadSettings();
    };

    window.addEventListener('storage', handleStorageChange);
    window.addEventListener('saveSettingsUpdated', handleSettingsUpdate);

    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('saveSettingsUpdated', handleSettingsUpdate);
    };
  }, []);

  // 使用保存设置下载单张图片
  const handleSaveImageWithSettings = async (itemId: string) => {
    const item = history.find(h => h.id === itemId);
    if (!item) return;

    const ext = getSaveExt(saveFormat);
    const upscaleSuffix = item.isUpscaled ? `_upscaled_${item.upscaleScale || 4}x` : '';
    const modeSuffix = getModeSuffixForFormat(saveMode, saveFormat);
    const fileName = generateImageFileName(`${upscaleSuffix}${modeSuffix}`, item.timestamp, ext);

    try {
      // PNG + original：直链下载，免去解码
      if (saveFormat === 'png' && saveMode === 'original') {
        const link = document.createElement('a');
        link.href = item.imageUrl;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      } else {
        const blob = await processImageForSave(item.imageUrl, {
          mode: saveMode,
          customPrompt,
          format: saveFormat,
          quality: saveQuality,
        });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      }
    } catch (error) {
      console.error('保存失败:', error);
    }
    closeContextMenu();
  };

  // 使用保存设置下载选中图片（>5张强制打包）
  const handleDownloadSelectedWithSettings = async () => {
    if (selectedItems.size > 5) {
      await handleZipSelectedWithSettings();
    } else {
      for (const id of selectedItems) {
        const item = history.find(h => h.id === id);
        if (!item) continue;

        const ext = getSaveExt(saveFormat);
        const upscaleSuffix = item.isUpscaled ? `_upscaled_${item.upscaleScale || 4}x` : '';
        const modeSuffix = getModeSuffixForFormat(saveMode, saveFormat);
        const fileName = generateImageFileName(`${upscaleSuffix}${modeSuffix}`, item.timestamp, ext);

        try {
          if (saveFormat === 'png' && saveMode === 'original') {
            const link = document.createElement('a');
            link.href = item.imageUrl;
            link.download = fileName;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
          } else {
            const blob = await processImageForSave(item.imageUrl, {
              mode: saveMode,
              customPrompt,
              format: saveFormat,
              quality: saveQuality,
            });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = fileName;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
          }
        } catch (error) {
          console.error('保存失败:', error);
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  };

  // 获取处理后的图片Blob
  const getProcessedImageBlob = async (item: typeof history[0]): Promise<Blob> => {
    return await processImageForSave(item.imageUrl, {
      mode: saveMode,
      customPrompt,
      format: saveFormat,
      quality: saveQuality,
    });
  };

  // 文件名后缀：jpg 模式不再附加 _clean/_custom，因 jpg 等价无元数据
  const getModeSuffixForFormat = (
    mode: 'original' | 'clean' | 'custom',
    format: SaveFormat,
  ): string => {
    if (format !== 'png') return '';
    if (mode === 'clean') return '_clean';
    if (mode === 'custom') return '_custom';
    return '';
  };

  // 获取文件名（考虑超分后缀 + 格式）
  const getItemFileName = (item: typeof history[0], suffix: string = '') => {
    const ext = getSaveExt(saveFormat);
    const upscaleSuffix = item.isUpscaled ? `_upscaled_${item.upscaleScale || 4}x` : '';
    return generateImageFileName(`${upscaleSuffix}${suffix}`, item.timestamp, ext);
  };

  // 获取文件名后缀
  const getFileSuffix = () => getModeSuffixForFormat(saveMode, saveFormat);

  // 打包下载所有图片
  const handleZipAllWithSettings = async () => {
    if (history.length === 0 || isZipping) return;
    setIsZipping(true);

    try {
      const zip = new JSZip();
      const suffix = getFileSuffix();

      for (const item of history) {
        try {
          const blob = await getProcessedImageBlob(item);
          zip.file(getItemFileName(item, suffix), blob);
        } catch (error) {
          console.error(`处理图片 ${item.seed} 失败:`, error);
        }
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(zipBlob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `novelai_images_${Date.now()}.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('打包失败:', error);
    } finally {
      setIsZipping(false);
    }
  };

  // 打包下载选中图片
  const handleZipSelectedWithSettings = async () => {
    if (selectedItems.size === 0 || isZipping) return;
    setIsZipping(true);

    try {
      const zip = new JSZip();
      const suffix = getFileSuffix();

      for (const id of selectedItems) {
        const item = history.find(h => h.id === id);
        if (!item) continue;

        try {
          const blob = await getProcessedImageBlob(item);
          zip.file(getItemFileName(item, suffix), blob);
        } catch (error) {
          console.error(`处理图片 ${item.seed} 失败:`, error);
        }
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(zipBlob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `novelai_images_${Date.now()}.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('打包失败:', error);
    } finally {
      setIsZipping(false);
    }
  };

  const handleContextMenu = (e: React.MouseEvent, itemId: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, itemId });
  };

  const closeContextMenu = () => setContextMenu(null);

  // 菜单 ref + 自适应：超出右/下边缘时反向定位
  const contextMenuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!contextMenu || !contextMenuRef.current) return;
    const rect = contextMenuRef.current.getBoundingClientRect();
    const padding = 8;
    let { x, y } = contextMenu;
    let needsUpdate = false;
    if (x + rect.width > window.innerWidth - padding) {
      x = Math.max(padding, window.innerWidth - rect.width - padding);
      needsUpdate = true;
    }
    if (y + rect.height > window.innerHeight - padding) {
      y = Math.max(padding, window.innerHeight - rect.height - padding);
      needsUpdate = true;
    }
    if (needsUpdate) setContextMenu({ ...contextMenu, x, y });
  }, [contextMenu]);

  useEffect(() => {
    if (!contextMenu) return;
    const handleClick = () => setContextMenu(null);
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setContextMenu(null); };
    const handleScroll = () => setContextMenu(null);
    window.addEventListener('mousedown', handleClick);
    window.addEventListener('keydown', handleKey);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('blur', handleClick);
    return () => {
      window.removeEventListener('mousedown', handleClick);
      window.removeEventListener('keydown', handleKey);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('blur', handleClick);
    };
  }, [contextMenu]);

  const handleCopyImage = async (itemId: string) => {
    const item = history.find(h => h.id === itemId);
    if (!item) return;
    try {
      const response = await fetch(item.imageUrl);
      const blob = await response.blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    } catch (error) {
      console.error('复制失败:', error);
    }
    closeContextMenu();
  };

  const handleUseSeed = (itemId: string) => {
    const item = history.find(h => h.id === itemId);
    if (!item) return;
    setSeedSetting(String(item.seed));
    closeContextMenu();
  };

  const handleUseMetadata = async (itemId: string) => {
    const item = history.find(h => h.id === itemId);
    if (!item) return;
    closeContextMenu();
    try {
      // 将历史图片转为 File 对象，触发 DropZoneModal 导入窗口
      const response = await fetch(item.imageUrl);
      const blob = await response.blob();
      const file = new File([blob], `history_${item.seed}.png`, { type: 'image/png' });

      // 将 HistoryItemMetadata 转换为 ImageMetadata 格式
      let presetMeta = undefined;
      if (item.metadata) {
        const m = item.metadata;
        presetMeta = {
          source: `NovelAI (${m.model})`,
          sourceType: 'novelai' as const,
          prompt: m.positivePrompt,
          negativePrompt: m.negativePrompt,
          width: item.width,
          height: item.height,
          seed: String(item.seed),
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
      }

      setPendingFile({
        file,
        dataUrl: item.imageUrl,
        isVibeFile: false,
        presetMetadata: presetMeta || null,
      });
    } catch (error) {
      console.error('打开导入窗口失败:', error);
    }
  };

  const handleDeleteImage = (itemId: string) => {
    deleteHistoryItem(itemId);
    closeContextMenu();
  };

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  };

  // 多选功能
  const toggleSelect = (id: string) => {
    const newSelected = new Set(selectedItems);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedItems(newSelected);
  };

  const selectAll = () => {
    setSelectedItems(new Set(history.map(h => h.id)));
  };

  const deselectAll = () => {
    setSelectedItems(new Set());
  };

  const handleDeleteSelected = () => {
    deleteHistoryItems(Array.from(selectedItems));
    setSelectedItems(new Set());
  };

  // 预览导航
  const previewIndex = previewItem ? history.findIndex(h => h.id === previewItem) : -1;
  const previewData = previewItem ? history.find(h => h.id === previewItem) : null;

  const goToPrevPreview = () => {
    if (previewIndex > 0) {
      setPreviewItem(history[previewIndex - 1].id);
    }
  };

  const goToNextPreview = () => {
    if (previewIndex < history.length - 1) {
      setPreviewItem(history[previewIndex + 1].id);
    }
  };

  return (
    <div className="relative w-[12.5rem] bg-nai-panel border-l border-gray-800 shrink-0 flex flex-col z-10" onClick={closeContextMenu}>
      {/* Collapse Button */}
      <button
        className="absolute left-0 top-1/2 -translate-x-full -translate-y-1/2 flex items-center justify-center w-6 h-24 bg-nai-panel border border-gray-600 border-r-0 rounded-l-2xl text-gray-400 hover:text-white hover:bg-gray-800 transition-all duration-200 shadow-[-4px_0_12px_rgba(0,0,0,0.5)] group"
        onClick={onClose}
        title="收起"
      >
        <ChevronRight className="w-5 h-5 group-hover:scale-110 transition-transform" />
      </button>

      <div className="p-4 border-b border-gray-800 flex items-center justify-between">
        <div className="flex items-center gap-2 text-base font-bold text-gray-200">
          历史记录
          <span className="text-sm text-gray-500 font-normal">({history.length})</span>
        </div>
        <div className="flex items-center gap-1">
          {history.length > 0 && (
            <>
              <button
                onClick={() => setIsGalleryOpen(true)}
                className="p-1.5 text-gray-500 hover:text-nai-accent transition-colors rounded hover:bg-white/5"
                title="全览模式"
              >
                <Maximize2 className="w-4 h-4" />
              </button>
              <button
                onClick={clearHistory}
                className="p-1.5 text-gray-500 hover:text-red-400 transition-colors rounded hover:bg-white/5"
                title="清空历史（保留最近一张）"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-2 custom-scrollbar">
        {/* 生成中占位卡片 */}
        {(isGenerating || isQueuing) && (
          <div
            className={`aspect-square bg-gray-800 rounded-lg border-2 cursor-pointer overflow-hidden relative transition-all ${!viewingHistory
              ? 'border-nai-accent shadow-[0_0_10px_rgba(252,237,164,0.3)]'
              : 'border-transparent hover:border-gray-600'
              }`}
            onClick={() => setViewingHistory(false)}
          >
            {/* 预览缩略图或加载动画 */}
            {previewUrl ? (
              <img src={previewUrl} alt="生成中" className="w-full h-full object-contain" />
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                <div className="relative w-8 h-8">
                  <div className="absolute inset-0 bg-nai-accent/30 rounded-full animate-ping" />
                  <div className="absolute inset-1.5 bg-nai-accent/60 rounded-full animate-pulse" />
                </div>
              </div>
            )}
            {/* 底部进度/排队状态 */}
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent p-1.5">
              {isQueuing ? (
                <div className="flex items-center gap-1">
                  <div className="relative w-2.5 h-2.5 flex-shrink-0">
                    <div className="absolute inset-0 bg-nai-accent/40 rounded-full animate-ping" />
                    <div className="absolute inset-0.5 bg-nai-accent rounded-full" />
                  </div>
                  <span className="text-[10px] text-gray-300">排队 #{queuePosition > 0 ? queuePosition : '-'}</span>
                </div>
              ) : (
                <div className="w-full h-1.5 bg-gray-700 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-nai-accent rounded-full transition-all duration-200 ease-out"
                    style={{ width: `${totalSteps > 0 ? (currentStep / totalSteps) * 100 : 0}%` }}
                  />
                </div>
              )}
            </div>
          </div>
        )}
        {history.length === 0 && !isGenerating && !isQueuing ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-500 text-xs">
            <p>暂无历史记录</p>
          </div>
        ) : (
          history.map((item) => (
            <div
              key={item.id}
              className={`aspect-square bg-gray-800 rounded-lg border-2 cursor-pointer overflow-hidden relative group transition-all ${imageUrl === item.imageUrl && (!(isGenerating || isQueuing) || viewingHistory)
                ? 'border-nai-accent shadow-[0_0_10px_rgba(252,237,164,0.3)]'
                : 'border-transparent hover:border-gray-600'
                }`}
              onClick={() => selectHistoryItem(item.id)}
              onContextMenu={(e) => handleContextMenu(e, item.id)}
            >
              <img src={item.imageUrl} alt={`Seed: ${item.seed}`} className="w-full h-full object-contain" />
              {/* 超分标记 */}
              {item.isUpscaled && (
                <div className="absolute top-1 left-1 px-1 py-0.5 bg-green-500/80 rounded text-[8px] text-white font-bold flex items-center gap-0.5" title="超分辨率">
                  <Maximize2 className="w-2 h-2" />
                  {item.upscaleScale || 4}x
                </div>
              )}
              {/* 局部重绘标记 */}
              {item.isInpainted && !item.isUpscaled && (
                <div className="absolute top-1 left-1 px-1 py-0.5 bg-blue-500/80 rounded text-[8px] text-white font-bold" title="局部重绘">
                  重绘
                </div>
              )}
              {/* 香蕉重绘标记 */}
              {item.isBananaRepaint && !item.isUpscaled && !item.isInpainted && (
                <div className="absolute top-1 left-1 px-1 py-0.5 bg-yellow-500/80 rounded text-[8px] text-black font-bold" title="香蕉重绘">
                  🍌
                </div>
              )}
              <button
                className="absolute top-1 right-1 p-1.5 bg-black/70 rounded opacity-0 group-hover:opacity-100 transition-opacity text-gray-300 hover:text-red-400"
                onClick={(e) => { e.stopPropagation(); deleteHistoryItem(item.id); }}
                title="删除"
              >
                <X className="w-4 h-4" />
              </button>
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/95 via-black/75 to-transparent p-1.5 backdrop-blur-[2px] opacity-0 group-hover:opacity-100 transition-opacity">
                <div className="text-[10px] text-gray-200 flex justify-between drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]">
                  <span>{item.width}×{item.height}</span>
                  <span>{formatTime(item.timestamp)}</span>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="p-3 border-t border-gray-800">
        <button
          className={`w-full py-2 flex items-center justify-center gap-2 text-xs transition-colors rounded ${history.length > 0 && !isZipping ? 'text-gray-400 hover:text-white hover:bg-gray-800' : 'text-gray-600 cursor-not-allowed'
            }`}
          onClick={handleZipAllWithSettings}
          disabled={history.length === 0 || isZipping}
        >
          <Archive className="w-3 h-3" />
          {isZipping ? '打包中...' : '打包下载'}
        </button>
      </div>

      {/* 右键菜单 */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed bg-nai-panel border border-gray-700 rounded-lg shadow-xl py-1 z-50 min-w-[120px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <button className="w-full px-3 py-1.5 text-left text-xs text-gray-300 hover:bg-gray-700 hover:text-white flex items-center gap-2" onClick={() => handleCopyImage(contextMenu.itemId)}>
            <Copy className="w-3 h-3" /> 复制图片
          </button>
          <button className="w-full px-3 py-1.5 text-left text-xs text-gray-300 hover:bg-gray-700 hover:text-white flex items-center gap-2" onClick={() => handleSaveImageWithSettings(contextMenu.itemId)}>
            <Download className="w-3 h-3" /> 保存图片
          </button>
          <button className="w-full px-3 py-1.5 text-left text-xs text-gray-300 hover:bg-gray-700 hover:text-white flex items-center gap-2" onClick={() => handleUseMetadata(contextMenu.itemId)}>
            <Settings2 className="w-3 h-3" /> 使用元数据
          </button>
          <button className="w-full px-3 py-1.5 text-left text-xs text-gray-300 hover:bg-gray-700 hover:text-white flex items-center gap-2" onClick={() => handleUseSeed(contextMenu.itemId)}>
            <FileDigit className="w-3 h-3" /> 使用种子
          </button>
          <div className="border-t border-gray-700 my-1" />
          <button className="w-full px-3 py-1.5 text-left text-xs text-red-400 hover:bg-gray-700 hover:text-red-300 flex items-center gap-2" onClick={() => handleDeleteImage(contextMenu.itemId)}>
            <Trash2 className="w-3 h-3" /> 删除
          </button>
        </div>
      )}

      {/* 全览模式弹窗 - 使用 Portal 渲染到 body */}
      {isGalleryOpen && createPortal(
        <div className="fixed inset-0 z-[9999] bg-black/80 backdrop-blur-sm flex items-center justify-center" onClick={() => { setIsGalleryOpen(false); setIsSelectMode(false); setSelectedItems(new Set()); }}>
          {/* 弹窗容器 */}
          <div className="bg-nai-panel border border-gray-700 rounded-xl shadow-2xl w-[90vw] max-w-[1200px] h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            {/* 头部工具栏 */}
            <div className="flex items-center justify-between p-4 border-b border-gray-800">
              <div className="flex items-center gap-3">
                <h2 className="text-white font-bold text-lg">历史记录 ({history.length})</h2>
                <button
                  className={`px-4 py-2 text-sm rounded-lg border transition-colors flex items-center gap-2 ${isSelectMode ? 'bg-nai-accent/20 text-nai-accent border-nai-accent/50' : 'bg-gray-800 text-gray-400 border-gray-700 hover:text-white'
                    }`}
                  onClick={() => { setIsSelectMode(!isSelectMode); if (isSelectMode) setSelectedItems(new Set()); }}
                >
                  <CheckSquare className="w-4 h-4" />
                  多选
                </button>
                {isSelectMode && (
                  <>
                    <button className="px-4 py-2 text-sm bg-gray-800 text-gray-400 border border-gray-700 rounded-lg hover:text-white" onClick={selectAll}>全选</button>
                    <button className="px-4 py-2 text-sm bg-gray-800 text-gray-400 border border-gray-700 rounded-lg hover:text-white" onClick={deselectAll}>取消</button>
                    <span className="text-sm text-gray-500">已选 {selectedItems.size} 项</span>
                  </>
                )}
              </div>
              <div className="flex items-center gap-3">
                {isSelectMode && selectedItems.size > 0 && (
                  <>
                    <button className="px-4 py-2 text-sm bg-nai-accent/20 text-nai-accent border border-nai-accent/50 rounded-lg hover:bg-nai-accent/30 flex items-center gap-2" onClick={handleDownloadSelectedWithSettings} disabled={isZipping}>
                      <Download className="w-4 h-4" /> 下载 ({selectedItems.size})
                    </button>
                    <button className="px-4 py-2 text-sm bg-blue-500/20 text-blue-400 border border-blue-500/50 rounded-lg hover:bg-blue-500/30 flex items-center gap-2" onClick={handleZipSelectedWithSettings} disabled={isZipping}>
                      <Archive className="w-4 h-4" /> {isZipping ? '打包中...' : `打包 (${selectedItems.size})`}
                    </button>
                    <button className="px-4 py-2 text-sm bg-red-500/20 text-red-400 border border-red-500/50 rounded-lg hover:bg-red-500/30 flex items-center gap-2" onClick={handleDeleteSelected}>
                      <Trash2 className="w-4 h-4" /> 删除 ({selectedItems.size})
                    </button>
                  </>
                )}
                <button className="p-2.5 text-gray-400 hover:text-white rounded-lg hover:bg-gray-800" onClick={() => { setIsGalleryOpen(false); setIsSelectMode(false); setSelectedItems(new Set()); }}>
                  <X className="w-6 h-6" />
                </button>
              </div>
            </div>

            {/* 图片网格 */}
            <div className="flex-1 overflow-y-auto p-4">
              <div className="grid grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8 gap-3">
                {history.map((item) => (
                  <div
                    key={item.id}
                    className={`aspect-square bg-gray-800 rounded-lg border-2 cursor-pointer overflow-hidden relative group transition-all ${selectedItems.has(item.id) ? 'border-nai-accent shadow-[0_0_10px_rgba(252,237,164,0.3)]' : 'border-transparent hover:border-gray-600'
                      }`}
                    onClick={() => {
                      if (isSelectMode) {
                        toggleSelect(item.id);
                      } else {
                        setPreviewItem(item.id);
                      }
                    }}
                    onContextMenu={(e) => handleContextMenu(e, item.id)}
                  >
                    <img src={item.imageUrl} alt={`Seed: ${item.seed}`} className="w-full h-full object-contain" />
                    {/* 超分标记 */}
                    {item.isUpscaled && !isSelectMode && (
                      <div className="absolute top-2 left-2 px-1.5 py-0.5 bg-green-500/80 rounded text-[10px] text-white font-bold flex items-center gap-1" title="超分辨率">
                        <Maximize2 className="w-3 h-3" />
                        {item.upscaleScale || 4}x
                      </div>
                    )}
                    {/* 局部重绘标记 */}
                    {item.isInpainted && !item.isUpscaled && !isSelectMode && (
                      <div className="absolute top-2 left-2 px-1.5 py-0.5 bg-blue-500/80 rounded text-[10px] text-white font-bold" title="局部重绘">
                        重绘
                      </div>
                    )}
                    {/* 香蕉重绘标记 */}
                    {item.isBananaRepaint && !item.isUpscaled && !item.isInpainted && !isSelectMode && (
                      <div className="absolute top-2 left-2 px-1.5 py-0.5 bg-yellow-500/80 rounded text-[10px] text-black font-bold" title="香蕉重绘">
                        🍌
                      </div>
                    )}
                    {/* 选择指示器 */}
                    {isSelectMode && (
                      <div className={`absolute top-2 left-2 w-6 h-6 rounded border-2 flex items-center justify-center transition-colors ${selectedItems.has(item.id) ? 'bg-nai-accent border-nai-accent' : 'bg-black/50 border-gray-400'
                        }`}>
                        {selectedItems.has(item.id) && <Check className="w-4 h-4 text-black" />}
                      </div>
                    )}
                    {/* 删除按钮 */}
                    {!isSelectMode && (
                      <button
                        className="absolute top-2 right-2 p-1.5 bg-black/70 rounded opacity-0 group-hover:opacity-100 transition-opacity text-gray-300 hover:text-red-400"
                        onClick={(e) => { e.stopPropagation(); deleteHistoryItem(item.id); }}
                      >
                        <X className="w-4 h-4" />
                      </button>
                    )}
                    {/* 信息覆盖层 */}
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-2 opacity-0 group-hover:opacity-100 transition-opacity">
                      <div className="text-xs text-gray-300 font-mono truncate">{item.isUpscaled && item.originalSeed ? item.originalSeed : item.seed}</div>
                      <div className="text-[10px] text-gray-500 flex justify-between">
                        <span>{item.width}×{item.height}</span>
                        <span>{formatTime(item.timestamp)}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* 图片预览弹窗 */}
      {previewItem && previewData && createPortal(
        <div
          className="fixed inset-0 z-[10000] bg-black/90 backdrop-blur-sm flex items-center justify-center"
          onClick={() => setPreviewItem(null)}
        >
          {/* 左箭头 */}
          {previewIndex > 0 && (
            <button
              className="absolute left-4 top-1/2 -translate-y-1/2 p-3 bg-black/60 rounded-full text-white hover:bg-black/80 transition-colors"
              onClick={(e) => { e.stopPropagation(); goToPrevPreview(); }}
            >
              <ChevronLeft className="w-8 h-8" />
            </button>
          )}

          {/* 图片容器 */}
          <div className="max-w-[90vw] max-h-[90vh] flex flex-col items-center" onClick={(e) => e.stopPropagation()}>
            {/* 图片 */}
            <div className="relative">
              <img
                src={previewData.imageUrl}
                alt={`Seed: ${previewData.seed}`}
                className="max-w-full max-h-[80vh] object-contain rounded-lg"
              />
              {/* 超分标记 */}
              {previewData.isUpscaled && (
                <div className="absolute top-3 left-3 px-2 py-1 bg-green-500/80 rounded text-sm text-white font-bold flex items-center gap-1" title="超分辨率">
                  <Maximize2 className="w-4 h-4" />
                  {previewData.upscaleScale || 4}x 超分
                </div>
              )}
              {/* 局部重绘标记 */}
              {previewData.isInpainted && !previewData.isUpscaled && (
                <div className="absolute top-3 left-3 px-2 py-1 bg-blue-500/80 rounded text-sm text-white font-bold" title="局部重绘">
                  局部重绘
                </div>
              )}
              {/* 香蕉重绘标记 */}
              {previewData.isBananaRepaint && !previewData.isUpscaled && !previewData.isInpainted && (
                <div className="absolute top-3 left-3 px-2 py-1 bg-yellow-500/80 rounded text-sm text-black font-bold" title="香蕉重绘">
                  🍌 香蕉重绘
                </div>
              )}
            </div>

            {/* 底部信息 */}
            <div className="mt-4 flex items-center gap-4 text-white">
              <span className="font-mono">{previewData.isUpscaled && previewData.originalSeed ? previewData.originalSeed : previewData.seed}</span>
              <span className="text-gray-400">{previewData.width}×{previewData.height}</span>
              <span className="text-gray-500">{formatTime(previewData.timestamp)}</span>
            </div>

            {/* 底部按钮栏 */}
            <div className="mt-3 flex items-center gap-3">
              <button
                className="px-4 py-2 bg-gray-800 text-gray-300 rounded-lg hover:bg-gray-700 flex items-center gap-2"
                onClick={() => { selectHistoryItem(previewData.id); setPreviewItem(null); setIsGalleryOpen(false); }}
              >
                <Check className="w-4 h-4" /> 选用
              </button>
              <button
                className="px-4 py-2 bg-gray-800 text-gray-300 rounded-lg hover:bg-gray-700 flex items-center gap-2"
                onClick={() => handleSaveImageWithSettings(previewData.id)}
              >
                <Download className="w-4 h-4" /> 保存
              </button>
              <button
                className="px-4 py-2 bg-gray-800 text-gray-300 rounded-lg hover:bg-gray-700 flex items-center gap-2"
                onClick={() => { handleUseSeed(previewData.id); setPreviewItem(null); setIsGalleryOpen(false); }}
              >
                <FileDigit className="w-4 h-4" /> 使用种子
              </button>
              <button
                className="px-4 py-2 bg-nai-accent/20 text-nai-accent rounded-lg hover:bg-nai-accent/30 flex items-center gap-2"
                onClick={() => { handleUseMetadata(previewData.id); setPreviewItem(null); setIsGalleryOpen(false); }}
              >
                <Settings2 className="w-4 h-4" /> 使用元数据
              </button>
            </div>
          </div>

          {/* 右箭头 */}
          {previewIndex < history.length - 1 && (
            <button
              className="absolute right-4 top-1/2 -translate-y-1/2 p-3 bg-black/60 rounded-full text-white hover:bg-black/80 transition-colors"
              onClick={(e) => { e.stopPropagation(); goToNextPreview(); }}
            >
              <ChevronRightIcon className="w-8 h-8" />
            </button>
          )}

          {/* 关闭按钮 */}
          <button
            className="absolute top-4 right-4 p-3 bg-black/60 rounded-full text-white hover:bg-black/80 transition-colors"
            onClick={() => setPreviewItem(null)}
          >
            <X className="w-6 h-6" />
          </button>

          {/* 计数器 - 移到顶部 */}
          <div className="absolute top-4 left-1/2 -translate-x-1/2 px-4 py-2 bg-black/60 rounded-full text-white text-sm">
            {previewIndex + 1} / {history.length}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};
