// 助手(Agent)编排装配层 —— 双端共享
// 逻辑自桌面 left-sidebar/useAgentPromptGeneration 与 useAgentSnapshotActions 原样抽取,
// 桌面端行为必须逐字节不变;移动端经薄适配复用同一层(同名导出,UI 组件不动)。
// 纯模块:无 React 值导入、无服务门面导入(agentService 的 setContext/execute 与
// publicLibrary 的 getPublicVibeFile 均以依赖注入传入),因此可直接被
// node --experimental-strip-types 加载做对等校验(scripts/check-agent-parity.mjs)。
// 多会话不在本期:本层只编排单次执行的上下文构建与结果应用,不持有会话状态。

import type { Dispatch, SetStateAction } from 'react';
import type { AgentContext, AgentResult } from '../../services/agentService';
import type { VibeData } from '../../services/localLibrary';

// ==================== 结构类型(双端组件类型均结构兼容) ====================

export interface AgentVibeFile {
  id: string;
  name: string;
  preview?: string;
  image?: string;
  encodings?: VibeData['encodings'];
  defaultStrength?: number;
  defaultInfoExtracted?: number;
  supportedModels?: string[];
  fileName?: string;
}

// 与桌面 ActiveVibe 输出形状一致(恢复/应用 agent 结果时构造的激活 vibe)
export interface AgentActiveVibe {
  id: string;
  name: string;
  preview?: string;
  image?: string;
  encodings?: VibeData['encodings'];
  referenceStrength: number;
  informationExtracted: number;
  supportedModels?: string[];
  enabled: boolean;
}

export interface AgentArtistFile {
  id: string;
  name: string;
  prompt: string;
}

export interface AgentOCFile {
  id: string;
  name: string;
  positive: string;
  negative?: string;
}

export type AgentRoleTagMap = AgentContext['roleTags'];

// 快照/结果里的角色条目:移动端快照 name 可缺省(壳层负责兜底命名)
export interface AgentCharacterSnapshot {
  name?: string;
  positive: string;
  negative?: string;
}

export type AgentPreState = {
  positive: string;
  negative: string;
  characters: Array<{ name: string; positive: string; negative?: string }>;
  /** 生成前选中的 vibe id;旧快照没有时回落到当前选中 */
  vibes?: string[];
};

// 与两端 CharacterPrompt 条目结构一致
export interface AgentCharacterPromptEntry {
  id: string;
  positive: string;
  negative: string;
  activeTab: 'prompt' | 'undesired';
  enabled: boolean;
  position?: string;
  name?: string;
}

// ==================== AgentContext 构建(桌面语义) ====================

export interface AgentContextSources {
  /** 全量 vibe 库(公共+本地)。注意:桌面语义是全量,移动端旧实现只发激活 vibe */
  vibeFiles: AgentVibeFile[];
  artistFiles: AgentArtistFile[];
  ocFiles: AgentOCFile[];
  roleTags: AgentRoleTagMap;
  currentPositive: string;
  currentNegative: string;
  currentCharacters: AgentCharacterPromptEntry[];
  /** 当前选中的 vibe id(进快照 preVibes,撤回/重试用) */
  selectedVibeIds: string[];
}

export function mapCurrentCharactersToContext(characterPrompts: AgentCharacterPromptEntry[]) {
  return characterPrompts
    .filter((c) => c.enabled && c.positive.trim())
    .map((c) => ({
      name: c.name || '未命名角色',
      positive: c.positive,
      negative: c.negative || undefined,
    }));
}

export function buildAgentContext(
  sources: AgentContextSources,
  preState?: AgentPreState,
): AgentContext {
  return {
    vibes: sources.vibeFiles.map((v) => ({
      id: v.id,
      name: v.name,
      supportedModels: v.supportedModels || [],
    })),
    artists: sources.artistFiles.map((a) => ({
      id: a.id,
      name: a.name,
      prompt: a.prompt,
    })),
    ocs: sources.ocFiles.map((o) => ({
      id: o.id,
      name: o.name,
      zhName: o.name,
      positive: o.positive,
      negative: o.negative || '',
    })),
    roleTags: sources.roleTags,
    currentPositive: preState?.positive ?? sources.currentPositive,
    currentNegative: preState?.negative ?? sources.currentNegative,
    currentCharacters: preState?.characters ?? mapCurrentCharactersToContext(sources.currentCharacters),
    currentVibes: preState?.vibes ?? sources.selectedVibeIds,
  };
}

// ==================== vibe 回填(桌面语义:id 精确匹配,默认 ie/strength 0.5) ====================

export function buildActiveVibesFromAgentResult(
  vibeIds: string[],
  publicFiles: AgentVibeFile[],
  localFiles: AgentVibeFile[],
) {
  const allFiles = [...publicFiles, ...localFiles];
  const publicFileIds = new Set(publicFiles.map((file) => file.id));
  const activeVibes: AgentActiveVibe[] = [];
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

export function buildActiveVibesFromIds(
  vibeIds: string[],
  publicFiles: AgentVibeFile[],
  localFiles: AgentVibeFile[],
) {
  const allFiles = [...publicFiles, ...localFiles];
  const activeVibes: AgentActiveVibe[] = [];

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

export type GetPublicVibeFile = (fileName: string) => Promise<Record<string, unknown> | null>;

// 公共 vibe 缺图/缺编码时回源拉取完整数据。setLoadingVibeIds 可选:
// 桌面有加载指示 UI,移动端无(仅静默加载,行为向桌面对齐)。
export function loadMissingPublicVibes(
  vibeIds: string[],
  allFiles: AgentVibeFile[],
  deps: {
    getPublicVibeFile: GetPublicVibeFile;
    setActiveVibes: Dispatch<SetStateAction<AgentActiveVibe[]>>;
    setLoadingVibeIds?: Dispatch<SetStateAction<Set<string>>>;
  },
) {
  deps.setLoadingVibeIds?.(new Set(vibeIds));

  vibeIds.forEach(async (id) => {
    const file = allFiles.find((candidate) => candidate.id === id);
    if (!file?.fileName) return;

    try {
      const fullData = await deps.getPublicVibeFile(file.fileName);
      if (fullData) {
        deps.setActiveVibes((prev) => prev.map((vibe) => (
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
      deps.setLoadingVibeIds?.((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  });
}

// ==================== 角色提示词回填(桌面语义) ====================

export function buildAgentCharacterPrompts(characters: AgentCharacterSnapshot[]): AgentCharacterPromptEntry[] {
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

// ==================== Agent 结果应用(桌面语义) ====================

export interface AgentResultUIDeps {
  publicVibeFiles: AgentVibeFile[];
  localVibeFiles: AgentVibeFile[];
  setPositivePrompt: (value: string) => void;
  setNegativePrompt: (value: string) => void;
  setCharacterPrompts: (value: AgentCharacterPromptEntry[]) => void;
  setActiveVibes: Dispatch<SetStateAction<AgentActiveVibe[]>>;
  clearPreciseReference: () => void;
  /** 桌面 vibe 选择状态;移动端无此 UI,缺省即可 */
  setSelectedVibes?: (value: string[]) => void;
  /** 桌面展开角色区块;移动端无此 UI,缺省即可 */
  openCharacterSection?: () => void;
  setLoadingVibeIds?: Dispatch<SetStateAction<Set<string>>>;
  getPublicVibeFile: GetPublicVibeFile;
}

export function applyAgentResultToUI(result: AgentResult, deps: AgentResultUIDeps) {
  if (result.positive) {
    deps.setPositivePrompt(result.positive);
  }

  if (result.negative) {
    deps.setNegativePrompt(result.negative);
  }

  if (result.vibes && result.vibes.length > 0) {
    const { activeVibes, vibesToLoad, allFiles } = buildActiveVibesFromAgentResult(
      result.vibes,
      deps.publicVibeFiles,
      deps.localVibeFiles,
    );

    deps.setSelectedVibes?.(result.vibes);
    deps.setActiveVibes(activeVibes);

    if (activeVibes.length > 0) {
      deps.clearPreciseReference();
    }

    if (vibesToLoad.length > 0) {
      loadMissingPublicVibes(vibesToLoad, allFiles, deps);
    }
  }

  if (result.characters && result.characters.length > 0) {
    deps.setCharacterPrompts(buildAgentCharacterPrompts(result.characters).slice(0, 6));
    deps.openCharacterSection?.();
  }
}

// ==================== 快照恢复(桌面语义) ====================

export interface AgentPromptSnapshot {
  positive: string;
  negative: string;
  characters: AgentCharacterSnapshot[];
}

export interface AgentGenerationSnapshot extends AgentPromptSnapshot {
  vibes: string[];
}

export interface AgentRestoreUIDeps {
  publicVibeFiles: AgentVibeFile[];
  localVibeFiles: AgentVibeFile[];
  setPositivePrompt: (value: string) => void;
  setNegativePrompt: (value: string) => void;
  setCharacterPrompts: (value: AgentCharacterPromptEntry[]) => void;
  setActiveVibes: Dispatch<SetStateAction<AgentActiveVibe[]>>;
  setSelectedVibes?: (value: string[]) => void;
  openCharacterSection?: () => void;
}

export function restorePromptSnapshotToUI(
  snapshot: AgentPromptSnapshot,
  deps: AgentRestoreUIDeps,
  options: { openCharacterSection: boolean } = { openCharacterSection: false },
) {
  deps.setPositivePrompt(snapshot.positive);
  deps.setNegativePrompt(snapshot.negative);

  if (snapshot.characters.length > 0) {
    deps.setCharacterPrompts(buildAgentCharacterPrompts(snapshot.characters).slice(0, 6));
    if (options.openCharacterSection) {
      deps.openCharacterSection?.();
    }
  } else {
    deps.setCharacterPrompts([]);
  }
}

export function restoreGeneratedSnapshotToUI(
  snapshot: AgentGenerationSnapshot,
  deps: AgentRestoreUIDeps,
  options: { openCharacterSection: boolean } = { openCharacterSection: false },
) {
  restorePromptSnapshotToUI(snapshot, deps, options);

  if (snapshot.vibes.length > 0) {
    deps.setSelectedVibes?.(snapshot.vibes);
    deps.setActiveVibes(buildActiveVibesFromIds(snapshot.vibes, deps.publicVibeFiles, deps.localVibeFiles));
  } else {
    deps.setSelectedVibes?.([]);
    deps.setActiveVibes([]);
  }
}

// ==================== 单次执行编排(桌面语义) ====================

export interface AgentRunDeps {
  contextSources: AgentContextSources;
  setIsGeneratingPrompt: (value: boolean) => void;
  setAgentContext: (context: AgentContext) => void;
  executeAgent: (
    input: string,
    model: string,
    skipUserLog: boolean,
    imageBase64?: string
  ) => Promise<AgentResult | null>;
  applyResult: (result: AgentResult) => void;
  onError: (error: unknown) => void;
}

export interface AgentRunOptions {
  input: string;
  aiModel: string;
  skipUserLog: boolean;
  allowImageOnly: boolean;
  imageBase64?: string;
  preState?: AgentPreState;
}

export async function runAgent(deps: AgentRunDeps, options: AgentRunOptions): Promise<void> {
  if (!options.input.trim() && (!options.allowImageOnly || !options.imageBase64)) return;

  deps.setIsGeneratingPrompt(true);

  try {
    deps.setAgentContext(buildAgentContext(deps.contextSources, options.preState));
    const result = await deps.executeAgent(
      options.input,
      options.aiModel,
      options.skipUserLog,
      options.imageBase64,
    );

    if (result) {
      deps.applyResult(result);
    }
  } catch (error) {
    deps.onError(error);
  } finally {
    deps.setIsGeneratingPrompt(false);
  }
}
