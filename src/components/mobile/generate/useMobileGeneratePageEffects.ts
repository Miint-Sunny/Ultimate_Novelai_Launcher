import { useEffect, type Dispatch, type SetStateAction } from 'react';
import { useDragDrop } from '../../../contexts/DragDropContext';
import { importedPositivePrompt } from '../../left-sidebar/metadataImportActions';
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
  // 本身不在这里消费,但剥离自动 teXt: 块要拿它重算一遍才知道该不该剥。
  characterPrompts?: Array<{ prompt: string; center?: { x: number; y: number } }>;
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

interface UseMobileLibraryBootstrapOptions {
  fetchAnlas: () => void | Promise<void>;
  loadVibes: () => void | Promise<void>;
  loadCRs: () => void | Promise<void>;
  loadArtists: () => void | Promise<void>;
  loadOCs: () => void | Promise<void>;
}

interface UseMobileOCSheetLifecycleOptions {
  showOCModal: boolean;
  loadOCs: () => void | Promise<void>;
  resetOCSelection: () => void;
}

interface UseMobileGeneratePageLifecycleOptions extends
  UseMobileEditorStateBridgeOptions,
  UseMobileMetadataImportHandlerOptions,
  UseMobileBackHandlersOptions,
  UseMobileLibraryBootstrapOptions,
  UseMobileOCSheetLifecycleOptions {}

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
        const imported = importedPositivePrompt(metadata);
        if (options.cleanImports) {
          setPositivePrompt(imported);
        } else {
          setPositivePrompt((prev) => prev ? `${prev}, ${imported}` : imported);
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

export function useMobileLibraryBootstrap({
  fetchAnlas,
  loadVibes,
  loadCRs,
  loadArtists,
  loadOCs,
}: UseMobileLibraryBootstrapOptions) {
  useEffect(() => {
    void fetchAnlas();
    void loadVibes();
    void loadCRs();
    void loadArtists();
    void loadOCs();
  }, []);
}

export function useMobileOCSheetLifecycle({
  showOCModal,
  loadOCs,
  resetOCSelection,
}: UseMobileOCSheetLifecycleOptions) {
  useEffect(() => {
    if (!showOCModal) {
      resetOCSelection();
      return;
    }
    void loadOCs();
  }, [loadOCs, resetOCSelection, showOCModal]);
}

export function useMobileGeneratePageLifecycle(options: UseMobileGeneratePageLifecycleOptions) {
  useMobileEditorStateBridge(options);
  useMobileMetadataImportHandler(options);
  useMobileBackHandlers(options);
  useMobileLibraryBootstrap(options);
  useMobileOCSheetLifecycle(options);
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
