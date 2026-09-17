/**
 * 工作台适配层:工具能看到、能改的东西。
 *
 * 他的工具直接改 Flutter 的 ViewModel;我们的状态在 LeftSidebar / GenerationContext 里,
 * 所以工具只跟这个接口说话,接口由 LeftSidebar 注册进 AgentDockContext(和现有的
 * generate / restoreSnapshot 一路)。字段名沿用他的参数键,免得两边翻译。
 */

import type { AnlasInfo } from './anlas';

export interface StudioParams {
  prompt: string;
  negative_prompt: string;
  /** 官方模型 id(nai-diffusion-5-full …)。 */
  model: string;
  width: number;
  height: number;
  steps: number;
  scale: number;
  cfg_rescale: number;
  sampler: string;
  noise_schedule: string;
  /** 当前预设行的 id(heavy / v5-standard …),供质量档读写。 */
  quality_preset: string;
  /** 空串 = 随机。 */
  seed: string;
  /** 全局位置模式:true = 交给模型排版,false = 自定义坐标。 */
  character_ai_position: boolean;
}

/** 生图后端最终消费的提示词快照。 */
export interface StudioEffectivePrompts {
  backend: string;
  prompt: string;
  negativePrompt: string;
  /** 当前质量 / UC 预设行的名字(工作台里一行同时管质量尾与 UC 前缀)。 */
  presetLabel: string;
}

export interface WorkbenchCharacter {
  id: string;
  name: string;
  enabled: boolean;
  prompt: string;
  negative_prompt: string;
  /** null = 自动。 */
  center: { x: number; y: number } | null;
}

export interface WorkbenchImage {
  id: string;
  width: number;
  height: number;
  seed: number;
  blob: () => Promise<Blob>;
  /** 出这张图时的角色槽位(含坐标),给 view_canvas_image 叠覆盖层;历史里没记就缺省。 */
  characters?: WorkbenchCharacter[];
  /** 出这张图用的官方模型 id。 */
  model?: string;
  createdAt?: number;
  /** 出图时位置区块的全局开关(use_coords);历史里没记就缺省。 */
  useCoords?: boolean;
}

export interface GenerateOutcome {
  ok: boolean;
  message: string;
  seed?: number;
  width?: number;
  height?: number;
}

export interface AgentQuestionOption {
  label: string;
  description?: string;
}

export interface AgentQuestion {
  question: string;
  header?: string;
  multiSelect: boolean;
  allowCustomInput: boolean;
  options: AgentQuestionOption[];
}

export interface WorkbenchAdapter {
  getParams(): StudioParams;
  /** 只做写入;校验、对齐与权限在工具和闸里已经做完。 */
  applyParams(patch: Partial<StudioParams>): void;
  /** 可选的模型与预设词表,给工具做校验与回显。 */
  availableModels(): { id: string; label: string }[];
  availableQualityPresets(): { id: string; label: string }[];
  /**
   * 当前后端实际会发出的正负提示词(质量尾 / UC 前缀已按当前预设行拼好)与预设名。
   * 工作台没实现时工具只回显原始串。(他 fork 的 pr-studio-state:模型得知道自动追加了什么。)
   */
  effectivePrompts?(): StudioEffectivePrompts;

  listCharacters(): WorkbenchCharacter[];
  addCharacter(entry: { name?: string; prompt: string; negative_prompt?: string; center?: { x: number; y: number } | null }): WorkbenchCharacter;
  updateCharacter(id: string, patch: Partial<Omit<WorkbenchCharacter, 'id'>>): WorkbenchCharacter | null;
  removeCharacter(id: string): boolean;
  /** 整体替换角色槽位(回溯还原用);id 原样保留。 */
  replaceCharacters(characters: WorkbenchCharacter[]): void;
  maxCharacters(): number;

  /** 按当前工作台参数生成,等到出图或失败才返回。 */
  generate(): Promise<GenerateOutcome>;
  /** 历史图片,最新的在前。 */
  images(): WorkbenchImage[];
  /** 把放大结果放回历史坞。 */
  addUpscaledImage(png: Blob, width: number, height: number, originalSeed: number): void;

  anlas(): Promise<AnlasInfo | null>;
  isOpus(): boolean;
  opusExhausted(): boolean;

  /** ask_user 的 UI 落点;用户取消返回 null。 */
  askUser(questions: AgentQuestion[]): Promise<string[] | null>;
}
