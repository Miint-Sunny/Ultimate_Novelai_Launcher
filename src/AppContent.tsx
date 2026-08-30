import React, { useState, useCallback, useRef, useEffect } from 'react';
import { LeftSidebar } from './components/LeftSidebar';
import { MainContent } from './components/MainContent';
import { HistoryDock } from './components/HistoryDock';
import { RightDock } from './components/desktop/dock/RightDock';
import { LoginModal } from './components/LoginModal';
import { AgentDockProvider } from './contexts/AgentDockContext';
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
  const {
    isDraggingOver,
    setIsDraggingOver,
    scrollToDropZones,
    pendingFile,
    setPendingFile,
    processFileForTarget,
  } = useDragDrop();
  const dragCounterRef = useRef(0);

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
        <AgentDockProvider>
          <LeftSidebar onLogout={logout} />
          {/* 中央工作区：画布在上，历史条横放在下方展开 */}
          <div className="flex-1 flex flex-col overflow-hidden">
            <MainContent />
            <HistoryDock />
          </div>
          {/* 右侧：可拼凑的停靠区(助手 / 会话历史,顶部图标或 ⋮ 菜单勾选) */}
          <RightDock />
        </AgentDockProvider>
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
