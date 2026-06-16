import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import {
  agentService,
  DEFAULT_AI_MODEL,
  type AgentContext,
  type AgentState,
} from '../../../services/agentService';
import type {
  ActiveVibe,
  ArtistFile,
  CharacterPrompt,
  OCFile,
  VibeFile,
} from '../types';

type CharacterSnapshot = { positive: string; negative?: string; name?: string };

interface AgentRoleTag {
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

const makeCharacterPrompts = (characters: CharacterSnapshot[]): CharacterPrompt[] => (
  characters.map((character, index) => ({
    id: `${Date.now()}-${index}`,
    positive: character.positive,
    negative: character.negative || '',
    activeTab: 'prompt' as const,
    enabled: true,
    name: character.name || `角色${index + 1}`,
  }))
);

const restoreVibes = (
  snapshotVibes: string[],
  vibeFiles: VibeFile[],
  localVibeFiles: VibeFile[],
  defaultInfoExtracted: number
): ActiveVibe[] => {
  const allVibes = [...vibeFiles, ...localVibeFiles];
  const restoredVibes: ActiveVibe[] = [];
  for (const vibeRef of snapshotVibes) {
    const file = allVibes.find((vibe) =>
      vibe.id === vibeRef ||
      vibe.name === vibeRef ||
      vibe.name.toLowerCase() === vibeRef.toLowerCase()
    );
    if (!file) continue;
    restoredVibes.push({
      ...file,
      referenceStrength: file.defaultStrength ?? 0.5,
      informationExtracted: file.defaultInfoExtracted ?? defaultInfoExtracted,
      enabled: true,
    });
  }
  return restoredVibes;
};

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

  const buildSharedContext = useCallback((): Omit<AgentContext, 'currentPositive' | 'currentNegative' | 'currentCharacters'> => ({
    vibes: activeVibes.map((vibe) => ({
      id: vibe.id,
      name: vibe.name,
      supportedModels: vibe.supportedModels || [],
    })),
    artists: [...artistPublicFiles, ...artistLocalFiles].map((artist) => ({
      id: artist.id,
      name: artist.name,
      prompt: artist.prompt,
    })),
    ocs: [...ocPublicFiles, ...ocLocalFiles].map((oc) => ({
      id: oc.id,
      name: oc.name,
      zhName: oc.name,
      positive: oc.positive,
      negative: oc.negative || '',
    })),
    roleTags: roleTagMap,
  }), [
    activeVibes,
    artistLocalFiles,
    artistPublicFiles,
    ocLocalFiles,
    ocPublicFiles,
    roleTagMap,
  ]);

  const applyAgentResult = useCallback((result: Awaited<ReturnType<typeof agentService.execute>>) => {
    if (!result) return;
    if (result.positive !== undefined) setPositivePrompt(result.positive);
    if (result.negative !== undefined) setNegativePrompt(result.negative);

    if (result.characters && result.characters.length > 0) {
      setCharacterPrompts(makeCharacterPrompts(result.characters).slice(0, 6));
    }

    if (result.vibes && result.vibes.length > 0) {
      const newActiveVibes = restoreVibes(result.vibes, vibeFiles, localVibeFiles, 0.5);
      if (newActiveVibes.length > 0) {
        setActiveVibes(newActiveVibes);
        clearActiveCR();
      }
    }
  }, [
    clearActiveCR,
    localVibeFiles,
    setActiveVibes,
    setCharacterPrompts,
    setNegativePrompt,
    setPositivePrompt,
    vibeFiles,
  ]);

  const handleAIGenerate = useCallback(async (request: string) => {
    if (!request || isGeneratingPrompt) return;
    setIsGeneratingPrompt(true);
    try {
      agentService.setContext({
        ...buildSharedContext(),
        currentPositive: positivePrompt,
        currentNegative: negativePrompt,
        currentCharacters: characterPrompts
          .filter((character) => character.enabled && character.positive.trim())
          .map((character) => ({
            name: character.name || '未命名角色',
            positive: character.positive,
            negative: character.negative || undefined,
          })),
      });
      const result = await agentService.execute(request, aiModel);
      applyAgentResult(result);
    } catch (error) {
      console.error('AI generation failed:', error);
    } finally {
      setIsGeneratingPrompt(false);
    }
  }, [
    aiModel,
    applyAgentResult,
    buildSharedContext,
    characterPrompts,
    isGeneratingPrompt,
    negativePrompt,
    positivePrompt,
  ]);

  const handleAIRegenerate = useCallback(async (
    request: string,
    preState: { positive: string; negative: string; characters: CharacterSnapshot[] },
    imageBase64?: string,
  ) => {
    if (!request || isGeneratingPrompt) return;
    setIsGeneratingPrompt(true);
    try {
      agentService.setContext({
        ...buildSharedContext(),
        currentPositive: preState.positive,
        currentNegative: preState.negative,
        currentCharacters: preState.characters.map((character, index) => ({
          name: character.name || `角色${index + 1}`,
          positive: character.positive,
          negative: character.negative,
        })),
      });
      const result = await agentService.execute(request, aiModel, true, imageBase64);
      applyAgentResult(result);
    } catch (error) {
      console.error('AI regeneration failed:', error);
    } finally {
      setIsGeneratingPrompt(false);
    }
  }, [
    aiModel,
    applyAgentResult,
    buildSharedContext,
    isGeneratingPrompt,
  ]);

  const handleRestoreSnapshot = useCallback((snapshot: RestoreSnapshot) => {
    setPositivePrompt(snapshot.positive);
    setNegativePrompt(snapshot.negative);
    setCharacterPrompts(snapshot.characters.length > 0 ? makeCharacterPrompts(snapshot.characters) : []);

    if (snapshot.vibes.length === 0) {
      setActiveVibes([]);
      return;
    }

    const restoredVibes = restoreVibes(snapshot.vibes, vibeFiles, localVibeFiles, 1);
    setActiveVibes(restoredVibes);
    if (restoredVibes.length > 0) {
      clearActiveCR();
    }
  }, [
    clearActiveCR,
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
