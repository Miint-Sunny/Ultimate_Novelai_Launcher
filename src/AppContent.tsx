import React, { useState, useCallback, useRef, useEffect } from 'react';
import { LeftSidebar } from './components/LeftSidebar';
import { MainContent } from './components/MainContent';
import { RightSidebar } from './components/RightSidebar';
import { LoginModal } from './components/LoginModal';
import { History } from 'lucide-react';
import { type HistoryItemMetadata } from './contexts/GenerationContext';
import { useAuth } from './contexts/AuthContext';
import { useDragDrop } from './contexts/DragDropContext';
import { DropZoneModal, type DropTarget } from './components/DropZoneModal';
import { type ImageMetadata } from './utils/imageMetadata';
import { WorkshopTaskFloat } from './components/workshop/WorkshopTaskFloat';
import { WorkshopResultViewer } from './components/workshop/WorkshopResultViewer';
import { restoreTasks as workshopRestoreTasks } from './components/workshop/workshopApi';
import type { Task as WorkshopTask } from './stores/taskStore';

interface ImportOptions {
  prompt: boolean;
  negativePrompt: boolean;
  characters: boolean;
  appendCharacters: boolean;
  settings: boolean;
  seed: boolean;
  vibes: boolean;
  cleanImports: boolean;
}

// Desktop layout. Lazy-loaded from App so mobile devices never parse it.
const AppContent: React.FC = () => {
  const { logout, showLoginModal, closeLoginModal, login, isAuthenticated } = useAuth();
  const [isRightPanelOpen, setIsRightPanelOpen] = useState(true);
  const {
    isDraggingOver,
    setIsDraggingOver,
    scrollToDropZones,
    pendingFile,
    setPendingFile,
    processFileForTarget,
  } = useDragDrop();
  const dragCounterRef = useRef(0);

  // Ref to store the apply metadata handler from LeftSidebar
  const applyMetadataHandlerRef = useRef<((metadata: HistoryItemMetadata, seed: number, width?: number, height?: number) => void) | null>(null);

  const setApplyMetadataHandler = useCallback((handler: (metadata: HistoryItemMetadata, seed: number, width?: number, height?: number) => void) => {
    applyMetadataHandlerRef.current = handler;
  }, []);

  const handleApplyMetadata = useCallback((metadata: HistoryItemMetadata, seed: number, width?: number, height?: number) => {
    if (applyMetadataHandlerRef.current) {
      applyMetadataHandlerRef.current(metadata, seed, width, height);
    }
  }, []);

  // Scroll to drop zones when dragging starts
  useEffect(() => {
    if (isDraggingOver) {
      scrollToDropZones();
    }
  }, [isDraggingOver, scrollToDropZones]);

  // 工坊：仅保留大图查看（输入条已移到 MainContent，让其嵌入画布）
  const [viewingWorkshopTask, setViewingWorkshopTask] = useState<WorkshopTask | null>(null);

  // 应用挂载时恢复 workshop 任务（继续轮询正在生成的、合并服务端任务）
  useEffect(() => {
    workshopRestoreTasks();
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;

    if (e.dataTransfer.types.includes('Files')) {
      setIsDraggingOver(true);
    }
  }, [setIsDraggingOver]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;

    if (dragCounterRef.current === 0) {
      setIsDraggingOver(false);
    }
  }, [setIsDraggingOver]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  // Handle drop on the background - show modal for selection
  const handleBackgroundDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDraggingOver(false);

    const files = Array.from(e.dataTransfer.files);
    const file = files[0];

    if (!file) return;

    const isVibeFile = file.name.toLowerCase().endsWith('.naiv4vibe') || file.name.toLowerCase().endsWith('.naiv4vibebundle');
    const isImage = file.type.startsWith('image/');

    if (!isVibeFile && !isImage) return;

    // Read file and show modal
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result as string;
      setPendingFile({
        file,
        dataUrl,
        isVibeFile,
      });
    };
    reader.readAsDataURL(file);
  }, [setIsDraggingOver, setPendingFile]);

  const handleModalSelect = useCallback((target: DropTarget, metadata?: ImageMetadata, importOptions?: ImportOptions) => {
    processFileForTarget(target, metadata, importOptions);
  }, [processFileForTarget]);

  const handleModalClose = useCallback(() => {
    setPendingFile(null);
  }, [setPendingFile]);

  return (
    <div
      className="flex flex-col h-screen bg-nai-bg text-white overflow-hidden font-sans"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleBackgroundDrop}
    >
      <div className="flex flex-1 overflow-hidden relative">
        <LeftSidebar onLogout={logout} onRegisterApplyMetadata={setApplyMetadataHandler} />
        <MainContent />
        {isRightPanelOpen ? (
          <RightSidebar onClose={() => setIsRightPanelOpen(false)} onApplyMetadata={handleApplyMetadata} />
        ) : (
          <button
            className="absolute right-0 top-1/2 -translate-y-1/2 z-20 flex items-center justify-center w-6 h-24 bg-nai-panel border border-gray-600 border-r-0 rounded-l-2xl text-gray-400 hover:text-white hover:bg-gray-800 transition-all duration-200 shadow-[-4px_0_12px_rgba(0,0,0,0.5)] group"
            onClick={() => setIsRightPanelOpen(true)}
            title="显示历史记录"
          >
            <History className="w-5 h-5 group-hover:scale-110 transition-transform" />
          </button>
        )}
      </div>

      {/* Drop target selection modal - shown when dropping outside specific zones */}
      <DropZoneModal
        isOpen={!!pendingFile}
        onClose={handleModalClose}
        onSelect={handleModalSelect}
        fileName={pendingFile?.file.name}
        isVibeFile={pendingFile?.isVibeFile}
        fileDataUrl={pendingFile?.dataUrl}
        presetMetadata={pendingFile?.presetMetadata}
      />

      {/* Login Modal */}
      <LoginModal
        isOpen={showLoginModal}
        onClose={closeLoginModal}
        onLogin={login}
        forced={!isAuthenticated}
      />

      {/* 图像编辑：任务进度浮卡（始终挂载，无任务时不渲染） */}
      <WorkshopTaskFloat onView={(t) => setViewingWorkshopTask(t)} />

      {/* 图像编辑：结果大图查看 */}
      <WorkshopResultViewer
        task={viewingWorkshopTask}
        onClose={() => setViewingWorkshopTask(null)}
      />
    </div>
  );
};

export default AppContent;
