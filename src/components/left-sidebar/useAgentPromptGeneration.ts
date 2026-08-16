import { useCallback } from 'react';
import type { Dispatch, MouseEvent as ReactMouseEvent, SetStateAction } from 'react';
import { agentService, type AgentContext, type AgentResult } from '../../services/agentService';
import type { VibeData } from '../../services/localLibrary';
import { getPublicVibeFile } from '../../services/publicLibrary';
import type { ArtistFile } from '../artist';
import type { OCFile } from '../oc';
import type { ActiveVibe, VibeFile } from '../vibe';
import type { CharacterPrompt as SidebarCharacterPrompt } from './types';

type AgentPreState = {
  positive: string;
  negative: string;
  characters: Array<{ name: string; positive: string; negative?: string }>;
  /** 生成前选中的 vibe id；旧快照没有时回落到当前选中 */
  vibes?: string[];
};

type RoleTagMap = AgentContext['roleTags'];

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

function mapCurrentCharacters(characterPrompts: SidebarCharacterPrompt[]) {
  return characterPrompts
    .filter((c) => c.enabled && c.positive.trim())
    .map((c) => ({
      name: c.name || '未命名角色',
      positive: c.positive,
      negative: c.negative || undefined,
    }));
}

function buildAgentContext(
  params: UseAgentPromptGenerationParams,
  preState?: AgentPreState,
): AgentContext {
  return {
    vibes: [...params.publicFiles, ...params.localFiles].map((v) => ({
      id: v.id,
      name: v.name,
      supportedModels: v.supportedModels || [],
    })),
    artists: [...params.artistPublicFiles, ...params.artistLocalFiles].map((a) => ({
      id: a.id,
      name: a.name,
      prompt: a.prompt,
    })),
    ocs: [...params.ocPublicFiles, ...params.ocLocalFiles].map((o) => ({
      id: o.id,
      name: o.name,
      zhName: o.name,
      positive: o.positive,
      negative: o.negative || '',
    })),
    roleTags: params.roleTagMap,
    currentPositive: preState?.positive ?? params.positivePrompt,
    currentNegative: preState?.negative ?? params.negativePrompt,
    currentCharacters: preState?.characters ?? mapCurrentCharacters(params.characterPrompts),
    currentVibes: preState?.vibes ?? params.selectedVibes,
  };
}

function buildActiveVibesFromResult(
  vibeIds: string[],
  publicFiles: VibeFile[],
  localFiles: VibeFile[],
) {
  const allFiles = [...publicFiles, ...localFiles];
  const publicFileIds = new Set(publicFiles.map((file) => file.id));
  const activeVibes: ActiveVibe[] = [];
  const vibesToLoad: string[] = [];

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

    if (file.fileName && (!file.image || !file.encodings) && publicFileIds.has(id)) {
      vibesToLoad.push(id);
    }
  }

  return { activeVibes, vibesToLoad, allFiles };
}

function loadMissingPublicVibes(
  vibeIds: string[],
  allFiles: VibeFile[],
  setActiveVibes: Dispatch<SetStateAction<ActiveVibe[]>>,
  setLoadingVibeIds: Dispatch<SetStateAction<Set<string>>>,
) {
  setLoadingVibeIds(new Set(vibeIds));

  vibeIds.forEach(async (id) => {
    const file = allFiles.find((candidate) => candidate.id === id);
    if (!file?.fileName) return;

    try {
      const fullData = await getPublicVibeFile(file.fileName);
      if (fullData) {
        setActiveVibes((prev) => prev.map((vibe) => (
          vibe.id === id
            ? {
              ...vibe,
              image: fullData.image as string,
              encodings: fullData.encodings as VibeData['encodings'],
            }
            : vibe
        )));
      }
    } catch (err) {
      console.error('Failed to load public vibe file:', err);
    } finally {
      setLoadingVibeIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  });
}

function buildCharacterPrompts(result: AgentResult): SidebarCharacterPrompt[] {
  return result.characters.map((char, index) => ({
    id: `${Date.now()}-${index}`,
    positive: char.positive,
    negative: char.negative || '',
    activeTab: 'prompt' as const,
    enabled: true,
    position: '',
    name: char.name || `角色${index + 1}`,
  }));
}

function applyAgentResult(result: AgentResult, params: UseAgentPromptGenerationParams) {
  if (result.positive) {
    params.setPositivePrompt(result.positive);
  }

  if (result.negative) {
    params.setNegativePrompt(result.negative);
  }

  if (result.vibes && result.vibes.length > 0) {
    const { activeVibes, vibesToLoad, allFiles } = buildActiveVibesFromResult(
      result.vibes,
      params.publicFiles,
      params.localFiles,
    );

    params.setSelectedVibes(result.vibes);
    params.setActiveVibes(activeVibes);

    if (activeVibes.length > 0) {
      params.clearPreciseReference();
    }

    if (vibesToLoad.length > 0) {
      loadMissingPublicVibes(
        vibesToLoad,
        allFiles,
        params.setActiveVibes,
        params.setLoadingVibeIds,
      );
    }
  }

  if (result.characters && result.characters.length > 0) {
    params.setCharacterPrompts(buildCharacterPrompts(result).slice(0, 6));
    params.setIsCharacterSectionOpen(true);
  }
}

export function useAgentPromptGeneration(params: UseAgentPromptGenerationParams) {
  const runAgent = useCallback(async (options: RunAgentOptions) => {
    if (!options.input.trim() && (!options.allowImageOnly || !options.imageBase64)) return;

    params.setIsGeneratingPrompt(true);

    try {
      agentService.setContext(buildAgentContext(params, options.preState));
      const result = await agentService.execute(
        options.input,
        params.aiModel,
        options.skipUserLog,
        options.imageBase64,
      );

      if (result) {
        applyAgentResult(result, params);
      }
    } catch (error) {
      console.error('Agent执行失败:', error);
    } finally {
      params.setIsGeneratingPrompt(false);
    }
  }, [params]);

  const handleAIGenerate = useCallback((
    request?: string | ReactMouseEvent,
    imageBase64?: string,
  ) => {
    const input = typeof request === 'string' ? request : '';
    return runAgent({
      input,
      imageBase64,
      skipUserLog: false,
      allowImageOnly: true,
    });
  }, [runAgent]);

  const handleAIGenerateWithRequest = useCallback((
    request: string,
    preState?: AgentPreState,
    imageBase64?: string,
  ) => runAgent({
    input: request,
    imageBase64,
    skipUserLog: true,
    allowImageOnly: false,
    preState,
  }), [runAgent]);

  return { handleAIGenerate, handleAIGenerateWithRequest };
}
