import { useCallback } from 'react';
import type { Dispatch, MouseEvent as ReactMouseEvent, SetStateAction } from 'react';
import { agentService } from '../../services/agentService';
import { getPublicVibeFile } from '../../services/publicLibrary';
import {
  applyAgentResultToUI,
  runAgent,
  type AgentPreState,
  type AgentRoleTagMap,
} from '../agent/agentOrchestration';
import type { ArtistFile } from '../artist';
import type { OCFile } from '../oc';
import type { ActiveVibe, VibeFile } from '../vibe';
import type { CharacterPrompt as SidebarCharacterPrompt } from './types';

type RoleTagMap = AgentRoleTagMap;

interface UseAgentPromptGenerationParams {
  aiModel: string;
  setIsGeneratingPrompt: Dispatch<SetStateAction<boolean>>;
  publicFiles: VibeFile[];
  localFiles: VibeFile[];
  artistPublicFiles: ArtistFile[];
  artistLocalFiles: ArtistFile[];
  ocPublicFiles: OCFile[];
  ocLocalFiles: OCFile[];
  roleTagMap: RoleTagMap;
  positivePrompt: string;
  negativePrompt: string;
  characterPrompts: SidebarCharacterPrompt[];
  selectedVibes: string[];
  setPositivePrompt: Dispatch<SetStateAction<string>>;
  setNegativePrompt: Dispatch<SetStateAction<string>>;
  setSelectedVibes: Dispatch<SetStateAction<string[]>>;
  setActiveVibes: Dispatch<SetStateAction<ActiveVibe[]>>;
  setLoadingVibeIds: Dispatch<SetStateAction<Set<string>>>;
  setCharacterPrompts: Dispatch<SetStateAction<SidebarCharacterPrompt[]>>;
  setIsCharacterSectionOpen: Dispatch<SetStateAction<boolean>>;
  clearPreciseReference: () => void;
}

interface RunAgentOptions {
  input: string;
  imageBase64?: string;
  skipUserLog: boolean;
  allowImageOnly: boolean;
  preState?: AgentPreState;
}

// 薄壳:编排逻辑全部在共享层 src/components/agent/agentOrchestration.ts
// (上下文构建、结果应用、公共 vibe 懒加载),行为与原实现逐字节一致。
export function useAgentPromptGeneration(params: UseAgentPromptGenerationParams) {
  const runAgentCallback = useCallback(async (options: RunAgentOptions) => {
    await runAgent({
      contextSources: {
        vibeFiles: [...params.publicFiles, ...params.localFiles],
        artistFiles: [...params.artistPublicFiles, ...params.artistLocalFiles],
        ocFiles: [...params.ocPublicFiles, ...params.ocLocalFiles],
        roleTags: params.roleTagMap,
        currentPositive: params.positivePrompt,
        currentNegative: params.negativePrompt,
        currentCharacters: params.characterPrompts,
        selectedVibeIds: params.selectedVibes,
      },
      setIsGeneratingPrompt: params.setIsGeneratingPrompt,
      setAgentContext: (context) => agentService.setContext(context),
      executeAgent: (input, model, skipUserLog, imageBase64) =>
        agentService.execute(input, model, skipUserLog, imageBase64),
      applyResult: (result) => applyAgentResultToUI(result, {
        publicVibeFiles: params.publicFiles,
        localVibeFiles: params.localFiles,
        setPositivePrompt: params.setPositivePrompt,
        setNegativePrompt: params.setNegativePrompt,
        setCharacterPrompts: params.setCharacterPrompts,
        setActiveVibes: params.setActiveVibes,
        clearPreciseReference: params.clearPreciseReference,
        setSelectedVibes: params.setSelectedVibes,
        openCharacterSection: () => params.setIsCharacterSectionOpen(true),
        setLoadingVibeIds: params.setLoadingVibeIds,
        getPublicVibeFile,
      }),
      onError: (error) => console.error('Agent执行失败:', error),
    }, {
      input: options.input,
      aiModel: params.aiModel,
      skipUserLog: options.skipUserLog,
      allowImageOnly: options.allowImageOnly,
      imageBase64: options.imageBase64,
      preState: options.preState,
    });
  }, [params]);

  const handleAIGenerate = useCallback((
    request?: string | ReactMouseEvent,
    imageBase64?: string,
  ) => {
    const input = typeof request === 'string' ? request : '';
    return runAgentCallback({
      input,
      imageBase64,
      skipUserLog: false,
      allowImageOnly: true,
    });
  }, [runAgentCallback]);

  const handleAIGenerateWithRequest = useCallback((
    request: string,
    preState?: AgentPreState,
    imageBase64?: string,
  ) => runAgentCallback({
    input: request,
    imageBase64,
    skipUserLog: true,
    allowImageOnly: false,
    preState,
  }), [runAgentCallback]);

  return { handleAIGenerate, handleAIGenerateWithRequest };
}

export type { AgentPreState };
