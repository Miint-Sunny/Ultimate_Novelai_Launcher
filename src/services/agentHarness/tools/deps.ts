import type { Skill } from '../skillCatalog';
import type { CostEstimate } from '../types';
import type { WorkbenchAdapter } from '../workbench';

/** 工具层的外部依赖,全部注入:核心不直接 import 重服务,校验脚本才能在 node 里跑。 */
export interface ToolDeps {
  adapter: WorkbenchAdapter;
  /** 当前预设允许 update_studio_parameters 改的参数键。 */
  allowedParams: () => ReadonlySet<string>;
  /** 估当前工作台参数出一张图要多少点(免费也要如实报 0)。 */
  estimateGenerationCost: () => CostEstimate;
  /** V5 扩散超分:源图尺寸 → 目标尺寸与点数;超上限 cost 为 null。 */
  upscaleQuote: (width: number, height: number) => { cost: number | null; target: { width: number; height: number } };
  upscaleV5: (imageBase64: string) => Promise<{ image: string; width: number; height: number }>;
  /** 图片缩到最长边 maxEdge,返回 base64(不含 data: 前缀)。 */
  downscaleImage: (blob: Blob, maxEdge: number | null) => Promise<{ base64: string; mimeType: string; width: number; height: number }>;
  postJson: <T>(path: string, body: unknown) => Promise<T>;
  promptLibrary: {
    list: () => Promise<PromptLibraryEntry[]>;
    save: (entry: PromptLibraryEntry) => Promise<void>;
    remove: (id: string) => Promise<void>;
  };
  skills: readonly Skill[];
  enabledSkillIds: () => readonly string[];
}

/** 词库条目:映射到我们的 Prompt Chunks(label = title,expansion = prompt,category = 文件夹)。 */
export interface PromptLibraryEntry {
  id: string;
  title: string;
  prompt: string;
  category: string;
  createdAt?: number;
}

export const blobToBase64 = async (blob: Blob): Promise<string> => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
};
