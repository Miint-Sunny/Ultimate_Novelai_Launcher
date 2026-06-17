import type { Dispatch, SetStateAction } from 'react';
import type { ActiveCR, ActiveVibe, ArtistFile, CharacterPrompt, OCFile, VibeFile } from '../types';
import { useMobileAgentAssistant } from './useMobileAgentAssistant';
import { useMobileArtistSelection } from './useMobileArtistSelection';
import { useMobilePromptTranslation } from './useMobilePromptTranslation';
import { useMobileRoleTags } from './useMobileRoleTags';

interface UseMobilePromptAssistWorkflowOptions {
  positivePrompt: string;
  setPositivePrompt: Dispatch<SetStateAction<string>>;
  negativePrompt: string;
  setNegativePrompt: Dispatch<SetStateAction<string>>;
  characterPrompts: CharacterPrompt[];
  setCharacterPrompts: Dispatch<SetStateAction<CharacterPrompt[]>>;
  activeVibes: ActiveVibe[];
  setActiveVibes: Dispatch<SetStateAction<ActiveVibe[]>>;
  vibeFiles: VibeFile[];
  localVibeFiles: VibeFile[];
  artistPublicFiles: ArtistFile[];
  artistLocalFiles: ArtistFile[];
  ocPublicFiles: OCFile[];
  ocLocalFiles: OCFile[];
  setActiveCR: (cr: ActiveCR | null) => void;
  closeArtistModal: () => void;
}

export function useMobilePromptAssistWorkflow({
  positivePrompt,
  setPositivePrompt,
  negativePrompt,
  setNegativePrompt,
  characterPrompts,
  setCharacterPrompts,
  activeVibes,
  setActiveVibes,
  vibeFiles,
  localVibeFiles,
  artistPublicFiles,
  artistLocalFiles,
  ocPublicFiles,
  ocLocalFiles,
  setActiveCR,
  closeArtistModal,
}: UseMobilePromptAssistWorkflowOptions) {
  const roleTagMap = useMobileRoleTags();

  const assistant = useMobileAgentAssistant({
    positivePrompt,
    setPositivePrompt,
    negativePrompt,
    setNegativePrompt,
    characterPrompts,
    setCharacterPrompts,
    activeVibes,
    setActiveVibes,
    vibeFiles,
    localVibeFiles,
    artistPublicFiles,
    artistLocalFiles,
    ocPublicFiles,
    ocLocalFiles,
    roleTagMap,
    clearActiveCR: () => setActiveCR(null),
  });

  const translation = useMobilePromptTranslation({
    positivePrompt,
    setPositivePrompt,
    negativePrompt,
    setNegativePrompt,
  });

  const artistSelection = useMobileArtistSelection({
    setPositivePrompt,
    closeArtistModal,
  });

  return {
    ...assistant,
    ...translation,
    ...artistSelection,
  };
}
