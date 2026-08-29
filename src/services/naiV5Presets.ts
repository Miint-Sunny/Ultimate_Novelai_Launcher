/**
 * NAI Diffusion V5 的预设文本与预设 id。
 *
 * V5 把 V4 系那套「数字 ucPreset + 布尔 qualityToggle」换成了字符串 id
 * (`ucPresetId` / `qualityPresetId`),所以本文件与 naiUcPresets.ts 是两套并行
 * 的口径,不要互相套用:V5 走这里,4.5 及以下走那里。
 *
 * 文本逐字取自 NAI 官方前端 bundle(6750aa2-production)与 docs.novelai.net,
 * 并与 2026-08-28 的真实抓包互校。逐字很重要——这些串是拼进提示词里发出去的,
 * 差一个词就是另一条提示词。
 *
 * 与 V4.5 的差别值得记一笔:
 *   - 质量尾去掉了 4.5 那个打头的 `location,`;
 *   - V5 是第一个有两档质量尾的模型族(standard / light),4.5 只有一档;
 *   - V5 Curated 不再像 4.5 Curated 那样自带 `-0.8::feet::, rating:general`;
 *   - UC 的 heavy / furryFocus / humanFocus 与 4.5 Full 同文,但 light 是全新写法,
 *     且用上了数字权重语法 `0::ai-generated::`。
 */

export type NaiV5UcPresetId = 'heavy' | 'light' | 'furryFocus' | 'humanFocus' | 'none';
export type NaiV5QualityPresetId = 'standard' | 'light' | 'none';

/** 质量尾。官方是「追加到提示词末尾」,前置逗号由调用方按需补。 */
export const V5_QUALITY_SUFFIX: Record<NaiV5QualityPresetId, string> = {
  standard: 'very aesthetic, masterpiece, no text',
  light: 'very aesthetic, amazing quality, no text',
  none: '',
};

/** UC 前缀。官方把它前置到用户 UC 之前。 */
export const V5_UC_PREFIX: Record<NaiV5UcPresetId, string> = {
  heavy:
    'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, ' +
    'jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, ' +
    'screentone, multiple views, logo, too many watermarks, negative space, blank page',
  light:
    'lowres, bad hands, bad anatomy, artistic error, sepia, white haze, worst quality, ' +
    'very displeasing, jpeg artifacts, 0::ai-generated::',
  furryFocus:
    '{worst quality}, distracting watermark, unfinished, bad quality, {widescreen}, ' +
    'upscale, {sequence}, {{grandfathered content}}, blurred foreground, ' +
    'chromatic aberration, sketch, everyone, [sketch background], simple, ' +
    '[flat colors], ych (character), outline, multiple scenes, [[horror (theme)]], comic',
  humanFocus:
    'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, ' +
    'jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, ' +
    'screentone, multiple views, logo, too many watermarks, negative space, blank page, ' +
    '@_@, mismatched pupils, glowing eyes, bad anatomy',
  none: '',
};

/**
 * 透明背景开关注入的词条。官方那个开关的 tooltip 原文就是
 * "Adds \"transparent background\" to the prompt",即它只是替用户写词,
 * 真正让 alpha 通道出来的是载荷里的 `straight_alpha`。
 */
export const V5_TRANSPARENT_BACKGROUND_TAG = 'transparent background';

/**
 * Furry 模式注入的数据集前缀(官方 tags 文档)。V5 用一个 Anime⇄Furry 开关
 * 取代了 V3 时代独立的 furry 模型,底层就是往提示词前面加这个前缀。
 */
export const V5_FURRY_DATASET_PREFIX = 'fur dataset';

/**
 * 官方 `tag_hint_qt` / `tag_hint_uc_preset` 共用的档位枚举顺序。
 *
 * ⚠ 它和线上那个数字 `ucPreset` **不是**一张表:后者是可见档位数组的下标,
 * 这张是官方内部的枚举顺序。两张表都有 heavy/light,别看串了。
 *
 * 出处是两个已上线客户端各自独立记下的同一张表
 * (Aaalice nai_image_request_builder.dart:140 的注释,
 *  Plana prompt_presets.dart:421 的 _officialPresetHintOrder)。
 */
const OFFICIAL_PRESET_HINT_ORDER: readonly string[] = [
  'none',
  'standard',
  'heavy',
  'light',
  'humanFocus',
  'furryFocus',
  'lowQualityPlusBadAnatomy',
  'lowQuality',
  'badAnatomy',
];

/**
 * 某个预设 id 的官方档位编号。映射不到就返回 null —— 官方客户端会把 undefined
 * 的键整个删掉,所以调用方要**省掉这个键**而不是发 0。
 */
export function officialPresetHint(presetId: string): number | null {
  const index = OFFICIAL_PRESET_HINT_ORDER.indexOf(presetId);
  return index < 0 ? null : index;
}

/** 我们的 UC 预设名(全族通用)映射到 V5 的合法 id;V5 未提供的档位退到 heavy。 */
export function toV5UcPresetId(preset: string): NaiV5UcPresetId {
  return preset in V5_UC_PREFIX ? (preset as NaiV5UcPresetId) : 'heavy';
}

/**
 * 现有 UI 只有「质量尾开/关」一个布尔。V5 有三档,先把布尔映到 standard / none,
 * 等 UI 出了三档选择器再直接传 id。
 */
export function toV5QualityPresetId(qualityToggle: boolean): NaiV5QualityPresetId {
  return qualityToggle ? 'standard' : 'none';
}

/**
 * `-full` 会自动前置 `nsfw, `,curated 不会——官方 UC 组装器的行为,
 * 条件是:模型不属于 curated 系、预设不是 none、且用户 UC 里还没写过 nsfw。
 *
 * ⚠ **目前没有任何产品代码调用它**,只有 check-v5-parity 在断言。也就是说
 * 我们实际发出去的负面词里没有这个前缀,别看到这个函数就以为已经在做了。
 *
 * 没接上是因为三份实现给出三种行为,而这条会改动每一次 V5 Full 的负面词:
 *   - 本函数:按「UC 里有没有 nsfw」决定加不加前缀;
 *   - Aaalice(V4.5 期):把 nsfw 写进 -full 的预设文本,再按「**正面**里有没有
 *     nsfw」决定要不要把它删掉(api_constants.dart 的 applyPresetWithNsfwCheck);
 *   - Plana(对齐我们 web,支持 V5):整套逻辑都没有,预设文本里也没有 nsfw。
 * 三者不是同一条规则,定不下来之前不接——接错就是静默改图。
 */
export function shouldPrefixNsfw(backendModel: string, preset: NaiV5UcPresetId, uc: string): boolean {
  if (preset === 'none') return false;
  if (backendModel.includes('curated')) return false;
  return !/\bnsfw\b/i.test(uc);
}
