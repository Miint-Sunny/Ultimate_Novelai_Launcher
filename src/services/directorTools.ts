/**
 * 导演工具(官方 Director Tools,`POST /ai/augment-image`)的纯逻辑:工具表、算价、入参校验。
 *
 * 这里不碰 DOM 也不发请求,校验在 scripts/check-director-tools.mjs。
 * 后端那半见 sidecar/api/v1/director.py(端点 `/api/v1/director/augment`)。
 *
 * 价钱是这条线上最容易出错的地方,所以口径写死在这里,界面直接显示算出来的数字,
 * 不写「约」「可能」。三次真链路实测钉住了它,见 directorBaseCost 的注释。
 */

import { directorBaseCost } from './costCalculator';

export type DirectorToolId =
  | 'bg-removal'
  | 'lineart'
  | 'sketch'
  | 'colorize'
  | 'emotion'
  | 'declutter';

export interface DirectorToolSpec {
  id: DirectorToolId;
  label: string;
  hint: string;
  /** 要不要提示词(官方只有上色与改表情收)。 */
  needsPrompt: boolean;
  /** 要不要 defry(0–5,官方与提示词同进退)。 */
  needsDefry: boolean;
}

/** 顺序照官方前端。 */
export const DIRECTOR_TOOLS: readonly DirectorToolSpec[] = [
  { id: 'lineart', label: '线稿', hint: '提取线条', needsPrompt: false, needsDefry: false },
  { id: 'sketch', label: '草图', hint: '转成草图', needsPrompt: false, needsDefry: false },
  { id: 'colorize', label: '上色', hint: '给线稿上色,可写要求', needsPrompt: true, needsDefry: true },
  { id: 'emotion', label: '改表情', hint: '换一种情绪,可写要求', needsPrompt: true, needsDefry: true },
  { id: 'declutter', label: '整理', hint: '去掉杂乱元素', needsPrompt: false, needsDefry: false },
  { id: 'bg-removal', label: '去背', hint: '抠掉背景,输出透明底', needsPrompt: false, needsDefry: false },
];

const TOOL_BY_ID = new Map(DIRECTOR_TOOLS.map((tool) => [tool.id, tool]));

export function directorTool(id: string): DirectorToolSpec | null {
  return TOOL_BY_ID.get(id as DirectorToolId) ?? null;
}

/** 官方网页端对输入图的上限:1536×2048。超了服务端会拒(我们在本地就拦,省一次往返)。 */
export const DIRECTOR_MAX_PIXELS = 1536 * 2048;

/** Opus 免费档的面积上限,与出图那条同一个数。 */
const OPUS_FREE_PIXELS = 1024 * 1024;

export interface DirectorCost {
  /** 这次要扣多少 Anlas。 */
  anlas: number;
  /** 真的一点都不扣(Opus 免费档)。 */
  free: boolean;
  /**
   * 要不要二次确认。去背在 1 MP 上是 65 点,和一次 V5 出图一个量级,
   * 不该点一下就走;免费的那几个不用拦。
   */
  confirm: boolean;
}

/**
 * 某工具在某尺寸下的花费。
 *
 * - **去背**:`base × 3 + 5`,**永远收费**,Opus 也照扣(官方特判,实测证实)。
 * - **其余五个**:就是 `base`;Opus 且面积 ≤ 1 MP 时为 0。
 *
 * ⚠ 免费只保证「不扣 Anlas」。会不会吃 Opus 体力条我们没有证据:单次 1 MP 约占 0.06%,
 * 整数百分比根本看不出来,所以界面上只写「不花 Anlas」,不写「不消耗额度」。
 */
export function directorCost(tool: DirectorToolId, width: number, height: number, isOpus: boolean): DirectorCost {
  const base = directorBaseCost(width, height);
  if (tool === 'bg-removal') {
    return { anlas: base * 3 + 5, free: false, confirm: true };
  }
  const free = isOpus && width * height <= OPUS_FREE_PIXELS;
  const anlas = free ? 0 : base;
  return { anlas, free, confirm: !free };
}

export type DirectorInputProblem = 'too-large' | 'no-image' | 'missing-prompt';

/**
 * 能不能发。三件事会让这次请求白跑:没有图、图超过官方上限、该写提示词的没写。
 * 提示词为空时官方不报错但等于没给要求,拦下来比花钱换一张没变化的图好。
 */
export function directorInputProblem(
  tool: DirectorToolId,
  image: { width: number; height: number } | null,
  prompt: string,
): DirectorInputProblem | null {
  if (!image) return 'no-image';
  if (image.width * image.height > DIRECTOR_MAX_PIXELS) return 'too-large';
  const spec = directorTool(tool);
  if (spec?.needsPrompt && prompt.trim().length === 0) return 'missing-prompt';
  return null;
}

/** defry 官方范围 0–5,不是数就当 0。 */
export function clampDefry(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.round(raw) : 0;
  return Math.min(5, Math.max(0, n));
}

/** 界面上那句价钱。免费档说清楚是「不花 Anlas」而不是「不消耗额度」。 */
export function describeDirectorCost(cost: DirectorCost): string {
  if (cost.free) return '不花 Anlas';
  return `${cost.anlas} Anlas`;
}
