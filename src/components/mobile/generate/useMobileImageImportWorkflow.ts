import type { Dispatch, SetStateAction } from 'react';
import type { ActiveCR, ActiveVibe, CharacterPrompt, VibeFile } from '../types';
import { useMobileImageImport } from './useMobileImageImport';
import { useMobileImportedImageActions } from './useMobileImportedImageActions';
import { useMobileMetadataImportActions } from './useMobileMetadataImportActions';
import { useMobileTaggerImportAction } from './useMobileTaggerImportAction';

interface UseMobileImageImportWorkflowOptions {
  setActiveVibes: Dispatch<SetStateAction<ActiveVibe[]>>;
  setImg2imgWithAutoRes: (dataUrl: string) => void;
  setActiveCR: (cr: ActiveCR | null) => void;
  setPositivePrompt: Dispatch<SetStateAction<string>>;
  setNegativePrompt: Dispatch<SetStateAction<string>>;
  setSteps: Dispatch<SetStateAction<number>>;
  setScale: Dispatch<SetStateAction<number>>;
  setSampler: Dispatch<SetStateAction<string>>;
  setNoiseSchedule: Dispatch<SetStateAction<string>>;
  setLocalWidth: Dispatch<SetStateAction<number>>;
  setLocalHeight: Dispatch<SetStateAction<number>>;
  setSeed: (seed: string) => void;
  setCharacterPrompts: Dispatch<SetStateAction<CharacterPrompt[]>>;
  setLocalVibeFiles: Dispatch<SetStateAction<VibeFile[]>>;
}

export function useMobileImageImportWorkflow({
  setActiveVibes,
  setImg2imgWithAutoRes,
  setActiveCR,
  setPositivePrompt,
  setNegativePrompt,
  setSteps,
  setScale,
  setSampler,
  setNoiseSchedule,
  setLocalWidth,
  setLocalHeight,
  setSeed,
  setCharacterPrompts,
  setLocalVibeFiles,
}: UseMobileImageImportWorkflowOptions) {
  const imageImport = useMobileImageImport();
  const {
    showImageImportModal,
    setShowImageImportModal,
    importImageDataUrl,
    importImageMetadata,
    taggerResult,
    importOptions,
    includeCharacter,
  } = imageImport;

  const closeImageImportModal = () => setShowImageImportModal(false);

  const importedImageActions = useMobileImportedImageActions({
    importImageDataUrl,
    setActiveVibes,
    setImg2imgWithAutoRes,
    setActiveCR,
    closeImageImportModal,
  });

  const { importMetadata } = useMobileMetadataImportActions({
    importImageMetadata,
    importOptions,
    setPositivePrompt,
    setNegativePrompt,
    setSteps,
    setScale,
    setSampler,
    setNoiseSchedule,
    setLocalWidth,
    setLocalHeight,
    setSeed,
    setCharacterPrompts,
    setLocalVibeFiles,
    setActiveVibes,
    closeImageImportModal,
  });

  const { importTaggerPrompt } = useMobileTaggerImportAction({
    taggerResult,
    includeCharacter,
    importOptions,
    setPositivePrompt,
    closeImageImportModal,
  });

  return {
    ...imageImport,
    ...importedImageActions,
    importMetadata,
    importTaggerPrompt,
    closeImageImportModal,
  };
}
