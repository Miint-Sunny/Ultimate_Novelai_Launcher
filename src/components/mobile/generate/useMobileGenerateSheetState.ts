import { useState } from 'react';

export type MobileEditorOpenState = 'prompt' | 'undesired' | null;

export function useMobileGenerateSheetState() {
  const [editorOpen, setEditorOpen] = useState<MobileEditorOpenState>(null);
  const [showAIAssistant, setShowAIAssistant] = useState(false);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [showResolutionDropdown, setShowResolutionDropdown] = useState(false);
  const [showVibeModal, setShowVibeModal] = useState(false);
  const [showCRModal, setShowCRModal] = useState(false);
  const [isInspirationModalOpen, setIsInspirationModalOpen] = useState(false);
  const [showArtistModal, setShowArtistModal] = useState(false);
  const [showOCModal, setShowOCModal] = useState(false);

  return {
    editorOpen,
    setEditorOpen,
    showAIAssistant,
    setShowAIAssistant,
    showModelDropdown,
    setShowModelDropdown,
    showResolutionDropdown,
    setShowResolutionDropdown,
    showVibeModal,
    setShowVibeModal,
    showCRModal,
    setShowCRModal,
    isInspirationModalOpen,
    setIsInspirationModalOpen,
    showArtistModal,
    setShowArtistModal,
    showOCModal,
    setShowOCModal,
  };
}
