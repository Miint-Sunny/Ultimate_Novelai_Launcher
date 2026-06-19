import { useEffect } from 'react';
import { registerBackHandler } from '../MobileLayout';

interface UseMobileGalleryBackStackOptions {
  isFullscreen: boolean;
  closeFullscreen: () => void;
  isGalleryExpanded: boolean;
  closeGallery: () => void;
  showSaveSettings: boolean;
  closeSaveSettings: () => void;
  isUpscaleModalOpen: boolean;
  closeUpscaleModal: () => void;
  isInpaintMode: boolean;
  closeInpaintMode: () => void;
}

export function useMobileGalleryBackStack({
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
}: UseMobileGalleryBackStackOptions) {
  useEffect(() => {
    const handleBack = () => {
      if (isFullscreen) {
        closeFullscreen();
        return true;
      }
      if (isGalleryExpanded) {
        closeGallery();
        return true;
      }
      if (showSaveSettings) {
        closeSaveSettings();
        return true;
      }
      if (isUpscaleModalOpen) {
        closeUpscaleModal();
        return true;
      }
      if (isInpaintMode) {
        closeInpaintMode();
        return true;
      }
      return false;
    };

    return registerBackHandler(handleBack);
  }, [
    closeFullscreen,
    closeGallery,
    closeInpaintMode,
    closeSaveSettings,
    closeUpscaleModal,
    isFullscreen,
    isGalleryExpanded,
    isInpaintMode,
    isUpscaleModalOpen,
    showSaveSettings,
  ]);
}
