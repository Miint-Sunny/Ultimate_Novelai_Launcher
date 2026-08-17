import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { agentService, type GenerationSnapshot } from '../../services/agentService';
import {
  restoreGeneratedSnapshotToUI,
  restorePromptSnapshotToUI,
} from '../agent/agentOrchestration';
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
    vibes?: string[];
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

// 薄壳:快照恢复逻辑全部在共享层 src/components/agent/agentOrchestration.ts;
// 日志截断/重试动作(agentService.truncate*)是桌面专属,留在壳内,行为不变。
export function useAgentSnapshotActions(params: UseAgentSnapshotActionsParams) {
  const restorePromptSnapshot = useCallback((
    snapshot: PromptSnapshot,
    options: { openCharacterSection: boolean } = { openCharacterSection: false },
  ) => {
    restorePromptSnapshotToUI(snapshot, {
      publicVibeFiles: params.publicFiles,
      localVibeFiles: params.localFiles,
      setPositivePrompt: params.setPositivePrompt,
      setNegativePrompt: params.setNegativePrompt,
      setCharacterPrompts: params.setCharacterPrompts,
      setActiveVibes: params.setActiveVibes,
      setSelectedVibes: params.setSelectedVibes,
      openCharacterSection: () => params.setIsCharacterSectionOpen(true),
    }, options);
  }, [params]);

  const restoreGeneratedSnapshot = useCallback((
    snapshot: GenerationSnapshot,
    options: { openCharacterSection: boolean } = { openCharacterSection: false },
  ) => {
    restoreGeneratedSnapshotToUI(snapshot, {
      publicVibeFiles: params.publicFiles,
      localVibeFiles: params.localFiles,
      setPositivePrompt: params.setPositivePrompt,
      setNegativePrompt: params.setNegativePrompt,
      setCharacterPrompts: params.setCharacterPrompts,
      setActiveVibes: params.setActiveVibes,
      setSelectedVibes: params.setSelectedVibes,
      openCharacterSection: () => params.setIsCharacterSectionOpen(true),
    }, options);
  }, [params]);

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
          vibes: snapshot.preVibes,
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
    restoreGeneratedSnapshot,
    handleSuccessLogAction,
    handleErrorLogRetry,
  };
}
