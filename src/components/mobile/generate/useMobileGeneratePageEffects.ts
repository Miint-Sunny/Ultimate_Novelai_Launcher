import { useEffect, type Dispatch, type SetStateAction } from 'react';
import { useDragDrop } from '../../../contexts/DragDropContext';
import { registerBackHandler } from '../MobileLayout';

type EditorOpenState = 'prompt' | 'undesired' | null;
type BooleanSetter = Dispatch<SetStateAction<boolean>>;
type NullableStringSetter = Dispatch<SetStateAction<string | null>>;
type EditorOpenSetter = Dispatch<SetStateAction<EditorOpenState>>;
type StringSetter = Dispatch<SetStateAction<string>>;

interface UseMobileEditorStateBridgeOptions {
  editorOpen: EditorOpenState;
  editingCharacterId: string | null;
  showAIAssistant: boolean;
  onEditorStateChange?: (isOpen: boolean) => void;
}

interface UseMobileMetadataImportHandlerOptions {
  setPositivePrompt: StringSetter;
  setNegativePrompt: StringSetter;
}

interface MetadataImportPayload {
  prompt?: string;
  negativePrompt?: string;
}

interface MetadataImportOptions {
  prompt?: boolean;
  negativePrompt?: boolean;
  cleanImports?: boolean;
}

interface UseMobileBackHandlersOptions {
  editorOpen: EditorOpenState;
  setEditorOpen: EditorOpenSetter;
  editingCharacterId: string | null;
  setEditingCharacterId: NullableStringSetter;
  editingPositionId: string | null;
  setEditingPositionId: NullableStringSetter;
  showAIAssistant: boolean;
  setShowAIAssistant: BooleanSetter;
  showImageImportModal: boolean;
  setShowImageImportModal: BooleanSetter;
  isInspirationModalOpen: boolean;
  setIsInspirationModalOpen: BooleanSetter;
  showArtistModal: boolean;
  setShowArtistModal: BooleanSetter;
  showOCModal: boolean;
  setShowOCModal: BooleanSetter;
  showVibeModal: boolean;
  setShowVibeModal: BooleanSetter;
  showCRModal: boolean;
  setShowCRModal: BooleanSetter;
}

export function useMobileEditorStateBridge({
  editorOpen,
  editingCharacterId,
  showAIAssistant,
  onEditorStateChange,
}: UseMobileEditorStateBridgeOptions) {
  useEffect(() => {
    onEditorStateChange?.(editorOpen !== null || editingCharacterId !== null || showAIAssistant);
  }, [editorOpen, editingCharacterId, showAIAssistant, onEditorStateChange]);
}

export function useMobileMetadataImportHandler({
  setPositivePrompt,
  setNegativePrompt,
}: UseMobileMetadataImportHandlerOptions) {
  const { setHandleMetadataImport } = useDragDrop();

  useEffect(() => {
    const handler = (metadata: MetadataImportPayload, options: MetadataImportOptions) => {
      if (options.prompt && metadata.prompt) {
        if (options.cleanImports) {
          setPositivePrompt(metadata.prompt);
        } else {
          setPositivePrompt((prev) => prev ? `${prev}, ${metadata.prompt}` : metadata.prompt || '');
        }
      }
      if (options.negativePrompt && metadata.negativePrompt) {
        if (options.cleanImports) {
          setNegativePrompt(metadata.negativePrompt);
        } else {
          setNegativePrompt((prev) => prev ? `${prev}, ${metadata.negativePrompt}` : metadata.negativePrompt || '');
        }
      }
    };
    setHandleMetadataImport(handler);
    return () => setHandleMetadataImport(null);
  }, [setHandleMetadataImport, setPositivePrompt, setNegativePrompt]);
}

export function useMobileBackHandlers({
  editorOpen,
  setEditorOpen,
  editingCharacterId,
  setEditingCharacterId,
  editingPositionId,
  setEditingPositionId,
  showAIAssistant,
  setShowAIAssistant,
  showImageImportModal,
  setShowImageImportModal,
  isInspirationModalOpen,
  setIsInspirationModalOpen,
  showArtistModal,
  setShowArtistModal,
  showOCModal,
  setShowOCModal,
  showVibeModal,
  setShowVibeModal,
  showCRModal,
  setShowCRModal,
}: UseMobileBackHandlersOptions) {
  useEffect(() => {
    const handleBack = () => {
      if (editorOpen !== null) {
        setEditorOpen(null);
        return true;
      }
      if (editingCharacterId !== null) {
        setEditingCharacterId(null);
        return true;
      }
      if (editingPositionId !== null) {
        setEditingPositionId(null);
        return true;
      }
      if (showAIAssistant) {
        setShowAIAssistant(false);
        return true;
      }
      if (showImageImportModal) {
        setShowImageImportModal(false);
        return true;
      }
      if (isInspirationModalOpen) {
        setIsInspirationModalOpen(false);
        return true;
      }
      if (showArtistModal) {
        setShowArtistModal(false);
        return true;
      }
      if (showOCModal) {
        setShowOCModal(false);
        return true;
      }
      if (showVibeModal) {
        setShowVibeModal(false);
        return true;
      }
      if (showCRModal) {
        setShowCRModal(false);
        return true;
      }
      return false;
    };

    return registerBackHandler(handleBack);
  }, [
    editorOpen,
    setEditorOpen,
    editingCharacterId,
    setEditingCharacterId,
    editingPositionId,
    setEditingPositionId,
    showAIAssistant,
    setShowAIAssistant,
    showImageImportModal,
    setShowImageImportModal,
    isInspirationModalOpen,
    setIsInspirationModalOpen,
    showArtistModal,
    setShowArtistModal,
    showOCModal,
    setShowOCModal,
    showVibeModal,
    setShowVibeModal,
    showCRModal,
    setShowCRModal,
  ]);
}
