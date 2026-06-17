import { MobileArtistModal } from './MobileArtistModal';
import { MobileInspirationSheet } from './MobileInspirationSheet';
import { MobileOCEditorSheet } from './MobileOCEditorSheet';
import { MobileOCSheet } from './MobileOCSheet';
import { MobilePreciseReferenceSheet } from './MobilePreciseReferenceSheet';
import { MobileVibeManagerSheet } from './MobileVibeManagerSheet';
import type { useMobileCodexInspiration } from './generate/useMobileCodexInspiration';
import type { useMobileOCManager } from './generate/useMobileOCManager';
import type { useMobilePreciseReferences } from './generate/useMobilePreciseReferences';
import type { useMobileVibeLibrary } from './generate/useMobileVibeLibrary';

type ArtistSelection = { name: string; prompt: string } | null;

interface MobileGenerateReferenceSheetsProps {
  showVibeModal: boolean;
  closeVibeModal: () => void;
  vibeLibrary: ReturnType<typeof useMobileVibeLibrary>;
  showCRModal: boolean;
  closeCRModal: () => void;
  preciseReferenceLibrary: ReturnType<typeof useMobilePreciseReferences>;
  showArtistModal: boolean;
  closeArtistModal: () => void;
  handleArtistSelection: (artist: ArtistSelection) => void;
  showOCModal: boolean;
  closeOCModal: () => void;
  characterPromptCount: number;
  ocManager: ReturnType<typeof useMobileOCManager>;
  isInspirationModalOpen: boolean;
  closeInspirationModal: () => void;
  handleInspirationSelect: (prompt: string) => void;
  codexInspiration: ReturnType<typeof useMobileCodexInspiration>;
}

export function MobileGenerateReferenceSheets({
  showVibeModal,
  closeVibeModal,
  vibeLibrary,
  showCRModal,
  closeCRModal,
  preciseReferenceLibrary,
  showArtistModal,
  closeArtistModal,
  handleArtistSelection,
  showOCModal,
  closeOCModal,
  characterPromptCount,
  ocManager,
  isInspirationModalOpen,
  closeInspirationModal,
  handleInspirationSelect,
  codexInspiration,
}: MobileGenerateReferenceSheetsProps) {
  return (
    <>
      <MobileVibeManagerSheet
        isOpen={showVibeModal}
        onClose={closeVibeModal}
        library={vibeLibrary}
      />

      <MobilePreciseReferenceSheet
        isOpen={showCRModal}
        onClose={closeCRModal}
        library={preciseReferenceLibrary}
      />

      <MobileArtistModal
        isOpen={showArtistModal}
        onClose={closeArtistModal}
        onConfirmSelection={handleArtistSelection}
      />

      <MobileOCSheet
        isOpen={showOCModal}
        onClose={closeOCModal}
        characterPromptCount={characterPromptCount}
        manager={ocManager}
      />
      <MobileOCEditorSheet
        isOpen={showOCModal}
        manager={ocManager}
      />

      <MobileInspirationSheet
        isOpen={isInspirationModalOpen}
        onClose={closeInspirationModal}
        onSelect={handleInspirationSelect}
        library={codexInspiration}
      />
    </>
  );
}
