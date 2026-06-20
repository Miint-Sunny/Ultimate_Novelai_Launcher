import React, { useState, useCallback, useEffect } from 'react';
import { useAuth } from './contexts/AuthContext';
import { useDragDrop } from './contexts/DragDropContext';
import { DropZoneModal, type DropTarget } from './components/DropZoneModal';
import { LoginModal } from './components/LoginModal';
import { type ImageMetadata } from './utils/imageMetadata';
import { MobileLayout } from './components/mobile';
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

// Mobile layout. Lazy-loaded from App so desktop devices never parse it.
const MobileAppContent: React.FC = () => {
  const { logout, showLoginModal, closeLoginModal, login, isAuthenticated } = useAuth();
  const { pendingFile, setPendingFile, processFileForTarget } = useDragDrop();

  const handleModalSelect = useCallback((target: DropTarget, metadata?: ImageMetadata, importOptions?: ImportOptions) => {
    processFileForTarget(target, metadata, importOptions);
  }, [processFileForTarget]);

  const handleModalClose = useCallback(() => {
    setPendingFile(null);
  }, [setPendingFile]);

  const [viewingWorkshopTask2, setViewingWorkshopTask2] = useState<WorkshopTask | null>(null);

  useEffect(() => {
    workshopRestoreTasks();
  }, []);

  return (
    <>
      <MobileLayout onLogout={logout} />
      <DropZoneModal
        isOpen={!!pendingFile}
        onClose={handleModalClose}
        onSelect={handleModalSelect}
        fileName={pendingFile?.file.name}
        isVibeFile={pendingFile?.isVibeFile}
        fileDataUrl={pendingFile?.dataUrl}
        presetMetadata={pendingFile?.presetMetadata}
      />
      <LoginModal
        isOpen={showLoginModal}
        onClose={closeLoginModal}
        onLogin={login}
        forced={!isAuthenticated}
      />

      <WorkshopTaskFloat onView={(t) => setViewingWorkshopTask2(t)} />
      <WorkshopResultViewer
        task={viewingWorkshopTask2}
        onClose={() => setViewingWorkshopTask2(null)}
      />
    </>
  );
};

export default MobileAppContent;
