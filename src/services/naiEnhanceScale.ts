// 图生图「放大重绘」的倍率档与结果尺寸 —— 纯逻辑,无 DOM/Node 依赖。
//
// 这里只解决一件事:**这次重绘最后会出多大的图**。它值得单列一个模块,是因为
// Max ✨ 档的尺寸不是客户端算的 —— 我们发的 params 里留的是**原图**尺寸,
// 服务端自己放大。于是任何按 params 宽高做的估价都会系统性少记(边长 ×2 =
// 四倍像素),而这类错本地完全看不出来:图照出,只有账单不对。
//
// 规则逐条照抄两个已上线客户端里带实测标注的那一份
// (Plana-App lib/features/gallery/upscale_model.dart),不是从文档推的。

import { modelCapabilities } from '../components/generation/modelResolutionOptions';

/** 生成管线的总像素上限。 */
export const NAI_MAX_PIXELS = 1024 * 3072;

/**
 * 官方阈值:源图像素必须**小于**上限的 0.8,才提供 Max 档。
 * 写字面量而不是 `NAI_MAX_PIXELS * 0.8` —— 后者浮点算出来是 2516582.4000000004,
 * 与官方那份对不上;这里照抄官方的常量。
 */
export const ENHANCE_MAX_SOURCE_LIMIT = 2_516_582.4;

/** 重绘默认强度/噪声,对齐 MAGNITUDE_PRESETS 档 3。 */
export const ENHANCE_DEFAULT_STRENGTH = 0.5;
export const ENHANCE_DEFAULT_NOISE = 0;

/**
 * 放大倍率档。`factor` 为 null 即 Max ✨:发原图尺寸 + `upscaled_enhance`,
 * 由服务端决定输出尺寸;客户端算出来的目标尺寸**只用于预估**,不进载荷。
 */
export type EnhanceScaleId = 'max' | 'x2' | 'x1.5' | 'x1';

export interface EnhanceScale {
  id: EnhanceScaleId;
  label: string;
  factor: number | null;
}

export const ENHANCE_SCALES: readonly EnhanceScale[] = [
  { id: 'max', label: 'Max ✨', factor: null },
  { id: 'x2', label: '2×', factor: 2 },
  { id: 'x1.5', label: '1.5×', factor: 1.5 },
  { id: 'x1', label: '1×', factor: 1 },
];

const NUMERIC_SCALES = ENHANCE_SCALES.filter((s) => s.factor !== null);

function scaleOf(id: EnhanceScaleId): EnhanceScale {
  const found = ENHANCE_SCALES.find((s) => s.id === id);
  if (!found) throw new Error(`未知的放大档:${id}`);
  return found;
}

/** 832×1216 / 1216×832:官方对这两个最常用尺寸做了特判,见 enhanceScaleOptions。 */
function isPortraitStd(width: number, height: number): boolean {
  return (width === 832 && height === 1216) || (width === 1216 && height === 832);
}

/**
 * Max ✨ 档的结果尺寸 —— 逐行照抄官方 `RO()`。
 *
 * 不是「等比放大到总像素上限」。实测 512×512 的源图服务端返回 1024×1024,
 * 正是这个函数的值;按「放到上限」算会得到 1774×1774,估价高出三倍。
 * 真实规则:**先把边长向下对齐到 16 的倍数再 ×2**,只有超过总像素上限时才
 * 等比缩回,最后对齐到 32。
 */
export function enhanceMaxTargetSize(width: number, height: number): { width: number; height: number } {
  const mult = 2;
  const step = 8 * mult;
  const tw = Math.floor(width / step) * step * mult;
  const th = Math.floor(height / step) * step * mult;
  if (tw <= 0 || th <= 0) return { width: 0, height: 0 };
  const k = Math.min(1, Math.sqrt(NAI_MAX_PIXELS / (tw * th)));
  let outW = 32 * Math.round((tw * k) / 32);
  let outH = 32 * Math.round((th * k) / 32);
  // round 有可能把两边同时抬上去而越过上限,越过就整体改用 floor。
  if (outW * outH > NAI_MAX_PIXELS) {
    outW = 32 * Math.floor((tw * k) / 32);
    outH = 32 * Math.floor((th * k) / 32);
  }
  return { width: outW, height: outH };
}

/**
 * 某一档的结果尺寸。
 *
 * 官方对数值倍率就是 `floor(边长 × 倍率)`、不额外对齐 —— 因为它只在结果本来
 * 就 64 对齐时才放出那一档。唯一例外是 832×1216 那两个特判尺寸:1.5× 出来是
 * 1248×1824 并非 64 对齐,官方照发。
 *
 * 我们比官方多一种情况:**用户可以导入任意尺寸的图**。那种图 floor 出来往往
 * 不对齐,直接发会被拒,所以这里补一次对齐。
 */
export function enhanceTargetSize(
  width: number,
  height: number,
  id: EnhanceScaleId,
): { width: number; height: number } {
  const factor = scaleOf(id).factor;
  if (factor === null) return enhanceMaxTargetSize(width, height);
  const tw = Math.floor(width * factor);
  const th = Math.floor(height * factor);
  if ((tw % 64 === 0 && th % 64 === 0) || isPortraitStd(width, height)) {
    return { width: tw, height: th };
  }
  return {
    width: Math.max(64, Math.round(tw / 64) * 64),
    height: Math.max(64, Math.round(th / 64) * 64),
  };
}

/** Max 档是否可用:只有能力位打开的模型有,且源图不能太大。 */
export function enhanceMaxAvailable(width: number, height: number, model: string): boolean {
  const pixels = width * height;
  if (pixels <= 0 || pixels >= ENHANCE_MAX_SOURCE_LIMIT) return false;
  return modelCapabilities(model).maxEnhance;
}

/**
 * 当前图片能选哪些倍率 —— 逐条照抄官方的筛选规则。
 *
 * 规则有三处不直观:
 * 1. **必须 64 对齐**:`w×s` 与 `h×s` 都得是 64 的倍数,否则那一档不出现。
 * 2. **832×1216 / 1216×832 特判**成 1.5× / 1×。832×1.5 = 1248 不是 64 的倍数,
 *    按通则会被筛掉只剩 1×,官方直接写死绕开。
 * 3. **1× = 同尺寸重绘**(只精修不放大),官方一直有这一档。
 *
 * 我们比官方多一步兜底:官方的图必然 64 对齐,而我们允许导入任意尺寸的图 ——
 * 那种图按通则会被筛得一档不剩,所以全空时仍给这几档,由 enhanceTargetSize 补齐。
 */
export function enhanceScaleOptions(width: number, height: number, model: string): EnhanceScale[] {
  const fits = (s: EnhanceScale): boolean => {
    const t = enhanceTargetSize(width, height, s.id);
    return t.width > 0 && t.height > 0 && t.width * t.height <= NAI_MAX_PIXELS;
  };
  const aligned = (s: EnhanceScale): boolean =>
    (width * s.factor!) % 64 === 0 && (height * s.factor!) % 64 === 0;

  let base = isPortraitStd(width, height)
    ? NUMERIC_SCALES.filter((s) => s.id === 'x1.5' || s.id === 'x1')
    : NUMERIC_SCALES.filter((s) => fits(s) && aligned(s));
  if (base.length === 0) base = NUMERIC_SCALES.filter(fits);

  return [
    ...(enhanceMaxAvailable(width, height, model) ? [scaleOf('max')] : []),
    ...base,
  ];
}

// 曾经这里还有一份「非 V5 的历史 1.5× 算法」(一律就近对齐 64),与官方那套
// 差在 832×1216 / 1216×832 的特判上:官方给 1248×1824,历史算法给 1280×1856。
// 现在**全族都跟官方**,所以那份没了 —— enhanceTargetSize 就是唯一出处。
// 其余尺寸两套算出来本就相同(w 是整数,floor 再 round 与直接 round 等价),
// 所以这次统一只动了这两个特判尺寸。
