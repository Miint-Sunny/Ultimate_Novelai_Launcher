/**
 * 左栏状态 ↔ Agent 工具的桥。桥本身不持有状态:所有读写都经过 LeftSidebar 每次渲染
 * 更新的 ref,所以工具在异步循环里拿到的永远是当前值,setter 也永远是活的。
 *
 * 字段口径按 harness 的 StudioParams(他的参数键),这里负责翻译成左栏自己的状态:
 * 模型 UI id ↔ 官方 id、预设行 id ↔ 质量档名、自定义分辨率的四个 setter 一起动。
 */

import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { sidecarApi } from '../../api/sidecar';
import { getCachedIsOpus, isOpusUsageExhausted } from '../../services/novelai';
import { legacyCellToCenter, nextSpawnCenter, placedCenter, type CharacterCenter } from '../../services/characterPosition';
import { promptPresetsForModel } from '../../services/promptPresetCatalog';
import { isV5Model, MODEL_MAP, MODELS, maxCharactersForModel, type ModelOption } from '../generation/modelResolutionOptions';
import type { HistoryItem } from '../../contexts/GenerationContext';
import type { GenerateOutcome, StudioParams, WorkbenchAdapter, WorkbenchCharacter } from '../../services/agentHarness/workbench';
import type { CharacterPrompt, PromptPreset } from './types';

export interface WorkbenchState {
  positivePrompt: string;
  negativePrompt: string;
  selectedModel: ModelOption;
  customWidth: number;
  customHeight: number;
  steps: number;
  scale: number;
  sampler: string;
  scaleRescale: number;
  noiseSchedule: string;
  activePresetId: string;
  promptPresets: PromptPreset[];
  seed: string;
  characterPrompts: CharacterPrompt[];
  /** 官方位置区块的全局开关;`character_ai_position` = !useCoords。 */
  useCoords: boolean;
  /** 当前模型是否自由定位(出生位置的占位判据用)。 */
  freeform: boolean;
  generationHistory: HistoryItem[];
  isGenerating: boolean;
  setPositivePrompt: Dispatch<SetStateAction<string>>;
  setNegativePrompt: Dispatch<SetStateAction<string>>;
  setSelectedModel: Dispatch<SetStateAction<ModelOption>>;
  setCustomWidth: Dispatch<SetStateAction<number>>;
  setCustomHeight: Dispatch<SetStateAction<number>>;
  setCustomWidthInput: Dispatch<SetStateAction<string>>;
  setCustomHeightInput: Dispatch<SetStateAction<string>>;
  setIsCustomRes: Dispatch<SetStateAction<boolean>>;
  setSteps: Dispatch<SetStateAction<number>>;
  setScale: Dispatch<SetStateAction<number>>;
  setSampler: Dispatch<SetStateAction<string>>;
  setScaleRescale: Dispatch<SetStateAction<number>>;
  setNoiseSchedule: Dispatch<SetStateAction<string>>;
  setActivePresetId: (id: string) => void;
  setSeed: (seed: string) => void;
  setCharacterPrompts: Dispatch<SetStateAction<CharacterPrompt[]>>;
  setUseCoords: (useCoords: boolean) => void;
  handleGenerate: () => void;
  addUpscaledImage: (imageUrl: string, width: number, height: number, originalSeed: number, scale: number) => void;
}

type PendingGenerate = { resolve: (outcome: GenerateOutcome) => void; historyHead: string | null; timer: number } | null;

const GENERATE_TIMEOUT_MS = 5 * 60_000;

/** 预设行 id → 他的质量档名。 */
function qualityPresetName(presetId: string): string {
  if (presetId === 'none') return 'Off';
  if (presetId === 'v5-light' || presetId === 'light') return 'Light';
  if (presetId === 'heavy') return 'Heavy';
  return 'Standard';
}

/** 质量档名 → 当前模型可见的预设行 id;找不到就保持不动。 */
function presetIdForQuality(name: string, presets: PromptPreset[], isV5: boolean, current: string): string {
  const visible = promptPresetsForModel(presets, isV5).map((p) => p.id);
  const pick = (...ids: string[]) => ids.find((id) => visible.includes(id));
  const chosen = name === 'Off' ? pick('none')
    : name === 'Light' ? pick('v5-light', 'light')
      : name === 'Heavy' ? pick('heavy', 'v5-standard')
        : pick('v5-standard', 'heavy');
  return chosen ?? current;
}

function uiModelIdFor(backendId: string): string | null {
  const hit = Object.entries(MODEL_MAP).find(([, id]) => id === backendId);
  return hit ? hit[0] : null;
}

function takenCenters(characters: readonly CharacterPrompt[]): CharacterCenter[] {
  return characters.map(placedCenter).filter((c): c is CharacterCenter => c !== null);
}

function toWorkbenchCharacter(c: CharacterPrompt): WorkbenchCharacter {
  return {
    id: c.id,
    name: c.name ?? '',
    enabled: c.enabled,
    prompt: c.positive,
    negative_prompt: c.negative,
    center: c.center ?? legacyCellToCenter(c.position) ?? null,
  };
}

export function createWorkbenchBridge(
  stateRef: MutableRefObject<WorkbenchState | null>,
  pendingRef: MutableRefObject<PendingGenerate>,
): Omit<WorkbenchAdapter, 'askUser'> {
  const state = () => {
    const s = stateRef.current;
    if (!s) throw new Error('工作台还没有挂载');
    return s;
  };
  return {
    getParams: (): StudioParams => {
      const s = state();
      return {
        prompt: s.positivePrompt,
        negative_prompt: s.negativePrompt,
        model: MODEL_MAP[s.selectedModel.id] ?? s.selectedModel.id,
        width: s.customWidth,
        height: s.customHeight,
        steps: s.steps,
        scale: s.scale,
        cfg_rescale: s.scaleRescale,
        sampler: s.sampler,
        noise_schedule: s.noiseSchedule,
        quality_preset: qualityPresetName(s.activePresetId),
        seed: s.seed,
        character_ai_position: !s.useCoords,
      };
    },
    applyParams: (patch) => {
      const s = state();
      if (patch.prompt !== undefined) s.setPositivePrompt(patch.prompt);
      if (patch.negative_prompt !== undefined) s.setNegativePrompt(patch.negative_prompt);
      if (patch.model !== undefined) {
        const uiId = uiModelIdFor(patch.model);
        const option = uiId ? MODELS.find((m) => m.id === uiId) : undefined;
        if (option) s.setSelectedModel(option);
      }
      if (patch.width !== undefined || patch.height !== undefined) {
        const width = patch.width ?? s.customWidth;
        const height = patch.height ?? s.customHeight;
        s.setIsCustomRes(true);
        s.setCustomWidth(width); s.setCustomHeight(height);
        s.setCustomWidthInput(String(width)); s.setCustomHeightInput(String(height));
      }
      if (patch.steps !== undefined) s.setSteps(patch.steps);
      if (patch.scale !== undefined) s.setScale(patch.scale);
      if (patch.cfg_rescale !== undefined) s.setScaleRescale(patch.cfg_rescale);
      if (patch.sampler !== undefined) s.setSampler(patch.sampler);
      if (patch.noise_schedule !== undefined) s.setNoiseSchedule(patch.noise_schedule);
      if (patch.quality_preset !== undefined) {
        const modelId = patch.model !== undefined ? (uiModelIdFor(patch.model) ?? s.selectedModel.id) : s.selectedModel.id;
        s.setActivePresetId(presetIdForQuality(patch.quality_preset, s.promptPresets, isV5Model(modelId), s.activePresetId));
      }
      if (patch.seed !== undefined) s.setSeed(patch.seed);
      // 官方的全局开关:交给模型排版不清坐标,坐标留着,切回来还在。
      if (patch.character_ai_position !== undefined) s.setUseCoords(!patch.character_ai_position);
    },
    availableModels: () => MODELS.map((m) => ({ id: MODEL_MAP[m.id] ?? m.id, label: m.name })),
    availableQualityPresets: () => ['Standard', 'Heavy', 'Light', 'Off'].map((id) => ({ id, label: id })),

    listCharacters: () => state().characterPrompts.map(toWorkbenchCharacter),
    addCharacter: (entry) => {
      const s = state();
      const created: CharacterPrompt = {
        id: `${Date.now()}${Math.floor(Math.random() * 1000)}`,
        positive: entry.prompt,
        negative: entry.negative_prompt ?? '',
        activeTab: 'prompt',
        enabled: true,
        position: '',
        // 没给坐标就照官方候选序挑一个空位:角色建出来就有坐标,不存在「自动」档。
        center: entry.center ?? nextSpawnCenter(takenCenters(s.characterPrompts), s.freeform),
        name: entry.name?.trim() || undefined,
      };
      s.setCharacterPrompts((prev) => [...prev, created]);
      return toWorkbenchCharacter(created);
    },
    updateCharacter: (id, patch) => {
      const s = state();
      const existing = s.characterPrompts.find((c) => c.id === id);
      if (!existing) return null;
      const next: CharacterPrompt = {
        ...existing,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.prompt !== undefined ? { positive: patch.prompt } : {}),
        ...(patch.negative_prompt !== undefined ? { negative: patch.negative_prompt } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        // 工具传 null(use_auto_position)= 重新挑一个空位,而不是留空。
        ...(patch.center !== undefined
          ? { center: patch.center ?? nextSpawnCenter(takenCenters(s.characterPrompts.filter((c) => c.id !== id)), s.freeform), position: '' }
          : {}),
      };
      s.setCharacterPrompts((prev) => prev.map((c) => (c.id === id ? next : c)));
      return toWorkbenchCharacter(next);
    },
    removeCharacter: (id) => {
      const s = state();
      if (!s.characterPrompts.some((c) => c.id === id)) return false;
      s.setCharacterPrompts((prev) => prev.filter((c) => c.id !== id));
      return true;
    },
    replaceCharacters: (characters) => {
      state().setCharacterPrompts(characters.map((c): CharacterPrompt => ({
        id: c.id, positive: c.prompt, negative: c.negative_prompt, activeTab: 'prompt', enabled: c.enabled,
        position: '', center: c.center, name: c.name?.trim() || undefined,
      })));
    },
    maxCharacters: () => maxCharactersForModel(state().selectedModel.id),

    generate: () => new Promise<GenerateOutcome>((resolve) => {
      const s = state();
      if (s.isGenerating || pendingRef.current) {
        resolve({ ok: false, message: '已有生成在进行中,等它结束再试。' });
        return;
      }
      const timer = window.setTimeout(() => {
        if (pendingRef.current?.resolve === resolve) {
          pendingRef.current = null;
          resolve({ ok: false, message: '生成超时(5 分钟)。' });
        }
      }, GENERATE_TIMEOUT_MS);
      pendingRef.current = { resolve, historyHead: s.generationHistory[0]?.id ?? null, timer };
      s.handleGenerate();
    }),
    images: () => state().generationHistory.map((item) => ({
      id: item.id,
      width: item.width,
      height: item.height,
      seed: item.seed,
      blob: () => fetch(item.imageUrl).then((r) => r.blob()),
      createdAt: item.timestamp,
      useCoords: item.metadata?.useCoords,
      model: item.metadata?.model ? (MODEL_MAP[item.metadata.model] ?? item.metadata.model) : undefined,
      characters: item.metadata?.characterPrompts?.map((c, i): WorkbenchCharacter => ({
        id: `hist_${i}`, name: '', enabled: c.enabled, prompt: c.positive, negative_prompt: c.negative,
        center: c.center ?? legacyCellToCenter(c.position) ?? null,
      })),
    })),
    addUpscaledImage: (png, width, height, originalSeed) => {
      state().addUpscaledImage(URL.createObjectURL(png), width, height, originalSeed, 2);
    },

    anlas: () => sidecarApi.getAnlas(),
    isOpus: () => getCachedIsOpus(),
    opusExhausted: () => isOpusUsageExhausted(),
  };
}
