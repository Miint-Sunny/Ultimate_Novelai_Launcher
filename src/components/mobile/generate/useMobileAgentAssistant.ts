import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import {
  agentService,
  DEFAULT_AI_MODEL,
  type AgentState,
} from '../../../services/agentService';
import { getPublicVibeFile } from '../../../services/publicLibrary';
import {
  applyAgentResultToUI,
  restoreGeneratedSnapshotToUI,
  runAgent,
} from '../../agent/agentOrchestration';
import type {
  ActiveVibe,
  ArtistFile,
  CharacterPrompt,
  OCFile,
  VibeFile,
} from '../types';

type CharacterSnapshot = { positive: string; negative?: string; name?: string };

export interface AgentRoleTag {
  role_en: string;
  role_zh: string[];
  origin_en: string;
  origin_zh: string[];
}

interface RestoreSnapshot {
  positive: string;
  negative: string;
  characters: CharacterSnapshot[];
  vibes: string[];
}

interface UseMobileAgentAssistantOptions {
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
  roleTagMap: Record<string, AgentRoleTag>;
  clearActiveCR: () => void;
}

// 薄适配:编排逻辑全部走共享层 src/components/agent/agentOrchestration.ts(与桌面同一层)。
// 此处只保留移动端既有差异:aiModel/agentState 本地状态、isGeneratingPrompt 并发门、
// preState 角色缺名时按「角色N」兜底(UI 快照形状兼容)。
// 移动端因此获得的对齐(见 P2 报告):AgentContext 发全量 vibe 库并带 currentVibes、
// 结果应用用桌面 truthy 语义、公共 vibe 缺数据时静默回源懒加载、
// 快照恢复对齐桌面(slice 6、id 匹配、ie 默认 0.5、不清 CR)。
export function useMobileAgentAssistant({
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
  clearActiveCR,
}: UseMobileAgentAssistantOptions) {
  const [aiModel, setAiModel] = useState<string>(DEFAULT_AI_MODEL);
  const [isGeneratingPrompt, setIsGeneratingPrompt] = useState(false);
  const [agentState, setAgentState] = useState<AgentState>({ status: 'idle', logs: [] });

  useEffect(() => {
    const unsubscribe = agentService.addEventListener(setAgentState);
    return () => unsubscribe();
  }, []);

  const handleAIGenerate = useCallback(async (request: string) => {
    if (!request || isGeneratingPrompt) return;
    await runAgent({
      contextSources: {
        vibeFiles: [...vibeFiles, ...localVibeFiles],
        artistFiles: [...artistPublicFiles, ...artistLocalFiles],
        ocFiles: [...ocPublicFiles, ...ocLocalFiles],
        roleTags: roleTagMap,
        currentPositive: positivePrompt,
        currentNegative: negativePrompt,
        currentCharacters: characterPrompts,
        selectedVibeIds: activeVibes.map((vibe) => vibe.id),
      },
      setIsGeneratingPrompt,
      setAgentContext: (context) => agentService.setContext(context),
      executeAgent: (input, model, skipUserLog, imageBase64) =>
        agentService.execute(input, model, skipUserLog, imageBase64),
      applyResult: (result) => applyAgentResultToUI(result, {
        publicVibeFiles: vibeFiles,
        localVibeFiles: localVibeFiles,
        setPositivePrompt,
        setNegativePrompt,
        setCharacterPrompts,
        setActiveVibes,
        clearPreciseReference: clearActiveCR,
        getPublicVibeFile,
      }),
      onError: (error) => console.error('AI generation failed:', error),
    }, {
      input: request,
      aiModel,
      skipUserLog: false,
      allowImageOnly: false,
    });
  }, [
    activeVibes,
    aiModel,
    artistLocalFiles,
    artistPublicFiles,
    characterPrompts,
    clearActiveCR,
    isGeneratingPrompt,
    localVibeFiles,
    negativePrompt,
    ocLocalFiles,
    ocPublicFiles,
    positivePrompt,
    roleTagMap,
    setActiveVibes,
    setCharacterPrompts,
    setNegativePrompt,
    setPositivePrompt,
    vibeFiles,
  ]);

  const handleAIRegenerate = useCallback(async (
    request: string,
    preState: { positive: string; negative: string; characters: CharacterSnapshot[] },
    imageBase64?: string,
  ) => {
    if (!request || isGeneratingPrompt) return;
    await runAgent({
      contextSources: {
        vibeFiles: [...vibeFiles, ...localVibeFiles],
        artistFiles: [...artistPublicFiles, ...artistLocalFiles],
        ocFiles: [...ocPublicFiles, ...ocLocalFiles],
        roleTags: roleTagMap,
        currentPositive: positivePrompt,
        currentNegative: negativePrompt,
        currentCharacters: characterPrompts,
        selectedVibeIds: activeVibes.map((vibe) => vibe.id),
      },
      setIsGeneratingPrompt,
      setAgentContext: (context) => agentService.setContext(context),
      executeAgent: (input, model, skipUserLog, image) =>
        agentService.execute(input, model, skipUserLog, image),
      applyResult: (result) => applyAgentResultToUI(result, {
        publicVibeFiles: vibeFiles,
        localVibeFiles: localVibeFiles,
        setPositivePrompt,
        setNegativePrompt,
        setCharacterPrompts,
        setActiveVibes,
        clearPreciseReference: clearActiveCR,
        getPublicVibeFile,
      }),
      onError: (error) => console.error('AI regeneration failed:', error),
    }, {
      input: request,
      aiModel,
      skipUserLog: true,
      allowImageOnly: false,
      imageBase64,
      preState: {
        positive: preState.positive,
        negative: preState.negative,
        characters: preState.characters.map((character, index) => ({
          name: character.name || `角色${index + 1}`,
          positive: character.positive,
          negative: character.negative,
        })),
      },
    });
  }, [
    activeVibes,
    aiModel,
    artistLocalFiles,
    artistPublicFiles,
    characterPrompts,
    clearActiveCR,
    isGeneratingPrompt,
    localVibeFiles,
    negativePrompt,
    ocLocalFiles,
    ocPublicFiles,
    positivePrompt,
    roleTagMap,
    setActiveVibes,
    setCharacterPrompts,
    setNegativePrompt,
    setPositivePrompt,
    vibeFiles,
  ]);

  const handleRestoreSnapshot = useCallback((snapshot: RestoreSnapshot) => {
    restoreGeneratedSnapshotToUI(snapshot, {
      publicVibeFiles: vibeFiles,
      localVibeFiles: localVibeFiles,
      setPositivePrompt,
      setNegativePrompt,
      setCharacterPrompts,
      setActiveVibes,
    });
  }, [
    localVibeFiles,
    setActiveVibes,
    setCharacterPrompts,
    setNegativePrompt,
    setPositivePrompt,
    vibeFiles,
  ]);

  return {
    aiModel,
    setAiModel,
    isGeneratingPrompt,
    agentState,
    handleAIGenerate,
    handleAIRegenerate,
    handleRestoreSnapshot,
  };
}
