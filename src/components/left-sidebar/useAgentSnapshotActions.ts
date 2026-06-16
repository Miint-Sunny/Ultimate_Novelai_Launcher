import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { agentService, type GenerationSnapshot } from '../../services/agentService';
import type { ActiveVibe, VibeFile } from '../vibe';
import type { CharacterPrompt } from './types';

type SnapshotCharacter = { name: string; positive: string; negative?: string };

type PromptSnapshot = {
  positive: string;
  negative: string;
  characters: SnapshotCharacter[];
};

type RegenerateWithRequest = (
  request: string,
  preState?: {
    positive: string;
    negative: string;
    characters: SnapshotCharacter[];
  },
  imageBase64?: string,
) => void;

interface UseAgentSnapshotActionsParams {
  publicFiles: VibeFile[];
  localFiles: VibeFile[];
  setPositivePrompt: Dispatch<SetStateAction<string>>;
  setNegativePrompt: Dispatch<SetStateAction<string>>;
  setCharacterPrompts: Dispatch<SetStateAction<CharacterPrompt[]>>;
  setIsCharacterSectionOpen: Dispatch<SetStateAction<boolean>>;
  setSelectedVibes: Dispatch<SetStateAction<string[]>>;
  setActiveVibes: Dispatch<SetStateAction<ActiveVibe[]>>;
  handleAIGenerateWithRequest: RegenerateWithRequest;
}

function buildCharacterPrompts(characters: SnapshotCharacter[]): CharacterPrompt[] {
  return characters.map((char, index) => ({
    id: `${Date.now()}-${index}`,
    positive: char.positive,
    negative: char.negative || '',
    activeTab: 'prompt' as const,
    enabled: true,
    position: '',
    name: char.name || `角色${index + 1}`,
  }));
}

function buildActiveVibes(vibeIds: string[], publicFiles: VibeFile[], localFiles: VibeFile[]) {
  const allFiles = [...publicFiles, ...localFiles];
  const activeVibes: ActiveVibe[] = [];

  for (const id of vibeIds) {
    const file = allFiles.find((candidate) => candidate.id === id);
    if (!file) continue;

    activeVibes.push({
      id,
      name: file.name,
      preview: file.preview,
      image: file.image,
      encodings: file.encodings,
      referenceStrength: file.defaultStrength ?? 0.5,
      informationExtracted: file.defaultInfoExtracted ?? 0.5,
      supportedModels: file.supportedModels,
      enabled: true,
    });
  }

  return activeVibes;
}

export function useAgentSnapshotActions(params: UseAgentSnapshotActionsParams) {
  const restorePromptSnapshot = useCallback((
    snapshot: PromptSnapshot,
    options: { openCharacterSection: boolean } = { openCharacterSection: false },
  ) => {
    params.setPositivePrompt(snapshot.positive);
    params.setNegativePrompt(snapshot.negative);

    if (snapshot.characters.length > 0) {
      params.setCharacterPrompts(buildCharacterPrompts(snapshot.characters).slice(0, 6));
      if (options.openCharacterSection) {
        params.setIsCharacterSectionOpen(true);
      }
    } else {
      params.setCharacterPrompts([]);
    }
  }, [params]);

  const restoreGeneratedSnapshot = useCallback((snapshot: GenerationSnapshot) => {
    restorePromptSnapshot(snapshot);

    if (snapshot.vibes.length > 0) {
      params.setSelectedVibes(snapshot.vibes);
      params.setActiveVibes(buildActiveVibes(snapshot.vibes, params.publicFiles, params.localFiles));
    } else {
      params.setSelectedVibes([]);
      params.setActiveVibes([]);
    }
  }, [params, restorePromptSnapshot]);

  const handleSuccessLogAction = useCallback((
    logIndex: number,
    snapshot: GenerationSnapshot,
    isLastSuccess: boolean,
  ) => {
    if (isLastSuccess) {
      const userRequest = agentService.truncateToUserRequest(logIndex);
      if (userRequest) {
        params.handleAIGenerateWithRequest(userRequest.request, {
          positive: snapshot.prePositive,
          negative: snapshot.preNegative,
          characters: snapshot.preCharacters,
        });
      }
      return;
    }

    restoreGeneratedSnapshot(snapshot);
    agentService.truncateLogsTo(logIndex);
  }, [params, restoreGeneratedSnapshot]);

  const handleErrorLogRetry = useCallback((logIndex: number) => {
    const userRequest = agentService.truncateToUserRequest(logIndex);
    if (userRequest) {
      params.handleAIGenerateWithRequest(userRequest.request);
    }
  }, [params]);

  return {
    restorePromptSnapshot,
    handleSuccessLogAction,
    handleErrorLogRetry,
  };
}
