import React, { createContext, useContext, useState, useRef, useCallback, type ReactNode, type RefObject } from 'react';
import { type DropTarget } from '../components/DropZoneModal';
import { type ImageMetadata } from '../utils/imageMetadata';

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

interface DroppedFile {
  file: File;
  dataUrl: string;
  isVibeFile: boolean;
  presetMetadata?: import('../utils/imageMetadata').ImageMetadata | null;
}

interface DragDropContextType {
  // Global drag state
  isDraggingOver: boolean;
  setIsDraggingOver: (value: boolean) => void;

  // Pending file for modal selection
  pendingFile: DroppedFile | null;
  setPendingFile: (file: DroppedFile | null) => void;

  // Direct drop handlers (for precise drops on specific areas)
  handleImg2ImgDrop: ((dataUrl: string) => void) | null;
  setHandleImg2ImgDrop: (handler: ((dataUrl: string) => void) | null) => void;

  handleVibeDrop: ((file: File, dataUrl: string) => void) | null;
  setHandleVibeDrop: (handler: ((file: File, dataUrl: string) => void) | null) => void;

  handleCRDrop: ((dataUrl: string) => void) | null;
  setHandleCRDrop: (handler: ((dataUrl: string) => void) | null) => void;

  // Metadata import handler
  handleMetadataImport: ((metadata: ImageMetadata, options: ImportOptions, fileName?: string) => void) | null;
  setHandleMetadataImport: (handler: ((metadata: ImageMetadata, options: ImportOptions, fileName?: string) => void) | null) => void;

  // Sidebar scroll container ref
  sidebarScrollRef: RefObject<HTMLDivElement | null>;

  // Function to scroll to drop zones
  scrollToDropZones: () => void;

  // Process file for a specific target (from modal)
  processFileForTarget: (target: DropTarget, metadata?: ImageMetadata, importOptions?: ImportOptions) => void;
}

const DragDropContext = createContext<DragDropContextType | null>(null);

export const useDragDrop = () => {
  const context = useContext(DragDropContext);
  if (!context) {
    throw new Error('useDragDrop must be used within a DragDropProvider');
  }
  return context;
};

interface DragDropProviderProps {
  children: ReactNode;
}

export const DragDropProvider: React.FC<DragDropProviderProps> = ({ children }) => {
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [pendingFile, setPendingFile] = useState<DroppedFile | null>(null);
  const sidebarScrollRef = useRef<HTMLDivElement | null>(null);

  // Use refs to store handlers to avoid re-renders
  const handleImg2ImgDropRef = useRef<((dataUrl: string) => void) | null>(null);
  const handleVibeDropRef = useRef<((file: File, dataUrl: string) => void) | null>(null);
  const handleCRDropRef = useRef<((dataUrl: string) => void) | null>(null);
  const handleMetadataImportRef = useRef<((metadata: ImageMetadata, options: ImportOptions, fileName?: string) => void) | null>(null);

  // Stable setter functions
  const setHandleImg2ImgDropStable = useCallback((handler: ((dataUrl: string) => void) | null) => {
    handleImg2ImgDropRef.current = handler;
  }, []);

  const setHandleVibeDropStable = useCallback((handler: ((file: File, dataUrl: string) => void) | null) => {
    handleVibeDropRef.current = handler;
  }, []);

  const setHandleCRDropStable = useCallback((handler: ((dataUrl: string) => void) | null) => {
    handleCRDropRef.current = handler;
  }, []);

  const setHandleMetadataImportStable = useCallback((handler: ((metadata: ImageMetadata, options: ImportOptions, fileName?: string) => void) | null) => {
    handleMetadataImportRef.current = handler;
  }, []);

  const scrollToDropZones = useCallback(() => {
    const img2imgSection = document.getElementById('drop-zone-img2img');
    if (img2imgSection && sidebarScrollRef.current) {
      const container = sidebarScrollRef.current;
      const sectionTop = img2imgSection.offsetTop;
      container.scrollTo({
        top: sectionTop - 100,
        behavior: 'smooth'
      });
    }
  }, []);

  const processFileForTarget = useCallback((target: DropTarget, metadata?: ImageMetadata, importOptions?: ImportOptions) => {
    // Handle metadata import
    if (target === 'import' && metadata && importOptions && handleMetadataImportRef.current) {
      // 从 pendingFile 获取文件名
      const fileName = pendingFile?.file?.name;
      handleMetadataImportRef.current(metadata, importOptions, fileName);
      setPendingFile(null);
      return;
    }

    if (!pendingFile) return;

    const { file, dataUrl, isVibeFile } = pendingFile;

    switch (target) {
      case 'img2img':
        if (!isVibeFile && handleImg2ImgDropRef.current) {
          handleImg2ImgDropRef.current(dataUrl);
        }
        break;
      case 'vibe':
        if (handleVibeDropRef.current) {
          handleVibeDropRef.current(file, dataUrl);
        }
        break;
      case 'cr':
        if (!isVibeFile && handleCRDropRef.current) {
          handleCRDropRef.current(dataUrl);
        }
        break;
    }

    setPendingFile(null);
  }, [pendingFile]);

  return (
    <DragDropContext.Provider
      value={{
        isDraggingOver,
        setIsDraggingOver,
        pendingFile,
        setPendingFile,
        handleImg2ImgDrop: handleImg2ImgDropRef.current,
        setHandleImg2ImgDrop: setHandleImg2ImgDropStable,
        handleVibeDrop: handleVibeDropRef.current,
        setHandleVibeDrop: setHandleVibeDropStable,
        handleCRDrop: handleCRDropRef.current,
        setHandleCRDrop: setHandleCRDropStable,
        handleMetadataImport: handleMetadataImportRef.current,
        setHandleMetadataImport: setHandleMetadataImportStable,
        sidebarScrollRef,
        scrollToDropZones,
        processFileForTarget,
      }}
    >
      {children}
    </DragDropContext.Provider>
  );
};
