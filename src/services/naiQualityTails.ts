/**
 * 质量尾:官方是**按模型**给一段,不是预设自带一段。
 *
 * 官方前端的「质量标签」开关只是个布尔——打开就把**当前模型**那段质量词追加到
 * 提示词末尾。文本随模型走:V4.5 Full 打头多一个 `location,`,V4.5 Curated 还带
 * `-0.8::feet::, rating:general`,V4 Full 是 `no text, best quality, …`,V3 又是
 * 另一段。我们原来把它当成预设的属性,`heavy` 一条硬编码的串在所有旧模型上通用,
 * 结果是 V3 的尾巴和 V4.5 的尾巴拼在一起发出去(还带重复词)。
 *
 * 表文照抄 Aaalice `api_constants.dart` 的 `modelQualityTags`(注释原文「添加到末尾」),
 * 它是三份实现里唯一按模型登记的一份;Plana 与我们一样沿用了拼接串,并注明
 * 「契约以 web 为准」——也就是说它抄的是我们的错,不构成第二份佐证。
 * V5 的两档直接引用 naiV5Presets,不在这里再抄一份。
 *
 * 只管**发出去**这一侧。读旧 PNG 时要认历史启动器写过的变体
 * (Aaalice 另有一张 `legacyModelQualityTags`),目前我们导入不剥质量尾,等做到再加。
 */

import { isV5Model, MODEL_MAP } from '../components/generation/modelResolutionOptions';
import { V5_QUALITY_SUFFIX, type NaiV5QualityPresetId } from './naiV5Presets';

/** 旧模型族只有一档质量尾;V5 才分 standard / light。 */
export type QualityTier = Exclude<NaiV5QualityPresetId, 'none'>;

/** 按官方模型 id 登记。V4 Curated 官方 id 带 `-preview` 后缀,两种写法都认。 */
const LEGACY_QUALITY_TAIL: Readonly<Record<string, string>> = {
  'nai-diffusion-4-5-full': 'location, very aesthetic, masterpiece, no text',
  'nai-diffusion-4-5-curated': 'location, masterpiece, no text, -0.8::feet::, rating:general',
  'nai-diffusion-4-full': 'no text, best quality, very aesthetic, absurdres',
  'nai-diffusion-4-curated-preview': 'rating:general, amazing quality, very aesthetic, absurdres',
  'nai-diffusion-4-curated': 'rating:general, amazing quality, very aesthetic, absurdres',
  'nai-diffusion-3': 'best quality, amazing quality, very aesthetic, absurdres',
  'nai-diffusion-furry-3': '{best quality}, {amazing quality}',
};

/**
 * 某模型在某档下应追加的质量尾。
 *
 * 认不出的模型返回 `null`——调用方退回预设行里的字面文本,别在这里猜一段。
 * 传 UI 模型 id(`v4.5-full`)或官方 id 都行,内部按 MODEL_MAP 归一。
 */
export function qualityTailForModel(model: string, tier: QualityTier): string | null {
  const backendId = MODEL_MAP[model] ?? model;
  if (isV5Model(backendId)) return V5_QUALITY_SUFFIX[tier];
  // 旧模型族没有 light 档,官方那个开关只有开关两态,所以档位在这里不起作用。
  return LEGACY_QUALITY_TAIL[backendId] ?? null;
}
