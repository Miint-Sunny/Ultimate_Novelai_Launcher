/**
 * NovelAI Anlas 点数消耗计算器
 * 
 * 基于 novelai-python SDK 的 CostCalculator 逻辑移植
 * 参考: https://github.com/LlmKira/novelai-python
 * 
 * 三种计算路径:
 * 1. calculateDimensionCost - V4/V4.5/SDXL 系列模型（主要使用）
 * 2. calculateStepsCost - 旧模型 + 小尺寸 + 简单采样器
 * 3. calculateSamplingCost - 其他情况（查表法）
 */

import { modelCapabilities } from '../components/generation/modelResolutionOptions';

// 模型分组
type ModelGroup = 'V5' | 'V4' | 'SDXL' | 'SDXL_FURRY' | 'LEGACY';

// V5 在与 V4 相同的维度公式之上再乘 1.5(官方 bundle 的 cost 函数里就是独立
// 一行 `group === v5 && (cost *= 1.5)`)。实测锚点:832×1216 / 28 步 = 20 × 1.5
// = 30 Anlas,与真实扣费一致。
const V5_COST_MULTIPLIER = 1.5;

// 单张封顶与保底(官方常量:超过 140 直接判错,最低 2)
const MAX_COST_PER_IMAGE = 140;

// 简单采样器列表（用于旧模型的 calculateStepsCost 路径）
const SIMPLE_SAMPLERS = ['plms', 'ddim', 'k_euler', 'k_euler_ancestral', 'k_lms'];

// 普通分辨率阈值（1024*1024 = 1048576 像素）
const NORMAL_RESOLUTION_THRESHOLD = 1048576;

// 模型名称到分组的映射
// V5 必须排在最前:漏掉它会掉进 LEGACY,而 LEGACY 对小图 + 简单采样器走的是
// 另一条指数公式,算出来的价跟真实扣费差一大截。
function getModelGroup(model: string): ModelGroup {
  const m = model.toLowerCase();
  if (m.includes('nai-diffusion-5') || m.includes('v5')) return 'V5';
  if (m.includes('nai-diffusion-4') || m.includes('v4')) return 'V4';
  if (m.includes('nai-diffusion-3') || m.includes('v3')) return 'SDXL';
  if (m.includes('furry')) return 'SDXL_FURRY';
  return 'LEGACY';
}

// 采样器名称标准化
function normalizeSampler(sampler: string): string {
  const map: Record<string, string> = {
    'Euler': 'k_euler',
    'Euler Ancestral': 'k_euler_ancestral',
    'DPM++ 2S Ancestral': 'k_dpmpp_2s_ancestral',
    'DPM++ 2M SDE': 'k_dpmpp_2m_sde',
    'DPM++ 2M': 'k_dpmpp_2m',
    'DPM++ SDE': 'k_dpmpp_sde',
  };
  return map[sampler] || sampler.toLowerCase();
}

/**
 * V4/SDXL 系列模型的点数计算（主要公式）
 * 
 * 新公式: cost = ceil(5.773e-7 * width * height * (steps + 5))
 * 相比旧公式，steps 变为 steps + 5，即每张图有 5 步固定"启动成本"。
 * 28 步实际按 33 步计费，50 步按 55 步计费。
 * 单步单像素价格几乎不变（5.753e-7 → 5.773e-7，差 <0.4%）。
 */
function calculateDimensionCost(
  width: number,
  height: number,
  steps: number,
  smea: boolean,
  smeaDyn: boolean,
): number {
  const pixels = width * height;
  const factor = smeaDyn ? 1.4 : (smea ? 1.2 : 1.0);
  const cost = Math.ceil(
    5.773e-7 * pixels * (steps + 5) * factor
  );
  return Math.max(cost, 2);
}

/**
 * 旧模型 + 小尺寸 + 简单采样器的点数计算
 */
function calculateStepsCost(
  width: number,
  height: number,
  steps: number,
): number {
  const pixels = width * height;
  const cost = (15.266 * Math.exp((pixels / 1048576) * 0.6326) - 15.225) / 28 * steps;
  return Math.max(Math.ceil(cost), 2);
}

export interface CostCalculationParams {
  width: number;
  height: number;
  steps: number;
  model: string;           // 模型 ID，如 'v4.5-full', 'nai-diffusion-4-5-full'
  sampler: string;         // 采样器名称
  smea?: boolean;          // SMEA 开关（V4 模型通常不用）
  smeaDyn?: boolean;       // SMEA DYN 开关
  nSamples?: number;       // 生成数量，默认 1
  img2imgStrength?: number; // 图生图强度 (0-1)，不传表示非图生图
  isOpus?: boolean;        // 是否 Opus 订阅
  preciseRefCount?: number; // 使用的 Precise Reference 数量（每张 +5 anlas）
  vibeRefCount?: number;    // 使用的 Vibe Transfer 参考图数量（第 5 张起每张 +2 anlas）
  /**
   * Opus「体力条」是否已耗尽（percent 为 0 或 isNegative）。
   * 只对 V5 有意义：V5 是唯一会消耗这条额度的模型族，4.5 及以下对 Opus 仍是无限。
   * 耗尽后 NAI 不报错，直接按 Anlas 收费——所以这里必须跟着算，否则界面会显示
   * 「免费」而钱已经在扣。
   */
  opusUsageExhausted?: boolean;
}

export interface CostResult {
  /** 单张图片的 anlas 消耗 */
  perImage: number;
  /** 总消耗 (perImage * nSamples) */
  total: number;
  /** Opus 免费的张数 */
  opusFreeCount: number;
  /** 是否完全免费 */
  isFree: boolean;
}

/**
 * 计算 NovelAI 图片生成的 Anlas 消耗
 */
export function calculateAnlasCost(params: CostCalculationParams): CostResult {
  const {
    width,
    height,
    steps,
    model,
    sampler,
    smea = false,
    smeaDyn = false,
    nSamples = 1,
    img2imgStrength,
    isOpus = false,
    preciseRefCount = 0,
    vibeRefCount = 0,
    opusUsageExhausted = false,
  } = params;

  const modelGroup = getModelGroup(model);
  const normalizedSampler = normalizeSampler(sampler);
  const pixels = width * height;
  const isImg2Img = img2imgStrength !== undefined && img2imgStrength > 0;
  const strength = isImg2Img ? img2imgStrength! : 1.0;
  // 模型不支持的参考图不计价。载荷层压根不会发它们（能力位关着），界面上却可能还挂着
  // 切模型之前留下的图——少了这一刀，V5 上每张精确参考虚收 5 Anlas，而出的图里什么都没有
  // （2026-09-21 真链路实测：载荷无 director_reference_*，余额纹丝不动，按钮却写着 5 💎）。
  // 拦在这里而不是各自的界面里：桌面底栏、竖屏工具条、助手估价读的都是这一个函数。
  const caps = modelCapabilities(model);
  const chargedPreciseRefCount = caps.preciseReference ? preciseRefCount : 0;
  const chargedVibeRefCount = caps.vibeTransfer ? vibeRefCount : 0;
  const hasPreciseRef = chargedPreciseRefCount > 0;
  const extraVibeCount = Math.max(0, chargedVibeRefCount - 4);

  let perImageCost: number;

  // V5/V4/SDXL 系列使用 calculateDimensionCost
  if (modelGroup === 'V5' || modelGroup === 'V4' || modelGroup === 'SDXL' || modelGroup === 'SDXL_FURRY') {
    perImageCost = calculateDimensionCost(width, height, steps, smea, smeaDyn);
    if (modelGroup === 'V5') {
      // 官方是「基数向上取整后再乘 1.5、然后再取整一次」的双重取整,不是一次算完
      // 才取整——两种写法在很多尺寸上差 1 点。
      perImageCost = Math.max(Math.ceil(perImageCost * V5_COST_MULTIPLIER), 2);
    }
  } else {
    // 旧模型：小尺寸 + 简单采样器走 calculateStepsCost
    if (pixels <= NORMAL_RESOLUTION_THRESHOLD && SIMPLE_SAMPLERS.includes(normalizedSampler)) {
      perImageCost = calculateStepsCost(width, height, steps);
    } else {
      // 其他情况也用 calculateDimensionCost 作为近似
      perImageCost = calculateDimensionCost(width, height, steps, smea, smeaDyn);
    }
  }

  // 应用 img2img strength 系数
  if (isImg2Img) {
    perImageCost = Math.max(Math.ceil(perImageCost * strength), 2);
  }

  // 官方对单张有硬上限：超过 140 直接判为不可生成。这里夹住而不是报错，界面上
  // 显示封顶价即可，真正的拒绝交给服务端。
  perImageCost = Math.min(perImageCost, MAX_COST_PER_IMAGE);

  // Precise Reference 附加费：每张 +5 anlas（即使 Opus 免费生成也要付）
  const preciseRefCost = hasPreciseRef ? 5 * chargedPreciseRefCount : 0;

  // Vibe Transfer 附加费：第 5 张起每张 +2 anlas（前 4 张免费；Opus 免费生成也要付）
  const vibeExtraCost = extraVibeCount * 2;

  // Opus 免费额度判断
  // 条件: Opus 订阅 + steps <= 28 + 像素 <= 1048576
  // 图生图和重绘在小图范围内同样免费，只有超出分辨率阈值才收费
  // V5 多一个条件：体力条没耗尽。这是 V5 引入的第四道闸——V5 是唯一按额度计的
  // 模型族，条空之后同样的小图就开始花 Anlas 了。
  let opusFreeCount = 0;
  const meteredByOpusUsage = modelGroup === 'V5';
  if (
    isOpus &&
    steps <= 28 &&
    pixels <= NORMAL_RESOLUTION_THRESHOLD &&
    !(meteredByOpusUsage && opusUsageExhausted)
  ) {
    // Opus 第一张免费（生成本身免费，但 PR 附加费仍需支付）
    opusFreeCount = 1;
  }

  // 计算实际需要付费的张数
  const paidSamples = Math.max(0, nSamples - opusFreeCount);
  const total = perImageCost * paidSamples + (preciseRefCost + vibeExtraCost) * nSamples;
  const isFree = total === 0;

  return {
    perImage: perImageCost,
    total,
    opusFreeCount,
    isFree,
  };
}

// 模型 ID 映射（前端 UI ID -> API 模型名）
const UI_MODEL_MAP: Record<string, string> = {
  'v5-full': 'nai-diffusion-5-full',
  'v5-curated': 'nai-diffusion-5-curated',
  'v4.5-full': 'nai-diffusion-4-5-full',
  'v4.5-curated': 'nai-diffusion-4-5-curated',
  'v4-full': 'nai-diffusion-4-full',
  'v4-curated-preview': 'nai-diffusion-4-curated-preview',
  'v3': 'nai-diffusion-3',
};

/**
 * 便捷函数：直接用前端 UI 的参数计算消耗
 */
export function calculateCostFromUI(params: {
  width: number;
  height: number;
  steps: number;
  modelId: string;        // UI 模型 ID，如 'v4.5-full'
  sampler: string;
  isOpus?: boolean;
  img2imgStrength?: number;
  preciseRefCount?: number;
  vibeRefCount?: number;
  opusUsageExhausted?: boolean;
}): CostResult {
  const apiModel = UI_MODEL_MAP[params.modelId] || params.modelId;
  return calculateAnlasCost({
    ...params,
    model: apiModel,
    nSamples: 1,
  });
}
